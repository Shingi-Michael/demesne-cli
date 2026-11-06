import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { changed, parseSteps, stepName, TRY_RUNTIME, type Fingerprint } from "../electron/foundry-try.ts";

// A small shopping list with the bugs foundry_try exists to catch: an Add
// that works, a Clear that does nothing, a Share hidden under a bar, a
// disabled Save.
const PAGE = `<!doctype html><html><body style="margin:0;font:14px sans-serif">
<h1>Groceries</h1><label>Item <input id="item"></label>
<button id="add" onclick="const li=document.createElement('li');li.textContent=document.getElementById('item').value;document.getElementById('list').append(li);document.getElementById('item').value=''">Add</button>
<button>Clear</button><button disabled>Save</button><button aria-label="Close menu">×</button>
<ul id="list"></ul>
<div style="height:1600px"></div>
<button id="share" style="position:fixed;bottom:10px;left:10px;width:120px;height:40px">Share</button>
<nav style="position:fixed;bottom:0;left:0;right:0;height:70px;background:#ddd">Tab bar</nav>
</body></html>`;

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("foundry_try in the page", () => {
  let browser: Browser, page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined, executablePath: process.env.DEMESNE_CHROMIUM || undefined });
    page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    await page.setContent(PAGE);
    expect(await page.evaluate(TRY_RUNTIME)).toBe(true);
  });
  afterAll(async () => { await browser?.close(); });

  type Found = { found: boolean; names?: string[]; x: number; y: number; many: number; what: string; covered: string | null; disabled: boolean };
  const find = (target: string) => page.evaluate((t) => (window as any).__demesneTry.find(t), target) as Promise<Found>;
  const print = () => page.evaluate(() => (window as any).__demesneTry.fingerprint()) as Promise<Fingerprint>;

  test("finds controls by their text, label, aria-label or a selector", async () => {
    expect((await find("Add")).what).toBe('button "Add"');
    expect((await find("item")).what).toBe('textbox "Item"');
    expect((await find("close menu")).what).toBe('button "Close menu"');
    expect((await find("#add")).what).toBe('button "Add"');
    const missing = await find("Checkout");
    expect(missing.found).toBe(false);
    expect(missing.names).toContain("Add");
  });

  test("says when a control is covered or disabled", async () => {
    const share = await find("Share");
    expect(share.covered).toContain('nav "Tab bar"');
    expect((await find("Save")).disabled).toBe(true);
  });

  test("a real click that works changes the page; one that does nothing doesn't", async () => {
    const item = await find("Item");
    await page.mouse.click(item.x, item.y);
    await page.keyboard.insertText("Milk");
    let before = await print();
    const add = await find("Add");
    await page.mouse.click(add.x, add.y);
    expect(changed(before, await print())).toContain("new text “Milk”");
    before = await print();
    const clear = await find("Clear");
    await page.mouse.click(clear.x, clear.y);
    expect(changed(before, await print())).toBeNull();
  });

  test("the tree names each heading and control with its place, size and state", async () => {
    const tree = await page.evaluate(() => (window as any).__demesneTry.tree()) as string[];
    expect(tree.some((line) => line.startsWith('heading "Groceries"'))).toBe(true);
    expect(tree.some((line) => line.startsWith('button "Save"') && line.includes("disabled"))).toBe(true);
    expect(tree.some((line) => line.startsWith('button "Share"') && line.includes("covered by nav"))).toBe(true);
    expect(tree.some((line) => /^button "Close menu".*small target/.test(line))).toBe(true);
  });
});

test("steps are checked before they run, and named for the result", () => {
  expect(parseSteps([{ click: "Add" }, { type: "Milk", into: "Item" }, { key: "enter" }, { scroll: 400.4 }, { wait: 9000 }]))
    .toEqual([{ click: "Add" }, { type: "Milk", into: "Item" }, { key: "Enter" }, { scroll: 400 }, { wait: 2000 }]);
  expect(() => parseSteps([])).toThrow(/one to 12/);
  expect(() => parseSteps(Array(13).fill({ wait: 1 }))).toThrow(/At most 12/);
  expect(() => parseSteps([{ key: "F5" }])).toThrow(/key must be one of/);
  expect(() => parseSteps([{ drag: "x" }])).toThrow(/needs one of/);
  expect(stepName({ type: "Milk", into: "Item" })).toBe("type “Milk” into “Item”");
  expect(stepName({ scroll: -200 })).toBe("scroll up 200px");
});
