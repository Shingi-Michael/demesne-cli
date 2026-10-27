/** Real Electron smoke test with disposable daemon, workspace, and credentials. */
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import sharp from "sharp";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const packagedExecutable = process.argv[2];
const application = resolve("apps/desktop/build/app");
assert(existsSync(join(application, "main.cjs")), "Run bun scripts/prepare-desktop.ts first");
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
const prompt = "Desktop smoke: update hello.ts and run its check";
const followUp = "Desktop smoke: continue while the window is closed";
const aside = "Desktop smoke: a second conversation";
const asideDone = "A second conversation is here.";
const completed = "Verified the desktop change.";
const afterClose = "Daemon work completed after the window closed.";
const thinkingPrompt = "Desktop smoke: readable thinking";
const previewPrompt = "Desktop smoke: run the site";
const overlapPrompt = "Desktop smoke: edit what another agent changed";
const askPrompt = "Desktop smoke: ask me first";
const missionPushPrompt = "Desktop smoke: the mission tries to push";
const brokePrompt = "Desktop smoke: break a check";
const steerPrompt = "Desktop smoke: steer me";
const habitPrompt = "Desktop smoke: check the version again";
const steerWords = "not lexer, the bug is in parser.ts";
let releaseSteer!: () => void;
const steerGate = new Promise<void>(resolve => { releaseSteer = resolve; });
let overlapRound = 0;
// A stand-in Heartbeat daemon: Claude Code works in this project on this
// machine, Codex in the second project on a paired one.
const heartbeatSocket = join(mkdtempSync(join(tmpdir(), "hb-")), "control.sock");
const heartbeatDaemon = Bun.listen({ unix: heartbeatSocket, socket: { data(socket, chunk) {
  const request = JSON.parse(Buffer.from(chunk).toString("utf8").split("\n")[0]!) as { command?: string; as?: string };
  const reply = (body: Record<string, unknown>) => { socket.write(`${JSON.stringify(body)}\n`); socket.end(); };
  if (request.command === "status") return reply({ status: "ok", node_id: "desktop-node", active_links: [] });
  if (request.command === "agents") return reply({ status: "ok", node_id: "desktop-node", agents: [
    { agent_id: "claude@desktop-node/workspace-k3x7a", node: "desktop-node", transport: "hooks" },
    { agent_id: "codex@macbook-air/sidebar-project-q2m7c", node: "macbook-air", transport: "link" },
  ] });
  if (request.command === "read") return reply({ status: "ok", address: request.as, messages: [] });
  if (request.command === "listen") { socket.write(`${JSON.stringify({ status: "ok", agent_id: request.as })}\n`); return; }
  reply({ status: "error", error: "unknown_command" });
} } });
// A stand-in gh for the pull request on a row: `gh pr view` prints what the
// check last wrote; everything else fails, as if gh had no GitHub here.
const ghBin = mkdtempSync(join(tmpdir(), "gh-")), ghPr = join(ghBin, "pr.json");
writeFileSync(join(ghBin, "gh"), `#!/bin/sh\nif [ "$1" = pr ] && [ "$2" = view ]; then cat "${ghPr}"; exit 0; fi\nexit 1\n`, { mode: 0o755 });
process.env.PATH = `${ghBin}:${process.env.PATH}`;
const ghPullRequest = (state: "OPEN" | "MERGED") => writeFileSync(ghPr, JSON.stringify({
  number: 287, title: "Peek the folded sidebar", url: "https://github.com/demesne/fieldnote/pull/287", state, isDraft: false,
  createdAt: new Date(Date.now() - 3_600_000).toISOString(), mergedAt: state === "MERGED" ? new Date(Date.now() - 60_000).toISOString() : null, closedAt: null,
  reviews: [{ author: { login: "mike" }, state: "COMMENTED", body: "The peek opens too soon.", submittedAt: new Date(Date.now() - 600_000).toISOString() }],
  comments: [], statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", completedAt: new Date(Date.now() - 3_000_000).toISOString() }],
}));
let previewRound = 0;
let askRound = 0, missionRound = 0;
let brokeRound = 0;
// The processor itself, so the last check can let it switch models (turns
// before it run on one fixed model).
let smokeProcessor: { modelId: string; contextCapacity?: number; setModel?: (id: string) => void } | undefined;
const thinkingText = "First reasoning paragraph.\nSecond line stays readable.\n\n" + "A detailed thought with enough words to wrap across several lines. ".repeat(12) + "\n" + "long_identifier_".repeat(90);
let nextThought!: () => void, finishThought!: () => void;
const thoughtGate = new Promise<void>(resolve => { nextThought = resolve; });
const thoughtFinish = new Promise<void>(resolve => { finishThought = resolve; });
let round = 0, release: (() => void) | undefined;
let failSuggestions = false, offerIdeas = false;
// The plan's usage windows the stand-in provider reports.
let smokeLimits: import("@demesne/protocol").PlanLimits[] = [];
const gate = new Promise<void>(done => { release = done; });
const f = await fixture({
  providerId: "test", modelId: "desktop-test", contextCapacity: 262144, maxOutputTokens: 1024,
  planLimits: () => smokeLimits,
  async listModels() { smokeProcessor = this; return [{ id: "desktop-test", provider: "test", contextWindow: 262144, reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningLevel: "low" }, { id: "desktop-small", provider: "test", contextWindow: 32768 }, { id: "desktop-fast", provider: "test", contextWindow: 131072 }, { id: "desktop-wide", provider: "test", contextWindow: 1048576 }, { id: "far-away-large", provider: "other", contextWindow: 200000 }, { id: "far-away-mini", provider: "other", contextWindow: 128000 }]; },
  async *stream(messages, _tools, signal) {
    const user = messages.findLast(message => message.role === "user")?.content;
    // Proof marks: the pass pairs the smoke answer's claims with its steps; a
    // check reads hello.ts and quotes it.
    if (_tools.some(tool => tool.name === "proof_marks")) {
      const claims = typeof user === "string" && user.includes(completed)
        ? [{ text: "Check passed", step: 2, quote: "DESKTOP_CHECK_PASSED" }, { text: completed.replace(/\.$/, "") }]
        : [];
      yield { type: "tool_call_delta", index: 0, idDelta: "proof-marks", nameDelta: "proof_marks", argumentsDelta: JSON.stringify({ claims }) };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (_tools.some(tool => tool.name === "proof_verdict")) {
      if (messages.some(message => message.role === "tool")) yield { type: "tool_call_delta", index: 0, idDelta: "proof-verdict", nameDelta: "proof_verdict", argumentsDelta: JSON.stringify({ holds: true, quote: "greeting = 'after'" }) };
      else yield { type: "tool_call_delta", index: 0, idDelta: "proof-read", nameDelta: "read_file", argumentsDelta: JSON.stringify({ path: "hello.ts" }) };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (typeof user === "string" && user.startsWith("Drive report: ")) {
      yield { type: "text_delta", delta: "Noted: Drive stopped before changing anything." };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (user === missionPushPrompt) {
      // The mission's coder tries to publish, the one step that would ask.
      if (missionRound++ === 0) yield { type: "tool_call_delta", index: 0, idDelta: "mission-push", nameDelta: "run_command", argumentsDelta: JSON.stringify({ argv: ["git", "push", "origin", "HEAD"] }) };
      else yield { type: "text_delta", delta: "The push was declined; the branch waits for review." };
      yield { type: "finish", reason: missionRound === 1 ? "tool_calls" : "stop" };
      return;
    }
    if (_tools.some(tool => tool.name === "drive_ui")) {
      // Keep planning pending so the actual UI can exercise Pause/Resume/Stop.
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      signal.throwIfAborted();
      return;
    }
    if (String(messages[0]?.content).includes("planner for one software workspace")) {
      if (failSuggestions) throw new Error("Fixture suggestion service unavailable");
      // Late in the run Drive offers ideas, citing whatever signal it was given.
      const cited = offerIdeas ? (JSON.parse(String(messages.findLast(message => message.role === "user")?.content ?? "{}")).signals ?? [])[0]?.id : undefined;
      const proposals = cited ? ["Add tests for fuzzy search ranking", "Drop the unused sidebar sort helper", "Cache the file list between turns"].map((title, index) => ({
        kind: "tidy", title, why: "Fixture idea for the composer strip.", evidence: [cited], minutes: 5 + index * 3, coders: 1, confidence: "high", value: 4 - index })) : [];
      yield { type: "tool_call_delta", index: 0, idDelta: "suggestions", nameDelta: "propose_next", argumentsDelta: JSON.stringify({ proposals }) };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (messages[0]?.content?.includes("immutable coding-session checkpoints")) {
      yield { type: "text_delta", delta: JSON.stringify({ schemaVersion: 1, goal: "Continue desktop work", currentState: "Older turns summarized", constraints: [], decisions: [], files: [], validation: [], unresolved: [] }) };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (typeof user === "string" && user.startsWith("Compaction fixture")) {
      yield { type: "text_delta", delta: "Historical evidence. ".repeat(1200) };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (user === thinkingPrompt) {
      yield { type: "reasoning_delta", delta: thinkingText };
      await thoughtGate;
      if (signal.aborted) throw signal.reason;
      yield { type: "reasoning_delta", delta: "\n\nThe streamed update arrived." };
      await thoughtFinish;
      if (signal.aborted) throw signal.reason;
      yield { type: "text_delta", delta: "Thinking check complete." };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (user === followUp) {
      yield { type: "text_delta", delta: "The daemon is still working.\n\n" };
      await gate;
      if (signal.aborted) throw signal.reason;
      yield { type: "text_delta", delta: afterClose };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (user === overlapPrompt) {
      if (overlapRound === 0) {
        yield { type: "tool_call_delta", index: 0, idDelta: "overlap-read", nameDelta: "read_file", argumentsDelta: JSON.stringify({ path: "notes.ts" }) };
        yield { type: "finish", reason: "tool_calls" };
      } else if (overlapRound === 1) {
        // Claude Code saves the file between this chat's read and its edit.
        writeFileSync(join(f.workspace, "notes.ts"), "export const note = 'theirs';\n");
        utimesSync(join(f.workspace, "notes.ts"), new Date(), new Date(Date.now() + 5_000));
        yield { type: "tool_call_delta", index: 0, idDelta: "overlap-edit", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: "notes.ts", content: "export const note = 'mine';\n" }) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "I'll ask Claude Code before changing notes.ts." };
        yield { type: "finish", reason: "stop" };
      }
      overlapRound++;
      return;
    }
    if (user === brokePrompt) {
      if (brokeRound++ === 0) {
        yield { type: "tool_call_delta", index: 0, idDelta: "desktop-broke", nameDelta: "run_command", argumentsDelta: JSON.stringify({ argv: [process.execPath, "-e", "console.error('error: expected after, received before'); process.exit(1)", "check"] }) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "The check fails now." };
        yield { type: "finish", reason: "stop" };
      }
      return;
    }
    if (user === habitPrompt) {
      // The same command every time: the fourth ask knows it's a habit.
      if (messages.at(-1)?.role === "tool") yield { type: "text_delta", delta: "Version checked." };
      else yield { type: "tool_call_delta", index: 0, idDelta: `habit-${Date.now()}`, nameDelta: "run_command", argumentsDelta: JSON.stringify({ argv: [process.execPath, "--version"] }) };
      yield { type: "finish", reason: messages.at(-1)?.role === "tool" ? "stop" : "tool_calls" };
      return;
    }
    if (user === steerPrompt) {
      // Holds its first step so the window can steer it mid-flight.
      await steerGate;
      yield { type: "tool_call_delta", index: 0, idDelta: "desktop-steer", nameDelta: "read_file", argumentsDelta: JSON.stringify({ path: "notes.ts" }) };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (typeof user === "string" && user.includes(steerWords)) {
      yield { type: "text_delta", delta: "Looking in parser.ts instead." };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (user === askPrompt) {
      if (askRound++ === 0) {
        yield { type: "tool_call_delta", index: 0, idDelta: "desktop-ask", nameDelta: "ask_user", argumentsDelta: JSON.stringify({ questions: [{ question: "Which direction do you want to take the CI failure now?", reason: "The last turn ended with a plan; I need your steer before acting.", suggestions: ["Scope the test job", "Fix the typecheck", "Paste the logs first"] }] }) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Scoping the test job then." };
        yield { type: "finish", reason: "stop" };
      }
      return;
    }
    if (user === previewPrompt) {
      if (previewRound++ === 0) {
        yield { type: "tool_call_delta", index: 0, idDelta: "desktop-preview", nameDelta: "run_command", argumentsDelta: JSON.stringify({ argv: [process.execPath, "serve.ts"], background: true }) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "The site is running." };
        yield { type: "finish", reason: "stop" };
      }
      return;
    }
    if (user === aside) {
      yield { type: "text_delta", delta: asideDone };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (user !== prompt) {
      // NEXT can ask this processor for proposals independently of the coder.
      yield { type: "text_delta", delta: "{\"proposals\":[]}" };
      yield { type: "finish", reason: "stop" };
      return;
    }
    const operation = [
      { name: "edit_file", input: { path: "hello.ts", edits: [{ oldText: "'before'", newText: "'after'" }] } },
      { name: "run_command", input: { argv: [process.execPath, "run", "check"] } },
    ][round++];
    if (operation) {
      yield { type: "tool_call_delta", index: 0, idDelta: `desktop-operation-${round}`, nameDelta: operation.name, argumentsDelta: JSON.stringify(operation.input) };
      yield { type: "finish", reason: "tool_calls" };
    } else {
      yield { type: "text_delta", delta: `${completed}\n\n**Results**\n- Updated \`hello.ts\`.\n- Check passed.\n\nMath: $x^2 + y^2 = r^2$.\n\n\`\`\`typescript\nexport const greeting = 'after';\n\`\`\`\n` };
      yield { type: "finish", reason: "stop" };
    }
  },
}, { heartbeatSocket });
writeFileSync(join(f.workspace, "notes.ts"), "export const note = 'ours';\n");
writeFileSync(join(f.workspace, "hello.ts"), "export const greeting = 'before';\n");
writeFileSync(join(f.workspace, "package.json"), JSON.stringify({ scripts: { check: "bun check.ts" } }));
writeFileSync(join(f.workspace, "site.html"), '<h1>Fieldnote preview</h1>\n<button id="save">Save</button>\n');
writeFileSync(join(f.workspace, "serve.ts"), "const server = Bun.serve({ port: 0, fetch: () => new Response('<h1>Fieldnote preview</h1><button id=\"save\">Save</button>', { headers: { 'content-type': 'text/html' } }) });\nconsole.log(`  \\u001b[32mLocal:\\u001b[39m http://localhost:${server.port}/`);\n");
writeFileSync(join(f.workspace, "check.ts"), "import {readFileSync} from 'node:fs';if(!readFileSync('hello.ts','utf8').includes(\"'after'\"))throw new Error('Wrong file');console.log('DESKTOP_CHECK_PASSED');\n");
const git = (...values: string[]) => execFileSync("git", ["-C", f.workspace, ...values], { stdio: "pipe" });
git("init", "-q"); git("add", ".");
git("-c", "user.name=Desktop Test", "-c", "user.email=test@example.com", "commit", "-qm", "Fixture baseline");

let desktop: ElectronApplication | undefined, page: Page;
let log = "";
async function until<T>(check: () => Promise<T>, label: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await Bun.sleep(100);
  }
  throw new Error(`${label} did not settle: ${String(lastError ?? "condition false")}\n${log}`);
}
const evaluate = <T = unknown>(script: string, values: unknown[] = []): Promise<T> =>
  page.evaluate(({script, values}) => new Function(script).apply(null, values), {script, values});
async function click(action: string, expected: Record<string, unknown> = {}) {
  await until(async () => {
    const buttons = page.locator(`button[data-action="${action}"]`);
    for (const button of await buttons.all()) {
      const data = JSON.parse(await button.getAttribute("data-args") ?? "{}");
      if (Object.entries(expected).every(([key, value]) => data[key] === value) && await button.isVisible() && await button.isEnabled()) { await button.click(); return true; }
    }
    return false;
  }, `click ${action}`);
}
async function type(text: string) {
  // The daemon can finish a turn before the window hears of it; Enter while
  // the window still shows a running turn would queue the text instead.
  await until(() => evaluate<boolean>("return !document.querySelector('#send-label .stop-word');"), "composer idle");
  await page.locator("textarea").fill(text); await page.locator("textarea").press("Enter");
}
async function textIncludes(text: string) {
  return until(() => page.locator("body").innerText().then(body => body.includes(text)), `visible text ${text}`);
}
async function capture(name: string) {
  const bytes = await page.screenshot({ animations: "disabled" }), metadata = await sharp(bytes).metadata(), statistics = await sharp(bytes).stats();
  assert(metadata.width && metadata.width >= 900 && metadata.height && metadata.height >= 500);
  assert(statistics.channels.slice(0, 3).some(channel => channel.stdev > 5), "Nonblank Chromium rendering");
  writeFileSync(join(output, `${name}.png`), bytes);
}
async function open(workspace = false, welcome = false, extraEnv: Record<string, string> = {}) {
  desktop = await electron.launch({ ...(packagedExecutable ? { executablePath: resolve(packagedExecutable) } : {}), args: [...(packagedExecutable ? [] : [application]), `--user-data-dir=${join(f.root, "electron")}`, ...(workspace ? [`--workspace=${f.workspace}`] : []), `--server=${f.server.url}`], env: {
    ...f.env, XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache"), ...extraEnv,
  }, timeout: 30_000 });
  desktop.process().stderr?.on("data", bytes => { log = (log + String(bytes)).slice(-64 * 1024); });
  page = await desktop.firstWindow();
  page.on("pageerror", error => { log += String(error); });
  if (welcome) {
    await page.getByRole("heading", { name: "Make room for your next idea." }).waitFor();
    await capture("00-welcome");
    // Stub only the OS picker result; project opening still goes through the
    // real preload, main process, and canonical host workspace validation.
    await desktop.evaluate(({ dialog }, workspace) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    }, f.workspace);
    await page.getByRole("button", { name: "Open a project", exact: false }).click();
  }
  await until(() => evaluate<boolean>("const editor=document.querySelector('textarea');return !!editor && editor.getBoundingClientRect().width>0 && document.body.innerText.includes('Desktop Test');"), "connected desktop project", 30_000);
  assert.equal(await evaluate("return document.getElementById('sidebar-sessions')?.dataset.workspace;"), f.workspace);
  assert((await page.locator("#composer-model").innerText()).startsWith("Desktop Test"), "a model with no name reads in words, not its raw id");
  assert.equal(await page.evaluate(() => typeof (window as any).require), "undefined", "No Node in the renderer");
  assert.equal(await page.evaluate(() => typeof (window as any).process), "undefined", "No process or environment in the renderer");
  const isolation = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences());
  assert(isolation.sandbox && isolation.contextIsolation && !isolation.nodeIntegration && !isolation.webviewTag);
  if (process.platform === "linux") {
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMenuBarVisible()), false, "Linux has no visible native menu bar");
    await page.keyboard.press("Alt");
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMenuBarVisible()), false, "Alt cannot restore the Linux menu bar");
  }
  const zoom = await desktop.evaluate(({ BrowserWindow, Menu }) => {
    const item = Menu.getApplicationMenu()!.items.find(item => item.label === "View")!.submenu!.items.find(item => item.label === "Zoom In")!;
    item.click();
    return BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor();
  });
  assert.equal(zoom, 1.1, "Native zoom menu is connected");
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.find(item => item.label === "View")!.submenu!.items.find(item => item.label === "Actual Size")!.click());
}
/// After a launch: Home as Just a chat, then the chat from its project's line.
async function reopenChat(id: string) {
  await until(async () => (await page.locator("#composer-where").textContent())?.startsWith("Just a chat") ?? false, "launch lands on Home as Just a chat");
  const row = page.locator(`.sidebar-session[data-args*='${id}']`);
  if (!(await row.isVisible())) await click("project-toggle", { path: f.workspace });
  await row.click();
}
async function close() {
  if (!desktop) return;
  const closing = desktop; desktop = undefined;
  // Exercise the normal quit path, including host EOF and Drive handoff.
  await closing.close();
}
let sessionId = "";
try {
  await open(false, true);
  await capture("01-start");
  // Home: the greeting, then one paragraph of what happened (nothing yet), no map.
  await until(() => page.locator(".intro p.away").innerText().then(text => text.length > 0), "Home says what happened while you were away");
  assert.equal(await page.locator(".hero-map, .land").count(), 0, "the map is gone");
  await type(thinkingPrompt);
  const trace = page.locator(".thinking-main .thinking-content").last();
  const thinkingToggle = page.locator(".thinking-main .thinking-toggle").last();
  await trace.waitFor({ state: "visible" });
  assert.equal(await thinkingToggle.getAttribute("aria-expanded"), "true");
  assert((await trace.innerText()).includes("First reasoning paragraph."));
  const layout = await trace.evaluate(element => {
    const paragraph = element.querySelector("p")!;
    return { height: paragraph.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(paragraph).lineHeight), width: element.clientWidth, scrollWidth: element.scrollWidth };
  });
  assert(layout.height > layout.lineHeight, "Thinking preserves multiple lines");
  assert(layout.scrollWidth <= layout.width + 1, "Long thinking text wraps without horizontal overflow");
  await capture("01-thinking-expanded");
  // While it thinks, the toggle carries the cube and the shining word.
  assert((await thinkingToggle.locator(".cube-mark svg polygon").count()) >= 8, "the working cube draws its cubelets");
  assert.equal(await page.locator("#sidebar-sessions .cube-mark").count(), 0, "one cube on screen: the sidebar shows a dot");
  assert(await page.locator("#sidebar-sessions .sidebar-session-mark.working").count() > 0, "the working chat breathes a dot in the sidebar");
  assert.equal(await thinkingToggle.locator(".shine").innerText(), "Thinking");
  await until(() => page.locator("#app").getAttribute("class").then(value => value?.includes("rim-work") ?? false), "a working turn runs a light along the panel's rim");
  assert.equal(await page.locator("#desktop-toolbar .header-live.work").innerText(), "Working", "the title line says it works");
  await capture("01-thinking-cube");
  await thinkingToggle.click();
  await trace.waitFor({ state: "hidden" });
  nextThought();
  await until(() => trace.textContent().then(text => text?.includes("The streamed update arrived.")), "reasoning delta arrived while collapsed");
  assert.equal(await thinkingToggle.getAttribute("aria-expanded"), "false");
  assert(!(await trace.isVisible()), "Streaming does not reopen a manually collapsed trace");
  await thinkingToggle.click();
  await trace.waitFor({ state: "visible" });
  await textIncludes("The streamed update arrived.");
  finishThought();
  await textIncludes("Thinking check complete.");
  await click("toggle-steps");
  await trace.waitFor({ state: "visible" });
  await thinkingToggle.click();
  await trace.waitFor({ state: "hidden" });
  await thinkingToggle.click();
  await trace.waitFor({ state: "visible" });
  await click("toggle-steps");
  // Mac banners: record them in the main process, and look away from the window.
  await desktop.evaluate(({ Notification }) => { (globalThis as any).banners = []; Notification.isSupported = () => true; Notification.prototype.show = function () { (globalThis as any).banners.push({ title: this.title, body: this.body }); }; });
  await page.evaluate(() => { document.hasFocus = () => false; });
  await type(prompt);
  await until(() => evaluate<boolean>("return Array.from(document.querySelectorAll('#approval .approval-row')).some(element => element.textContent.includes(arguments[0]));", ["Edit"]), "file approval visible");
  await until(() => desktop.evaluate(() => (globalThis as any).banners as { body: string }[]).then(banners => banners.some(banner => banner.body.startsWith("Wants to edit"))), "a waiting approval sends a Mac banner");
  await page.evaluate(() => { delete (document as any).hasFocus; });
  await capture("02-file-approval");
  // New chat lands on Home as Just a chat; the where word under the
  // composer unfolds its choices in place and puts it in the project.
  await click("new-session");
  await until(async () => (await page.locator("#composer-where").textContent())?.startsWith("Just a chat") ?? false, "a new chat is Just a chat");
  assert.equal(await page.locator(".intro p.away").count(), 0, "Just a chat has no project news");
  await click("where-toggle");
  await capture("02b-where");
  await click("where-pick", { path: f.workspace });
  await until(() => page.locator(".intro p.away").isVisible(), "a new chat in the project shows the start screen");
  assert((await page.locator("#composer-where").textContent())?.startsWith("in "), "the where word names the project");
  // Home says which chat waits on you and on what; its phrase unfolds the
  // approval right there, and Allow answers it without opening the chat.
  const waitingPhrase = page.locator(".intro p.away .away-link.warn");
  await until(() => page.locator(".intro p.away").innerText().then(text => text.includes("is waiting on your yes to edit hello.ts")), "Home names the chat waiting on you", 20_000);
  await waitingPhrase.click();
  const homeApproval = page.locator(".away-fold .approval-row");
  await until(() => homeApproval.isVisible(), "the phrase unfolds the approval in place");
  assert((await homeApproval.innerText()).includes("hello.ts"), "the row names the file");
  await capture("02-home-away");
  // Pick up goes back to the last chat, with the last thing you asked there.
  assert((await page.locator(".hero-pick").innerText()).includes("Pick up"), "Pick up names the last chat");
  await homeApproval.locator('[data-action="away-permission"]', { hasText: "Allow" }).click();
  await until(() => homeApproval.count().then(count => count === 0), "Allow folds the row");
  await page.locator(".hero-pick").click();
  await until(() => evaluate<boolean>("return Array.from(document.querySelectorAll('#approval .approval-row')).some(element => element.textContent.includes(arguments[0]));", ["Run"]), "command approval visible");
  assert.equal(await page.locator("#approval .approval-row code").innerText(), "bun run check", "the row names the command by its program");
  assert((await page.locator("#approval .approval-row code").getAttribute("title"))!.includes("not sandboxed"), "where it runs is on hover");
  assert.equal(await page.locator("#approval .approval-show, #approval .approval-fold").count(), 0, "a command has nothing to unfold");
  await until(() => page.locator(".tool-row.waiting .target").innerText().then(text => text === "bun run check"), "the waiting step names the command");
  assert.equal(await page.evaluate(() => { const row = document.querySelector("#approval .approval-row")!; return row.scrollWidth <= row.clientWidth; }), true, "the row fits its width");
  await until(() => page.locator("#app").getAttribute("class").then(value => value?.includes("rim-wait") ?? false), "waiting on you holds an amber arc on the rim");
  assert.equal(await page.locator("#desktop-toolbar .header-live.wait").innerText(), "Waiting on you · run bun run check?", "the title line says what it waits for");
  await capture("02-command-approval");
  await click("permission", { decision: "allow_once" });
  await textIncludes(completed);
  assert.equal(readFileSync(join(f.workspace, "hello.ts"), "utf8"), "export const greeting = 'after';\n");
  const sessions = await f.client.listSessions();
  const completedSession = sessions.find(item => item.turns.some(turn => turn.content === prompt));
  assert(completedSession, "The desktop submitted its turn to the real daemon");
  sessionId = completedSession.id;
  assert.equal(completedSession.turns.at(-1)?.status, "completed");
  const commands = await f.client.commands(sessionId);
  assert(commands.commands.some(command => command.status === "completed" && command.exitCode === 0 && command.stdout.includes("DESKTOP_CHECK_PASSED")), "Approved command output was recorded");
  assert(await evaluate<boolean>("return !!document.querySelector('.katex') && !!document.querySelector('pre code');"), "Markdown, code and math rendered in Chromium");
  // Proof marks: the claim its check backs carries a green line; its proof
  // unfolds under the paragraph with the step's own lines, and Open the
  // step unfolds that step on the guide. The claim nothing checked is
  // dotted; Prove it reads the file and the line turns green.
  const turnId = completedSession.turns.at(-1)!.id;
  const proved = page.locator(`#turn-${turnId} .claim.proved`);
  await until(() => proved.count().then(count => count === 1), "a claim a step proved gets its green line", 20_000);
  assert.equal(await proved.innerText(), "Check passed");
  assert((await proved.getAttribute("title"))!.startsWith("Ran bun run check · step 2"), "hovering a mark names its step");
  const proofLine = page.locator(`#turn-${turnId} .proof-line`);
  assert((await proofLine.innerText()).includes("1 proved") && (await proofLine.innerText()).includes("1 not checked"), "one count line under the answer");
  await proved.click();
  const proof = page.locator(`#turn-${turnId} .proof-fold.ok`);
  await until(() => proof.isVisible(), "the proof unfolds under the paragraph");
  assert((await proof.innerText()).includes("DESKTOP_CHECK_PASSED"), "the proof quotes the step's output");
  assert.equal(await page.locator(`#turn-${turnId} .markdown > .proof-fold`).count(), 0, "the proof sits in the list item, not after the list");
  await capture("02c-proof");
  await proof.locator('[data-action="proof-step"]').click();
  await until(() => page.locator(`#turn-${turnId} .tool-row.open`).count().then(count => count === 1), "Open the step unfolds it on the guide");
  const unchecked = page.locator(`#turn-${turnId} .claim.unchecked`);
  assert.equal(await unchecked.innerText(), completed.replace(/\.$/, ""));
  await unchecked.click();
  const unproven = page.locator(`#turn-${turnId} .proof-fold:not(.ok)`);
  await until(() => unproven.innerText().then(text => text.includes("Nothing in this turn checked this.") && text.includes("This turn only edited hello.ts and ran bun run check.")), "an unchecked claim says what the turn did look at");
  await page.locator("textarea").press("Enter");
  await until(() => page.locator(`#turn-${turnId} .claim.proved`).count().then(count => count === 2), "Enter proves it: the check reads the file and the dotted line turns green", 20_000);
  assert((await proofLine.innerText()).includes("All 2 proved"), "the count says all proved");
  assert((await page.locator(`#turn-${turnId} .proof-fold.ok`).last().innerText()).includes("greeting = 'after'"), "the check's proof quotes what it read");
  await page.keyboard.press("Escape");
  await until(() => page.locator(`#turn-${turnId} .proof-fold`).count().then(count => count === 0), "Esc folds the proof");
  // The edge is a timeline: a long chat shows its shape on the panel's right edge.
  await page.evaluate(() => { document.getElementById("conversation")!.style.paddingBottom = "1600px"; });
  await until(() => page.locator("#timeline").isVisible(), "a long chat has a timeline edge");
  await page.locator("#timeline").hover();
  await until(() => page.locator("#timeline .tl-m.you").count().then(count => count >= 2), "the timeline marks each message you sent");
  assert(await page.locator("#timeline .tl-m.answer").count() >= 1, "answers are rings on the timeline");
  assert(await page.locator("#timeline .tl-m.edit").count() >= 1, "the turn that edited hello.ts is a green tick");
  const youMark = await page.locator("#timeline .tl-m.you").last().boundingBox();
  await page.mouse.move(youMark!.x + youMark!.width / 2, youMark!.y + youMark!.height / 2);
  await until(() => page.locator("#timeline .tl-label").innerText().then(text => text.includes("Desktop smoke: update hello.ts")), "pointing at a mark names it");
  await capture("02d-timeline");
  await page.evaluate(() => { document.getElementById("stage")!.scrollTop = document.getElementById("stage")!.scrollHeight; });
  await page.mouse.click(youMark!.x + youMark!.width / 2, youMark!.y + youMark!.height / 2);
  await until(() => page.evaluate((id) => { const ask = document.querySelector(`#turn-${id} .request`)!.getBoundingClientRect(), stage = document.getElementById("stage")!.getBoundingClientRect(); return ask.top >= stage.top - 2 && ask.top < stage.top + 120; }, turnId), "clicking a mark goes to that message");
  await page.mouse.move(400, 300);
  await page.evaluate(() => { document.getElementById("conversation")!.style.paddingBottom = ""; });
  await until(() => page.locator(".sidebar-session[aria-current='page']").innerText().then(text => text.includes("Desktop smoke")), "sidebar tracks the current conversation title");
  await page.getByRole("searchbox", { name: "Search chats and projects" }).fill("no-such-conversation");
  await textIncludes("No matching conversations");
  await page.getByRole("searchbox", { name: "Search chats and projects" }).press("Escape");
  assert.equal(await page.getByRole("searchbox", { name: "Search chats and projects" }).inputValue(), "", "Escape clears the search");
  await until(() => page.locator(".sidebar-session[aria-current='page']").isVisible(), "the list is back after search");
  assert(await page.locator("#sidebar-drive, #drive-page").count() === 0, "Drive has no sidebar row and no page");
  // Projects stay visible, and each project owns a collapsible list of chats.
  assert.equal(await page.locator("#desktop-project-button, #sidebar-open-folder, #sidebar-branches").count(), 0, "The sidebar names the project once, in its group");
  assert((await page.locator(".sidebar-project.active .sidebar-project-name").getAttribute("title"))?.startsWith(f.workspace), "The project's line carries its folder");
  await page.getByRole("searchbox", { name: "Search chats and projects" }).focus();
  await until(() => page.locator("#sidebar-projects").isVisible(), "projects are visible");
  // ⌘K is Search: the row itself becomes the field.
  await page.locator("textarea").focus();
  await page.keyboard.press("Control+k");
  await until(() => evaluate<boolean>("return document.activeElement?.id === 'sidebar-search';"), "Ctrl+K puts you in Search");
  await page.getByRole("searchbox", { name: "Search chats and projects" }).press("Escape");
  assert(await page.locator("#sidebar-projects").isVisible(), "projects stay visible after search");
  // The project's whole line is its fold, its folder shut or open with it.
  const projectToggle = page.locator(".sidebar-project.active .sidebar-project-name");
  assert.equal(await page.locator(".sidebar-project-toggle").count(), 0, "no separate chevron: the line folds");
  await projectToggle.click();
  assert.equal(await projectToggle.getAttribute("aria-expanded"), "false");
  assert(!await page.locator(".sidebar-session[aria-current='page']").isVisible(), "collapsing a project hides its chats");
  await page.reload();
  await until(() => page.locator(".sidebar-project.active .sidebar-project-name").getAttribute("aria-expanded").then(value => value === "false"), "project collapse persists across reload");
  await projectToggle.click();
  assert(await page.locator(".sidebar-session[aria-current='page']").isVisible(), "expanding restores its chats");
  // A settled chat carries no mark; double-clicking its title renames it in place.
  assert.equal(await page.locator(".sidebar-session:not([aria-current]) .sidebar-session-mark").evaluateAll(marks => marks.filter(mark => getComputedStyle(mark).visibility === "visible").length), 0, "Settled chats carry no mark");
  await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
  assert.equal(await page.locator("#desktop-toggle-sidebar").getAttribute("aria-expanded"), "false");
  assert(await page.locator("#rail-expand").isVisible(), "The folded sidebar is a rail");
  assert(!await page.locator("#sidebar-sessions").isVisible(), "The rail hides the list");
  await capture("02-rail");
  // Resting on the rail's empty space peeks the whole sidebar out over the panel.
  const rail = await page.locator(".sidebar-rail").boundingBox();
  await page.mouse.move(rail!.x + rail!.width / 2, rail!.y + rail!.height - 120);
  await page.mouse.move(rail!.x + rail!.width / 2, rail!.y + rail!.height - 110);
  await until(() => page.locator("#desktop-shell.sidebar-peek").count().then(count => count === 1), "the folded sidebar peeks out");
  await page.locator(".sidebar-session[aria-current='page']").waitFor();
  assert.equal(await page.locator("#desktop-toggle-sidebar").getAttribute("aria-expanded"), "false", "a peek leaves the sidebar folded");
  await capture("02-rail-peek");
  await page.locator(".sidebar-session[aria-current='page']").click();
  await until(() => page.locator("#desktop-shell.sidebar-peek").count().then(count => count === 0), "picking a chat puts the peek away");
  assert(await page.locator("#rail-expand").isVisible(), "and the rail is back");
  await page.locator("#rail-expand").click();
  // Rest on a chat: after a moment its card says where it stands.
  await page.locator(".sidebar-session[aria-current='page']").hover();
  const glance = page.locator("#sidebar-glance");
  await glance.waitFor();
  const glanceText = await glance.innerText();
  assert.match(glanceText, /Branch\s+master/, `the card names the branch: ${glanceText}`);
  assert.match(glanceText, /Last turn\s+\+1 −1 · 1 file/, `and what the last turn changed: ${glanceText}`);
  assert.match(glanceText, /Model\s+Desktop Test · \d+% context/, `and the model and its context: ${glanceText}`);
  assert.match(glanceText, /Last: “/, `and its last line: ${glanceText}`);
  assert.equal(await page.locator(".sidebar-session[aria-current='page']").getAttribute("title"), null, "the card replaces the native tooltip");
  await capture("02-glance");
  await page.mouse.move(600, 400);
  await until(() => glance.count().then(count => count === 0), "the card goes when the pointer leaves");
  assert.equal(await page.locator("#desktop-toggle-sidebar").getAttribute("aria-expanded"), "true");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("heading", { name: /^What are we building/ }).waitFor();
  await until(() => page.locator("#workspace-title").innerText().then(text => text === "Home"), "the top bar says Home for a new chat");
  // The empty chat is the composer, not a row: New chat above already names
  // it, so Chats only lists conversations that have a turn.
  assert.equal(await page.locator("#sidebar-projects .sidebar-session", { hasText: "New chat" }).count(), 0, "An empty chat is not listed under Chats");
  await type(aside);
  await textIncludes(asideDone);
  await until(() => page.locator("#sidebar-projects .sidebar-item").count().then(count => count === 2), "the second conversation joins the list once it has a turn");
  // It is Just a chat: listed under Just a chat below the projects, and it
  // ends with one quiet line that can move it into a project.
  await until(() => page.locator("#sidebar-chats .sidebar-item").count().then(count => count === 1), "a plain chat is listed under Just a chat");
  await until(() => page.locator("#plain-line .plain-note").isVisible(), "a plain chat ends with Move to a project");
  assert.equal(await page.locator("#workspace-where").innerText(), "Just a chat");
  await click("where-move");
  await until(() => page.locator("#plain-line .where-opt").first().isVisible(), "Move to a project unfolds the projects");
  await capture("02-plain-chat");
  await page.keyboard.press("Escape");
  await until(() => page.locator("#plain-line .where-opt").count().then(count => count === 0), "Esc folds the projects");
  await page.locator(`.sidebar-session[data-args*='${sessionId}']`).click();
  await textIncludes(completed);
  await page.locator(`.sidebar-session[data-args*='${sessionId}'] .sidebar-session-name`).dblclick();
  const renameLook = await page.locator(".sidebar-rename input").evaluate(node => { const style = getComputedStyle(node); return style.borderTopWidth + style.boxShadow + style.backgroundColor; });
  assert.equal(renameLook, "0pxnonergba(0, 0, 0, 0)", "the name is edited on the row, with no box or ring");
  await capture("02-rename");
  await page.locator(".sidebar-rename input").fill("Desktop smoke, renamed");
  await page.locator(".sidebar-rename input").press("Enter");
  await until(async () => (await f.client.getSessionState(sessionId)).session.title === "Desktop smoke, renamed", "double-click renames the chat in place");
  await until(() => page.locator(`.sidebar-session[data-args*='${sessionId}']`).innerText().then(text => text.includes("renamed")), "the row shows its new title");
  // Ctrl+Tab steps to the other chat and Ctrl+Shift+Tab steps back.
  const current = () => page.locator(".sidebar-session[aria-current='page']").getAttribute("data-args");
  await page.locator("textarea").focus();
  await page.keyboard.press("Control+Tab");
  await until(async () => !(await current())?.includes(sessionId), "Ctrl+Tab opens the next chat");
  await page.keyboard.press("Control+Shift+Tab");
  await until(async () => (await current())?.includes(sessionId), "Ctrl+Shift+Tab opens the one before");
  await textIncludes(completed);
  // Bring it back later: the bell beside Pin and Archive unfolds a few times;
  // the chat leaves the list until then, and comes back under Back now.
  const asideRow = page.locator(`#sidebar-projects .sidebar-item:not(:has([data-args*='${sessionId}']))`).first();
  const asideId = JSON.parse(await asideRow.locator(".sidebar-session").getAttribute("data-args") ?? "{}").id as string;
  await asideRow.hover();
  await asideRow.locator(".sidebar-bell").click();
  await page.locator(".sidebar-back-line .sidebar-back-opt", { hasText: "in an hour" }).waitFor();
  await capture("02-bring-back");
  await page.locator(".sidebar-back-line .sidebar-back-opt", { hasText: "in an hour" }).click();
  await until(() => page.locator(`.sidebar-session[data-args*='${asideId}']`).count().then(count => count === 0), "the chat leaves the list until then");
  assert.ok(Date.parse((await f.client.getSessionState(asideId)).session.backAt ?? "") > Date.now() + 3_500_000, "for an hour");
  await page.evaluate((id) => (window as unknown as { demesne: { request: (method: string, args: unknown) => Promise<unknown> } }).demesne.request("bring-back", { id: id.aside, sessionId: id.current, at: new Date(Date.now() - 1000).toISOString() }), { aside: asideId, current: sessionId });
  await until(() => page.locator(`#sidebar-back .sidebar-session[data-args*='${asideId}']`).count().then(count => count === 1), "once due it leads the list under Back now");
  await capture("02-back-now");
  await page.locator(`#sidebar-back .sidebar-session[data-args*='${asideId}']`).click();
  await until(async () => !(await f.client.getSessionState(asideId)).session.backAt, "opening it ends its coming back");
  await until(() => page.locator("#sidebar-back").isHidden(), "and Back now empties");
  await page.locator(`.sidebar-session[data-args*='${sessionId}']`).click();
  await textIncludes(completed);
  // Its pull request on the row: #287 where the time was, a blue dot for the
  // review since; the number unfolds it, Hand it to the chat puts it in the
  // composer, and merged turns it purple with Archive.
  ghPullRequest("OPEN");
  await f.client.updateSession(asideId, { prUrl: "https://github.com/demesne/fieldnote/pull/287" });
  await page.locator(`.sidebar-session[data-args*='${asideId}']`).click();
  await textIncludes(asideDone);
  await page.locator(`.sidebar-session[data-args*='${sessionId}']`).click();
  await textIncludes(completed);
  const prRow = page.locator(`.sidebar-item:has(.sidebar-session[data-args*='${asideId}'])`).first();
  await prRow.locator(".sidebar-pr.new", { hasText: "#287" }).waitFor();
  await page.mouse.move(600, 400);
  await capture("02-pr-row");
  await prRow.locator(".sidebar-pr").click();
  await page.locator(".sidebar-pr-line", { hasText: "2 new on #287" }).waitFor();
  assert.ok(await page.locator(".sidebar-pr-line", { hasText: "mike: The peek opens too soon." }).isVisible(), "the review's words unfold");
  assert.equal(await prRow.locator(".sidebar-pr-dot").count(), 0, "looking at it clears the dot");
  await capture("02-pr-news");
  await page.keyboard.press("Enter");
  await until(async () => (await current())?.includes(asideId), "Hand it to the chat opens the chat");
  await until(() => page.locator("textarea").inputValue().then(value => value.startsWith("Pull request #287") && value.includes("The peek opens too soon.")), "the news waits in the composer");
  await page.locator("textarea").fill("");
  await page.locator(`.sidebar-session[data-args*='${sessionId}']`).click();
  await textIncludes(completed);
  ghPullRequest("MERGED");
  await prRow.locator(".sidebar-pr").click();
  await page.locator(".sidebar-pr-line", { hasText: "Merged" }).locator(".sidebar-back-opt", { hasText: "Archive" }).waitFor();
  await prRow.locator(".sidebar-pr.merged").waitFor();
  await capture("02-pr-merged");
  await prRow.locator(".sidebar-pr").click();
  await until(() => page.locator(".sidebar-pr-line").count().then(count => count === 0), "the number folds it again");
  // Each row deletes itself from the sidebar, without a menu or a dialog;
  // the list closes up and never shows more than six. ⌘Z brings it back
  // while it waits to be archived.
  const before = await page.locator("#sidebar-projects .sidebar-item").count();
  // Empty chats (the map step opened one) are kept by the daemon but not listed.
  const kept = (await f.client.listSessions()).length;
  const other = page.locator(`#sidebar-projects .sidebar-item:not(:has([data-args*='${sessionId}']))`).first();
  const otherArgs = await other.locator(".sidebar-session").getAttribute("data-args");
  await other.hover();
  await other.locator(".sidebar-delete").click();
  assert.equal(await page.locator("#overlay:not([hidden])").count(), 0, "Deleting opens no menu or dialog");
  await until(() => page.locator("#sidebar-projects .sidebar-item").count().then(count => count === before - 1), "the deleted conversation leaves the list");
  await page.locator("body").focus();
  await page.keyboard.press("Control+z");
  await until(() => page.locator("#sidebar-projects .sidebar-item").count().then(count => count === before), "undo brings the conversation back");
  assert.equal((await f.client.listSessions()).length, kept, "An undone delete never reaches the daemon");
  // The keyboard reaches the same delete: Delete on the focused row.
  const row = page.locator(`#sidebar-projects .sidebar-session[data-args='${otherArgs}']`);
  await row.focus();
  // Pin and Archive ease in, so give their transition a moment.
  await until(() => row.locator("xpath=..").locator(".sidebar-row-actions").evaluate(actions => getComputedStyle(actions).opacity === "1").then(shown => shown || Promise.reject(new Error("actions hidden"))), "Pin and Archive show when the keyboard is on the row");
  await page.keyboard.press("Delete");
  await until(() => page.locator("#sidebar-projects .sidebar-item").count().then(count => count === before - 1), "Delete on a row removes it");
  await until(async () => (await f.client.listSessions()).length === kept - 1, "the daemon archived it");
  assert(await page.locator("#sidebar-projects .sidebar-item").count() <= 6, "The sidebar lists at most six conversations");
  await capture("02-completed");
  // Group and sort unfolds under a heading; Archived opens All chats, where
  // Restore brings the chat back.
  const archivedId = JSON.parse(otherArgs ?? "{}").id as string;
  await page.locator(".sidebar-project.active .sidebar-project-header").hover();
  await page.locator(".sidebar-project.active .sidebar-view-button").click();
  await until(() => page.locator(".sidebar-view-line").isVisible(), "Group and sort unfolds under the heading");
  await until(() => page.locator(".sidebar-view-count").innerText().then(text => /^\d+ ›$/.test(text)), "Archived chats says how many");
  assert.equal(await page.locator("#overlay:not([hidden])").count(), 0, "Group and sort is no menu");
  await capture("02-group-sort");
  await page.locator(".sidebar-view-opt", { hasText: "Date" }).click();
  await until(() => page.locator('.sidebar-group-block[data-group="d:Today"] .sidebar-session').first().isVisible(), "by date, today's chats sit under Today");
  assert(await page.locator('.sidebar-group-block[data-group="d:Today"] .sidebar-session-age', { hasText: basename(f.workspace) }).count() > 0, "by date, each row names where it lives");
  await capture("02-by-date");
  await page.locator(".sidebar-view-opt", { hasText: "Project" }).click();
  await until(() => page.locator(".sidebar-project.active .sidebar-view-line").isVisible(), "back by project, the line stays under the first heading");
  await page.locator(".sidebar-view-archived").click();
  await until(() => page.locator("#page .cp-row").first().isVisible(), "Archived opens All chats");
  assert.equal(await page.locator("#workspace-title").innerText(), "All chats");
  assert(!await page.locator("#input-area").isVisible(), "All chats has no composer");
  await capture("02-all-chats");
  await page.locator(`#page .cp-restore[data-args*='${archivedId}']`).click();
  await until(async () => (await f.client.listSessions()).length === kept, "Restore brings the chat back to the daemon's list");
  await until(() => page.locator(`#sidebar-projects .sidebar-session[data-args*='${archivedId}']`).isVisible(), "the restored chat is back in the sidebar");
  await page.locator("body").focus();
  await page.keyboard.press("Escape");
  await until(() => page.locator("#page").isHidden(), "Esc leaves All chats");
  await page.locator(".sidebar-project.active .sidebar-view-button").click();
  // A pinned chat leads the list, above its project.
  const pinRow = page.locator(`:is(#sidebar-sessions, #sidebar-chats) .sidebar-item:has(.sidebar-session[data-args*='${archivedId}'])`);
  await pinRow.hover();
  await pinRow.locator(".sidebar-pin").click();
  await until(() => page.locator(`#sidebar-pinned .sidebar-session[data-args*='${archivedId}']`).isVisible(), "Pin moves the chat to Pinned");
  assert(await f.client.getSessionState(archivedId).then(state => Boolean(state.session.pinnedAt)), "the daemon keeps the pin");
  await capture("02-pinned");
  const pinnedRow = page.locator(`#sidebar-pinned .sidebar-item:has(.sidebar-session[data-args*='${archivedId}'])`);
  await pinnedRow.hover();
  await pinnedRow.locator(".sidebar-pin").click();
  await until(() => page.locator("#sidebar-pinned").isHidden(), "Unpin puts it back with its project");
  // The foot: who you are, the theme switch, Settings.
  assert((await page.locator("#sidebar-you").innerText()).length > 0, "the foot names you");
  const themeBefore = await evaluate<string>("return document.documentElement.dataset.theme;");
  await page.locator("#sidebar-theme").click();
  await until(() => evaluate<string>("return document.documentElement.dataset.theme;").then(theme => theme !== themeBefore), "the sun switches the theme");
  await capture("02-light");
  await page.locator("#sidebar-theme").click();
  await until(() => evaluate<string>("return document.documentElement.dataset.theme;").then(theme => theme === themeBefore), "the moon switches it back");
  // Scheduled: a routine is one sentence, when and then what.
  await page.locator('.sidebar-nav [data-action="page-open"]', { hasText: "Scheduled" }).click();
  await until(() => page.locator('#page[data-kind="scheduled"] #routine-new input').isVisible(), "Scheduled opens in place of the chat");
  assert.equal(await page.locator("#workspace-title").innerText(), "Scheduled");
  await page.locator("#routine-new input").fill("list the PRs");
  await page.locator("#routine-new input").press("Enter");
  await until(() => page.locator("#page .sp-error").isVisible(), "a routine without a time says how to write one");
  await page.locator("#routine-new input").fill("Every weekday at 8:30, summarize what changed overnight");
  await page.locator("#routine-new input").press("Enter");
  await until(() => page.locator("#page .sp-row", { hasText: "Summarize what changed overnight" }).isVisible(), "the new routine joins the list");
  assert((await page.locator("#page .sp-row", { hasText: "Summarize what changed overnight" }).innerText()).includes("Weekdays · 8:30"), "the routine says when it runs");
  assert.equal((await f.client.routines()).routines.length, 1, "the daemon keeps the routine");
  await capture("02-scheduled");
  const routineRow = page.locator("#page .sp-row", { hasText: "Summarize what changed overnight" });
  await routineRow.locator(".sp-switch").click();
  await until(() => routineRow.locator(".sp-switch").innerText().then(text => text === "Off"), "a routine switches off on its row");
  await routineRow.hover();
  await routineRow.locator(".sp-remove").click();
  await until(async () => (await f.client.routines()).routines.length === 0, "Delete removes the routine");
  await page.locator('.sidebar-nav [data-action="page-open"]', { hasText: "Scheduled" }).click();
  await until(() => page.locator("#page").isHidden(), "Scheduled folds away from its row");
  // Customize: the project's instructions, commands and workflows, edited in place.
  await page.locator('.sidebar-nav [data-action="page-open"]', { hasText: "Customize" }).click();
  await until(() => page.locator('#page[data-kind="customize"] .cz-row').first().isVisible(), "Customize opens in place of the chat");
  const instructionsPath = join(f.workspace, "DEMESNE.md");
  const hadInstructions = existsSync(instructionsPath) ? readFileSync(instructionsPath, "utf8") : null;
  await page.locator(`#page .cz-edit-button[data-args*='DEMESNE.md'], #page .cz-edit-button[data-args*='AGENTS.md']`).first().click();
  await until(() => page.locator("#page .cz-edit textarea").isVisible(), "Edit unfolds the instructions under their row");
  const instructionsFile = await page.locator("#page .cz-edit").getAttribute("data-path");
  const instructionsBefore = await page.locator("#page .cz-edit textarea").inputValue();
  await page.locator("#page .cz-edit textarea").fill(`${instructionsBefore}\nKeep replies short.\n`);
  await page.locator("#page .cz-edit textarea").press("Control+Enter");
  await until(() => page.locator("#page .cz-edit").count().then(count => count === 0), "Ctrl+Enter saves and folds the file");
  assert(readFileSync(instructionsFile!, "utf8").includes("Keep replies short."), "the instructions file is written in place");
  await page.locator('#page .cz-new[data-kind="command"] input').fill("ship-it");
  await page.locator('#page .cz-new[data-kind="command"] input').press("Enter");
  await until(() => page.locator("#page .cz-edit textarea").isVisible(), "a new command opens for its words");
  await capture("02-customize");
  await page.locator("#page .cz-save").click();
  await until(() => page.locator("#page .cz-row", { hasText: "/ship-it" }).isVisible(), "the new command is listed");
  await page.locator("#page .cz-row", { hasText: "/ship-it" }).locator('[data-action="cz-run"]').click();
  await until(() => page.locator("textarea").first().inputValue().then(value => value.startsWith("/ship-it")), "Run puts the command in the composer");
  assert(await page.locator("#page").isHidden(), "Run leaves Customize");
  await page.locator("textarea").first().fill("");
  rmSync(join(f.workspace, ".demesne", "commands", "ship-it.md"));
  if (hadInstructions === null) rmSync(instructionsFile!); else writeFileSync(instructionsFile!, hadInstructions);
  // Settings is a page: the sidebar becomes its list, each row has its own control.
  await page.locator(".sidebar-settings").click();
  await page.locator('#page[data-kind="settings"]').waitFor();
  await page.locator("#settings-nav .st-nav.on").filter({ hasText: "General" }).waitFor();
  assert(await page.locator("#sidebar-projects").isHidden(), "the sidebar holds Settings' list instead of the chats");
  assert.equal(await page.locator("#workspace-title").innerText(), "Settings", "the title bar says Settings");
  assert.equal(await page.locator("#settings-nav .st-nav").count(), 13, "thirteen sections");
  await capture("02-settings");
  assert(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#page .st-tx")].every(text => text.getBoundingClientRect().width >= 200)), "every settings row keeps its text readable");
  await page.locator("#page .st-row").filter({ hasText: "Open on" }).getByRole("button", { name: "Last chat" }).click();
  await until(() => page.evaluate("localStorage.getItem('demesne-open-on')").then(value => value === "last"), "Open on remembers Last chat");
  await page.locator("#page .st-row").filter({ hasText: "Open on" }).getByRole("button", { name: "Home" }).click();
  await until(() => page.evaluate("localStorage.getItem('demesne-open-on')").then(value => value === "home"), "Open on goes back to Home");
  await page.keyboard.press("ArrowDown");
  await page.locator("#settings-nav .st-nav.on").filter({ hasText: "Notifications" }).waitFor();
  await page.getByRole("switch", { name: "A chat finishes" }).click();
  await until(() => page.evaluate("JSON.parse(localStorage.getItem('demesne-notify-kinds') || '{}').done").then(value => value === true), "A chat finishes turns on");
  await page.getByRole("switch", { name: "A chat finishes" }).click();
  await until(() => page.evaluate("JSON.parse(localStorage.getItem('demesne-notify-kinds') || '{}').done").then(value => value === false), "and off again");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("palette");
  await until(() => page.locator("#page .st-tx b").allInnerTexts().then(titles => titles.includes("Theme") && !titles.includes("Open on")), "Settings search finds the theme row");
  assert.equal(await page.locator("#page .st-tx mark").first().innerText(), "palette", "the searched word is marked");
  await page.keyboard.press("Escape");
  await until(() => page.getByRole("searchbox", { name: "Search settings" }).inputValue().then(value => value === ""), "Esc clears the search");
  await page.locator("#settings-nav .st-nav").filter({ hasText: "Appearance" }).click();
  assert.equal(await page.locator("#page [data-glass]").count(), 0, "no Glass slider where the desktop doesn't blur behind the window");
  await page.locator("#page .st-word").first().click();
  await page.locator("#page .st-choice").first().waitFor();
  await capture("02-themes");
  await page.locator(`#page .st-choice[data-args*='"demesne-light"']`).click();
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--ink").toUpperCase() === "#F6F8FA");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--ink").trim()), "rgb(242 242 242)", "The desktop wears its own light palette");
  assert(await page.locator('#page[data-kind="settings"]').isVisible(), "Settings stays open while the theme changes");
  await capture("02-light-settings");
  await page.locator("#page .settings-segments button").filter({ hasText: "Large" }).click();
  await until(() => page.locator("#page .settings-segments button.on").filter({ hasText: "Large" }).count().then(count => count === 1), "Text size goes to Large");
  await page.locator("#page .settings-segments button").filter({ hasText: "Default" }).click();
  await until(() => page.locator("#page .settings-segments button.on").filter({ hasText: "Default" }).count().then(count => count === 1), "Text size back to Default");
  await page.locator("#settings-nav .st-back").click();
  await until(() => page.locator("#page").isHidden(), "Back to chats closes Settings");
  assert(await page.locator("#sidebar-projects").isVisible(), "and the chats come back to the sidebar");
  await capture("02-light-conversation");
  await page.locator(".sidebar-settings").click();
  await page.locator("#settings-nav .st-nav").filter({ hasText: "Appearance" }).click();
  await page.locator("#page .st-word").first().click();
  await page.locator(`#page .st-choice[data-args*='"demesne"']`).click();
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--ink").toUpperCase() === "#0B1218");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--ink").trim()), "rgb(22 22 23)", "The desktop wears its own dark palette");
  const accent = () => page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--acc").trim());
  const neutralAccent = await accent();
  await page.locator("#page .st-inks button[aria-label='Warm']").click();
  await until(() => page.evaluate(() => document.documentElement.dataset.ink === "warm"), "the Warm ink is worn");
  assert.notEqual(await accent(), neutralAccent, "the accent follows the ink");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--ink").trim()), "rgb(30 24 19)", "the warm ink tints the panel");
  await capture("02-ink-warm");
  await page.locator("#page .st-inks button[aria-label='Neutral']").click();
  await until(() => page.evaluate(() => document.documentElement.dataset.ink === undefined), "back to the Neutral ink");
  // The rows backed by config.toml and the daemon.
  await page.locator("#settings-nav .st-nav").filter({ hasText: "Drive" }).click();
  const tokens = page.getByRole("textbox", { name: "Tokens" });
  await tokens.waitFor();
  await tokens.fill("400k");
  await tokens.press("Enter");
  await until(() => tokens.inputValue().then(value => value === "400,000"), "a typed Drive limit is saved");
  assert.match(readFileSync(join(f.home, ".demesne/config.toml"), "utf8"), /max_tokens = 400000/, "Drive's token limit lands in config.toml");
  await page.locator("#settings-nav .st-nav").filter({ hasText: "Permissions" }).click();
  await until(() => page.locator("#page .st-row", { hasText: "Its chats read its files" }).count().then(count => count >= 1), "the trusted folders are listed");
  await capture("02-permissions");
  await page.locator("#settings-nav .st-nav").filter({ hasText: "Keyboard shortcuts" }).click();
  assert(await page.locator("#page .st-keys").count() > 10, "the shortcuts are listed");
  await page.locator("#settings-nav .st-nav").filter({ hasText: "Providers" }).click();
  await page.locator("#page .st-row").filter({ hasText: "Provider setup" }).waitFor();
  await capture("02-providers");
  await page.locator("#page .st-row").filter({ hasText: "Provider setup" }).getByRole("button", { name: "Open" }).click();
  await page.locator("#setup:not([hidden])").waitFor();
  await capture("02-setup");
  await page.keyboard.press("Escape");
  await page.locator("#setup").waitFor({ state: "hidden" });
  if (await page.locator("#page").isVisible()) await page.keyboard.press("Escape");
  // The picker lists four models, numbered, with the rest one step away.
  await page.locator("#composer-model").click();
  await page.locator("#overlay .mp-row").first().waitFor();
  assert(await page.locator("#overlay .mp-key", { hasText: /^[2-4]$/ }).count() === 3, "the short list numbers the other three models");
  assert(await page.getByRole("textbox", { name: "Filter models" }).isVisible(), "the search sits on top, in sight");
  assert.equal(await evaluate<string>("return document.activeElement?.id;"), "chooser-filter", "the search has the keyboard");
  assert.equal(await page.locator("#overlay .mp").count(), 1, "the picker is one panel");
  // Thinking is a track with a stop per level, inside the panel.
  const panel = (await page.locator("#overlay .mp").boundingBox())!;
  const stops = page.locator("#overlay .mp-stop");
  assert.equal(await stops.count(), 6, "a stop for each of the model's six levels");
  for (const stop of await stops.all()) { const r = (await stop.boundingBox())!; assert(r.x >= panel.x && r.x + r.width <= panel.x + panel.width, "every thinking stop sits inside the panel"); }
  assert.equal(await page.locator("#overlay .mp-level").innerText(), "Low");
  await capture("02-models");
  // Pointing at a model without thinking: the line says None, the panel keeps its height.
  const panelHeight = () => evaluate<number>("return document.querySelector('#overlay .mp')?.offsetHeight ?? 0;");
  const height = await panelHeight();
  await page.locator("#overlay .mp-row", { hasText: "Desktop Small" }).hover();
  await until(() => page.locator("#overlay .mp-level").innerText().then(text => text === "None"), "Thinking follows the row you point at");
  assert.equal(await panelHeight(), height, "the panel keeps its height");
  await page.locator("#overlay .mp-row", { hasText: "More models" }).click();
  await until(() => page.locator("#overlay .mp-row", { hasText: "Far Away Large" }).isVisible(), "More models unfolds in the same panel");
  assert.equal(await page.locator("#overlay .mp-group", { hasText: "other" }).count(), 1, "the rest come by provider");
  await capture("02-models-more");
  await page.getByRole("textbox", { name: "Filter models" }).fill("far");
  await until(() => page.locator("#overlay .mp-row").count().then(count => count === 2), "a search lists only its matches");
  assert.equal(await page.locator("#overlay .mp-row b").first().innerText(), "Far", "the match is marked");
  await page.keyboard.press("Escape");


  // The receipt opens the turn's steps; the edit's row unfolds its diff in place.
  await click("toggle-steps", { id: completedSession.turns.find(turn => turn.content === prompt)!.id });
  await click("step");
  await until(() => evaluate<boolean>("return !!document.querySelector('.step-fold')?.innerText.includes('after');"), "inline diff visible");
  await capture("03-changes");
  // "N files changed" unfolds the turn's diffs under the answer; a note on a
  // line waits in the composer for the next message.
  const editTurn = completedSession.turns.find(turn => turn.content === prompt)!.id;
  await page.locator(`#turn-${editTurn} .receipt-files`).click();
  await until(() => evaluate<boolean>(`return !!document.querySelector('#turn-${editTurn} .turn-review')?.innerText.includes("greeting = 'after'");`), "the turn's diff unfolds under the receipt");
  await page.locator(`#turn-${editTurn} .rv-l.ad`).first().click();
  await page.locator("#rv-note-input").fill("Say hello instead");
  await page.locator("#rv-note-input").press("Enter");
  await page.locator(`#turn-${editTurn} .rv-note`).filter({ hasText: "Say hello instead" }).waitFor();
  await page.locator("#mention-chips .notes-chip").filter({ hasText: "1 note on the changes" }).waitFor();
  await capture("03-review");
  await page.locator("#mention-chips .notes-chip").click();
  await until(() => page.locator(`#turn-${editTurn} .rv-note`).count().then(count => count === 0), "dropping the notes clears them from the diff");
  await page.locator(`#turn-${editTurn} .receipt-files`).click();
  await until(() => page.locator(`#turn-${editTurn} .turn-review`).count().then(count => count === 0), "the review folds away again");
  // Rewind: a finished step can become "now" again. Back to just after the
  // edit, the check and the answer fold into one line; Redo returns them.
  const editLine = page.locator(`#turn-${editTurn} .step-line`).first();
  await editLine.hover();
  await editLine.locator(".step-rewind").click();
  const rewound = page.locator(`#turn-${editTurn} .rewind-line`);
  await until(() => rewound.innerText().then(text => text.includes("Rewound") && text.includes("1 step and the answer undone") && text.includes("1 command ran")), "rewinding to a step folds what came after");
  assert.equal(await page.locator(`#turn-${editTurn} .answer`).count(), 0, "the answer is folded away");
  assert.equal(readFileSync(join(f.workspace, "hello.ts"), "utf8"), "export const greeting = 'after';\n", "the edit itself stays");
  await capture("03-rewound-step");
  await rewound.locator(".rw-redo").click();
  await until(() => page.locator(`#turn-${editTurn} .answer`).count().then(count => count === 1), "Redo brings the answer back");
  // From the message: back to before it was sent, the edit put back too.
  await page.locator(`#turn-${editTurn} .request`).hover();
  await page.locator(`#turn-${editTurn} .request [data-action="rewind"]`).click();
  await until(() => page.locator(`#turn-${editTurn} .rewind-line`).innerText().then(text => text.includes("hello.ts put back")), "rewinding to a message folds the whole turn");
  assert.equal(readFileSync(join(f.workspace, "hello.ts"), "utf8"), "export const greeting = 'before';\n", "the file is back as it was");
  await capture("03-rewound-message");
  await page.locator(`#turn-${editTurn} .rw-redo`).click();
  await until(() => page.locator(`#turn-${editTurn} .request`).count().then(count => count === 1), "Redo brings the turn back");
  assert.equal(readFileSync(join(f.workspace, "hello.ts"), "utf8"), "export const greeting = 'after';\n", "Redo puts the edit back");
  // The mode word under the composer: ⇧⇥ steps Ask → Accept edits → Plan → Auto → Ask.
  await page.locator("textarea").focus();
  for (const [word, policy] of [["Accept edits", { acceptEdits: true, autoApprove: false }], ["Plan", { acceptEdits: false, autoApprove: false }],
    ["Auto", { acceptEdits: false, autoApprove: true }], ["Ask", { acceptEdits: false, autoApprove: false }]] as const) {
    await page.keyboard.press("Shift+Tab");
    await until(() => page.locator("#composer-mode .mode-opt.on").innerText().then(text => text === word), `mode word ${word}`);
    await until(async () => {
      const session = (await f.client.getSessionState(sessionId)).session;
      return session.acceptEdits === policy.acceptEdits && session.autoApprove === policy.autoApprove;
    }, `daemon policy for ${word}`);
    if (word === "Plan") {
      assert(await page.locator("#composer-mode.open").isVisible(), "the mode word opens into the four modes");
      assert.equal(await page.locator("#composer-mode .mode-opt").count(), 4, "all four modes are in the bar");
      await capture("03-mode-plan");
    }
  }
  assert(await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA"), "⇧⇥ keeps focus in the composer");
  // + attaches images: a thumbnail sits in the box above the text, × drops it.
  const shot = join(f.workspace, "..", "shot.png");
  writeFileSync(shot, await sharp({ create: { width: 320, height: 200, channels: 3, background: "#3d5a80" } }).png().toBuffer());
  await page.locator("#attach-input").setInputFiles(shot);
  await page.locator("#attach-row .att img").waitFor();
  await page.locator("textarea").fill("Make the header match this");
  await capture("03-attach");
  await page.locator("#attach-row .att").hover();
  await page.locator("#attach-row .att-x").click();
  await until(() => page.locator("#attach-row .att").count().then(count => count === 0), "removing the image empties the row");
  await page.locator("textarea").fill("");
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 680));
  await until(() => page.evaluate(() => window.innerWidth <= 900), "narrow desktop size");
  assert(await page.locator("textarea").isVisible(), "Composer remains available at minimum window size");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Workspace does not overflow horizontally");
  await capture("03-narrow-review");
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1180, 820));
  // The top bar's ⋯ is the conversation's menu: rename, compact, archive…
  await page.locator(".header-more").click();
  await page.locator("#overlay .menu-row").filter({ has: page.getByText("Compact", { exact: true }) }).waitFor();
  await capture("04-menu");
  await page.keyboard.press("Escape");
  await page.locator("#overlay").waitFor({ state: "hidden" });
  for (let i = 0; i < 3; i++) {
    const text = `Compaction fixture ${i}`;
    await type(text);
    await until(() => page.locator("#conversation").innerText().then(body => body.includes(text)), "the window shows the sent message");
    await until(async () => {
      const turn = (await f.client.getSessionState(sessionId)).session.turns.at(-1);
      if (turn?.content === text && turn.status === "completed") return true;
      throw new Error(`last turn: ${JSON.stringify({ content: turn?.content, status: turn?.status })}`);
    }, "history ready for compaction");
  }
  await page.locator(".header-more").click();
  await page.locator("#overlay .menu-row").filter({ has: page.getByText("Compact", { exact: true }) }).click();
  const compacted = (await f.client.getSessionState(sessionId)).checkpoint!;
  assert(compacted && compacted.afterTokens < compacted.beforeTokens);
  const percentage = Math.round(compacted.afterTokens / 262144 * 100);
  // The cards on the right carry where the chat works, its context and what
  // changed; the composer's ring and the branch chip stand aside meanwhile.
  await until(() => page.locator("#cards [data-card=context]").innerText().then(text => text.includes(`${percentage}%`) && text.includes("Chat") && text.includes("Tools")), "the Context card shows the reduced context");
  await until(() => page.locator("#cards [data-card=changes]").innerText().then(text => text.includes("+1") && text.includes("−1") && text.includes("Commit & PR")), "the Changes card lists what changed");
  await until(() => page.locator("#cards [data-card=environment]").innerText().then(text => text.includes("This computer") && text.includes("Heartbeat")), "the Environment card names where the chat works");
  const cardInsets = await page.locator("#cards").evaluate((cards) => {
    const panel = cards.getBoundingClientRect();
    const environment = cards.querySelector("[data-card=environment]")!.getBoundingClientRect();
    return { top: environment.top - panel.top, right: panel.right - environment.right };
  });
  assert.equal(cardInsets.top, cardInsets.right, "the cards have matching top and right insets");
  assert(!(await page.locator("#composer-context").isVisible()), "the composer ring stands aside while the cards show");
  await capture("04-cards");
  // Cards that did not change are left in place: folding one repaints no other.
  await page.evaluate(() => { (document.querySelector("#cards [data-card=context]") as HTMLElement & { kept?: boolean }).kept = true; });
  await page.locator("#cards [data-card=environment] .card-head").click();
  await until(() => page.locator("#cards [data-card=environment].folded").count().then(count => count === 1), "a card folds to one line");
  assert(await page.evaluate(() => (document.querySelector("#cards [data-card=context]") as HTMLElement & { kept?: boolean }).kept === true), "folding one card leaves the others in place");
  await page.locator("#cards [data-card=environment] .card-head").click();
  await page.locator("#cards [data-card=environment] .card-body").waitFor();
  // The panel icon hides the cards; the ring and the branch chip come back.
  await page.locator(".header-cards").click();
  await page.locator("#cards").waitFor({ state: "hidden" });
  await until(() => evaluate<string>("return document.getElementById('composer-context').title + ' ' + (document.querySelector('#composer-context .ring')?.style.getPropertyValue('--usage') ?? '');").then(text => text.includes(`${percentage}%`)), "composer context ring updates");
  // The branch chip carries what changed since the last commit; the ring
  // unfolds the context breakdown above it until Esc.
  await until(() => page.locator("#desktop-toolbar .chip.ship").innerText().then(text => text.includes("+1") && text.includes("−1")), "branch chip shows the changes");
  await page.locator("#composer-context").click();
  await until(() => page.locator("#context-card").innerText().then(text => text.includes("Conversation") && text.includes("Tools") && text.includes(`${percentage}%`)), "context breakdown unfolds");
  if (percentage < 50) assert.equal(await page.locator("#context-card .context-compact").count(), 0, "Compact now waits until the context is half full");
  await capture("04-context");
  await page.keyboard.press("Escape");
  await page.locator("#context-card").waitFor({ state: "hidden" });
  await page.locator(".header-cards").click();
  await page.locator("#cards [data-card=context]").waitFor();
  await until(() => page.locator(".compaction-card").count().then(count => count === 1), "conversation summary visible");
  const firstTurnId = completedSession.turns[0]!.id;
  assert.equal(await page.locator(`#turn-${firstTurnId}`).count(), 0, "Older conversation is unmounted by default");
  assert.equal(await page.locator(`#turn-${compacted.firstRetainedTurnId}`).count(), 1, "Retained turns stay visible");
  await page.getByRole("button", { name: "Expand full history", exact: true }).click();
  assert.equal(await page.locator(`#turn-${firstTurnId}`).count(), 1, "Full history can be expanded");
  assert.equal(await page.locator("#conversation > article").first().getAttribute("id"), `turn-${firstTurnId}`, "Expansion restores chronological order");
  await page.getByRole("button", { name: "Collapse older conversation", exact: true }).click();
  assert.equal(await page.locator(`#turn-${firstTurnId}`).count(), 0);
  await capture("04-compacted");
  await page.locator(".header-more").click();
  await until(() => page.locator("#overlay .menu-row").filter({ has: page.getByText("Compact", { exact: true }) }).innerText().then(text => text.includes(`${percentage}%`)), "the menu shows the reduced context");
  await page.keyboard.press("Escape");
  await page.locator("#overlay").waitFor({ state: "hidden" });
  await close();
  assert.equal((await f.client.health()).model, "desktop-test", "Closing the app leaves the daemon alive");
  // No workspace/session args: private preferences restore the project. This
  // launch is on Hyprland, which blurs behind clear pixels: the window is glass.
  await open(false, false, { HYPRLAND_INSTANCE_SIGNATURE: "smoke" });
  assert(await page.evaluate(() => document.documentElement.classList.contains("glass")), "on Hyprland the shell is glass");
  assert(!await page.evaluate(() => document.documentElement.classList.contains("mac-chrome")), "with the desktop's own window chrome");
  // (Xvfb has no compositor, so the window itself can't be checked for clear pixels here.)
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgba(0, 0, 0, 0)", "the page leaves clear pixels for Hyprland to blur");
  await page.locator(".sidebar-settings").click();
  await page.locator("#settings-nav .st-nav").filter({ hasText: "Appearance" }).click();
  await page.locator("#page [data-glass]").waitFor();
  await capture("05-hyprland-glass");
  await page.locator("#settings-nav .st-back").click();
  await until(() => page.locator("#page").isHidden(), "Back to chats closes Settings");
  // Launch lands on Home; the chat is one click away in the sidebar.
  await reopenChat(sessionId);
  await page.getByRole("button", { name: "Expand full history", exact: true }).waitFor();
  assert.equal(await page.locator(`#turn-${firstTurnId}`).count(), 0, "Reopening starts with compacted history collapsed");
  await page.getByRole("button", { name: "Expand full history", exact: true }).click();
  await textIncludes(completed);
  await page.getByRole("button", { name: "Collapse older conversation", exact: true }).click();
  const preferences = JSON.parse(readFileSync(join(f.home, ".demesne/desktop-ui.json"), "utf8"));
  assert.equal(preferences.lastWorkspace, f.workspace);
  await capture("05-restored");
  assert(await page.locator("#composer-limit").isHidden(), "no plan word while the plan says nothing");
  await type(followUp);
  await textIncludes("The daemon is still working.");
  // Words arrive softly: the streaming answer's new words fade in, then settle at full.
  const fading = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#conversation .markdown .md-in")].map((span) => span.textContent ?? "").join(""));
  assert.ok(fading.includes("daemon is still working"), `streamed words fade in: ${fading}`);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#conversation .markdown .md-in")!).opacity), "1", "faded words settle at full");
  await until(async () => (await f.client.getSessionState(sessionId)).session.turns.at(-1)?.status === "running", "daemon turn running");
  await close();
  release!();
  await until(async () => (await f.client.getSessionState(sessionId)).session.turns.at(-1)?.status === "completed", "daemon completes after window closes");
  smokeLimits = [{ provider: "test", plan: "plus", at: new Date().toISOString(),
    primary: { usedPercent: 78, windowMinutes: 300, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    secondary: { usedPercent: 41, windowMinutes: 10080, resetsAt: null } }];
  await open();
  await reopenChat(sessionId);
  await textIncludes(afterClose);
  // Your plan's limit: past half, the fuller window sits beside the model word, amber from 75%.
  const limitWord = page.locator("#composer-limit");
  await limitWord.waitFor();
  assert.equal((await limitWord.textContent())?.trim(), "78% of your 5-hour limit", "the plan's fuller window shows under the composer");
  assert.match(await limitWord.getAttribute("class") ?? "", /\bwarn\b/, "amber from 75%");
  const limitTip = await limitWord.getAttribute("title") ?? "";
  assert.match(limitTip, /^test Plus\n5-hour window 78%, resets .+\nThis week 41%\nDrive pauses its own runs at 90%$/, `the tooltip gives resets, the week and Drive's rule: ${limitTip}`);
  assert.equal((await f.client.planLimits()).limits[0]?.primary?.usedPercent, 78, "the daemon serves the provider's numbers");
  await capture("06-plan-limit");
  await capture("06-work-survived-close");
  // Project groups expose their own chats and open the selected chat across
  // workspace boundaries, rather than restoring a different conversation.
  const openProject = page.getByRole("button", { name: "Open New Project", exact: true });
  assert(await openProject.isVisible(), "opening a project is available above the project list");
  assert(await openProject.evaluate(button => Boolean(button.compareDocumentPosition(document.getElementById("sidebar-sessions")!) & Node.DOCUMENT_POSITION_FOLLOWING)), "the project picker precedes the project list");
  await desktop!.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await openProject.click();
  await until(() => openProject.isEnabled(), "cancelling the project picker leaves navigation usable");
  assert.equal(await page.locator("#sidebar-sessions").getAttribute("data-workspace"), f.workspace, "cancelling keeps the current project");
  const secondProject = join(f.root, "sidebar-project");
  mkdirSync(secondProject);
  await f.client.createSession({ workspacePath: secondProject, trustWorkspace: true });
  await desktop!.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, secondProject);
  await page.locator("textarea").focus();
  await page.keyboard.press("Control+o");
  await until(() => page.locator("#sidebar-sessions").getAttribute("data-workspace").then(path => path === secondProject), "sidebar opens another project");
  // Opening it switches chats; typing before the switch lands loses the text.
  await until(() => evaluate<boolean>("return window.demesneInspect?.().host.session !== arguments[0];", [sessionId]), "the window is on the new project's chat");
  await page.waitForTimeout(300);
  await type("A chat in the second project");
  await until(() => page.locator(".sidebar-project.active .sidebar-session").count().then(count => count === 1), "new chat is nested under its project");
  await page.locator(`.sidebar-project[data-project="${f.workspace}"] .sidebar-session[data-args*="${sessionId}"]`).click();
  await until(() => page.locator("#sidebar-sessions").getAttribute("data-workspace").then(path => path === f.workspace), "chat selection switches to its project");
  await until(() => page.locator(".sidebar-session[aria-current='page']").getAttribute("data-args").then(args => Boolean(args?.includes(sessionId))), "cross-project selection opens the exact chat");
  const secondary = page.locator(`.sidebar-project[data-project="${secondProject}"]`);
  await secondary.locator(".sidebar-project-name").click();
  assert(await secondary.locator(".sidebar-session").isVisible(), "other projects expand without switching workspace");
  assert.equal(await page.locator(`.sidebar-project[data-project="${f.workspace}"] .sidebar-project-name`).getAttribute("aria-expanded"), "true", "each project folds on its own");
  await page.locator(`.sidebar-project[data-project="${f.workspace}"] .sidebar-project-name`).click();
  assert(await page.locator(`.sidebar-project[data-project="${f.workspace}"] :is(.sidebar-project-state, .sidebar-agents, .sidebar-group-count)`).first().isVisible(), "a folded project shows its state on its line");
  await page.locator(`.sidebar-project[data-project="${f.workspace}"] .sidebar-project-name`).click();
  await page.getByRole("searchbox", { name: "Search chats and projects" }).fill("second project");
  assert.equal(await page.locator(".sidebar-project").count(), 1, "search keeps only projects with matching chats");
  assert(await secondary.locator(".sidebar-session").isVisible(), "search exposes matching chats in another project");
  await page.getByRole("searchbox", { name: "Search chats and projects" }).press("Escape");
  const projectOrder = () => page.locator(".sidebar-project").evaluateAll(groups => groups.map(group => (group as HTMLElement).dataset.project));
  const primary = page.locator(`.sidebar-project[data-project="${f.workspace}"]`);
  await secondary.locator(".sidebar-project-name").dragTo(primary.locator(".sidebar-project-header"), { targetPosition: { x: 80, y: 2 } });
  await until(async () => JSON.stringify(await projectOrder()) === JSON.stringify([secondProject, f.workspace]), "dragging reorders project groups");
  assert.equal(await page.locator("#sidebar-sessions").getAttribute("data-workspace"), f.workspace, "dragging does not open a project");
  assert.equal(await page.locator(".dragging, .drop-before, .drop-after").count(), 0, "drop clears drag feedback");
  await page.reload();
  await until(async () => JSON.stringify(await projectOrder()) === JSON.stringify([secondProject, f.workspace]), "manual order survives reload with the active project second");
  await secondary.locator(".sidebar-project-name").focus();
  await page.keyboard.press("Alt+ArrowDown");
  assert.deepEqual(await projectOrder(), [f.workspace, secondProject], "keyboard moves a project down");
  await page.keyboard.press("Alt+ArrowUp");
  assert.deepEqual(await projectOrder(), [secondProject, f.workspace], "keyboard moves a project up");
  // + on a project's line starts a chat there, switching projects.
  await secondary.locator(".sidebar-project-header").hover();
  await secondary.locator(".sidebar-project-new").click();
  await until(() => page.locator(".sidebar-project.active").getAttribute("data-project").then(path => path === secondProject), "opening the reordered project");
  await primary.locator(`.sidebar-session[data-args*="${sessionId}"]`).click();
  await until(() => page.locator(".sidebar-project.active").getAttribute("data-project").then(path => path === f.workspace), "switching back to the second project in manual order");
  assert.deepEqual(await projectOrder(), [secondProject, f.workspace], "switching projects preserves manual ordering");
  await page.locator("textarea").focus();
  await capture("07-project-groups");
  // Drive has no page: it speaks from a line at the end of the conversation.
  const line = page.locator("#briefing");
  const pressAction = (action: string) => evaluate(`const b = document.createElement("button"); b.dataset.action = ${JSON.stringify(action)}; document.body.append(b); b.click(); b.remove();`);
  failSuggestions = true;
  await pressAction("next-refresh");
  await until(() => line.innerText().then(text => text.includes("Drive couldn't look for ideas")), "idea failures show on Drive's line");
  failSuggestions = false;
  await line.getByRole("button", { name: "look again", exact: true }).click();
  await until(() => line.isHidden(), "look again recovers, and the line goes quiet with nothing to offer");
  await page.locator("textarea").fill("/drive --bounded Verify the Drive controls");
  await page.locator("textarea").press("Enter");
  const control = (name: string) => page.locator('[data-action="drive-control"]').filter({ hasText: new RegExp(`^${name}$`, "i") }).first();
  await control("pause").waitFor();
  assert.deepEqual(await projectOrder(), [secondProject, f.workspace], "Drive worktrees stay within their parent project");
  assert.equal(await page.locator(".sidebar-project.active").getAttribute("data-project"), f.workspace);
  await capture("08-drive-working");
  // The mission makes no chat in the sidebar; you write to it from Drive's line.
  await until(() => line.innerText().then(text => text.includes("Verify the Drive controls")), "Drive's line names the mission");
  assert.equal(await page.locator("#sidebar-sessions .sidebar-session", { hasText: "Drive mission:" }).count(), 0, "the mission's chat stays off the sidebar");
  const home = await page.locator("#workspace-title").innerText();
  await line.locator(".bf-tell").click();
  await page.locator("#drive-tell-form input").fill("Keep the tests green");
  await page.locator("#drive-tell-form input").press("Enter");
  await until(() => page.locator("#drive-reply .dt-sent").isVisible(), "the note says it was sent");
  await until(() => page.locator("#drive-reply .drive-told li").innerText().then(text => text.includes("Keep the tests green") && text.includes(`From ${home}`)), "the mission card shows your note");
  await capture("08-drive-tell");
  // Drive's chat waits behind yours: one edge of its panel, its title down it.
  await until(() => page.locator("#drive-peek.work").isVisible(), "Drive's panel waits behind yours while it works");
  assert((await page.locator("#drive-peek").getAttribute("aria-label"))!.includes("Verify the Drive controls"), "the edge names the mission");
  // Its own chat says where it came from and shows the note; the link goes back.
  await page.locator('#drive-reply [data-action="select-session"]', { hasText: "Watch" }).click();
  await until(() => page.locator("#workspace-from").innerText().then(text => text === `from ${home}`), "the mission's chat names the chat it came from");
  await until(() => page.locator("#drive-turn .drive-told li").innerText().then(text => text.includes("Keep the tests green")), "the mission's chat shows your note");
  assert.equal(await page.locator("#drive-turn .drive-heading").count(), 0, "the mission turn has no boxed details");
  assert.equal(await page.locator("#drive-turn").evaluate(node => getComputedStyle(node).borderTopWidth + getComputedStyle(node).backgroundColor), "0pxrgba(0, 0, 0, 0)", "the mission turn sits unboxed in the chat");
  await until(() => page.locator("#drive-peek.back").getAttribute("aria-label").then(text => text === `Back to ${home}`), "inside Drive's chat the edge is the chat it came from");
  await capture("08-drive-chat");
  await page.locator("#drive-peek").click();
  await until(() => page.locator("#workspace-title").innerText().then(text => text === home), "clicking the edge swaps the two back");
  await page.locator("#drive-peek.work").click();
  await until(() => page.locator("#workspace-from").innerText().then(text => text === `from ${home}`), "and the edge swaps them again");
  await page.locator("#workspace-from button").click();
  await until(() => page.locator("#workspace-title").innerText().then(text => text === home), "from takes you back");
  assert(await page.locator("#workspace-from").isHidden(), "your own chat has no from");
  await line.locator(".bf-word").click();
  await control("pause").click();
  await control("resume").waitFor();
  // Drive never waits on you: its coder trying to publish is declined
  // without asking, and nothing lands in your chat.
  const missionId = (await f.client.listSessions()).find(session => session.title.startsWith("Drive mission:"))!.id;
  await f.client.submitTurn(missionId, { content: missionPushPrompt, permissionMode: "allow", fromDrive: true });
  await until(async () => (await f.client.getSessionState(missionId)).session.turns.at(-1)?.status === "completed", "the mission carries on past its publish step");
  assert.equal(await page.locator("#approval .approval-row").count(), 0, "Drive's publish step never asks you");
  assert.equal(await page.locator("#workspace-title").innerText(), home, "you stay in your chat");
  if (!(await control("resume").isVisible())) await line.locator(".bf-word").click();
  await control("resume").click();
  await control("pause").waitFor();
  await control("stop").click();
  await until(() => page.locator('[data-action="drive-control"]').filter({ hasText: /^pause$/i }).count().then(count => count === 0), "Stop ends the mission");
  await capture("09-drive-stopped");
  // Your chat gets Drive's report as a turn, and its model takes it in.
  await until(() => page.locator(".request.drive-report").innerText().then(text => text.includes("Drive stopped") && text.includes("Verify the Drive controls")), "the mission's report lands in the chat it started from");
  await until(() => page.locator(".response").last().innerText().then(text => text.includes("Noted: Drive stopped")), "your chat's model answers the report");
  assert(await page.locator('.request.drive-report [data-action="select-session"]').isVisible(), "the report links to the mission's chat");
  await capture("09-drive-report");
  // In the mission's chat, what Drive asked its coder is a quiet line on the
  // guide, not a bubble you seem to have typed; it unfolds to every word.
  await page.locator('.request.drive-report [data-action="select-session"]').click();
  const asked = page.locator(".drive-asked").first();
  await until(() => asked.innerText().then(text => text.startsWith("→") || text.includes("Drive asked the coder")), "Drive's request is a line on the guide");
  assert.equal(await page.locator(".request", { hasText: missionPushPrompt.slice(0, 30) }).count(), 0, "Drive's request is no bubble");
  await asked.locator(".ds-fold").click();
  await until(() => page.locator(".drive-asked + .ds-said").innerText().then(text => text.trim() === missionPushPrompt.trim()), "the line unfolds to the whole request");
  await capture("09-drive-asked");
  await page.locator("#workspace-from button").click();
  await until(() => page.locator("#workspace-title").innerText().then(text => text === home), "back in your chat");
  // The finished mission left a worktree without changes; its review card
  // opens from Drive's line and discards it.
  offerIdeas = true;
  await line.getByRole("button", { name: /to review/ }).click();
  await until(() => page.locator("#drive-reply.open .bf-row.branch").count().then(count => count === 1), "the branch unfolds as a row under Drive's line");
  await page.locator("#drive-reply .bf-row.branch button.bf-title").click();
  await until(() => page.locator("#drive-reply .bf-sum").isVisible(), "its title unfolds what Drive says it did");
  await page.locator("#drive-reply .bf-row.branch").hover();
  await capture("09-drive-branch");
  await page.locator("#drive-reply").getByRole("button", { name: "Discard", exact: true }).click();
  await until(() => page.locator("#branch-done").innerText().then(text => text.includes("Discarded Verify the Drive controls")), "what Discard did is its own quiet line");
  await pressAction("next-refresh");
  await until(() => page.locator("#briefing .bf-chip").innerText().then(text => text.includes("Drive has 3 ideas")), "Drive's chip names its ideas");
  assert(await page.evaluate(() => Boolean(document.querySelector("#stage > #briefing")) && !document.querySelector("#composer-slot #briefing")), "Drive's line sits where the conversation ends, not on the composer");
  // Drive is on by default: the line says when it starts on its own, and one word turns it off.
  await until(() => page.locator("#briefing .bf-chip").innerText().then(text => text.includes("starts the first after 20 quiet minutes")), "Drive's line says it starts on its own");
  await capture("10-drive-auto");
  await page.locator("#briefing").getByRole("button", { name: "Turn off", exact: true }).click();
  await until(() => page.locator("#briefing .bf-chip").innerText().then(text => text.includes("Drive is off here") && text.includes("3 ideas")), "Turn off says Drive is off here");
  await capture("10-drive-off");
  await page.locator("#briefing").getByRole("button", { name: "Turn on", exact: true }).click();
  await until(() => page.locator("#briefing .bf-chip").innerText().then(text => text.includes("Drive has 3 ideas") && text.includes("Turn off")), "Turn on brings it back");
  await page.locator("#briefing .bf-chev").click();
  await until(() => page.locator("#briefing .bf-word").innerText().then(text => text.includes("Three things I could do next")), "the line becomes Drive's reply");
  await until(() => page.locator("#drive-reply.open .bf-row").count().then(count => count === 3), "Drive's ideas open as a reply in the conversation");
  await page.waitForTimeout(400);
  assert(await page.evaluate(() => { const stage = document.getElementById("stage")!, reply = document.getElementById("drive-reply")!; return reply.getBoundingClientRect().bottom <= stage.getBoundingClientRect().bottom + 2; }), "the reply is scrolled into view, not covering anything");
  await page.locator("#drive-reply .bf-row").first().hover();
  await capture("10-drive-reply");
  await page.keyboard.press("Escape");
  await until(() => page.locator("#drive-reply.open").count().then(count => count === 0), "Escape folds the reply away");
  await page.waitForTimeout(400);
  await capture("10-drive-line");
  await page.locator("#briefing .bf-word").click();
  await until(() => page.locator("#drive-reply.open").count().then(count => count === 1), "the chip's word opens it again");
  await page.locator("#briefing .bf-chev").click();
  await until(() => page.locator("#drive-reply").isHidden(), "the chevron folds it away");
  // A dev server started in the chat unfolds its live page under its step.
  await type(previewPrompt);
  await until(() => evaluate<boolean>("return Array.from(document.querySelectorAll('#approval .approval-row')).some(element => element.textContent.includes(arguments[0]));", ["Run"]), "the server's command asks first");
  await click("permission", { decision: "allow_once" });
  await textIncludes("The site is running.");
  const preview = page.locator("[data-preview]").last();
  await until(() => preview.isVisible(), "the running server's page unfolds under its step", 20_000);
  await until(() => page.frameLocator("[data-preview] iframe").last().locator("h1").innerText().then(text => text === "Fieldnote preview"), "the preview shows the live page");
  assert(await page.locator(".tool-row .verb", { hasText: "Serving" }).count() > 0, "the step says it is serving");
  await preview.getByRole("button", { name: "Phone", exact: true }).click();
  assert(await preview.locator(".pv-view.phone").count() === 1, "Phone narrows the page in place");
  await preview.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await capture("11-preview");
  await preview.getByRole("button", { name: "Output", exact: true }).click();
  await until(() => page.locator(".step-fold .fold-cmd .pv-back").last().isVisible(), "Output swaps the page for the command's output");
  await page.locator(".step-fold .fold-cmd .pv-back").last().click();
  await until(() => page.locator("[data-preview] iframe").last().isVisible(), "Preview brings the page back");
  // Point at it: a click inside the page lands as a chip named by the
  // element, with the file that writes it.
  await until(() => page.frameLocator("[data-preview] iframe").last().locator("#save").isVisible(), "the page is back with its button");
  const pointButton = preview.locator('.pv-btn[data-action="preview-point"]');
  await pointButton.click();
  await until(() => pointButton.evaluate(element => element.classList.contains("on")), "Point turns on in place");
  await page.keyboard.press("Escape");
  await until(() => pointButton.evaluate(element => !element.classList.contains("on")), "Esc puts the pointer away");
  await pointButton.click();
  await until(() => pointButton.evaluate(element => element.classList.contains("on")), "Point turns on again");
  await page.frameLocator("[data-preview] iframe").last().locator("#save").click();
  const pointChip = page.locator("#mention-chips .point-chip");
  await until(() => pointChip.isVisible(), "the clicked element lands in the composer as a chip");
  assert.equal(await pointChip.innerText(), "⌖ Save button ×");
  assert((await pointChip.getAttribute("title"))?.startsWith("site.html:2"), "the chip names the file that writes the element");
  assert(await pointButton.evaluate(element => !element.classList.contains("on")), "a pick puts the pointer away");
  await page.waitForTimeout(200);
  await capture("11-point");
  await pointChip.click();
  await until(() => pointChip.count().then(count => count === 0), "clicking the chip drops it");
  // Agents nearby: other agents (Heartbeat) sit on their projects' lines,
  // and a write to a file one of them changed asks first.
  const here = page.locator(`.sidebar-project[data-project="${f.workspace}"] .sidebar-agents`);
  await until(() => here.isVisible(), "this project's line shows the agent working in it", 20_000);
  assert.equal(await here.getAttribute("aria-label"), "1 agent working in workspace");
  assert(await page.locator(`.sidebar-project[data-project="${join(f.root, "sidebar-project")}"] .sidebar-agents .agent-mark[data-provider="codex"]`).isVisible(), "an agent on a paired machine shows on its own project");
  await here.click();
  const agentRow = page.locator(".sidebar-agent-row").first();
  await until(() => agentRow.isVisible(), "clicking the marks unfolds who is working");
  assert.equal(await agentRow.locator("span:not(.agent-mark)").innerText(), "Claude Code · this computer");
  await agentRow.hover();
  await agentRow.getByRole("button", { name: "Message" }).click();
  assert.equal(await page.locator("textarea").inputValue(), "Message Claude Code at claude@desktop-node/workspace-k3x7a: ", "Message starts a note to the agent");
  await page.locator("textarea").fill("");
  await type(overlapPrompt);
  const overlap = page.locator("#approval .approval-row.overlap");
  await until(() => overlap.isVisible(), "a write to a file another agent changed asks first");
  assert((await overlap.innerText()).includes("Claude Code"), "the line names the agent");
  assert((await overlap.innerText()).includes("notes.ts"), "the line names the file");
  await capture("12-agents-nearby");
  await page.locator("textarea").press("Enter");
  await textIncludes("I'll ask Claude Code before changing notes.ts.");
  assert.equal(readFileSync(join(f.workspace, "notes.ts"), "utf8"), "export const note = 'theirs';\n", "Enter asks first and leaves the other agent's change");
  // The model's question is its next line in the conversation, with its
  // suggestions as answers to pick; no step row and no "interview".
  await type(askPrompt);
  const ask = page.locator("#stage .ask-q");
  await until(() => ask.isVisible(), "the question shows in the conversation", 20_000);
  assert.equal(await page.locator(".tool-row", { hasText: "ask_user" }).count(), 0, "no step row names the tool");
  assert(!(await page.locator("#stage").innerText()).toLowerCase().includes("interview"), "nothing says interview");
  assert.equal(await ask.locator(".ask-choice").count(), 3, "the suggestions are answers to pick");
  assert.equal(await page.locator("textarea").getAttribute("placeholder"), "Answer, or pick one above…");
  await page.waitForTimeout(500);
  await capture("13-question");
  assert(await page.evaluate(() => { const stage = document.getElementById("stage")!; return stage.scrollWidth <= stage.clientWidth && stage.scrollLeft === 0; }), "the question never pushes the chat sideways");
  assert(!(await page.locator("#briefing").innerText()).includes("Discarded"), "Drive's line only says what Drive is doing");
  await page.locator("textarea").press("1");
  await textIncludes("Scoping the test job then.");
  // Enter while it works steers it: the words wait faintly at the end of the
  // guide, then sit where the model read them, in the same turn.
  await type(steerPrompt);
  await until(() => evaluate<boolean>("return Boolean(document.querySelector('#send-label .stop-word'));"), "the steer turn is running");
  await page.locator("textarea").fill(steerWords);
  await until(() => page.locator("#send-label").innerText().then(text => text.includes("steer")), "the composer says Enter steers");
  await page.locator("textarea").press("Enter");
  const pendingSteer = page.locator("#stage .tool-row.steer.pending");
  await until(() => pendingSteer.isVisible(), "the words wait on the guide");
  assert((await pendingSteer.innerText()).includes("on its way"));
  await capture("15-steer-pending");
  releaseSteer();
  await textIncludes("Looking in parser.ts instead.");
  const steered = page.locator("#stage .tool-row.steer:not(.pending)");
  await until(() => steered.isVisible(), "the words sit where the model read them");
  assert((await steered.innerText()).includes(`you: ${steerWords}`));
  assert.equal(await page.locator("#stage .request", { hasText: steerWords }).count(), 0, "steering is not a new message");
  await capture("15-steered");
  // Something broke: Drive's line says so and unfolds in place; no box on
  // the composer.
  await type(brokePrompt);
  await until(() => evaluate<boolean>("return Array.from(document.querySelectorAll('#approval .approval-row')).some(element => element.textContent.includes(arguments[0]));", ["Run"]), "the failing check asks first");
  await click("permission", { decision: "allow_once" });
  await textIncludes("The check fails now.");
  const broke = page.locator("#briefing .bf-word.bad");
  await until(() => broke.isVisible(), "Drive's line says the check broke", 30_000);
  assert.equal(await page.locator("#breakage, .breakage-card").count(), 0, "Drive's branches never float as cards");
  await broke.click();
  await until(() => page.locator("#drive-reply.open button", { hasText: "Fix in a worktree" }).isVisible(), "it unfolds with the fix");
  await page.waitForTimeout(400);
  await capture("14-broke");
  await page.locator("#drive-reply.open button", { hasText: "Not now" }).click();
  await until(() => broke.count().then(count => count === 0), "Not now puts it away");
  // Allowed three times, the fourth ask says so and Always takes Enter;
  // after that it never asks about that command again.
  for (let time = 1; time <= 3; time++) {
    await type(habitPrompt);
    await until(() => page.locator("#approval .approval-row").isVisible(), `the version check asks (${time})`);
    assert.equal(await page.locator("#approval .approval-note.habit").count(), 0, "no habit before the third allow");
    await click("permission", { decision: "allow_once" });
    await until(() => evaluate<boolean>("return !document.querySelector('#send-label .stop-word');"), "the version check finished");
  }
  await type(habitPrompt);
  const habit = page.locator("#approval .approval-note.habit");
  await until(() => habit.isVisible(), "the fourth ask knows it's a habit");
  assert((await habit.innerText()).includes("allowed 3×"));
  assert(await page.evaluate(() => { const code = document.querySelector("#approval .approval-row code")!; return code.scrollWidth <= code.clientWidth; }), "the command still fits on the row");
  assert((await page.locator("#approval button.allow").innerText()).includes("Always here"), "Always takes Enter");
  await capture("16-habit");
  await page.locator("textarea").press("Enter");
  await until(() => evaluate<boolean>("return !document.querySelector('#send-label .stop-word');"), "Always ran it");
  assert(readFileSync(join(f.home, ".demesne/config.toml"), "utf8").includes("--version"), "the rule is saved to your config");
  await type(habitPrompt);
  await textIncludes("Version checked.");
  await until(() => evaluate<boolean>("return !document.querySelector('#send-label .stop-word');"), "the fifth runs without asking");
  assert.equal(await page.locator("#approval .approval-row").count(), 0, "it no longer asks");
  // Switching models resizes the context at once, before the new model's
  // first request.
  const sizeBefore = await page.locator("#composer-context").getAttribute("title");
  assert(sizeBefore?.includes("of 262.1k"), `the context starts at the first model's size: ${sizeBefore}`);
  smokeProcessor!.setModel = (id: string) => { smokeProcessor!.modelId = id; smokeProcessor!.contextCapacity = id === "desktop-small" ? 32768 : 262144; };
  await page.locator("#composer-model").click();
  await page.getByRole("textbox", { name: "Filter models" }).fill("desktop-small");
  await page.keyboard.press("Enter");
  await until(() => page.locator("#composer-context").getAttribute("title").then(title => Boolean(title?.includes("of 32.8k"))), "the context follows the model switch");
  console.log(JSON.stringify({ result: "passed", screenshots: output, checked: ["native Chromium rendering", "streaming thinking wrapping and disclosure", "composer submission", "file and command approvals", "actual edit and successful check", "Markdown/code/math", "inline diff and the conversation menu", "persisted project/session restore", "project grouping and drag ordering", "Drive empty/error states and mission controls", "daemon work survives app closure", "live preview", "agents nearby and the overlap line", "the model's question in the conversation", "breakage on Drive's line", "the context follows a model switch", "a mission linked to its chat, with notes", "Drive never waits on you, and its report", "steering a running turn", "words arrive softly", "ink in Appearance", "glass on Hyprland", "the folded sidebar peeks out", "rest on a chat to see where it stands", "bring it back later", "its pull request on the row", "your plan's limit under the composer", "it learns your yes", "Home's paragraph of what happened, answering an approval from Home", "pointing at the live page"] }, null, 2));
  writeFileSync(join(output, "result.json"), JSON.stringify({ result: "passed", platform: process.platform, application, sessionId }, null, 2));
} catch (error) {
  if (desktop) {
    try { writeFileSync(join(output, "failure.txt"), await evaluate<string>("return document.body.innerText;")); await capture("failure"); } catch {}
    try {
      const sessions = (await f.client.listSessions()).map(session => ({ id: session.id, title: session.title, turns: session.turns.map(turn => [turn.content.slice(0, 40), turn.status]) }));
      const state = JSON.stringify({ window: await evaluate("return window.demesneInspect?.().host;"), sessions }, null, 2);
      writeFileSync(join(output, "failure-state.json"), state);
      console.error(`Desktop state at failure:\n${state}`);
    } catch {}
  }
  throw error;
} finally {
  release?.();
  try { await close(); } catch {}
  writeFileSync(join(output, "electron.log"), log);
  await f.close();
  heartbeatDaemon.stop(true);
}
