#!/usr/bin/env node
// toolkit-mcp — MCP server bridge to Serve Electric's toolkit-api.
// Runs on the user's Windows host (outside Claude Desktop's Cowork sandbox)
// so HTTPS calls to toolkit.serveelectric.com go over the user's native network,
// bypassing Anthropic's outbound proxy domain allowlist.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.TOOLKIT_API_URL || "https://toolkit.serveelectric.com").replace(/\/+$/, "");
const CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID;
const CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;
const REQUEST_TIMEOUT_MS = Number(process.env.TOOLKIT_TIMEOUT_MS || 120000);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("toolkit-mcp: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set in env.");
  process.exit(1);
}

async function apiRequest(method, path, query) {
  let url = `${BASE_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") params.append(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res, text;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "CF-Access-Client-Id": CLIENT_ID,
        "CF-Access-Client-Secret": CLIENT_SECRET,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    clearTimeout(timer);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "fetch failed",
          message: err.message,
          name: err.name,
          url,
          method,
        }, null, 2),
      }],
      isError: true,
    };
  }
  clearTimeout(timer);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: `HTTP ${res.status} ${res.statusText}`,
          url,
          method,
          body,
        }, null, 2),
      }],
      isError: true,
    };
  }

  return {
    content: [{
      type: "text",
      text: typeof body === "string" ? body : JSON.stringify(body, null, 2),
    }],
  };
}

const SERVER_INSTRUCTIONS = `Bridge to Serve Electric's centralized toolkit-api (Intacct/GL data).

ROUTING — cached vs. live:

CACHED (fast, includes only CLOSED months — the current unclosed month is NOT in the cache):
  - dashboard_get   → 12MMA P&L, BS, CF, per-branch rollups. Preferred for revenue / GM% / OpEx / cash-flow / branch-scorecard questions.
  - cache_raw       → raw GLACCOUNTBALANCE records for account-level drill-down beyond what dashboard_get exposes.
  - cache_info      → freshness metadata. Call this BEFORE dashboard_get / cache_raw — but read the UX note below before judging "stale".
  - cache_refresh_start + cache_refresh_status → force a fresh Intacct pull. Rarely needed — the toolkit auto-refreshes nightly at 02:00 NAS local time.

LIVE Intacct queries (slower, but capture activity in the unclosed current month):
  - ap_open   → open AP bills for a vendor (substring match). ~20–60s.
  - ap_aging  → full AP aging by bucket and vendor. ~45–90s.
  - ar_open   → open AR invoices for a customer (substring match). ~20–60s.
  - ar_aging  → full AR aging by bucket and customer. ~45–90s.

For routine analytical questions (P&L, GM%, branch rollups, 12MMA), prefer dashboard_get over reading local _shared/source-data Excel files — the cache IS the canonical view.

Auth (CF Access service token) is injected automatically from env vars; you do not need to handle it.

==================================================================
DATA INTEGRITY RULE — unclosed-period requests (READ THIS)
==================================================================
The current calendar month is UNCLOSED until month-end + close. The dashboard cache excludes unclosed periods entirely. If the user asks for P&L, gross margin, job costing, branch scorecard, cash flow, or any analysis whose natural date range would include the current unclosed month — for example "P&L through today", "April so far", "QTD with current month", "current job profitability" — you MUST stop before answering and ask:

  "Your request would include the current unclosed month, which has interim numbers that will still move and aren't reflected in the cached dashboard. Two options:
   (a) Use the most recent CLOSED month only — [name the month] — recommended for data integrity.
   (b) Combine cached closed-month data with live current-month figures — possible for AP via ap_open/ap_aging and AR via ar_open/ar_aging, but P&L / job costing have no live source and can't be reliably computed mid-close.
   Which would you like?"

Default to (a). Do not silently produce a number that mixes closed-cache data with current-month estimates — that's a data-integrity failure.

==================================================================
UX NOTE — cache_info "stale" appearance
==================================================================
cache_info.fetched_at reflects the last raw Intacct API pull, NOT the last dashboard recompute. Production currently runs with SKIP_POST_CLOSE_REFRESH=1 (a workaround for NAS DNS flakiness on Intacct's CDN). Under that flag, fetched_at advances ONLY when a brand-new closed period is added (e.g., when April closes in early May), not on every nightly run. The dashboard JSON itself is recomputed nightly from the existing raw cache, so closed-period numbers stay correct.

Translation: a "stale-looking" fetched_at — even weeks old — is EXPECTED. Closed-period data is still right. If a user asks "is this fresh?" or "why does it say it was fetched [date]?", explain this calmly. Don't alarm them. Don't recommend cache_refresh_start as a fix — under SKIP_POST_CLOSE_REFRESH=1 it won't move fetched_at either.`;

const server = new McpServer(
  { name: "toolkit-mcp", version: "0.2.0" },
  { instructions: SERVER_INSTRUCTIONS }
);

server.tool(
  "toolkit_status",
  "Health check for toolkit-api: service status, version, uptime, config presence, scheduler state. Use to verify connectivity if other calls fail.",
  {},
  async () => apiRequest("GET", "/api/status")
);

server.tool(
  "toolkit_version",
  "Returns toolkit-api version and git SHA.",
  {},
  async () => apiRequest("GET", "/api/version")
);

server.tool(
  "cache_info",
  "Cache metadata — last raw-API-pull timestamp, periods covered, cache size. Call before dashboard_get / cache_raw. IMPORTANT UX: under the current production config (SKIP_POST_CLOSE_REFRESH=1, set to bypass a known NAS DNS flake on Intacct's CDN), fetched_at only advances when a brand-new closed period gets added — NOT on every nightly run. A 'stale-looking' fetched_at is expected; closed-period data is still correct. Don't alarm the user; explain calmly.",
  {},
  async () => apiRequest("GET", "/api/cache/info")
);

server.tool(
  "dashboard_get",
  "Computed 12MMA dashboard JSON — P&L, Balance Sheet, Cash Flow, per-branch rollups, 12-month moving averages. Returns ONLY CLOSED MONTHS; the current unclosed month is NOT here. BEFORE calling this for any analysis whose natural range would include the current month, STOP and ask the user whether to constrain to the most recent closed month — see DATA INTEGRITY RULE in server instructions. Preferred path for closed-period revenue / GM% / OpEx / branch scorecard / cash-flow questions. Large response.",
  {},
  async () => apiRequest("GET", "/api/cache/dashboard")
);

server.tool(
  "cache_raw",
  "Raw GLACCOUNTBALANCE records across cached periods (account × location × period). Use only for account-level drill-down beyond what dashboard_get exposes. Very large — prefer dashboard_get for routine questions.",
  {},
  async () => apiRequest("GET", "/api/cache/raw")
);

server.tool(
  "cache_refresh_start",
  "Force an Intacct re-pull + dashboard recompute. Returns job_id for polling. Single-flight — returns 409 if a refresh is already running. Typical run: ~3–5 minutes. RARELY NEEDED — the nightly 02:00 auto-refresh handles it. Only use when cache_info shows stale data AND the user wants sub-daily freshness.",
  {},
  async () => apiRequest("POST", "/api/cache/refresh")
);

server.tool(
  "cache_refresh_status",
  "Poll a cache refresh job. With job_id: that specific job. Without: the latest job. Status: pending → running → success | error. Poll every 5–10s until terminal.",
  {
    job_id: z.string().optional().describe("Job ID from cache_refresh_start (omit for latest job)"),
  },
  async ({ job_id }) => {
    const path = job_id
      ? `/api/cache/refresh/${encodeURIComponent(job_id)}`
      : "/api/cache/refresh";
    return apiRequest("GET", path);
  }
);

server.tool(
  "ap_open",
  "LIVE Intacct query — open AP bills for a vendor (substring LIKE match on VENDORNAME). Default as_of=today (current snapshot, INCLUDING the unclosed current month — which is why this is live, not cached). Returns bill list with open_amount, age_days_past_due, due date, sorted by open amount desc. Vendor='Kendall' matches 'Kendall Electric' and variants. ~20–60s.",
  {
    vendor: z.string().describe("Vendor name substring, e.g. 'Kendall'"),
    as_of: z.string().optional().describe("YYYY-MM-DD (defaults to today — usually what you want)"),
  },
  async ({ vendor, as_of }) => apiRequest("GET", "/api/intacct/ap/open", { vendor, as_of })
);

server.tool(
  "ap_aging",
  "LIVE Intacct query — full AP aging bucketed (current / 1-30 / 31-60 / 61-90 / 91+) with per-vendor rollup and grand totals. Default as_of=today. ~45–90s — pulls the entire AP ledger. Use for total AP exposure, top-vendor exposure, or aged-AP analysis.",
  {
    as_of: z.string().optional().describe("YYYY-MM-DD (defaults to today)"),
  },
  async ({ as_of }) => apiRequest("GET", "/api/intacct/ap/aging", { as_of })
);

server.tool(
  "ar_open",
  "LIVE Intacct query — open AR invoices for a customer (substring LIKE match on CUSTOMERNAME). Default as_of=today (current snapshot, INCLUDING the unclosed current month — which is why this is live, not cached). Returns invoice list with open_amount, age_days_past_due, due date, sorted by open amount desc. Customer='Gray' matches 'Gray Construction' and variants. ~20–60s.",
  {
    customer: z.string().describe("Customer name substring, e.g. 'Gray'"),
    as_of: z.string().optional().describe("YYYY-MM-DD (defaults to today — usually what you want)"),
  },
  async ({ customer, as_of }) => apiRequest("GET", "/api/intacct/ar/open", { customer, as_of })
);

server.tool(
  "ar_aging",
  "LIVE Intacct query — full AR aging bucketed (current / 1-30 / 31-60 / 61-90 / 91+) with per-customer rollup and grand totals. Default as_of=today. ~45–90s — pulls the entire AR ledger. Use for total AR exposure, top-customer exposure, or aged-AR analysis.",
  {
    as_of: z.string().optional().describe("YYYY-MM-DD (defaults to today)"),
  },
  async ({ as_of }) => apiRequest("GET", "/api/intacct/ar/aging", { as_of })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`toolkit-mcp connected — base URL: ${BASE_URL}`);
