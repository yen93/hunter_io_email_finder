# CLAUDE.md — hunter_io_email_finder

## What this project is
A single **cloud routine** (`hunter_io_email_finder`, id
`trig_01KTt7PyrxbDdu7ReQ9Hi8Gp`) that enriches contacts in the Supabase
`linkedin_posts` table: it finds each contact's work email via the Hunter.io
Email Finder API and writes it to `enrichment_email`. There is **no local code** —
all logic lives in the routine's prompt. This repo holds the API key, the docs
(`as_built.txt`), and `chat_history/`.

## How it's triggered in production (parent n8n pipeline)
This routine is the **email-finding fallback** in a larger n8n workflow, "Comment
Scraping POC Enrichment" (id `YAexztVMLu7zp3TN`). Nightly the workflow: (1) finds a
point-of-contact for each verified `linkedin_posts` lead (GPT-4.1-mini classifier
+ Apify comment scraper), (2) does a first email pass with Google Gemini (verified/
cited emails only, writing `enrichment_email` + `enrichment_email_source`), then
(3) an n8n **HTTP Request** node fires THIS routine
(`POST https://api.anthropic.com/v1/claude_code/routines/trig_01KTt7PyrxbDdu7ReQ9Hi8Gp/fire`,
bearer auth) to fill the emails Gemini left blank. A separate 21:00 trigger exports
finished leads to the Google Sheet `ai_scraped_soc_med_leads`. The workflow export
`n8n - Comment Scraping POC Enrichment.json` lives in this folder but is **gitignored
(`*.json`)** because it embeds a live Serper.dev key in a disabled node.

## Key architecture / gotchas
- **The routine runs in Anthropic's cloud, not on this machine.** It therefore
  **cannot read local files.** The Hunter.io API key is embedded directly in the
  routine prompt. The local `hunter_io_api_key.txt` is the source of truth; if
  you rotate the key you must also update the routine prompt (via `RemoteTrigger`
  `action: update`). `hunter_io_api_key.txt` is gitignored — never commit it.
- **Hunter.io is not an MCP connector** — the routine calls it over HTTP with
  Bash/curl: `GET https://api.hunter.io/v2/email-finder?company={org}
  &first_name={..}&last_name={..}&api_key={key}`. There is no domain column in
  the data, so it queries by `company` (the `org` value). `enrichment_poc_name`
  is a full name, split on whitespace into first/last.
- **Supabase** is attached to the routine as an MCP connector (`execute_sql`).
  Project MAGTestProject, id `aivitcomiywiysrfwqxt`. (Supabase reaches the internet
  through the sandbox's *allowed* MCP proxy — which is why it worked while direct
  Hunter calls initially did not.)
- **Egress allowlist is required for Hunter (important gotcha).** The cloud sandbox
  blocks outbound HTTPS to everything except an allowlist (Anthropic APIs, the MCP
  proxy, package registries). Early runs failed *every* Hunter call with
  `connect_rejected (organization policy)` / `CONNECT tunnel failed, 403`. Declaring
  `user_declared_urls: ["https://api.hunter.io"]` on the routine did NOT fix it — the
  block is environment-level. The fix was adding `api.hunter.io` to the **Default
  environment's egress allowlist** manually (done 2026-09-09). If Hunter calls start
  returning 403 on CONNECT again, check that env allowlist first. Verify with
  `RemoteTrigger get_run_log` on the run's session id.

## Behaviour rules baked into the routine (keep these if editing the prompt)
- Only processes rows matching the agreed filter (verified leads with
  `enrichment_poc_name`+`org`, `enrichment_email` null, not yet processed).
- Writes **any** non-null email Hunter returns (no confidence threshold).
- **Always** sets `email_finder_is_processed = true` on every attempted row
  (found or not) so nothing is reprocessed / no repeated credit spend.
- Never overwrites a row that already has a non-null `enrichment_email`.

## Operating the routine
- It is **paused** (`enabled=false`) by design — the user fires it via their own
  external API trigger: `POST /v1/code/triggers/trig_01KTt7PyrxbDdu7ReQ9Hi8Gp/run`.
  "Run now" works even while paused; the placeholder cron never fires.
- Manage/debug with the `RemoteTrigger` tool: `get`, `update`, `run`,
  `list_runs`, `get_run_log`. To verify results after a run, check Supabase that
  affected rows have `enrichment_email` set and `email_finder_is_processed=true`.
- Routines can't be deleted via tool — use https://claude.ai/code/routines.
