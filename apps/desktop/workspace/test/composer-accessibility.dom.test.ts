import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

// Opt-in real browser checks, without downloading a browser or starting a daemon.
// These mount the actual completion renderer and delegated keyboard handler in
// a small DOM fixture. Host actions are recorded, not executed. This is not a
// full Electron integration test or a substitute for screen-reader testing.
const source = readFileSync(new URL("../live.ts", import.meta.url), "utf8");
function section(start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error(`Missing renderer section: ${start}`);
  return source.slice(from, to);
}
const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`
const el = (id) => document.getElementById(id);
const editor = document.querySelector('textarea');
${section("const h = (value:", "const shortcut =")}
${section("const btn = (", "const num =")}
let state = { approvals: [], questions: [], activeTurnId: null, runs: [], files: [
  {path:'src/alpha.ts'}, {path:'src/beta.ts'}
], commands: [
  {name:'/help', id:'help', aliases:[], description:'Show help', section:'chat', argument:'none'},
  {name:'/model', id:'model', aliases:[], description:'Choose a model', section:'chat', argument:'optional'}
] };
let overlay = null, pageOpen = '', pointing = null, contextCardOpen = false;
let completionItems = [], completionIndex = 0, completionAll = false, completionMore = 0, completionDismissed = false;
let question = null, suggestion = null, modeChanges = 0;
const calls = [], pendingDeletes = new Map();
const pendingQuestion = () => question;
const recentCommands = () => [];
const commandIcon = () => '', groupWords = x => x, sectionTitle = x => x, sectionRank = () => 0;
const plainName = x => x.replace(/^\\//, '');
const act = fn => fn(), cycleMode = () => { modeChanges++; };
const api = (method, args) => { calls.push([method, args]); };
const openPage = page => { pageOpen = page; calls.push(['page', page]); };
const nextSuggestion = () => suggestion, driveSuggestion = () => null;
const lastPrompt = () => null, inSession = () => true;
const closeBriefingCard = () => false;
const habitual = () => false;
const denyInstead = text => calls.push(['deny', text]);
const submitText = (text, wait = false) => { calls.push(['submit', text, wait]); hideCompletion(); };
${section("const completionOptionId =", "function changedDraft()")}
function changedDraft() { completionIndex = 0; completionDismissed = false; renderCompletion(); }
${section("function setDraft(text:", "/// Point at it:")}
${section('document.addEventListener("keydown", (event) => {\n  if (!state || event.isComposing) return;', 'window.demesneInspect =')}
editor.addEventListener('input', changedDraft);
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action="completion"]');
  if (button) chooseCompletion(JSON.parse(button.dataset.args).index);
});
window.fixture = {
  draft: setDraft,
  configure(patch) {
    if ('question' in patch) question = patch.question;
    if ('suggestion' in patch) suggestion = patch.suggestion;
    if ('approvals' in patch) state.approvals = patch.approvals;
    if ('activeTurnId' in patch) state.activeTurnId = patch.activeTurnId;
    renderCompletion();
  },
  snapshot: () => ({modeChanges, calls, pageOpen, draft:editor.value}),
  hide: hideCompletion
};
`);

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("composer keyboard and accessible completion DOM", () => {
  let browser: Browser, page: Page;
  let errors: string[];
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined });
  });
  beforeEach(async () => {
    page = await browser.newPage();
    errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<button id="before">Previous control</button><div id="completion" hidden></div><form><textarea id="message" aria-label="Message"></textarea><button id="send" type="button">Send</button><button id="mode" type="button">Mode</button></form>`);
    await page.addScriptTag({ content: script });
  });
  afterEach(async () => {
    await page?.close();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await browser?.close(); });

  const draft = (text: string) => page.evaluate(text => (window as any).fixture.draft(text), text);
  const configure = (patch: Record<string, unknown>) => page.evaluate(patch => (window as any).fixture.configure(patch), patch);
  const snapshot = () => page.evaluate(() => (window as any).fixture.snapshot());
  const focused = () => page.evaluate(() => document.activeElement?.id);

  test("Tab traverses empty and nonempty drafts without accepting a suggestion or changing mode", async () => {
    await configure({ suggestion: "Review the changes" });
    for (const text of ["", "Keep this draft"]) {
      await draft(text);
      await page.keyboard.press("Tab");
      expect(await focused()).toBe("send");
      await page.locator("#message").focus();
      await page.keyboard.press("Shift+Tab");
      expect(await focused()).toBe("before");
      expect(await snapshot()).toEqual({ modeChanges: 0, calls: [], pageOpen: "", draft: text });
    }
  });

  test("Shift+Tab leaves an open completion without selecting or submitting it", async () => {
    for (const text of ["/", "@src/"]) {
      await draft(text);
      await page.keyboard.press("Shift+Tab");
      expect(await focused()).toBe("before");
      expect((await snapshot()).draft).toBe(text);
      expect((await snapshot()).calls).toEqual([]);
      expect((await snapshot()).modeChanges).toBe(0);
    }
  });

  test("commands expose listbox selection while focus remains in the multiline textbox", async () => {
    await draft("/");
    const editor = page.locator("#message");
    expect(await editor.getAttribute("aria-controls")).toBe("completion-list");
    expect(await editor.getAttribute("aria-autocomplete")).toBe("list");
    expect(await page.getByRole("listbox", { name: "Commands" }).count()).toBe(1);
    expect(await page.getByRole("option", { selected: true }).textContent()).toContain("help");
    await page.keyboard.press("ArrowDown");
    expect(await focused()).toBe("message");
    const selected = page.getByRole("option", { selected: true });
    expect(await selected.textContent()).toContain("model");
    expect(await editor.getAttribute("aria-activedescendant")).toBe(await selected.getAttribute("id"));
    expect(await page.locator("#completion").ariaSnapshot()).toContain("[selected]");
    await page.keyboard.press("Tab");
    expect((await snapshot()).draft).toBe("/model ");
    expect((await snapshot()).calls).toEqual([]);
    expect(await editor.getAttribute("aria-activedescendant")).toBeNull();
    expect(await editor.getAttribute("aria-controls")).toBeNull();
  });

  test("file option IDs remain stable when filtering and pointer selection agrees with keyboard selection", async () => {
    await draft("@src/");
    const beta = page.getByRole("option").filter({ hasText: "beta.ts" });
    const id = await beta.getAttribute("id");
    await draft("@src/b");
    expect(await page.getByRole("option", { selected: true }).getAttribute("id")).toBe(id);
    expect(await page.locator("#message").getAttribute("aria-activedescendant")).toBe(id);
    await page.getByRole("option", { selected: true }).click();
    expect((await snapshot()).draft).toBe("@src/beta.ts ");
    expect(await focused()).toBe("message");
    expect(await page.locator("#message").getAttribute("aria-activedescendant")).toBeNull();
    await draft("@src/");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect((await snapshot()).draft).toBe("@src/beta.ts ");
  });

  test("Escape, empty results, approvals, questions and running turns clear stale accessible references", async () => {
    await draft("/");
    await page.keyboard.press("Escape");
    expect((await snapshot()).draft).toBe("/");
    expect(await page.locator("#message").getAttribute("aria-activedescendant")).toBeNull();
    await draft("/no-match");
    expect(await page.locator("#completion").isHidden()).toBe(true);
    for (const patch of [{ approvals: [{ id: "approval" }] }, { question: { id: "question" } }, { activeTurnId: "running" }]) {
      await configure({ approvals: [], question: null, activeTurnId: null });
      await draft("/");
      await configure(patch);
      expect(await page.locator("#completion").isHidden()).toBe(true);
      expect(await page.locator("#message").getAttribute("aria-controls")).toBeNull();
      expect(await page.locator("#message").getAttribute("aria-activedescendant")).toBeNull();
      await page.keyboard.press("Tab");
      expect(await focused()).toBe("send");
      await page.locator("#message").focus();
      await page.keyboard.press("Shift+Tab");
      expect(await focused()).toBe("before");
    }
    expect((await snapshot()).calls).toEqual([]);
    expect((await snapshot()).modeChanges).toBe(0);
  });

  test("Shift+Enter remains a newline with completion open; plain Enter runs the selected command", async () => {
    await draft("/");
    await page.keyboard.press("Shift+Enter");
    expect((await snapshot()).draft).toBe("/\n");
    expect((await snapshot()).calls).toEqual([]);
    await draft("/help");
    await page.keyboard.press("Enter");
    expect((await snapshot()).calls).toEqual([["submit", "/help", false]]);
    expect(await page.locator("#message").getAttribute("aria-controls")).toBeNull();
  });

  test("explicit shortcuts change mode or accept a suggestion; normal sending still steers or queues", async () => {
    await draft("");
    await page.keyboard.press("Alt+KeyM");
    expect((await snapshot()).modeChanges).toBe(1);
    await page.keyboard.press("Alt+ArrowRight");
    expect((await snapshot()).pageOpen).toBe("");
    await configure({ suggestion: "Review changes" });
    await page.keyboard.press("Alt+ArrowRight");
    expect((await snapshot()).draft).toBe("Review changes");
    await configure({ activeTurnId: "running" });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Alt+Enter");
    expect((await snapshot()).calls).toEqual([["submit", "Review changes", false], ["submit", "Review changes", true]]);
  });
});
