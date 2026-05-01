// Smoke test — spawns toolkit-mcp, runs MCP handshake, verifies tool registration.
// Uses fake env so tools/list doesn't make real API calls.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LIVE = !!(process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET);

const child = spawn(process.execPath, [join(__dirname, "index.js")], {
  env: {
    ...process.env,
    CF_ACCESS_CLIENT_ID: process.env.CF_ACCESS_CLIENT_ID || "smoke.test",
    CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET || "smoke",
    TOOLKIT_API_URL: process.env.TOOLKIT_API_URL || (LIVE ? "https://toolkit.serveelectric.com" : "https://example.invalid"),
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuf = "";
const responses = [];
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
  const lines = stdoutBuf.split("\n");
  stdoutBuf = lines.pop() ?? "";
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      responses.push(JSON.parse(t));
    } catch {
      console.error("non-JSON stdout:", t);
    }
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(`[mcp] ${chunk}`));

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.1" },
    },
  });
  await sleep(300);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await sleep(50);

  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await sleep(400);

  if (LIVE) {
    console.log("LIVE: calling toolkit_status against the real API...");
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "toolkit_status", arguments: {} },
    });
    await sleep(8000);
  }

  child.kill();

  const init = responses.find((r) => r.id === 1);
  const tools = responses.find((r) => r.id === 2);

  let ok = true;
  if (!init?.result) {
    console.error("FAIL: no initialize response");
    ok = false;
  } else {
    console.log("OK: initialize →", init.result.serverInfo, "instructions length:", init.result.instructions?.length ?? 0);
  }

  if (!tools?.result?.tools) {
    console.error("FAIL: no tools/list response");
    ok = false;
  } else {
    const names = tools.result.tools.map((t) => t.name).sort();
    const expected = [
      "ap_aging",
      "ap_open",
      "ap_payments",
      "ar_aging",
      "ar_open",
      "ar_payments",
      "ar_retainage",
      "cache_info",
      "cache_raw",
      "cache_refresh_start",
      "cache_refresh_status",
      "customer_dso",
      "dashboard_get",
      "gl_balance",
      "gl_detail",
      "project_budget_changes",
      "project_labor",
      "project_list",
      "project_pnl",
      "project_summary",
      "project_vendors",
      "toolkit_status",
      "toolkit_version",
      "vendor_dtp",
    ];
    console.log("OK: tools/list returned", names.length, "tools:", names.join(", "));
    const missing = expected.filter((n) => !names.includes(n));
    const extra = names.filter((n) => !expected.includes(n));
    if (missing.length) { console.error("FAIL: missing tools:", missing); ok = false; }
    if (extra.length) { console.error("WARN: unexpected tools:", extra); }
  }

  if (LIVE) {
    const live = responses.find((r) => r.id === 3);
    if (!live?.result) {
      console.error("FAIL: no tools/call response", live);
      ok = false;
    } else if (live.result.isError) {
      console.error("FAIL: live toolkit_status returned error:", live.result.content?.[0]?.text);
      ok = false;
    } else {
      const text = live.result.content?.[0]?.text ?? "";
      try {
        const status = JSON.parse(text);
        console.log(`OK: live toolkit_status → service=${status.service} version=${status.version} status=${status.status} config_present=${status.config_present}`);
        if (status.status !== "ok") { console.error("FAIL: status.status !== 'ok'"); ok = false; }
      } catch {
        console.error("FAIL: could not parse status response:", text.slice(0, 200));
        ok = false;
      }
    }
  }

  process.exit(ok ? 0 : 1);
})();
