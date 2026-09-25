# CLAUDE.md — hunter_io_email_finder

## What this project is
A single **cloud routine** (`hunter_io_email_finder`, id
`trig_01KTt7PyrxbDdu7ReQ9Hi8Gp`) that enriches contacts in the Supabase
`linkedin_posts` table: it finds each contact's work email and writes it to
`enrichment_email` (with `enrichment_email_source` = `hunter` or `prospeo`). Since
2026-09-25 it uses a **two-provider chain** — it first resolves a company domain via
**Clearbit Autocomplete**, then tries **Hunter.io** Email Finder, then falls back to
**Prospeo** (`enrich-person`) for any Hunter miss. There is **no local code** — all
logic lives in the routine's prompt. This repo holds the API keys, the docs
(`as_built.txt`), `chat_history/`, and the edge-function source (below).

## Production path moved to a Supabase Edge Function (2026-09-25)
The identical logic now runs as a Supabase **Edge Function**
`linkedin_comments_poc_enrichment` (project `aivitcomiywiysrfwqxt`), which is what the
n8n pipeline calls in production. Rationale: the work is deterministic ETL, so this
removes Claude-token cost and the cloud-sandbox egress-allowlist fragility (Deno edge
functions have open egress). **The Claude routine is kept paused as a fallback.**
- URL: `https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/linkedin_comments_poc_enrichment`
- Deployed with `verify_jwt:false`, **no inbound auth** (matches the project's other
  functions, e.g. `alternate-lead-finder`). Anyone with the URL can trigger it.
- Params: `?limit=N` (default 10); `?sync=1` runs inline and returns the JSON summary
  (default is background: returns 202 immediately and works via `EdgeRuntime.waitUntil`).
- Env secrets it reads: `HUNTER_IO_API_KEY` (already set project-wide),
  `PROSPEO_API_KEY` (**must be set** — Dashboard → Edge Functions → Manage secrets, or
  `supabase secrets set PROSPEO_API_KEY=... --project-ref aivitcomiywiysrfwqxt`), plus
  auto-injected `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`. Clearbit needs no key.
- **Source of truth in repo:** `supabase/functions/linkedin_comments_poc_enrichment/index.ts`
  — edit there, then redeploy via the Supabase MCP `deploy_edge_function`
  (`verify_jwt:false`). Same behaviour rules as the routine (see below).
- **Completion webhook (2026-09-25):** at the very end of every run the function
  `GET`s the n8n webhook
  `https://n8n-659687081407.australia-southeast1.run.app/webhook/d13096b0-03af-400a-8f4c-1b37cdaf8a9b`
  (the "sheet update" workflow). This **replaced** the daily pg_cron job
  `n8n-linkedin-comment-enrichment-sheet-update` (jobid 32) in the **`n8n-production`
  Supabase project** (id `uwsncuowtzydylfabikj`), which was **deactivated**
  (`cron.alter_job(32, active:=false)`). That project holds ~20+ pg_cron jobs that GET
  n8n webhooks on a nightly cadence; note it's a SEPARATE Supabase project from
  MAGTest. The webhook is called with GET to match how the cron invoked it.

## How it's triggered in production (parent n8n pipeline)
This routine is the **email-finding fallback** in a larger n8n workflow, "Comment
Scraping POC Enrichment" (id `YAexztVMLu7zp3TN`). Nightly the workflow: (1) finds a
point-of-contact for each verified `linkedin_posts` lead (GPT-4.1-mini classifier
+ Apify comment scraper), (2) does a first email pass with Google Gemini (verified/
cited emails only, writing `enrichment_email` + `enrichment_email_source`), then
(3) an n8n **HTTP Request** node (named "HTTP Request", under the "claude routine:
⚡ hunter_io_email_finder" sticky) calls the email-finder to fill the emails Gemini
left blank. **As of 2026-09-25 this node points at the Supabase Edge Function**
(`POST https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/linkedin_comments_poc_enrichment`,
auth None) instead of the old routine fire endpoint
(`POST https://api.anthropic.com/v1/claude_code/routines/trig_01KTt7PyrxbDdu7ReQ9Hi8Gp/fire`,
bearer auth). A separate 21:00 trigger exports
finished leads to the Google Sheet `ai_scraped_soc_med_leads`. The workflow export
`n8n - Comment Scraping POC Enrichment.json` lives in this folder but is **gitignored
(`*.json`)** because it embeds a live Serper.dev key in a disabled node.

## Key architecture / gotchas
- **The routine runs in Anthropic's cloud, not on this machine.** It therefore
  **cannot read local files.** Both the Hunter.io and Prospeo API keys are embedded
  directly in the routine prompt. The local `hunter_io_api_key.txt` /
  `prospeo_api_key.txt` are the on-disk source of truth (both gitignored via
  `*_key.txt`); the Prospeo key is also in **GCP Secret Manager** as `prospeo-api-key`
  (project `claudegwscli-502400`). If you rotate a key, update the routine prompt too
  (via `RemoteTrigger` `action: update`) — and the secret for Prospeo.
- **Neither Hunter nor Prospeo is an MCP connector** — the routine calls them over
  HTTP with Bash/curl.
  - Hunter: `GET https://api.hunter.io/v2/email-finder?company={org}
    &first_name={..}&last_name={..}&api_key={key}`; email at `data.email`.
  - Prospeo (`enrich-person`): `POST https://api.prospeo.io/enrich-person`, header
    `X-KEY: {key}`, body `{"data":{"first_name":..,"last_name":..,
    "company_name":<org>,"company_website":"https://<domain>"}}`; email at
    `response.person.email.email`. **Gotchas:** `company_website` MUST be a full
    `https://` URL (a bare domain → `INVALID_DATAPOINTS`); fields MUST nest under
    `data`; the **free tier is rate-limited** (429 → space calls ~2s + retry once);
    free plan = **75 email credits/month** (no rollover); the classic Email Finder
    API is **deprecated** — use `enrich-person`. **Emails only** — never set
    `enrich_mobile` (mobile reveals cost 10 credits each).
- **Domain resolution step (Clearbit).** There is no domain column in the source
  data, so before the email lookup the routine resolves `org` → a domain via
  `GET https://autocomplete.clearbit.com/v1/companies/suggest?query={org}` (free, no
  key; take the first result's `domain`) and stores it in the new
  `enrichment_company_domain` column (or the literal `'unresolved'` when none is
  found, so it isn't re-queried). `enrichment_poc_name` is a full name, split on
  whitespace into first/last; when `enrichment_poc_linkedin_link` exists it's passed
  to Prospeo as an extra `linkedin_url` datapoint.
- **Supabase** is attached to the routine as an MCP connector (`execute_sql`).
  Project MAGTestProject, id `aivitcomiywiysrfwqxt`. (Supabase reaches the internet
  through the sandbox's *allowed* MCP proxy — which is why it worked while direct
  Hunter calls initially did not.)
- **Egress allowlist is required for Hunter (important gotcha).** The cloud sandbox
  blocks outbound HTTPS to everything except an allowlist (Anthropic APIs, the MCP
  proxy, package registries). Early runs failed *every* Hunter call with
  `connect_rejected (organization policy)` / `CONNECT tunnel failed, 403`. Declaring
  `user_declared_urls: ["https://api.hunter.io"]` on the routine did NOT fix it — the
  block is environment-level. The fix was adding the hosts to the **Default
  environment's egress allowlist** manually: `api.hunter.io` (2026-09-09) and, for the
  Prospeo fallback + domain step, `api.prospeo.io` and `autocomplete.clearbit.com`
  (2026-09-25). If any provider call starts returning 403 on CONNECT again, check that
  env allowlist first. Verify with `RemoteTrigger get_run_log` on the run's session id.

## Behaviour rules baked into the routine (keep these if editing the prompt)
- Only processes rows matching the agreed filter (verified leads with
  `enrichment_poc_name`+`org`, `enrichment_email` null, not yet processed).
- Resolves a domain into `enrichment_company_domain` first (Clearbit), then tries
  **Hunter, then Prospeo** on Hunter's miss. Emails only.
- Writes **any** non-null email a provider returns (no confidence threshold) and
  records `enrichment_email_source` = `hunter` or `prospeo`.
- Sets `email_finder_is_processed = true` on every row that got a **definitive
  answer** (email found, or a clean no-match). **Refinement (2026-09-25):** a row left
  unresolved *only* because every provider was blocked by quota / out-of-credits /
  rate-limit / egress is **left retryable** (flag NOT set) so it can be retried when
  quotas reset — this replaces the old "always set true" rule and prevents permanent
  skips during a quota outage.
- Never overwrites a row that already has a non-null `enrichment_email`.
- **Budget note:** Prospeo free = 75 emails/month; the backlog can exceed that, so a
  single run may exhaust Prospeo credits and stop (remaining rows stay retryable).

## Operating the routine
- It is **paused** (`enabled=false`) by design — the user fires it via their own
  external API trigger: `POST /v1/code/triggers/trig_01KTt7PyrxbDdu7ReQ9Hi8Gp/run`.
  "Run now" works even while paused; the placeholder cron never fires.
- Manage/debug with the `RemoteTrigger` tool: `get`, `update`, `run`,
  `list_runs`, `get_run_log`. To verify results after a run, check Supabase that
  affected rows have `enrichment_email` set and `email_finder_is_processed=true`.
- Routines can't be deleted via tool — use https://claude.ai/code/routines.
