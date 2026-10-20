/** Real Electron smoke test with disposable daemon, workspace, and credentials. */
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
const thinkingText = "First reasoning paragraph.\nSecond line stays readable.\n\n" + "A detailed thought with enough words to wrap across several lines. ".repeat(12) + "\n" + "long_identifier_".repeat(90);
let nextThought!: () => void, finishThought!: () => void;
const thoughtGate = new Promise<void>(resolve => { nextThought = resolve; });
const thoughtFinish = new Promise<void>(resolve => { finishThought = resolve; });
let round = 0, release: (() => void) | undefined;
let failSuggestions = false, offerIdeas = false;
const gate = new Promise<void>(done => { release = done; });
const f = await fixture({
  providerId: "test", modelId: "desktop-test", contextCapacity: 262144, maxOutputTokens: 1024,
  async listModels() { return [{ id: "desktop-test", provider: "test", contextWindow: 262144 }]; },
  async *stream(messages, _tools, signal) {
    const user = messages.findLast(message => message.role === "user")?.content;
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
  await page.getByRole("searchbox", { name: "Find a conversation or project" }).fill("no-such-conversation");
  await textIncludes("No matching conversations");
  await page.getByRole("searchbox", { name: "Find a conversation or project" }).press("Escape");
  assert.equal(await page.getByRole("searchbox", { name: "Find a conversation or project" }).inputValue(), "", "Escape clears the search");
  await until(() => page.locator(".sidebar-session[aria-current='page']").isVisible(), "the list is back after search");
  assert(await page.locator("#sidebar-drive").isVisible(), "Drive is a fixed row in the sidebar");
  // Projects stay visible, and each project owns a collapsible list of chats.
  assert((await page.locator("#desktop-project-sub").innerText()).length > 0, "The project shows its folder under its name");
  await page.getByRole("searchbox", { name: "Find a conversation or project" }).focus();
  await until(() => page.locator("#sidebar-projects").isVisible(), "projects are visible");
  assert(await page.locator("#sidebar-projects").getByText("Open a folder…").isVisible(), "search can open another folder");
  await page.getByRole("searchbox", { name: "Find a conversation or project" }).press("Escape");
  assert(await page.locator("#sidebar-projects").isVisible(), "projects stay visible after search");
  const projectToggle = page.locator(".sidebar-project.active .sidebar-project-toggle");
  await projectToggle.click();
  assert.equal(await projectToggle.getAttribute("aria-expanded"), "false");
  assert(!await page.locator(".sidebar-session[aria-current='page']").isVisible(), "collapsing a project hides its chats");
  await page.reload();
  await until(() => page.locator(".sidebar-project.active .sidebar-project-toggle").getAttribute("aria-expanded").then(value => value === "false"), "project collapse persists across reload");
  await projectToggle.click();
  assert(await page.locator(".sidebar-session[aria-current='page']").isVisible(), "expanding restores its chats");
  // A settled chat carries no mark; double-clicking its title renames it in place.
  assert.equal(await page.locator(".sidebar-session:not([aria-current]) .sidebar-session-mark").evaluateAll(marks => marks.filter(mark => getComputedStyle(mark).visibility === "visible").length), 0, "Settled chats carry no mark");
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
  // The empty chat is the composer, not a row: New chat above already names
  // it, so Chats only lists conversations that have a turn.
  assert.equal(await page.locator("#sidebar-sessions .sidebar-session", { hasText: "New chat" }).count(), 0, "An empty chat is not listed under Chats");
  await type(aside);
  await textIncludes(asideDone);
  await until(() => page.locator("#sidebar-sessions .sidebar-item").count().then(count => count === 2), "the second conversation joins the list once it has a turn");
  await page.locator(`.sidebar-session[data-args*='${sessionId}']`).click();
  await textIncludes(completed);
  await page.locator(`.sidebar-session[data-args*='${sessionId}'] .sidebar-session-name`).dblclick();
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
  // Each row deletes itself from the sidebar, without a menu or a dialog;
  // the list closes up and never shows more than six. ⌘Z brings it back
  // while it waits to be archived.
  const before = await page.locator("#sidebar-sessions .sidebar-item").count();
  const other = page.locator(`#sidebar-sessions .sidebar-item:not(:has([data-args*='${sessionId}']))`).first();
  const otherArgs = await other.locator(".sidebar-session").getAttribute("data-args");
  await other.hover();
  await other.locator(".sidebar-delete").click();
  assert.equal(await page.locator("#overlay:not([hidden])").count(), 0, "Deleting opens no menu or dialog");
  await until(() => page.locator("#sidebar-sessions .sidebar-item").count().then(count => count === before - 1), "the deleted conversation leaves the list");
  await page.locator("body").focus();
  await page.keyboard.press("Control+z");
  await until(() => page.locator("#sidebar-sessions .sidebar-item").count().then(count => count === before), "undo brings the conversation back");
  assert.equal((await f.client.listSessions()).length, before, "An undone delete never reaches the daemon");
  // The keyboard reaches the same delete: Delete on the focused row.
  const row = page.locator(`#sidebar-sessions .sidebar-session[data-args='${otherArgs}']`);
  await row.focus();
  // The trash eases in, so give its transition a moment.
  await until(() => row.locator("xpath=..").locator(".sidebar-delete").evaluate(button => getComputedStyle(button).opacity === "1").then(shown => shown || Promise.reject(new Error("trash hidden"))), "The trash shows when the keyboard is on the row");
  await page.keyboard.press("Delete");
  await until(() => page.locator("#sidebar-sessions .sidebar-item").count().then(count => count === before - 1), "Delete on a row removes it");
  await until(async () => (await f.client.listSessions()).length === before - 1, "the daemon archived it");
  assert(await page.locator("#sidebar-sessions .sidebar-item").count() <= 6, "The sidebar lists at most six conversations");
  await capture("02-completed");
  // Settings is one sheet: sections on the left, each row with its own control.
  await page.locator(".sidebar-settings").click();
  await page.locator('#overlay[data-screen="settings"] .settings-nav-item.on').filter({ hasText: "General" }).waitFor();
  await capture("02-settings");
  await page.getByRole("textbox", { name: "Search settings" }).fill("palette");
  await until(() => page.locator("#overlay .settings-row b").allInnerTexts().then(titles => titles.includes("Theme") && !titles.includes("Mode")), "Settings search finds the theme row");
  await page.getByRole("textbox", { name: "Search settings" }).fill("");
  await page.locator("#overlay .settings-nav-item").filter({ hasText: "Appearance" }).click();
  await page.locator("#settings-theme").waitFor();
  await capture("02-themes");
  await page.locator("#settings-theme").selectOption("demesne-light");
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--ink").toUpperCase() === "#F6F8FA");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--ink").trim()), "#f7f7f5", "The desktop wears its own light palette");
  assert(await page.locator('#overlay[data-screen="settings"]').isVisible(), "Settings stays open while the theme changes");
  await capture("02-light-settings");
  await page.locator("#overlay .settings-segments button").filter({ hasText: "Large" }).click();
  await until(() => page.locator("#overlay .settings-segments button.on").filter({ hasText: "Large" }).count().then(count => count === 1), "Text size goes to Large");
  await page.locator("#overlay .settings-segments button").filter({ hasText: "Default" }).click();
  await until(() => page.locator("#overlay .settings-segments button.on").filter({ hasText: "Default" }).count().then(count => count === 1), "Text size back to Default");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await capture("02-light-conversation");
  await page.locator(".sidebar-settings").click();
  await page.locator("#overlay .settings-nav-item").filter({ hasText: "Appearance" }).click();
  await page.locator("#settings-theme").selectOption("demesne");
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--ink").toUpperCase() === "#0B1218");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--ink").trim()), "#121315", "The desktop wears its own dark palette");
  await page.locator("#overlay .settings-nav-item").filter({ hasText: "Providers" }).click();
  await page.locator("#overlay .settings-row").filter({ hasText: "Provider setup" }).waitFor();
  await capture("02-providers");
  await page.locator("#overlay .settings-row").filter({ hasText: "Provider setup" }).getByRole("button", { name: "Open" }).click();
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
  // The mode word under the composer: ⇧⇥ steps Ask → Accept edits → Plan → Auto → Ask.
  await page.locator("textarea").focus();
  for (const [word, policy] of [["Accept edits", { acceptEdits: true, autoApprove: false }], ["Plan", { acceptEdits: false, autoApprove: false }],
    ["Auto", { acceptEdits: false, autoApprove: true }], ["Ask", { acceptEdits: false, autoApprove: false }]] as const) {
    await page.keyboard.press("Shift+Tab");
    await until(() => page.locator("#composer-mode").innerText().then(text => text.startsWith(word)), `mode word ${word}`);
    await until(async () => {
      const session = (await f.client.getSessionState(sessionId)).session;
      return session.acceptEdits === policy.acceptEdits && session.autoApprove === policy.autoApprove;
    }, `daemon policy for ${word}`);
    if (word === "Plan") {
      assert(await page.locator("#mode-hint").isVisible(), "the mode hint names the four modes");
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
  await until(() => evaluate<string>("return document.getElementById('composer-context').title + ' ' + (document.querySelector('#composer-context .ring')?.style.getPropertyValue('--usage') ?? '');").then(text => text.includes(`${percentage}%`)), "composer context ring updates");
  // The branch chip carries what changed since the last commit; the ring
  // unfolds the context breakdown above it until Esc.
  await until(() => page.locator("#desktop-toolbar .chip.ship").innerText().then(text => text.includes("+1") && text.includes("−1")), "branch chip shows the changes");
  await page.locator("#composer-context").click();
  await until(() => page.locator("#context-card").innerText().then(text => text.includes("Conversation") && text.includes("Tools") && text.includes(`${percentage}%`)), "context breakdown unfolds");
  await capture("04-context");
  await page.keyboard.press("Escape");
  await page.locator("#context-card").waitFor({ state: "hidden" });
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
  // Project groups expose their own chats and open the selected chat across
  // workspace boundaries, rather than restoring a different conversation.
  const secondProject = join(f.root, "sidebar-project");
  mkdirSync(secondProject);
  await f.client.createSession({ workspacePath: secondProject, trustWorkspace: true });
  await desktop!.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, secondProject);
  await page.locator("#sidebar-open-project").click();
  await until(() => page.locator("#desktop-project-button").getAttribute("title").then(path => path === secondProject), "sidebar opens another project");
  await type("A chat in the second project");
  await until(() => page.locator(".sidebar-project.active .sidebar-session").count().then(count => count === 1), "new chat is nested under its project");
  await page.locator(`.sidebar-project[data-project="${f.workspace}"] .sidebar-session[data-args*="${sessionId}"]`).click();
  await until(() => page.locator("#desktop-project-button").getAttribute("title").then(path => path === f.workspace), "chat selection switches to its project");
  await until(() => page.locator(".sidebar-session[aria-current='page']").getAttribute("data-args").then(args => Boolean(args?.includes(sessionId))), "cross-project selection opens the exact chat");
  const secondary = page.locator(`.sidebar-project[data-project="${secondProject}"]`);
  await secondary.locator(".sidebar-project-toggle").click();
  assert(await secondary.locator(".sidebar-session").isVisible(), "other projects expand without switching workspace");
  await page.getByRole("searchbox", { name: "Find a conversation or project" }).fill("second project");
  assert.equal(await page.locator(".sidebar-project").count(), 1, "search keeps only projects with matching chats");
  assert(await secondary.locator(".sidebar-session").isVisible(), "search exposes matching chats in another project");
  await page.getByRole("searchbox", { name: "Find a conversation or project" }).press("Escape");
  const projectOrder = () => page.locator(".sidebar-project").evaluateAll(groups => groups.map(group => (group as HTMLElement).dataset.project));
  const primary = page.locator(`.sidebar-project[data-project="${f.workspace}"]`);
  await secondary.locator(".sidebar-project-name").dragTo(primary.locator(".sidebar-project-header"), { targetPosition: { x: 80, y: 2 } });
  await until(async () => JSON.stringify(await projectOrder()) === JSON.stringify([secondProject, f.workspace]), "dragging reorders project groups");
  assert.equal(await page.locator("#desktop-project-button").getAttribute("title"), f.workspace, "dragging does not open a project");
  assert.equal(await page.locator(".dragging, .drop-before, .drop-after").count(), 0, "drop clears drag feedback");
  await page.reload();
  await until(async () => JSON.stringify(await projectOrder()) === JSON.stringify([secondProject, f.workspace]), "manual order survives reload with the active project second");
  await secondary.locator(".sidebar-project-name").focus();
  await page.keyboard.press("Alt+ArrowDown");
  assert.deepEqual(await projectOrder(), [f.workspace, secondProject], "keyboard moves a project down");
  await page.keyboard.press("Alt+ArrowUp");
  assert.deepEqual(await projectOrder(), [secondProject, f.workspace], "keyboard moves a project up");
  await secondary.locator(".sidebar-project-name").click();
  await until(() => page.locator(".sidebar-project.active").getAttribute("data-project").then(path => path === secondProject), "opening the reordered project");
  await primary.locator(".sidebar-project-name").click();
  await until(() => page.locator(".sidebar-project.active").getAttribute("data-project").then(path => path === f.workspace), "switching back to the second project in manual order");
  assert.deepEqual(await projectOrder(), [secondProject, f.workspace], "switching projects preserves manual ordering");
  await page.locator("textarea").focus();
  await capture("07-project-groups");
  await page.locator("#sidebar-drive").click();
  const drivePage = page.locator("#drive-page");
  const mission = drivePage.getByLabel("What should Drive take on?");
  await mission.waitFor();
  await drivePage.getByText("Nothing waiting", { exact: false }).waitFor();
  assert(!(await page.locator("#stage").isVisible()), "Drive takes the main column in place of the conversation");
  await mission.fill("Verify the Drive controls");
  await page.keyboard.press("Escape");
  await page.locator("#stage").waitFor();
  assert(await drivePage.isHidden(), "Escape leaves the Drive page");
  await page.locator("#sidebar-drive").click();
  assert.equal(await mission.inputValue(), "Verify the Drive controls", "leaving Drive preserves the mission draft");
  failSuggestions = true;
  await drivePage.getByRole("button", { name: "look now", exact: true }).click();
  await until(() => drivePage.innerText().then(text => text.includes("Couldn’t load ideas:")), "idea failures are visible");
  assert.equal(await mission.inputValue(), "Verify the Drive controls", "looking again preserves the mission draft");
  failSuggestions = false;
  await drivePage.getByRole("button", { name: "Look again", exact: true }).click();
  await until(() => drivePage.innerText().then(text => !text.includes("Couldn’t load ideas:") && !text.includes("Looking")), "Look again recovers the ideas view");
  await capture("08-drive");
  await drivePage.getByRole("button", { name: "Start", exact: true }).click();
  await drivePage.getByRole("button", { name: "Pause", exact: true }).waitFor();
  assert(await drivePage.isVisible(), "Drive stays open when a mission switches to its worktree");
  assert.deepEqual(await projectOrder(), [secondProject, f.workspace], "Drive worktrees stay within their parent project");
  assert.equal(await page.locator(".sidebar-project.active").getAttribute("data-project"), f.workspace);
  await capture("08-drive-working");
  await drivePage.getByRole("button", { name: "Pause", exact: true }).click();
  await drivePage.getByRole("button", { name: "Resume", exact: true }).waitFor();
  await until(() => drivePage.locator(".drive-status").innerText().then(text => text === "Paused"), "Pause is reflected in mission status");
  await drivePage.getByRole("button", { name: "Resume", exact: true }).click();
  await drivePage.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await drivePage.getByRole("button", { name: "Stop", exact: true }).click();
  await until(() => drivePage.locator(".drive-status").innerText().then(text => text === "Stopped"), "Stop is reflected in mission status");
  await capture("09-drive-stopped");
  // Back in a chat, Drive's ideas sit on the composer's top edge; the
  // chevron grows the box upward to show them, one line each.
  offerIdeas = true;
  await drivePage.locator(".drive-row").filter({ hasText: "No changes" }).hover();
  await drivePage.getByRole("button", { name: "Discard", exact: true }).click();
  // Nothing on the page asks for fresh ideas while a past mission is listed,
  // so press the same action the strip's "look again" sends.
  await evaluate(`const b = document.createElement("button"); b.dataset.action = "next-refresh"; b.id = "fixture-refresh"; document.getElementById("drive-page").append(b); b.click(); b.remove();`);
  await until(() => drivePage.innerText().then(text => text.includes("Add tests for fuzzy search ranking")), "Drive offers the fixture ideas");
  await page.keyboard.press("Escape");
  await until(() => page.locator("#briefing .bf-strip").innerText().then(text => text.includes("Drive has 3 ideas")), "the composer strip names Drive's ideas");
  await page.locator("#briefing .bf-chev").click();
  await until(() => page.locator("#briefing .bf-fold.open .bf-row").count().then(count => count === 3), "the strip unfolds three idea rows");
  await page.waitForTimeout(400);
  await page.locator("#briefing .bf-row").first().hover();
  await capture("10-drive-strip");
  await page.locator("#briefing .bf-chev").click();
  await until(() => page.locator("#briefing .bf-fold.open").count().then(count => count === 0), "the strip folds the ideas away");
  console.log(JSON.stringify({ result: "passed", screenshots: output, checked: ["native Chromium rendering", "streaming thinking wrapping and disclosure", "composer submission", "file and command approvals", "actual edit and successful check", "Markdown/code/math", "inline diff and the conversation menu", "persisted project/session restore", "project grouping and drag ordering", "Drive empty/error states and mission controls", "daemon work survives app closure"] }, null, 2));
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
