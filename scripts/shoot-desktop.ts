/**
 * Screenshots of the desktop UI: the real Bun desktop host and an isolated
 * daemon with a scripted model, drawn in Chromium instead of the native
 * webview. `bun scripts/shoot-desktop.ts [dir]` writes every view to dir;
 * `--readme` retakes docs/assets/demesne-{start,drive,review}.png.
 * Needs Playwright (set PLAYWRIGHT_MODULE to its path if it is not installed here).
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, resolve, extname } from "node:path";
import { fixture } from "../apps/graphics/test/fixture.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop"), graphics = join(root, "apps/graphics");
const readme = process.argv.includes("--readme");
const output = readme ? join(root, "docs/assets") : resolve(process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? "test-results/shots");
const pw = process.env.PLAYWRIGHT_MODULE ?? "playwright";
const { chromium } = await import(pw);
mkdirSync(output, { recursive: true });

// The same page prepare-desktop builds, minus the native sidecars.
const web = mkdtempSync(join(tmpdir(), "demesne-shots-web-"));
const bundle = await Bun.build({ entrypoints: [join(desktop, "frontend.ts")], outdir: web, target: "browser", splitting: true });
if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"));
writeFileSync(join(web, "ui.css"), readFileSync(join(graphics, "ui.css"), "utf8").replaceAll("node_modules/@fontsource/jetbrains-mono/files/", "vendor/fonts/"));
cpSync(join(graphics, "live.css"), join(web, "live.css"));
cpSync(join(desktop, "desktop.css"), join(web, "desktop.css"));
cpSync(join(graphics, "assets"), join(web, "assets"), { recursive: true });
mkdirSync(join(web, "vendor/fonts"), { recursive: true });
for (const weight of [400, 500]) cpSync(join(graphics, "node_modules/@fontsource/jetbrains-mono/files", `jetbrains-mono-latin-${weight}-normal.woff2`), join(web, "vendor/fonts", `jetbrains-mono-latin-${weight}-normal.woff2`));
cpSync(join(graphics, "node_modules/katex/dist"), join(web, "vendor/katex"), { recursive: true });
writeFileSync(join(web, "index.html"), readFileSync(join(desktop, "index.html"), "utf8")
  .replaceAll("node_modules/katex/dist/katex.min.css", "vendor/katex/katex.min.css")
  .replace('<script type="module" src="frontend.js">', '<script src="shim.js"></script><script type="module" src="frontend.js">'));
// window.__TAURI__ over HTTP: invoke posts to the host, events arrive by SSE.
writeFileSync(join(web, "shim.js"), `
const handlers = {};
const source = new EventSource("/events");
source.onmessage = (m) => { const { event, payload } = JSON.parse(m.data); for (const h of handlers[event] || []) h({ payload }); };
window.__TAURI__ = {
  core: { invoke: async (command, args) => {
    const r = await fetch("/invoke", { method: "POST", body: JSON.stringify(args) });
    const v = await r.json(); if (!v.ok) throw new Error(v.error); return v.value;
  } },
  event: { listen: async (event, h) => { (handlers[event] ||= []).push(h); return () => { handlers[event] = handlers[event].filter(x => x !== h); }; } },
};`);

const prompt = "Make the greeting configurable and check it";
// A fixed, readable project path for the published images.
const demoRoot = join(tmpdir(), "demesne-demo");
if (readme) rmSync(demoRoot, { recursive: true, force: true });
let round = 0;
const f = await fixture({
  providerId: "test", modelId: "qwen3.8-27b", contextCapacity: 262144,
  async listModels() { return [{ id: "qwen3.8-27b", provider: "test", contextWindow: 262144 }, { id: "llama4-scout", provider: "test", contextWindow: 131072 }]; },
  async *stream(messages, tools) {
    if (tools?.some(tool => tool.name === "propose_next")) {
      const { signals } = JSON.parse(String(messages.at(-1)?.content)) as { signals: { id: string }[] };
      const ids = signals.map(signal => signal.id);
      const proposals = [
        { kind: "fix", title: "Handle an empty name in greet()", why: "greet('') returns 'Hello, !' and the TODO next to it says so.", evidence: ids.slice(0, 1), minutes: 15, coders: 1, confidence: "high", value: 4 },
        { kind: "tidy", title: "Move the greeting text into config", why: "The string is duplicated in two files.", evidence: ids.slice(0, 2), minutes: 25, coders: 1, confidence: "medium", value: 3 },
        { kind: "investigate", title: "Find why the check is slow on CI", why: "The last runs took over a minute for one file.", evidence: ids.slice(-1), minutes: 40, coders: 1, confidence: "low", value: 3 },
      ];
      yield { type: "tool_call_delta", index: 0, idDelta: "next-1", nameDelta: "propose_next", argumentsDelta: JSON.stringify({ proposals }) };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    const user = messages.findLast(message => message.role === "user")?.content;
    // A proposal run (in its own worktree): one edit, then done.
    if (String(user).includes("Handle an empty name in greet()")) {
      if (!messages.some(message => message.role === "tool")) {
        yield { type: "tool_call_delta", index: 0, idDelta: "fix-1", nameDelta: "edit_file", argumentsDelta: JSON.stringify({ path: "hello.ts", edits: [{ oldText: "`${greeting}, ${name}!`", newText: "name ? `${greeting}, ${name}!` : `${greeting}!`" }] }) };
        yield { type: "finish", reason: "tool_calls" };
      } else { yield { type: "text_delta", delta: "greet('') now returns 'Hello!'." }; yield { type: "finish", reason: "stop" }; }
      return;
    }
    if (user !== prompt) { yield { type: "text_delta", delta: "Ready." }; yield { type: "finish", reason: "stop" }; return; }
    const operation = [
      { name: "edit_file", input: { path: "hello.ts", edits: [{ oldText: "export const greeting = 'Hello';", newText: "export const greeting = process.env.GREETING ?? 'Hello';" }] } },
      { name: "run_command", input: { argv: [process.execPath, "run", "check"] } },
    ][round++];
    if (operation) {
      yield { type: "tool_call_delta", index: 0, idDelta: `op-${round}`, nameDelta: operation.name, argumentsDelta: JSON.stringify(operation.input) };
      yield { type: "finish", reason: "tool_calls" };
    } else {
      yield { type: "text_delta", delta: "The greeting now reads `GREETING` from the environment and falls back to `Hello`.\n\n- Updated `hello.ts`.\n- `bun run check` passed.\n" };
      yield { type: "finish", reason: "stop" };
    }
  },
}, readme ? { root: demoRoot, workspaceName: "greeter" } : {});
writeFileSync(join(f.workspace, "hello.ts"), "export const greeting = 'Hello';\n// TODO: greet('') returns 'Hello, !'\nexport const greet = (name: string) => `${greeting}, ${name}!`;\n");
writeFileSync(join(f.workspace, "package.json"), JSON.stringify({ name: "hello", scripts: { check: "bun check.ts" } }));
mkdirSync(join(f.workspace, ".demesne/workflows"), { recursive: true });
writeFileSync(join(f.workspace, ".demesne/workflows/fix-bug.md"), "# Fix a bug\n\nReproduce, fix, prove it.\n\n## Reproduce\nWrite a failing test.\ncheck: bun check.ts\nexpect: fail\n\n## Fix\nMake the smallest change.\ncheck: bun check.ts\n\n## Tidy\nRemove dead code.\n");
writeFileSync(join(f.workspace, "check.ts"), "import {greet} from './hello.ts';if(!greet('a').includes('a'))throw new Error('bad');console.log('CHECK_PASSED');\n");
const git = (...values: string[]) => execFileSync("git", ["-C", f.workspace, ...values], { stdio: "pipe" });
git("init", "-q"); git("add", ".");
git("-c", "user.name=Shots", "-c", "user.email=shots@example.com", "commit", "-qm", "Baseline");

const host = Bun.spawn([process.execPath, join(desktop, "host.ts"), `--workspace=${f.workspace}`, `--server=${f.server.url}`], {
  env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") }, stdin: "pipe", stdout: "pipe", stderr: "inherit",
});
let nextId = 1;
const pending = new Map<number, (value: { ok: boolean; value?: unknown; error?: string }) => void>();
const streams = new Set<ReadableStreamDefaultController<string>>();
const emit = (event: string, payload: unknown) => { for (const c of streams) c.enqueue(`data: ${JSON.stringify({ event, payload })}\n\n`); };
const write = (value: unknown) => { host.stdin.write(JSON.stringify(value) + "\n"); host.stdin.flush(); };
(async () => {
  let buffer = "";
  for await (const chunk of host.stdout) {
    buffer += new TextDecoder().decode(chunk);
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (message.kind === "response") { pending.get(message.id)?.(message); pending.delete(message.id); }
      else if (message.kind === "update") emit("demesne:update", message.update);
      else if (message.kind === "command") emit("demesne:command", message.command);
      else if (message.kind === "native") write({ kind: "native-response", id: message.id, ok: true, value: null });
      else if (message.kind === "protocol-error") emit("demesne:desktop-error", { message: message.error });
    }
  }
})();
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".ttf": "font/ttf", ".woff": "font/woff" };
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/invoke") {
      const { method, args } = await request.json() as { method: string; args: Record<string, unknown> };
      if (method === "desktop-ready" || method === "quit" || method === "desktop-quit") return Response.json({ ok: true, value: null });
      const id = nextId++;
      const result = await new Promise(done => { pending.set(id, done); write({ kind: "request", id, method, args: args ?? {} }); });
      return Response.json(result);
    }
    if (url.pathname === "/events") {
      let self: ReadableStreamDefaultController<string>;
      return new Response(new ReadableStream<string>({ start(c) { self = c; streams.add(c); c.enqueue(": open\n\n"); }, cancel() { streams.delete(self); } }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    const path = join(web, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    if (!path.startsWith(web) || !existsSync(path)) return new Response("missing", { status: 404 });
    return new Response(Bun.file(path), { headers: { "content-type": types[extname(path)] ?? "application/octet-stream" } });
  },
});

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const theme = (process.env.THEME ?? "dark") as "dark" | "light";
const page = await browser.newPage({ viewport: readme ? { width: 1280, height: 800 } : { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
page.on("pageerror", (error: Error) => console.error("page:", error.message));
await page.goto(server.url.href);
await page.waitForSelector("#app:not([hidden])", { timeout: 30_000 });
await page.waitForTimeout(3000);
const shot = async (name: string) => { await page.screenshot({ path: join(output, `${name}.png`) }); console.log("shot", name); };
const panel = async (name: string) => { await page.locator(`.header-nav button[data-args*='"${name}"']`).click(); await page.waitForTimeout(1500); };
const toggle = async (selector: string, name: string) => {
  if (!(await page.locator(selector).count())) return;
  await page.locator(selector).first().click(); await page.waitForTimeout(800);
  await shot(name);
  await page.locator(selector).first().click(); await page.waitForTimeout(400);
};
const named = (scratch: string, published: string) => readme ? `demesne-${published}` : scratch;
await shot(named("01-start", "start"));
if (!readme) {
  // Run the top proposal in its worktree; the start screen then says a branch waits for review.
  await page.locator('#hero button[data-action="next-run"]').first().click();
  for (let i = 0; i < 60 && !(await page.locator('#hero button[data-action="review-open"]').count()); i++) {
    const approve = page.locator(".approval-actions button.allow").first();
    if (await approve.count() && await approve.isVisible()) await approve.click();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(800);
  await shot("01-start-review");
  if (await page.locator('#hero button[data-action="review-open"]').count()) {
    await page.locator('#hero button[data-action="review-open"]').click(); await page.waitForTimeout(800);
    await shot("01-start-review-open");
    await page.locator('#hero button[data-action="review-open"]').click();
  }
}
await page.fill("textarea", prompt); await page.keyboard.press("Enter");
for (let i = 0; i < 40; i++) {
  const approve = page.locator(".approval-actions button.allow").first();
  if (await approve.count() && await approve.isVisible()) { await approve.click(); await page.waitForTimeout(500); }
  if (await page.evaluate(() => document.body.innerText.includes("falls back to"))) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(1500);
if (readme) {
  // The finished turn, with Drive's next ideas unfolded above the composer.
  await page.locator('#briefing button[data-action="ideas-show"]').click(); await page.waitForTimeout(800);
  await shot("demesne-drive");
  await page.locator('#briefing button[data-action="ideas-show"]').click(); await page.waitForTimeout(400);
} else {
  await shot("02-turn");
  // The briefing line above the composer, each part opened, then Drive's popover.
  await toggle('#briefing button[data-action="review-open"]', "02-review-open");
  await toggle('#briefing button[data-action="ideas-show"]', "02-ideas");
  await toggle('.turn-receipt button[data-action="toggle-steps"]', "02-steps");
  await page.locator("#drive-word").click(); await page.waitForTimeout(800);
  await shot("02-drive-pop");
  await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  // The slash list: your workflows first, then what you used recently.
  await page.locator("textarea").click(); await page.keyboard.type("/"); await page.waitForTimeout(900);
  await shot("02-slash");
  await page.fill("textarea", ""); await page.keyboard.press("Escape"); await page.waitForTimeout(300);
}
for (const name of readme ? ["changes"] : ["changes", "files", "history"]) {
  await panel(name);
  await shot(named(`03-panel-${name}`, name === "changes" ? "review" : name));
  if (name === "changes" && !readme) await toggle(".review-scope-button", "03-panel-scope");
}
if (!readme) {
  // A workflow running as a Drive mission: the conversation's newest turn.
  await page.locator(".header-nav button.active").click().catch(() => {});
  await page.fill("textarea", "/fix-bug Handle an empty name in greet()"); await page.keyboard.press("Enter");
  for (let i = 0; i < 20 && !(await page.locator("#drive-turn:not([hidden])").count()); i++) await page.waitForTimeout(500);
  await page.waitForTimeout(1500);
  await shot("04-drive-live");
}
await browser.close();
host.kill(); server.stop(true); await f.close(); rmSync(web, { recursive: true, force: true });
process.exit(0);
