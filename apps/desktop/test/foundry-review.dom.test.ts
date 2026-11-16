import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { LOOK_MEASURE, type LookMeasure } from "../electron/foundry-look-measure.ts";
import { scopeAppStyles } from "../foundry-kit/scope-app.ts";

// Pass 223 A: a review of something that exists is one sheet. The screen as
// it is with the parts outlined and numbered, then each part at its own
// size: Today, the pick, the other options.
const kit = (name: string) => readFileSync(resolve(import.meta.dir, "../foundry-kit", name), "utf8");
const appStyles = scopeAppStyles(["workspace/ui.css", "workspace/live.css", "desktop.css", "workspace.css"].map((file) => readFileSync(resolve(import.meta.dir, "..", file), "utf8"))).replace(/@font-face\{[^}]*\}/g, "");
const WINDOW = (attributes = "") => `<d-demesne tabs="Tidy the sidebar|Settings|Drive picks" chats="Tidy the sidebar|Drive picks" height="520" ${attributes}></d-demesne>`;
const PAGE = `<!doctype html><html><head><style>${kit("base.css").replace(/@font-face\{[^}]*\}/g, "")}</style><style data-demesne-app>${appStyles}</style><script>${kit("parts.js")}</script></head><body>
<d-review>
<section data-today marks="#desktop-toolbar | .sidebar-nav">${WINDOW()}</section>
<section data-part="Top bar" why="Three tabs, the Drive pill and the menu compete in one row.">
<d-compare recommended="Fewer">
<section data-option="Two tabs"><d-crop to="#desktop-toolbar">${WINDOW('tabs="Tidy the sidebar|Settings"')}</d-crop></section>
<section data-option="Fewer things"><d-crop to="#desktop-toolbar">${WINDOW('tabs="Tidy the sidebar" drive="none"')}</d-crop></section>
<section data-option="Today"><d-crop to="#desktop-toolbar">${WINDOW()}</d-crop></section>
</d-compare></section>
<section data-part="Sidebar actions" why="Four actions with the same weight sit above the chats.">
<d-compare recommended="Quiet">
<section data-option="Today"><d-crop to=".sidebar-nav">${WINDOW()}</d-crop></section>
<section data-option="Quiet"><d-crop to=".sidebar-nav">${WINDOW()}</d-crop></section>
<section data-option="Two lines"><d-crop to=".sidebar-nav">${WINDOW()}</d-crop></section>
</d-compare></section>
</d-review></body></html>`;

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("A review sheet drawn by the kit", () => {
  let browser: Browser, page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined, executablePath: process.env.DEMESNE_CHROMIUM || undefined });
    // The Foundry page loads a mockup with stack=1; a review must not split into option stages there.
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.route("https://review.test/**", (route) => route.fulfill({ contentType: "text/html", body: PAGE }));
    await page.goto("https://review.test/?stack=1");
    await page.waitForTimeout(1500);
  });
  afterAll(async () => { await browser?.close(); });

  test("the screen as it is has each part outlined and numbered where it sits", async () => {
    const rings = await page.evaluate(() => [...document.querySelectorAll(".dr-ring")].map((ring) => {
      const at = ring.getBoundingClientRect(), bar = document.querySelector("[data-today] #desktop-toolbar")!.getBoundingClientRect(), nav = document.querySelector("[data-today] .sidebar-nav")!.getBoundingClientRect();
      const around = (box: DOMRect) => Math.abs(at.left - box.left) < 6 && Math.abs(at.top - box.top) < 6 && Math.abs(at.width - box.width) < 10;
      return { number: ring.textContent, bar: around(bar), nav: around(nav) };
    }));
    expect(rings).toEqual([{ number: "1", bar: true, nav: false }, { number: "2", bar: false, nav: true }]);
    expect(await page.locator(".dr-cap").innerText()).toBe("As it is today. Outlined: the 2 parts that most need work, most important first.");
  });

  test("each part is named and says why, with Today first, then the pick, then the rest", async () => {
    expect(await page.locator(".dr-head span").allInnerTexts()).toEqual(["Top bar", "Sidebar actions"]);
    expect(await page.locator(".dr-head d-mark").allInnerTexts()).toEqual(["1", "2"]);
    expect(await page.locator(".dr-why").first().innerText()).toBe("Three tabs, the Drive pill and the menu compete in one row.");
    const order = await page.evaluate(() => [...document.querySelectorAll("d-review d-compare")].map((compare) => [...compare.children].map((option) => (option.querySelector(".dp-opt") as HTMLElement).innerText.replace(/\s+/g, " ").trim())));
    expect(order).toEqual([["Today", "Fewer things recommended", "Two tabs"], ["Today", "Quiet recommended", "Two lines"]]);
    // Nothing is hidden and no option strip is drawn: every option is on the sheet.
    expect(await page.locator("d-review [data-option][hidden]").count()).toBe(0);
    expect(await page.locator(".dp-strip").count()).toBe(0);
    expect(await page.locator("d-review .dp-rec > .dr-tile").count()).toBe(2);
  });

  test("a crop shows the piece alone at its own size; wide pieces stack, small ones sit side by side", async () => {
    const crops = await page.evaluate(() => [...document.querySelectorAll("d-crop")].map((crop) => {
      const box = crop.getBoundingClientRect(), piece = crop.querySelector(crop.getAttribute("to")!)!.getBoundingClientRect();
      return { width: Math.round(box.width), inside: piece.left >= box.left - 1 && piece.right <= box.right + 1 && piece.top >= box.top - 1 && piece.bottom <= box.bottom + 1, slack: Math.round(box.height - piece.height) };
    }));
    expect(crops).toHaveLength(6);
    for (const crop of crops) { expect(crop.inside).toBe(true); expect(crop.slack).toBe(24); }
    // The top bar is most of the window wide; the sidebar's actions are a narrow column.
    expect(crops[0]!.width).toBeGreaterThan(700);
    expect(crops[3]!.width).toBeLessThan(320);
    const wide = await page.evaluate(() => [...document.querySelectorAll("d-review d-compare")].map((compare) => compare.classList.contains("dr-wide")));
    expect(wide).toEqual([true, false]);
    const tops = await page.evaluate(() => [...document.querySelectorAll("d-review d-compare")].map((compare) => new Set([...compare.children].map((option) => Math.round(option.getBoundingClientRect().top))).size));
    expect(tops).toEqual([3, 1]);
  });

  test("Foundry's own look finds nothing wrong with the sheet, and does not look at what a crop cuts away", async () => {
    const measured = await page.evaluate(LOOK_MEASURE) as LookMeasure;
    expect(measured.issues).toEqual([]);
  });

  test("a cut-out piece takes the room there is: it never holds a grid or a narrow page open", async () => {
    // From the pass 223 run: three crops in a grid page scrolled a phone-wide page sideways by 290px.
    const narrow = await browser.newPage({ viewport: { width: 390, height: 800 } });
    try {
      await narrow.route("https://crop.test/**", (route) => route.fulfill({ contentType: "text/html", body: PAGE.slice(0, PAGE.indexOf("<body>") + 6) + (
        `<style>main{display:grid;gap:24px;padding:16px}.reference{max-width:900px;width:100%;margin:auto}</style><main><div class="reference"><d-crop to="#desktop-toolbar" width="900">${WINDOW()}</d-crop></div>`
        + `<d-compare layout="side" recommended="A"><section data-option="A"><d-crop to="#desktop-toolbar" width="900">${WINDOW()}</d-crop></section><section data-option="B"><d-crop to="#desktop-toolbar" width="900">${WINDOW()}</d-crop></section></d-compare></main></body></html>`) }));
      await narrow.goto("https://crop.test/");
      await narrow.waitForTimeout(1500);
      const seen = await narrow.evaluate(() => ({ wide: document.documentElement.scrollWidth, crops: [...document.querySelectorAll("d-crop")].map((crop) => Math.round(crop.getBoundingClientRect().width)) }));
      expect(seen.wide).toBe(390);
      expect(seen.crops.length).toBe(3);
      for (const width of seen.crops) { expect(width).toBeGreaterThan(200); expect(width).toBeLessThanOrEqual(358); }
      expect((await narrow.evaluate(LOOK_MEASURE) as LookMeasure).issues).toEqual([]);
      // With room, the piece is drawn at its own size again.
      await narrow.setViewportSize({ width: 1280, height: 800 });
      await narrow.waitForTimeout(600);
      expect(await narrow.evaluate(() => Math.round(document.querySelector(".reference d-crop")!.getBoundingClientRect().width))).toBeGreaterThan(600);
    } finally { await narrow.close(); }
  });
});
