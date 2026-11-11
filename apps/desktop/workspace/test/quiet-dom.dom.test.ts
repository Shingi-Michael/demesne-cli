import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

// Writes that change nothing are skipped; real changes still land.
describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("quiet DOM writes", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined }); });
  afterAll(async () => { await browser?.close(); });

  test("same-value writes queue no mutation, changes still land", async () => {
    const source = await Bun.file(new URL("../quiet-dom.ts", import.meta.url)).text();
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source).replace("export function", "function");
    const page = await browser.newPage();
    await page.setContent('<div id="a" class="x" title="t" role="note" hidden></div>');
    await page.addScriptTag({ content: `${code}\nwindow.quietDom = quietDom;` });
    const result = await page.evaluate(async () => {
      (window as any).quietDom();
      const a = document.getElementById("a")!, records: string[] = [];
      const observer = new MutationObserver((list) => list.forEach((m) => records.push(m.attributeName!)));
      observer.observe(a, { attributes: true });
      a.hidden = true; a.className = "x"; a.title = "t"; a.setAttribute("role", "note");
      await Promise.resolve();
      const unchanged = records.splice(0);
      a.hidden = false; a.className = "y"; a.title = "u"; a.setAttribute("role", "status");
      await Promise.resolve();
      return { unchanged, changed: records, hidden: a.hidden, cls: a.className, title: a.title, role: a.getAttribute("role") };
    });
    expect(result.unchanged).toEqual([]);
    expect(result.changed.sort()).toEqual(["class", "hidden", "role", "title"]);
    expect(result).toMatchObject({ hidden: false, cls: "y", title: "u", role: "status" });
    await page.close();
  });
});
