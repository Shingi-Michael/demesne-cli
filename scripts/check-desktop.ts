/** Real Electron smoke test with disposable daemon, workspace, and credentials. */
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fixture } from "../apps/graphics/test/fixture.ts";

const packagedExecutable = process.argv[2];
const application = resolve("apps/desktop/build/app");
assert(existsSync(join(application, "main.cjs")), "Run bun scripts/prepare-desktop.ts first");
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
const prompt = "Desktop smoke: update hello.ts and run its check";
const followUp = "Desktop smoke: continue while the window is closed";
const completed = "Verified the desktop change.";
const afterClose = "Daemon work completed after the window closed.";
let round = 0, release: (() => void) | undefined;
const gate = new Promise<void>(done => { release = done; });
const f = await fixture({
  providerId: "test", modelId: "desktop-test", contextCapacity: 262144, maxOutputTokens: 1024,
  async listModels() { return [{ id: "desktop-test", provider: "test", contextWindow: 262144 }]; },
  async *stream(messages, _tools, signal) {
    const user = messages.findLast(message => message.role === "user")?.content;
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
    if (user === followUp) {
      yield { type: "text_delta", delta: "The daemon is still working.\n\n" };
      await gate;
      if (signal.aborted) throw signal.reason;
      yield { type: "text_delta", delta: afterClose };
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
});
writeFileSync(join(f.workspace, "hello.ts"), "export const greeting = 'before';\n");
writeFileSync(join(f.workspace, "package.json"), JSON.stringify({ scripts: { check: "bun check.ts" } }));
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
async function open(workspace = false, welcome = false) {
  desktop = await electron.launch({ ...(packagedExecutable ? { executablePath: resolve(packagedExecutable) } : {}), args: [...(packagedExecutable ? [] : [application]), `--user-data-dir=${join(f.root, "electron")}`, ...(workspace ? [`--workspace=${f.workspace}`] : []), `--server=${f.server.url}`], env: {
    ...f.env, XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache"),
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
  await until(() => evaluate<boolean>("const editor=document.querySelector('textarea');return !!editor && editor.getBoundingClientRect().width>0 && document.body.innerText.includes('desktop-test');"), "connected desktop project", 30_000);
  assert.equal(await evaluate("return document.getElementById('desktop-project-button')?.title;"), f.workspace);
  assert.equal(await page.evaluate(() => typeof (window as any).require), "undefined", "No Node in the renderer");
  assert.equal(await page.evaluate(() => typeof (window as any).process), "undefined", "No process or environment in the renderer");
  const isolation = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences());
  assert(isolation.sandbox && isolation.contextIsolation && !isolation.nodeIntegration && !isolation.webviewTag);
  const zoom = await desktop.evaluate(({ BrowserWindow, Menu }) => {
    const item = Menu.getApplicationMenu()!.items.find(item => item.label === "View")!.submenu!.items.find(item => item.label === "Zoom In")!;
    item.click();
    return BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor();
  });
  assert.equal(zoom, 1.1, "Native zoom menu is connected");
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.find(item => item.label === "View")!.submenu!.items.find(item => item.label === "Actual Size")!.click());
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
  await type(prompt);
  await until(() => evaluate<boolean>("return Array.from(document.querySelectorAll('#approval .approval-row')).some(element => element.textContent.includes(arguments[0]));", ["Edit"]), "file approval visible");
  await capture("02-file-approval");
  await click("permission", { decision: "allow_once" });
  await until(() => evaluate<boolean>("return Array.from(document.querySelectorAll('#approval .approval-row')).some(element => element.textContent.includes(arguments[0]));", ["Run"]), "command approval visible");
  assert(await evaluate<boolean>("const fold = document.querySelector('#approval .approval-fold'); return !!fold && fold.hidden;"), "The full command starts folded");
  await page.locator("#approval .approval-show").click();
  await until(() => evaluate<boolean>("const fold = document.querySelector('#approval .approval-fold'); return !!fold && !fold.hidden && fold.innerText.includes('run check');"), "command details can be inspected");
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
  await until(() => page.locator(".sidebar-session[aria-current='page']").innerText().then(text => text.includes("Desktop smoke")), "sidebar tracks the current conversation title");
  await page.getByRole("button", { name: "Find a conversation", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find a conversation" }).fill("no-such-conversation");
  await textIncludes("No matching conversations");
  await page.getByRole("searchbox", { name: "Find a conversation" }).press("Escape");
  assert(!await page.getByRole("searchbox", { name: "Find a conversation" }).isVisible(), "Escape folds the search away");
  await until(() => page.locator(".sidebar-session[aria-current='page']").isVisible(), "the list is back after search");
  await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
  assert.equal(await page.locator("#desktop-toggle-sidebar").getAttribute("aria-expanded"), "false");
  assert(await page.locator("#rail-expand").isVisible(), "The folded sidebar is a rail");
  assert(!await page.locator("#sidebar-sessions").isVisible(), "The rail hides the list");
  await capture("02-rail");
  await page.locator("#rail-expand").click();
  assert.equal(await page.locator("#desktop-toggle-sidebar").getAttribute("aria-expanded"), "true");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("heading", { name: /^What are we building/ }).waitFor();
  await until(() => page.locator("#workspace-title").innerText().then(text => text === "New chat"), "the top bar names the new chat");
  await page.locator(`.sidebar-session[data-args*='${sessionId}']`).click();
  await textIncludes(completed);
  await capture("02-completed");
  await page.locator(".sidebar-footer button").click();
  await page.locator('#overlay[data-screen="settings"]').waitFor();
  await capture("02-settings");
  await page.locator("#overlay .menu-row").filter({ has: page.getByText("Theme", { exact: true }) }).click();
  await page.locator('#overlay[data-screen="themes"]').waitFor();
  await capture("02-themes");
  await page.locator("#overlay .menu-row").filter({ has: page.getByText("Demesne Light", { exact: true }) }).click();
  await page.locator("#overlay").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--ink").toUpperCase() === "#F6F8FA");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--ink").trim()), "#f7f7f5", "The desktop wears its own light palette");
  await capture("02-light-conversation");
  await page.locator(".sidebar-footer button").click();
  await page.locator("#overlay .menu-row").filter({ has: page.getByText("Theme", { exact: true }) }).click();
  await page.locator("#overlay .menu-row").filter({ has: page.getByText("Demesne", { exact: true }) }).click();
  await page.locator("#overlay").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--ink").toUpperCase() === "#0B1218");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--ink").trim()), "#121315", "The desktop wears its own dark palette");
  await page.locator(".sidebar-footer button").click();
  await page.locator("#overlay .menu-row").filter({ has: page.getByText("Providers", { exact: true }) }).click();
  await page.locator('#overlay[data-screen="providers"]').waitFor();
  await capture("02-providers");
  await page.locator("#overlay .menu-row").filter({ has: page.getByText("Provider setup", { exact: true }) }).click();
  await page.locator("#setup:not([hidden])").waitFor();
  await capture("02-setup");
  await page.keyboard.press("Escape");
  await page.locator("#setup").waitFor({ state: "hidden" });
  if (await page.locator("#overlay").isVisible()) await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.locator("#composer-model").click();
  await page.getByRole("textbox", { name: "Filter models" }).waitFor();
  await capture("02-models");
  await page.keyboard.press("Escape");


  // The receipt opens the turn's steps; the edit's row unfolds its diff in place.
  await click("toggle-steps");
  await click("step");
  await until(() => evaluate<boolean>("return !!document.querySelector('.step-fold')?.innerText.includes('after');"), "inline diff visible");
  await capture("03-changes");
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 680));
  await until(() => page.evaluate(() => window.innerWidth <= 900), "narrow desktop size");
  assert(await page.locator("textarea").isVisible(), "Composer remains available at minimum window size");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Workspace does not overflow horizontally");
  await capture("03-narrow-review");
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1180, 820));
  await click("panel", { name: "history" });
  await textIncludes("TURNS");
  await capture("04-history");
  // Keep the Context panel open while real compaction completes over SSE.
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
  await click("panel", { name: "context" });
  await click("compact");
  await textIncludes("SAVED COMPACTION");
  const compacted = (await f.client.getSessionState(sessionId)).checkpoint!;
  assert(compacted && compacted.afterTokens < compacted.beforeTokens);
  const percentage = Math.round(compacted.afterTokens / 262144 * 100);
  await until(() => page.locator(".context-top").innerText().then(text => text.includes(`${percentage}%`)), "context panel updates without reopening");
  await until(() => evaluate<string>("return document.getElementById('composer-context').title + ' ' + (document.querySelector('#composer-context .ring')?.style.getPropertyValue('--usage') ?? '');").then(text => text.includes(`${percentage}%`)), "composer context ring updates");
  await until(() => page.locator(".compaction-card").count().then(count => count === 1), "conversation summary visible");
  const firstTurnId = completedSession.turns.find(turn => turn.content === prompt)!.id;
  assert.equal(await page.locator(`#turn-${firstTurnId}`).count(), 0, "Older conversation is unmounted by default");
  assert.equal(await page.locator(`#turn-${compacted.firstRetainedTurnId}`).count(), 1, "Retained turns stay visible");
  await page.getByRole("button", { name: "Expand full history", exact: true }).click();
  assert.equal(await page.locator(`#turn-${firstTurnId}`).count(), 1, "Full history can be expanded");
  assert.equal(await page.locator("#conversation > article").first().getAttribute("id"), `turn-${firstTurnId}`, "Expansion restores chronological order");
  await page.getByRole("button", { name: "Collapse older conversation", exact: true }).click();
  assert.equal(await page.locator(`#turn-${firstTurnId}`).count(), 0);
  await capture("04-compacted");
  await click("panel", { name: "history" });
  await until(() => page.locator(".session-context .meter").getAttribute("title").then(title => title === `${percentage}% used`), "session view shows reduced context");
  await close();
  assert.equal((await f.client.health()).model, "desktop-test", "Closing the app leaves the daemon alive");
  await open(); // No workspace/session args: private preferences must restore both.
  await page.getByRole("button", { name: "Expand full history", exact: true }).waitFor();
  assert.equal(await page.locator(`#turn-${firstTurnId}`).count(), 0, "Reopening starts with compacted history collapsed");
  await page.getByRole("button", { name: "Expand full history", exact: true }).click();
  await textIncludes(completed);
  await page.getByRole("button", { name: "Collapse older conversation", exact: true }).click();
  const preferences = JSON.parse(readFileSync(join(f.home, ".demesne/desktop-ui.json"), "utf8"));
  assert.equal(preferences.lastWorkspace, f.workspace);
  await capture("05-restored");
  await type(followUp);
  await textIncludes("The daemon is still working.");
  await until(async () => (await f.client.getSessionState(sessionId)).session.turns.at(-1)?.status === "running", "daemon turn running");
  await close();
  release!();
  await until(async () => (await f.client.getSessionState(sessionId)).session.turns.at(-1)?.status === "completed", "daemon completes after window closes");
  await open();
  await textIncludes(afterClose);
  await capture("06-work-survived-close");
  console.log(JSON.stringify({ result: "passed", screenshots: output, checked: ["native Chromium rendering", "composer submission", "file and command approvals", "actual edit and successful check", "Markdown/code/math", "inline diff and the session view", "persisted project/session restore", "daemon work survives app closure"] }, null, 2));
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
}
