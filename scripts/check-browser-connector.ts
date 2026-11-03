#!/usr/bin/env bun
/** Opt-in, real Playwright MCP check. Never invokes a package installer or daemon. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { McpStdioClient } from "../apps/daemon/src/mcp.ts";
import type { McpServerConfig } from "../packages/config/src/index.ts";

type Stage = "prerequisites" | "package" | "initialize" | "discovery" | "navigate" | "snapshot" | "click" | "close" | "cleanup";
class CheckFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

// Deliberately report only categories, never raw stderr, configuration, DOM, or errors.
function classify(stage: Stage, message: string): string {
  if (/socket directory path is too long/i.test(message)) return "SOCKET_PATH_TOO_LONG";
  if (/executable doesn't exist|browser.*not found|chromium.*not installed|chromium distribution.*not found|please run.*playwright install|browser_install/i.test(message)) return "BROWSER_NOT_INSTALLED";
  if (/cannot find module|cannot find package|module_not_found|err_module_not_found|npm err|enotcached|eresolve/i.test(message)) return "PACKAGE_UNAVAILABLE";
  if (/could not start|enoent|eacces|permission denied|executable not found/i.test(message)) return "EXECUTABLE_UNAVAILABLE";
  if (/timed out|timeout/i.test(message)) return stage === "initialize" ? "INITIALIZATION_TIMEOUT" : stage === "package" ? "PACKAGE_PROBE_TIMEOUT" : "TOOL_TIMEOUT";
  if (/browserType\.launch|browser.*launch|failed to launch|target.*closed|missing dependencies|host system is missing/i.test(message)) return "BROWSER_LAUNCH_FAILED";
  return stage === "initialize" ? "INITIALIZATION_FAILED" : stage === "package" ? "PACKAGE_PROBE_FAILED" : "TOOL_FAILED";
}

function buttonRef(snapshot: string): string | undefined {
  return snapshot.split("\n").find(line => /button "Run smoke click"/.test(line))?.match(/\[ref=([^\]\s]+)\]/)?.[1];
}

const help = `Browser connector smoke check (no installation, no live daemon/config access)
  bun scripts/check-browser-connector.ts --run --cli /absolute/path/to/@playwright/mcp/cli.js
  bun scripts/check-browser-connector.ts --self-test
Options:
  --cli PATH                 Already-installed Playwright MCP JS entry point
                             (default: resolve @playwright/mcp from this checkout)
  --node PATH                Existing Node executable (default: node on PATH)
  --browser-executable PATH  Optional existing Chrome/Chromium executable
  --timeout-ms NUMBER        Per-request timeout, 1000..120000 (default: 60000)
  --run                      Required opt-in to spawn MCP/browser and loopback fixture
No npx/bunx, browser_install, remote sites, CDP attachment, or personal profiles.
Output is sanitized; see docs/browser-connector.md for failure categories.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) { console.log(help); return; }
  if (args.length === 1 && args[0] === "--self-test") {
    assert.equal(classify("initialize", "MCP request initialize timed out after 1000ms"), "INITIALIZATION_TIMEOUT");
    assert.equal(classify("initialize", "MCP request tools/list timed out after 1000ms"), "INITIALIZATION_TIMEOUT");
    assert.equal(classify("package", "Cannot find module /private/token"), "PACKAGE_UNAVAILABLE");
    assert.equal(classify("package", "ENOENT secret"), "EXECUTABLE_UNAVAILABLE");
    assert.equal(classify("navigate", "Executable doesn't exist; please run playwright install"), "BROWSER_NOT_INSTALLED");
    assert.equal(classify("navigate", "browserType.launch: Target page, context or browser has been closed"), "BROWSER_LAUNCH_FAILED");
    assert.equal(classify("navigate", "request timed out"), "TOOL_TIMEOUT");
    assert.equal(classify("initialize", "secret unknown failure"), "INITIALIZATION_FAILED");
    assert.equal(buttonRef('- button "Run smoke click" [ref=e2]'), "e2");
    assert.equal(buttonRef('- button "Other" [ref=e2]'), undefined);
    assert.equal(classify("navigate", "Socket directory path is too long (113 bytes)"), "SOCKET_PATH_TOO_LONG");
    assert.equal(classify("navigate", "Chromium distribution 'chrome' is not found"), "BROWSER_NOT_INSTALLED");
    console.log("PASS self-test: 12 classification/reference assertions; no processes launched");
    return;
  }
  const values = new Map<string, string>();
  let optIn = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--run") { optIn = true; continue; }
    if (!["--cli", "--node", "--browser-executable", "--timeout-ms"].includes(flag) || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new CheckFailure("INVALID_ARGUMENTS");
    values.set(flag, args[++i]!);
  }
  if (!optIn) throw new CheckFailure("OPT_IN_REQUIRED");
  const timeoutMs = Number(values.get("--timeout-ms") ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new CheckFailure("INVALID_TIMEOUT");
  const node = Bun.which(values.get("--node") ?? "node");
  if (!node) throw new CheckFailure("EXECUTABLE_UNAVAILABLE");
  let cli = values.get("--cli");
  if (!cli) {
    try { cli = join(dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js"); }
    catch { throw new CheckFailure("PACKAGE_UNAVAILABLE"); }
  }
  cli = resolve(cli);
  if (!existsSync(cli)) throw new CheckFailure("PACKAGE_UNAVAILABLE");
  const executable = values.get("--browser-executable");
  if (executable && !Bun.which(executable)) throw new CheckFailure("BROWSER_NOT_INSTALLED");

  // macOS's long per-user /var/folders TMPDIR can exceed Unix socket limits
  // inside Playwright MCP. mkdtemp still creates a private, unpredictable dir.
  const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "demesne-browser-smoke-"));
  let stage: Stage = "prerequisites";
  let client: McpStdioClient | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browserMayBeOpen = false;
  let closeAvailable = false;
  let failed = false;
  let interrupted = false;
  const interrupt = () => { interrupted = true; client?.stop(); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  // Retain only OS executable/browser lookup essentials, not credentials or
  // Node injection settings. Empty strings are NOT equivalent to absent vars.
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "LOCALAPPDATA", "PLAYWRIGHT_BROWSERS_PATH"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  Object.assign(env, { TMPDIR: root, TMP: root, TEMP: root, NO_COLOR: "1" });
  const pass = (detail: string) => console.log(`PASS ${stage}: ${detail}`);
  try {
    stage = "package";
    // Probe the installed entry directly; unlike npx this cannot fetch a package.
    for (const flag of ["--version", "--help"]) {
      const child = Bun.spawn([node, cli, flag], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, Math.min(timeoutMs, 15000));
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      clearTimeout(timer);
      if (expired) throw new CheckFailure("PACKAGE_PROBE_TIMEOUT");
      if (exit !== 0) throw new CheckFailure(classify(stage, stderr + stdout));
      if (flag === "--version") {
        const version = stdout.trim().match(/^(?:Version\s+)?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/)?.[1];
        pass(`installed CLI responds${version ? `; version=${version}` : ""}`);
      } else if (!["--headless", "--user-data-dir", "--output-dir", "--browser"].every(option => stdout.includes(option))) {
        throw new CheckFailure("UNSUPPORTED_CLI_FLAGS");
      }
    }
    if (interrupted) throw new CheckFailure("INTERRUPTED");
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Demesne browser smoke fixture</title><h1>Browser smoke fixture</h1><button onclick="document.querySelector('[role=status]').textContent='Smoke click confirmed'">Run smoke click</button><p role="status">Smoke click pending</p></html>`;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname !== "/fixture") return new Response("Not found", { status: 404 });
      return new Response(html, { headers: {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'",
      } });
    } });
    const config: McpServerConfig = {
      command: node, args: [cli, "--headless", "--browser", "chrome", "--user-data-dir", join(root, "profile"), "--output-dir", join(root, "output"),
        ...(executable ? ["--executable-path", resolve(executable)] : [])],
      env, timeoutMs,
    };
    let initializationFailure = "INITIALIZATION_FAILED";
    client = new McpStdioClient("browser-smoke", config, message => { initializationFailure = classify("initialize", message); });
    stage = "initialize";
    // The public client merges process.env; scope its inherited environment to
    // this standalone script's allowlist. Nothing changes in the parent/daemon.
    const inheritedEnv = process.env;
    try {
      process.env = env;
      if (!await client.start()) throw new CheckFailure(initializationFailure);
    } finally { process.env = inheritedEnv; }
    pass("real MCP initialize + tools/list completed");
    stage = "discovery";
    const tools = client.listTools();
    closeAvailable = tools.some(tool => tool.name === "browser_close");
    if (!["browser_navigate", "browser_snapshot", "browser_click", "browser_close"].every(name => tools.some(tool => tool.name === name))) throw new CheckFailure("REQUIRED_TOOLS_MISSING");
    pass(`tools=${tools.length}; navigate, snapshot, click, close present`);
    stage = "navigate";
    browserMayBeOpen = true;
    await client.callTool("browser_navigate", { url: `http://127.0.0.1:${server.port}/fixture` });
    pass("opened loopback fixture in temporary profile");
    stage = "snapshot";
    const snapshot = await client.callTool("browser_snapshot", {});
    const ref = buttonRef(snapshot);
    if (!snapshot.includes("Browser smoke fixture") || !snapshot.includes("Smoke click pending") || !ref) throw new CheckFailure("FIXTURE_SNAPSHOT_MISMATCH");
    pass("fixture heading, pending status, and button reference found");
    stage = "click";
    const click = tools.find(tool => tool.name === "browser_click")!;
    const properties = click.inputSchema.properties as Record<string, unknown> | undefined;
    const target = properties && "target" in properties ? { target: ref } : { ref };
    await client.callTool("browser_click", { element: "Run smoke click button", ...target });
    const after = await client.callTool("browser_snapshot", {});
    if (!after.includes("Smoke click confirmed") || after.includes("Smoke click pending")) throw new CheckFailure("CLICK_NOT_CONFIRMED");
    pass("DOM snapshot confirms click changed status");
    stage = "close";
    await client.callTool("browser_close", {});
    browserMayBeOpen = false;
    pass("browser_close completed");
  } catch (error) {
    failed = true;
    console.error(`FAIL ${stage}: ${interrupted ? "INTERRUPTED" : error instanceof CheckFailure ? error.code : classify(stage, error instanceof Error ? error.message : "")}`);
  } finally {
    if (browserMayBeOpen && closeAvailable && !interrupted) {
      try { await client?.callTool("browser_close", {}); }
      catch { failed = true; console.error("FAIL close: CLEANUP_CLOSE_FAILED"); }
    }
    client?.stop();
    server?.stop(true);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    stage = "cleanup";
    try {
      rmSync(root, { recursive: true, force: true });
      if (existsSync(root)) throw new CheckFailure("TEMP_REMOVE_FAILED");
      pass("MCP stop requested; fixture stopped; temporary profile/output removed");
    } catch { failed = true; console.error("FAIL cleanup: TEMP_REMOVE_FAILED"); }
  }
  process.exitCode = failed ? 1 : 0;
  if (!failed) console.log("PASS browser connector end-to-end (standalone; not active-daemon health)");
}

await main().catch(error => {
  console.error(`FAIL prerequisites: ${error instanceof CheckFailure ? error.code : "CHECK_SETUP_FAILED"}`);
  process.exitCode = 1;
});
