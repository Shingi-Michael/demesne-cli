import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

// Real DOM, production tab renderer/model/keyboard handlers; host navigation is
// simulated. No daemon, model calls, downloads, or installed app are involved.
const source = readFileSync(new URL("../live.ts", import.meta.url), "utf8");
function section(start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error(`Missing renderer section: ${start}`);
  return source.slice(from, to);
}
const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`
${readFileSync(new URL("../tabs.ts", import.meta.url), "utf8").replace("export class", "class")}
${readFileSync(new URL("../tab-strip.ts", import.meta.url), "utf8").replaceAll("export function", "function")}
${section("const h = (value:", "const shortcut =")}
${section("const btn = (", "const num =")}
const editor = document.querySelector('textarea'), el = id => document.getElementById(id);
const sessions = ['a', 'b', 'c'].map(id => ({id, title:'Chat '+id, updatedAt:'2026-01-01', workspace:'/project'}));
let state = { sessions, session:sessions[0], workspace:'/project', breakage:{inbox:[]}, approvals:[] };
let pageOpen = '', foundryOpen = null, pointing = null, contextCardOpen = false, overlay = null;
let sessionVisible = true, revision = 0;
const deletedSessions = new Set(), pendingDeletes = new Map(), calls = [];
const inSession = () => sessionVisible, inAssistant = () => false;
const chatTone = item => item.waiting ? 'wait' : 'ready';
const STATE_WORDS = {ready:'', wait:'Needs you'}, fullTime = x => x, shortcut = x => x;
const act = fn => fn(), pendingQuestion = () => null;
const openPage = value => { pageOpen = value; renderTabs(); };
const dispatch = (action, args) => {
  calls.push([action, args]);
  if (action === 'tab-close') return closeTab(args.id);
  if (action === 'select-session') { state.session = state.sessions.find(s => s.id === args.id); sessionVisible = true; pageOpen = ''; }
  if (action === 'new-session') { state.session = undefined; sessionVisible = false; pageOpen = ''; }
  renderTabs();
};
${section("const tabs = new OpenTabs", "function totals(")}
for (const id of ['a','b','c']) tabs.open(id);
const strip = el('workspace-tabs');
strip.addEventListener('keydown', event => { if (handleTabStripKey(event, strip)) event.stopPropagation(); });
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (button) dispatch(button.dataset.action, JSON.parse(button.dataset.args || '{}'));
});
${section('document.addEventListener("keydown", (event) => {\n  if (!state || event.isComposing) return;', 'window.demesneInspect =')}
document.addEventListener('demesne:close-tab', () => closeTab(state.session?.id || ''));
window.fixture = {
  calls, render:renderTabs,
  update() { state.sessions[1].updatedAt = String(++revision); state.sessions[1].waiting = true; renderTabs(); },
  page(value) { pageOpen = value; renderTabs(); },
  single() { tabs.ids = ['a']; state.session = state.sessions[0]; renderTabs(); },
  close:closeTab,
  snapshot:() => ({pageOpen, current:state.session?.id, ids:tabs.ids, calls})
};
renderTabs();
`);

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("tab strip accessibility DOM", () => {
  let browser: Browser, page: Page;
  let errors: string[];
  beforeAll(async () => { browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined }); }, 20_000);
  beforeEach(async () => {
    page = await browser.newPage();
    errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<!doctype html><button id="before">Before</button><div id="workspace-tabs" role="tablist" aria-label="Open chats"></div><button id="workspace-new-tab" data-action="new-session">New chat</button><div id="workspace-call"></div><div id="completion" hidden></div><div id="workspace" role="tabpanel"><textarea aria-label="Message"></textarea></div>`);
    await page.addScriptTag({ content: script });
  });
  afterEach(async () => { await page?.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); });
  const tab = (id: string) => page.locator(`#workspace-tab-${id}`);
  const focused = () => page.evaluate(() => document.activeElement?.id);
  const snapshot = () => page.evaluate(() => (window as any).fixture.snapshot());

  test("one tab stop, manual arrow/Home/End navigation, and native Enter/Space activation", async () => {
    expect(await page.locator('[role="tab"][tabindex="0"]').count()).toBe(1);
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    expect(await focused()).toBe("workspace-tab-a");
    await page.keyboard.press("ArrowLeft");
    expect(await focused()).toBe("workspace-tab-c");
    await page.keyboard.press("ArrowRight");
    expect(await focused()).toBe("workspace-tab-a");
    await page.keyboard.press("End");
    expect(await focused()).toBe("workspace-tab-c");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    expect((await snapshot()).calls).toEqual([]);
    expect((await snapshot()).current).toBe("a");
    await page.keyboard.press("Enter");
    expect((await snapshot()).current).toBe("b");
    expect(await tab("b").getAttribute("aria-selected")).toBe("true");
    expect(await page.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("workspace-tab-b");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    expect((await snapshot()).current).toBe("c");
    await page.keyboard.press("Tab");
    expect(await focused()).toBe("workspace-new-tab");
    await page.keyboard.press("Shift+Tab");
    expect(await focused()).toBe("workspace-tab-c");
  });

  test("status updates preserve the focused tab and close-button DOM nodes without stealing outside focus", async () => {
    for (const selector of ['#workspace-tab-b', '[data-tab="b"] .bar-tab-close']) {
      await page.locator(selector).focus();
      const same = await page.evaluate(() => {
        const before = document.activeElement;
        (window as any).fixture.update();
        return document.activeElement === before && before?.isConnected;
      });
      expect(same).toBe(true);
    }
    expect(await tab("b").getAttribute("aria-label")).toContain("Needs you");
    await page.locator("textarea").focus();
    await page.evaluate(() => (window as any).fixture.page("settings"));
    expect(await page.locator("textarea").evaluate(node => node === document.activeElement)).toBe(true);
    expect(await page.locator('[role="tab"][tabindex="0"]').count()).toBe(1);
    expect(await tab("page").getAttribute("tabindex")).toBe("0");
  });

  test("numbered shortcuts and Ctrl+Tab uncover the underlying chat from Settings", async () => {
    await page.evaluate(() => (window as any).fixture.page("settings"));
    await page.locator("textarea").focus();
    await page.keyboard.press("Control+1");
    expect((await snapshot()).pageOpen).toBe("");
    expect((await snapshot()).current).toBe("a");
    await page.keyboard.press("Control+9");
    expect((await snapshot()).current).toBe("c");
    await page.keyboard.press("Control+Tab");
    expect((await snapshot()).current).toBe("a");
    await page.keyboard.press("Control+Shift+Tab");
    expect((await snapshot()).current).toBe("c");
    await page.evaluate(() => { (window as any).fixture.single(); (window as any).fixture.page("settings"); });
    await page.keyboard.press("Control+1");
    await page.evaluate(() => (window as any).fixture.page("settings"));
    await page.keyboard.press("Control+Tab");
    expect((await snapshot()).pageOpen).toBe("");
    expect((await snapshot()).current).toBe("a");
  });

  test("closing a focused tab chooses its neighbor, the last close chooses New chat, and reopen works", async () => {
    await page.locator('[data-tab="b"] .bar-tab-close').focus();
    await page.keyboard.press("Enter");
    expect((await snapshot()).ids).toEqual(["a", "c"]);
    expect(await focused()).toBe("workspace-tab-c");
    await page.locator('[data-tab="c"] .bar-tab-close').focus();
    await page.keyboard.press("Enter");
    expect(await focused()).toBe("workspace-tab-a");
    await page.keyboard.press("Control+w");
    expect(await focused()).toBe("workspace-new-tab");
    expect((await snapshot()).ids).toEqual([]);
    await page.keyboard.press("Control+Shift+t");
    expect((await snapshot()).current).toBe("a");
    expect((await snapshot()).ids).toEqual(["a"]);
    expect(await tab("a").getAttribute("aria-selected")).toBe("true");
  });

  test("a transient page tab participates without an extra tab stop", async () => {
    await page.evaluate(() => { (window as any).fixture.page("settings"); });
    await tab("page").focus();
    await page.keyboard.press("Home");
    expect(await focused()).not.toBe("workspace-tab-page");
    await page.keyboard.press("End");
    expect(await focused()).toBe("workspace-tab-page");
    expect(await page.locator('[role="tab"][tabindex="0"]').count()).toBe(1);
    expect(await page.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("workspace-tab-page");
  });
});
