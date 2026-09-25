// linkedin_comments_poc_enrichment
// Email-finding enrichment for the linkedin_posts table. Port of the
// hunter_io_email_finder Claude routine into a deterministic edge function.
//
// Per qualifying row: resolve a company domain via Clearbit Autocomplete (stored
// in enrichment_company_domain), then try Hunter.io Email Finder, then fall back to
// Prospeo enrich-person. Writes enrichment_email + enrichment_email_source
// ('hunter' | 'prospeo'). Emails only (never requests mobile). Sets
// email_finder_is_processed=true only on a DEFINITIVE answer (email found or clean
// no-match); rows blocked purely by quota / credits / rate-limit / network are left
// retryable. Never overwrites an existing non-null enrichment_email.
//
// At the VERY END of every run it POSTs to the n8n completion webhook (replaces the
// old daily schedule that used to trigger the downstream workflow).
//
// Invoke: POST/GET ?limit=N (default 10) ?sync=1 (run inline & return summary).
// Default (no sync) kicks work to a background task and returns 202 immediately so
// the caller (n8n) never hits the request timeout.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HUNTER_API_KEY = Deno.env.get("HUNTER_IO_API_KEY") ?? "";
const PROSPEO_API_KEY = Deno.env.get("PROSPEO_API_KEY") ?? "";

// Downstream n8n workflow, fired once at the end of every run.
const COMPLETION_WEBHOOK_URL =
  "https://n8n-659687081407.australia-southeast1.run.app/webhook/d13096b0-03af-400a-8f4c-1b37cdaf8a9b";

const DEFAULT_LIMIT = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

interface Row {
  id: string;
  enrichment_poc_name: string | null;
  org: string | null;
  enrichment_company_domain: string | null;
  enrichment_poc_linkedin_link: string | null;
}

type Outcome = "email" | "nomatch" | "retry";

// ---- Completion webhook (n8n). Fired at the very end of every run. ----
// GET to match the n8n webhook's configured method (it replaces the pg_cron job
// n8n-linkedin-comment-enrichment-sheet-update, which used net.http_get).
async function callCompletionWebhook(): Promise<string | null> {
  try {
    const resp = await fetch(COMPLETION_WEBHOOK_URL, { method: "GET" });
    return resp.ok ? null : `webhook HTTP ${resp.status}`;
  } catch (e) {
    return `webhook error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---- Provider: Clearbit Autocomplete (name -> domain). Free, no key. ----
async function resolveDomain(org: string): Promise<string | null | "transient"> {
  try {
    const resp = await fetch(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(org)}`,
    );
    if (!resp.ok) return "transient";
    const arr = await resp.json();
    const domain = Array.isArray(arr) && arr[0]?.domain ? String(arr[0].domain) : null;
    return domain;
  } catch (_e) {
    return "transient";
  }
}

// ---- Provider 1: Hunter.io Email Finder ----
async function tryHunter(
  org: string,
  first: string,
  last: string,
): Promise<{ email: string | null; blocked: boolean }> {
  if (!HUNTER_API_KEY) return { email: null, blocked: true };
  const url =
    `https://api.hunter.io/v2/email-finder?company=${encodeURIComponent(org)}` +
    `&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}` +
    `&api_key=${HUNTER_API_KEY}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url);
      if (resp.status === 429 || resp.status === 401) {
        if (attempt === 0) {
          await sleep(3000);
          continue;
        }
        return { email: null, blocked: true }; // quota/auth -> fall through to Prospeo
      }
      const body = await resp.json().catch(() => ({}));
      if (body?.errors) return { email: null, blocked: true };
      const email = body?.data?.email ?? null;
      return { email: email && String(email).trim() ? String(email) : null, blocked: false };
    } catch (_e) {
      if (attempt === 0) {
        await sleep(3000);
        continue;
      }
      return { email: null, blocked: true };
    }
  }
  return { email: null, blocked: true };
}

// ---- Provider 2: Prospeo enrich-person (fallback) ----
async function tryProspeo(
  org: string,
  first: string,
  last: string,
  domain: string | null,
  linkedin: string | null,
): Promise<{ email: string | null; blocked: boolean; creditsExhausted: boolean }> {
  if (!PROSPEO_API_KEY) return { email: null, blocked: true, creditsExhausted: false };
  const data: Record<string, string> = {
    first_name: first,
    last_name: last,
    company_name: org,
  };
  // company_website MUST be a full https:// URL; a bare domain -> INVALID_DATAPOINTS.
  if (domain && domain !== "unresolved") data.company_website = `https://${domain}`;
  if (linkedin && linkedin.trim()) data.linkedin_url = linkedin.trim();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch("https://api.prospeo.io/enrich-person", {
        method: "POST",
        headers: { "X-KEY": PROSPEO_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      const body = await resp.json().catch(() => ({}));
      const code = typeof body?.error_code === "string" ? body.error_code : "";

      if (resp.status === 429 || /RATE.?LIMIT/i.test(code)) {
        if (attempt === 0) {
          await sleep(5000);
          continue;
        }
        return { email: null, blocked: true, creditsExhausted: false };
      }
      if (resp.status === 402 || /CREDIT/i.test(code)) {
        return { email: null, blocked: true, creditsExhausted: true };
      }
      const email = body?.response?.person?.email?.email ?? null;
      // NO_MATCH / INVALID_DATAPOINTS / null email = clean (definitive) no-match.
      return {
        email: email && String(email).trim() ? String(email) : null,
        blocked: false,
        creditsExhausted: false,
      };
    } catch (_e) {
      if (attempt === 0) {
        await sleep(5000);
        continue;
      }
      return { email: null, blocked: true, creditsExhausted: false };
    }
  }
  return { email: null, blocked: true, creditsExhausted: false };
}

async function run(limit: number) {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const summary = {
    limit,
    considered: 0,
    domains_resolved: 0,
    domains_unresolved: 0,
    hunter_found: 0,
    prospeo_found: 0,
    no_match: 0,
    retryable: 0,
    prospeo_credits_exhausted: false,
    webhook_error: null as string | null,
    errors: [] as string[],
  };

  try {
    const { data: rows, error } = await supabase
      .from("linkedin_posts")
      .select(
        "id, enrichment_poc_name, org, enrichment_company_domain, enrichment_poc_linkedin_link",
      )
      .or("and(status.neq.1A,status.neq.5A),status.is.null")
      .eq("is_verified_lead", true)
      .not("enrichment_poc_name", "is", null)
      .neq("enrichment_poc_name", "not found")
      .not("org", "is", null)
      .is("enrichment_email", null)
      .or("email_finder_is_processed.is.null,email_finder_is_processed.eq.false")
      .order("id", { ascending: true })
      .limit(limit);

    if (error) {
      summary.errors.push(`select failed: ${error.message}`);
      return summary;
    }
    const candidates = (rows ?? []) as Row[];
    summary.considered = candidates.length;
    if (candidates.length === 0) return summary;

    let prospeoCreditsExhausted = false;

    for (const row of candidates) {
      const org = (row.org ?? "").trim();
      const fullName = (row.enrichment_poc_name ?? "").trim();
      if (!org || !fullName) continue;
      const parts = fullName.split(/\s+/);
      const first = parts[0];
      const last = parts.slice(1).join(" ") || parts[0];

      // 1) Domain resolution (only if we don't have one yet).
      let domain = row.enrichment_company_domain;
      if (domain === null) {
        const resolved = await resolveDomain(org);
        await sleep(500);
        if (resolved === "transient") {
          // leave null; try again a future run
        } else if (resolved) {
          domain = resolved;
          summary.domains_resolved++;
          await supabase
            .from("linkedin_posts")
            .update({ enrichment_company_domain: domain })
            .eq("id", row.id);
        } else {
          domain = "unresolved";
          summary.domains_unresolved++;
          await supabase
            .from("linkedin_posts")
            .update({ enrichment_company_domain: "unresolved" })
            .eq("id", row.id);
        }
      }

      // 2) Hunter first.
      let email: string | null = null;
      let source: string | null = null;
      let outcome: Outcome = "retry";

      const h = await tryHunter(org, first, last);
      await sleep(1000);
      if (h.email) {
        email = h.email;
        source = "hunter";
        outcome = "email";
      } else {
        // 3) Prospeo fallback.
        if (prospeoCreditsExhausted) {
          outcome = "retry";
        } else {
          const p = await tryProspeo(org, first, last, domain, row.enrichment_poc_linkedin_link);
          await sleep(2000);
          if (p.creditsExhausted) {
            prospeoCreditsExhausted = true;
            summary.prospeo_credits_exhausted = true;
          }
          if (p.email) {
            email = p.email;
            source = "prospeo";
            outcome = "email";
          } else if (p.blocked || p.creditsExhausted) {
            outcome = "retry"; // no definitive answer -> keep retryable
          } else {
            outcome = "nomatch"; // clean no-match from the fallback
          }
        }
      }

      // 4) Write back (guard against overwriting an email set meanwhile).
      if (outcome === "email" && email) {
        const { error: upErr } = await supabase
          .from("linkedin_posts")
          .update({
            enrichment_email: email,
            enrichment_email_source: source,
            email_finder_is_processed: true,
          })
          .eq("id", row.id)
          .is("enrichment_email", null);
        if (upErr) summary.errors.push(`update ${row.id}: ${upErr.message}`);
        else if (source === "hunter") summary.hunter_found++;
        else summary.prospeo_found++;
      } else if (outcome === "nomatch") {
        const { error: upErr } = await supabase
          .from("linkedin_posts")
          .update({ email_finder_is_processed: true })
          .eq("id", row.id)
          .is("enrichment_email", null);
        if (upErr) summary.errors.push(`update ${row.id}: ${upErr.message}`);
        else summary.no_match++;
      } else {
        summary.retryable++;
      }
    }

    return summary;
  } finally {
    // Always fire the downstream n8n webhook at the very end of the run.
    summary.webhook_error = await callCompletionWebhook();
    console.log(
      "linkedin_comments_poc_enrichment summary:",
      JSON.stringify(summary),
    );
  }
}

Deno.serve(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const limitParam = params.get("limit");
  let limit = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  const sync = params.get("sync") === "1" || params.get("sync") === "true";

  if (sync) {
    const summary = await run(limit);
    return json({ mode: "sync", ...summary });
  }

  const work = run(limit).catch((e) =>
    console.error("run failed:", e instanceof Error ? e.message : String(e))
  );
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  return json({ mode: "async", status: "accepted", limit }, 202);
});
