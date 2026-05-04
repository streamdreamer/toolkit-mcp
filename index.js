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
  - ap_open      → open AP bills for a vendor (substring match). ~20–60s.
  - ap_aging     → full AP aging by bucket and vendor. ~45–90s.
  - ar_open      → open AR invoices for a customer (substring match). ~20–60s.
  - ar_aging     → full AR aging by bucket and customer. ~45–90s.
  - ap_payments  → vendor payments PAID in a date range (APPYMT). ~20–60s.
  - ar_payments  → customer receipts RECEIVED in a date range (ARPYMTHEADER). ~20–60s.

CASHFLOW ANALYTICS (computed historical metrics — slower, but mirror Dave's existing Excel model):
  - vendor_dtp    → historical days-to-pay per vendor (avg/median over last N months of paid bills). ~60–120s.
  - customer_dso  → customer-specific days-sales-outstanding (avg/median over last N months of paid invoices). ~60–120s.
  These mirror the "AP Detail" and "AR Collection Detail" tabs in Serve Electric Cash Flow Forecast 2026.xlsx.
  Use lookback_months=15 by default (matches the production model). Customers/vendors with <3 paid samples
  are excluded by default to reduce noise.

GL DRILL-DOWN (transaction-level):
  - gl_detail → transaction-level GLDETAIL rows for specified accounts in a date range. REQUIRED: accounts (list of account numbers), start, end (YYYY-MM-DD). OPTIONAL: type=both|debits|credits, vendor/customer/project/location for sub-drill. Caps at 50K records — narrow query if response shows truncated=true. Use for credit-card payment tracking, special-account analysis, ad-hoc GL drill-down. ~30–90s depending on result size.

GL BALANCES (month-end snapshots — cache-backed, sub-second):
  - gl_balance → OPENBAL / TOTDEBIT / TOTCREDIT / ENDBAL per (account, period) from the daily-refreshed GLACCOUNTBALANCE cache. Sub-second filter, no live API hit. Sums across locations by default; pass location= to drill into a single branch. ACCRUAL book only (cache is accrual-hardcoded). 13 trailing-month periods always available. Use for cash account balances (10010/10011/10015), LOC balance (23030), AR balance (12010), AP balance (20010), or ANY month-end account-balance question. Reconciles penny-perfect to the trial balance for closed periods. Prefer this over gl_detail when the user wants a balance, not transactions.

AR RETAINAGE (separate dimension from regular AR aging):
  - ar_retainage → open retainage outstanding by project and customer (GC). Mirrors the "Retainage Release Schedule" tab in Serve Electric Cash Flow Forecast 2026.xlsx. Use this for cash-flow forecasting because retainage has different release timing than regular AR (tied to project completion / GC release schedule, not invoice age). When asked about "open AR" or "AR aging", consider whether the user wants retainage included or shown separately — for cash-flow purposes they usually want it separate. ~45–90s.

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

Translation: a "stale-looking" fetched_at — even weeks old — is EXPECTED. Closed-period data is still right. If a user asks "is this fresh?" or "why does it say it was fetched [date]?", explain this calmly. Don't alarm them. Don't recommend cache_refresh_start as a fix — under SKIP_POST_CLOSE_REFRESH=1 it won't move fetched_at either.

==================================================================
SALESFORCE INTEGRATION — sf_* tools (added v0.8.0)
==================================================================
toolkit-api now exposes SF WorkOrder data via /api/sf/* routes. Bridge tools:
  - sf_status            → auth health check (no data)
  - sf_project           → full WorkOrder by Intacct_ID__c (e.g., 'W010232'), ~80 fields incl. budgets, hours, parent/child rollups, scheduling, scoring
  - sf_project_po        → PO commitment subset (V2 / Spent / Remaining) — SF-aggregated, faster than Intacct POORDER drill-down
  - sf_project_scoring   → operational scores (PR / Safety / Quality / Time / BM) + counts (DSR, work day, manpower, duration)
  - sf_active_projects   → list active portfolio with optional branch / billing_type / min_budget filters

ROUTING TIPS:
  - Cost actuals → ALWAYS Intacct (project_pnl, project_labor, project_vendors). SF mirrors Intacct via integration; never trust SF for accounting.
  - Budgets / scoring / scheduling / PO commitment → SF (sf_project, sf_project_po, sf_project_scoring). SF is canonical here.
  - Parent+child rollup metrics → use SF's pre-computed Overall_* fields (e.g., Overall_Project_Margin__c, Overall_Percent_Complete__c) — much faster than aggregating children manually.
  - Join key between systems: SF Intacct_ID__c = Intacct PROJECT.PROJECTID (the W-prefixed IDs like 'W010232').
  - For Operations users (Tim Perry — Sterling/Automation): sf_project + sf_project_po + sf_project_scoring are the daily-driver tools.`;

const server = new McpServer(
  { name: "serve-toolkit-mcp", version: "0.8.0" },
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
  "LIVE Intacct query — open AR invoices for a customer (substring LIKE match on CUSTOMERNAME). Default as_of=today (current snapshot, INCLUDING the unclosed current month — which is why this is live, not cached). Returns invoice list with open_amount, retainage_held, open_billing (= open_amount minus retainage), age_days_past_due, due date, sorted by open amount desc. Top-level also exposes total_open, total_retainage_held, and total_billing_open — use these to answer 'what's our retainage exposure on customer X' in one call. retainage_held comes straight from Intacct's TOTALRETAINED field; open_billing is the portion expected via normal AR collection. Customer='Gray' matches 'Gray Construction' and variants. ~20–60s.",
  {
    customer: z.string().describe("Customer name substring, e.g. 'Gray'"),
    as_of: z.string().optional().describe("YYYY-MM-DD (defaults to today — usually what you want)"),
  },
  async ({ customer, as_of }) => apiRequest("GET", "/api/intacct/ar/open", { customer, as_of })
);

server.tool(
  "ar_aging",
  "LIVE Intacct query — full AR aging bucketed (current / 1-30 / 31-60 / 61-90 / 91+) with a SEPARATE retainage column for contractually-held amounts that are NOT aged like delinquent AR. Per-customer rollup and grand totals. Each customer row and bucket_totals expose 6 keys: current, 1_30, 31_60, 61_90, 91_plus, retainage. Top-level exposes total_open, total_retainage_held, total_billing_open. Default as_of=today. ~45–90s — pulls the entire AR ledger. Use for total AR exposure, top-customer exposure, aged-AR analysis, or retainage-vs-collectible breakdown.",
  {
    as_of: z.string().optional().describe("YYYY-MM-DD (defaults to today)"),
  },
  async ({ as_of }) => apiRequest("GET", "/api/intacct/ar/aging", { as_of })
);

server.tool(
  "ap_payments",
  "LIVE Intacct query — vendor payments (APPYMT) PAID in a date range. Returns paid amounts with date, payment method, vendor. Vendor filter optional (substring LIKE match). Date range required (YYYY-MM-DD). Use for cash-out analysis, vendor payment history, or weekly cash-flow actuals. ~20–60s.",
  {
    start: z.string().describe("Start date YYYY-MM-DD (required)"),
    end: z.string().describe("End date YYYY-MM-DD (required)"),
    vendor: z.string().optional().describe("Vendor name substring (omit for all vendors in range)"),
  },
  async ({ start, end, vendor }) => apiRequest("GET", "/api/intacct/ap/payments", { start, end, vendor })
);

server.tool(
  "ar_payments",
  "LIVE Intacct query — customer receipts (ARPYMTHEADER) RECEIVED in a date range. Returns received amounts with date, customer, payment method. Customer filter optional. Date range required (YYYY-MM-DD). Use for cash-in analysis, customer collection history, or weekly cash-flow actuals. ~20–60s.",
  {
    start: z.string().describe("Start date YYYY-MM-DD (required)"),
    end: z.string().describe("End date YYYY-MM-DD (required)"),
    customer: z.string().optional().describe("Customer name substring (omit for all customers in range)"),
  },
  async ({ start, end, customer }) => apiRequest("GET", "/api/intacct/ar/payments", { start, end, customer })
);

server.tool(
  "vendor_dtp",
  "Historical days-to-pay per vendor. Pulls APBILL records paid in the last N months and computes avg/median/min/max days from posted to paid, grouped by vendor. Mirrors the 'Hist DTP (days)' column in Dave's AP Detail tab of Serve Electric Cash Flow Forecast 2026.xlsx. Default lookback=15 months (matches existing model). Vendors with <3 paid bills excluded by default. Use for cash-out timing forecasts, vendor payment behavior analysis. ~60–120s (full AP query).",
  {
    lookback_months: z.number().optional().describe("Months of payment history to analyze (default 15)"),
    min_samples: z.number().optional().describe("Minimum paid bills per vendor to include (default 3)"),
  },
  async ({ lookback_months, min_samples }) => apiRequest("GET", "/api/cashflow/vendor-dtp", { lookback_months, min_samples })
);

server.tool(
  "customer_dso",
  "Customer-specific days-sales-outstanding (DSO). Pulls ARINVOICE records paid in the last N months and computes avg/median/min/max days from posted to paid, grouped by customer. Mirrors the 'Customer DSO' calculation in Dave's AR Collection Detail tab of Serve Electric Cash Flow Forecast 2026.xlsx. Default lookback=15 months (matches existing model). Customers with <3 paid invoices excluded by default. Use for AR collection forecasting, customer payment behavior, expected pay date per invoice (= invoice_date + customer_DSO). ~60–120s.",
  {
    lookback_months: z.number().optional().describe("Months of payment history to analyze (default 15)"),
    min_samples: z.number().optional().describe("Minimum paid invoices per customer to include (default 3)"),
  },
  async ({ lookback_months, min_samples }) => apiRequest("GET", "/api/cashflow/customer-dso", { lookback_months, min_samples })
);

server.tool(
  "ar_retainage",
  "Open retainage outstanding by project and customer (GC). Mirrors the 'Retainage Release Schedule' tab in Serve Electric Cash Flow Forecast 2026.xlsx. Pulls all open ARINVOICE records, filters for ones with retainage held back (and not yet released), groups by project + customer (often the GC). Returns: total_retainage_outstanding, project rollup with customer names + invoice count + total per project, customer rollup, plus top 200 invoices by retainage_open. Default as_of=today. Use for cash-flow forecasting since retainage has different release timing than regular AR (tied to project completion, not invoice age). ~45–90s — pulls full AR ledger then filters. When the user asks 'what's our open AR' or 'AR aging', consider whether they want retainage included or shown separately — for cash-flow purposes they usually want it separate.",
  {
    as_of: z.string().optional().describe("YYYY-MM-DD (defaults to today)"),
  },
  async ({ as_of }) => apiRequest("GET", "/api/intacct/ar/retainage", { as_of })
);

server.tool(
  "gl_balance",
  "CACHED month-end GL account balances — sub-second filter over the daily-refreshed GLACCOUNTBALANCE cache. Returns OPENBAL, TOTDEBIT, TOTCREDIT, ENDBAL per (account, period). REQUIRED: accounts (list of account numbers like ['10010','10011','10015']). OPTIONAL: periods (list of Intacct period names like ['Month Ended February 2026']; if omitted, returns all 13 cached trailing-month periods), location (LOCATIONID; if omitted, sums across all locations), book (ACCRUAL only — cache is accrual-hardcoded). The response also includes available_periods and fetched_at so you can see cache freshness. Use for cash balance reconciliation (e.g., 10010 Checking), LOC balance (23030), AR balance for borrowing-base (12010), AP balance (20010), or ANY 'what's the balance of GL X at month-end Y' question. Reconciles penny-perfect to the trial balance for closed periods. Prefer this over gl_detail when the user wants a single balance number rather than transaction rows. ~1s.",
  {
    accounts: z.array(z.string()).describe("List of account numbers to query (e.g., ['10010','10011','10015']). Always pass as an array even for a single account."),
    periods: z.array(z.string()).optional().describe("List of Intacct period names — exact format 'Month Ended <Month> <Year>' (e.g., ['Month Ended February 2026']). Omit to return all 13 cached periods."),
    location: z.string().optional().describe("LOCATIONID exact match (e.g., '200' Sterling Heights). Omit to sum across all locations."),
    book: z.string().optional().describe("Book ID. Only 'ACCRUAL' supported (cache is accrual-only). Default 'ACCRUAL'."),
  },
  async ({ accounts, periods, location, book }) => apiRequest(
    "GET",
    "/api/intacct/gl/balance",
    {
      accounts: Array.isArray(accounts) ? accounts.join(",") : accounts,
      periods: Array.isArray(periods) ? periods.join(",") : periods,
      location,
      book,
    },
  )
);

server.tool(
  "gl_detail",
  "Transaction-level GLDETAIL rows for specified accounts in a date range. REQUIRED: accounts (list of account numbers like ['21010','21011']), start, end (YYYY-MM-DD). OPTIONAL: type=both|debits|credits (default both), vendor / customer / project / location for sub-drill. Returns each transaction with date, debit/credit amount, description, document, vendor/customer/project/location context. Caps at 50K records — if response shows truncated=true, narrow your query (smaller date range or fewer accounts). Use for credit-card payment tracking (e.g., accounts 21010-21203), special-account analysis, drilling into a specific vendor's GL activity, or ad-hoc account-level investigation. ~30–90s.",
  {
    accounts: z.array(z.string()).describe("List of account numbers to query (e.g., ['21010','21011','21012'])"),
    start: z.string().describe("Start date YYYY-MM-DD (required)"),
    end: z.string().describe("End date YYYY-MM-DD (required)"),
    type: z.enum(["both", "debits", "credits"]).optional().describe("Filter to debit-only, credit-only, or both (default both)"),
    vendor: z.string().optional().describe("VENDORID exact match (e.g., 'V0743')"),
    customer: z.string().optional().describe("CUSTOMERID exact match"),
    project: z.string().optional().describe("PROJECTID exact match"),
    location: z.string().optional().describe("LOCATIONID exact match (e.g., '200' for Sterling Heights)"),
  },
  async ({ accounts, start, end, type, vendor, customer, project, location }) => apiRequest(
    "GET",
    "/api/intacct/gl/detail",
    {
      accounts: Array.isArray(accounts) ? accounts.join(",") : accounts,
      start, end, type, vendor, customer, project, location,
    },
  )
);

// === v0.6.0 — v1.4 Job Costing endpoints ===

server.tool(
  "project_list",
  "List active projects with default Fixed Fee + budgeted revenue >= $50K + Active filter (the controller's WIP focus). Cached 1h server-side. Reconciles to Dave's 'All WIP Jobs' BI export — 81 jobs / ~$40M total contract value. Filters: branch (LOCATIONID '200'-'800'), billing_type ('Fixed Fee' default; 'T&M', 'Cost plus', or empty for all), min_budget (default 50000), status (default 'Active'; 'all' for closed too), parents_only (default true — children rolled up; false to see each child as its own row), pm (substring match on PM name), include_closed (default false). Returns project header data: project_id, name, billing_type, branch, customer, PM, BM, contract_value, budgeted_cost, budgeted/actual hours, child_count, sf_workorder_id, schedule dates. ~35s cold call, sub-second cached. Use this as the first call when the user asks for the active job book or wants to drill into a specific job.",
  {
    branch: z.string().optional().describe("LOCATIONID exact match: '200' Sterling Heights, '300' Plymouth, '400' Grand Rapids, '500' Automation, '600' Travel, '700' TPS, '800' Tampa"),
    billing_type: z.string().optional().describe("Default 'Fixed Fee'. Other values: 'T&M', 'Cost plus', etc. Pass empty string or 'all' for every type."),
    min_budget: z.number().optional().describe("Minimum BUDGETAMOUNT (contract revenue). Default 50000."),
    status: z.string().optional().describe("Default 'Active'. Pass 'all' to include closed/inactive."),
    parents_only: z.boolean().optional().describe("Default true (root jobs only — children rolled up). False shows each child WO as its own row."),
    pm: z.string().optional().describe("Substring match on MANAGERCONTACTNAME. e.g., 'Bussott'."),
    include_closed: z.boolean().optional().describe("Default false. True bypasses status filter."),
  },
  async ({ branch, billing_type, min_budget, status, parents_only, pm, include_closed }) => apiRequest(
    "GET", "/api/intacct/projects",
    { branch, billing_type, min_budget, status, parents_only, pm, include_closed }
  )
);

server.tool(
  "project_summary",
  "Header view for ONE project: full record + parent+descendants rollup (via ROOTPARENTID, the multi-generation parent join in Intacct) + billed-to-date from GL credits to revenue accounts (41000+41009) + retainage. Reconciles penny-perfect to SF Overall_Billed_Amount on parent. Sub-second after first project_list call (uses same cache). Note: actual_cost and project margin are NOT in this response — call project_pnl for the GL-derived job-margin matrix. Use this for the project drill-down landing page (header card before showing the P&L).",
  {
    project_id: z.string().describe("Intacct PROJECTID, e.g., 'W010232'. Use the W-prefixed format from project_list output."),
  },
  async ({ project_id }) => apiRequest("GET", `/api/intacct/projects/${encodeURIComponent(project_id)}/summary`, {})
);

server.tool(
  "project_pnl",
  "Parent + children Job Margin matrix for ONE project — mirrors Intacct's 'Job Margin Report' layout. Rows: Job Revenue (41000 Revenue, 49000 Allocation In, 49005 Allocation Out, Total) → Cost of Sales (Material/Labor/Sub/Travel/Equipment/Compliance/Tooling/Total) → Total Job Margin → Job Margin %. Columns: parent | each child | 'All' (parent + descendants total). Includes inter-branch allocations — this is the GAAP/branch-attribution view, NOT the SF Overall_Project_Margin (which excludes allocations). Reconciles within 0.5% to Dave's saved Job Margin Report xlsx for W010232 (Job Margin % = -17.95% vs xlsx -18%). Performance: 45-70s for jobs with 50+ children, ~30s for smaller. ~13K GL rows pulled per call.",
  {
    project_id: z.string().describe("Intacct PROJECTID (e.g., 'W010232'). Loops over parent + all descendants."),
  },
  async ({ project_id }) => apiRequest("GET", `/api/intacct/projects/${encodeURIComponent(project_id)}/pnl`, {})
);

server.tool(
  "project_labor",
  "Per-employee + per-week labor breakdown for ONE project (parent + descendants). Pulls TIMESHEETENTRY filtered by PROJECTID OR-list. Returns totals (hours, cost, billable/non-billable, avg rate, employee count, week count) plus by_employee (sorted by cost desc, with avg rate per person) and by_week (sorted by date, with employee count). Cost is UNBURDENED (raw payroll) — burdened cost is in project_pnl 'Labor Costs' row. Use for crew-size trends, identifying who's working on a job, week-over-week labor burn rate. ~50s for big jobs (~7K timesheet entries).",
  {
    project_id: z.string().describe("Intacct PROJECTID, e.g., 'W010232'."),
    start: z.string().optional().describe("YYYY-MM-DD, optional. Filter to ENTRYDATE >= start."),
    end: z.string().optional().describe("YYYY-MM-DD, optional. Filter to ENTRYDATE <= end."),
  },
  async ({ project_id, start, end }) => apiRequest("GET", `/api/intacct/projects/${encodeURIComponent(project_id)}/labor`, { start, end })
);

server.tool(
  "project_vendors",
  "Top suppliers on ONE project — GLDETAIL on direct-cost accounts grouped by vendor (matches project_pnl Cost of Sales basis). Returns each vendor with total_spend, by_category breakdown (Material/Labor/Sub/Travel/Equipment/Compliance/Tooling), transaction_count, last_transaction_date. Sorted by total_spend desc. Reconciles to project_pnl Cost of Sales total (excluding labor since labor mostly posts under employees, not vendors). Use for top-suppliers analysis, vendor concentration risk, identifying who's burning the cost budget. Open PO commitment (ordered − received) NOT included — POORDER access not yet granted to dsmith2; once granted, a project_po endpoint will layer that view. ~60s.",
  {
    project_id: z.string().describe("Intacct PROJECTID, e.g., 'W010232'."),
  },
  async ({ project_id }) => apiRequest("GET", `/api/intacct/projects/${encodeURIComponent(project_id)}/vendors`, {})
);

server.tool(
  "project_budget_changes",
  "Month-over-month budget delta detection — catches CO additions, estimating revisions, and scope creep that change BUDGETAMOUNT (contract), BUDGETEDCOST, or BUDGETQTY (hours) on existing projects. Compares current PROJECT cache to a snapshot from `since` date or closest prior. Snapshots auto-save daily on first cache refresh. Returns new_projects (created since snapshot), deleted_projects (gone since snapshot), changed_projects (sorted by largest absolute delta). Each change shows {prior, current, delta, delta_pct}. Default since=30 days ago. Use weekly to surface jobs where budgets shifted between months — particularly important for Fixed Fee jobs where unauthorized scope creep destroys margin.",
  {
    since: z.string().optional().describe("YYYY-MM-DD — compares to snapshot from this date or closest prior. Default 30 days ago."),
    min_change: z.number().optional().describe("Ignore changes smaller than this absolute dollar / hour delta. Default 0.01 (any change)."),
  },
  async ({ since, min_change }) => apiRequest("GET", "/api/intacct/projects/budget-changes", { since, min_change })
);

// --- Salesforce tools (v0.8.0) ---

server.tool(
  "sf_status",
  "Salesforce auth health check — verifies toolkit-api can authenticate to Serve's Salesforce via client_credentials flow. No data pulled, just a connectivity test. Returns {ok: true, instance_url, auth_method, token_cached} on success. Useful first call when SF data feels stale or other sf_* tools error.",
  {},
  async () => apiRequest("GET", "/api/sf/status")
);

server.tool(
  "sf_project",
  "Salesforce WorkOrder full record by Intacct_ID__c (the W-prefixed ID like 'W010232'). Returns ~80 fields covering: budgets (Budgeted_Amount, Overall_BBB_Amount), billed status (Billed_Amount, Amount_left_to_Bill), hours (Budgeted_Hours, Actual_Hours, Hours_Used_Percentage), costs by category (material/labor/rental/travel/sub/tooling — both budgeted and actual), parent+child rollups (Overall_*, Children_*), scheduling (start/end dates, months_left), PO commitment (PO_Amount_V2/Spent/Remaining), scoring (PR/Safety/Quality/Time/BM), operational depth (manpower, DSR count, work day count), ETC (Left-to-Spend per category). The 'Overall_*' fields are SF's pre-computed parent+child+grandchild rollups — use these for change-order-aware reporting. SF is canonical for budgets, plan, status, scoring; Intacct (project_pnl) is canonical for cost actuals. Join key: Intacct_ID__c.",
  {
    intacct_id: z.string().describe("Intacct PROJECTID / SF Intacct_ID__c, e.g., 'W010232'."),
  },
  async ({ intacct_id }) => apiRequest("GET", `/api/sf/projects/${encodeURIComponent(intacct_id)}`, {})
);

server.tool(
  "sf_project_po",
  "Salesforce PO commitment subset for a WorkOrder. Returns PO_Amount_V2__c (committed), PO_Amount_Spent_Actual__c (paid), PO_Amount_Remaining__c (open commitment), plus Open_PO_s_Dailys__c flag. SF aggregates these on the WorkOrder header — faster than Intacct POORDER drill-down and doesn't require POORDER read permission for dsmith2. Use for cash-out forecasting (open PO commitment that will hit AP soon), checking remaining material/sub commitments on a job, or verifying PO totals match expectations.",
  {
    intacct_id: z.string().describe("Intacct PROJECTID, e.g., 'W010232'."),
  },
  async ({ intacct_id }) => apiRequest("GET", `/api/sf/projects/${encodeURIComponent(intacct_id)}/po`, {})
);

server.tool(
  "sf_project_scoring",
  "Salesforce operational scoring subset for a WorkOrder — PR Score, Safety Score, Quality Score, Time Score, Total Job Score, BM Score Entry + Comment. Plus operational depth metrics: Work Day Count, DSR Count (daily site reports), PR Count, Actual Manpower (avg crew), Actual Work Duration (days), Assigned Resources (distinct people). Plus completion: Hours_Saved_Percentage, Hours_Used_Percentage, Overall_Percent_Complete. Use for performance reviews, branch comparison on score-based metrics, identifying jobs at risk operationally before financial impact shows up.",
  {
    intacct_id: z.string().describe("Intacct PROJECTID, e.g., 'W010232'."),
  },
  async ({ intacct_id }) => apiRequest("GET", `/api/sf/projects/${encodeURIComponent(intacct_id)}/scoring`, {})
);

server.tool(
  "sf_active_projects",
  "List active Salesforce WorkOrders with optional filters. Active status set: 'Approved/Won', 'On Hold', 'Waiting', 'To Schedule', 'On-Site/Scheduled', 'Work Complete', 'PM Approval', 'BM Approval', 'Active', 'Waiting to be Invoiced' (excludes Final Status / Closed). Optional filters: branch (e.g., '200'), billing_type (e.g., 'Fixed Fee'), min_budget (e.g., 50000 to match the Fixed Fee + ≥$50K convention). Returns total_budgeted_amount + total_billed_amount across the filtered set, plus per-WO field set covering ID/branch/status/billing/budgets/billed/percent-complete/margin. Sorted by Budgeted_Amount__c desc. Default limit 500, max 2000.",
  {
    branch: z.string().optional().describe("Branch__c exact match (e.g., '200' for Sterling Heights, '500' for Automation)"),
    billing_type: z.string().optional().describe("Billing_Type__c exact match (e.g., 'Fixed Fee', 'T&M')"),
    min_budget: z.number().optional().describe("Minimum Budgeted_Amount__c (e.g., 50000 for the Fixed Fee + ≥$50K convention)"),
    limit: z.number().optional().describe("Max records (default 500, SF max 2000)"),
  },
  async ({ branch, billing_type, min_budget, limit }) => apiRequest(
    "GET", "/api/sf/projects/active",
    { branch, billing_type, min_budget, limit },
  )
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`serve-toolkit-mcp connected — base URL: ${BASE_URL}`);
