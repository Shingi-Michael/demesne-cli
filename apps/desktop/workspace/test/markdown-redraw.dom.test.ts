import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

// Opt-in, in-memory renderer bundle. No daemon, app build, browser download or
// Electron launch. These checks do not verify Windows acrylic/compositor paint.
describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("Windows opt-in Markdown DOM reconciliation", () => {
  let browser: Browser, page: Page, script: string, errors: string[];
  beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("../markdown.ts", import.meta.url))], target: "browser", format: "esm" });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    script = await build.outputs[0]!.text();
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined });
  }, 20_000);
  beforeEach(async () => {
    page = await browser.newPage({ reducedMotion: "no-preference" }); errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<!doctype html><div id="output"></div>');
    await page.addStyleTag({ content: readFileSync(new URL("../live.css", import.meta.url), "utf8") + readFileSync(new URL("../../workspace.css", import.meta.url), "utf8") + '\n.md-scroll{width:160px;overflow:auto} table{white-space:nowrap}' });
    await page.evaluate(async source => {
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      try { (window as any).MarkdownUI = await import(url); }
      finally { URL.revokeObjectURL(url); }
      const ui = (window as any).MarkdownUI;
      const view = new ui.MarkdownView({ preserveNodes: true });
      (window as any).view = view;
      document.getElementById("output")!.append(view.element);
      (window as any).normalized = () => {
        const copy = view.element.cloneNode(true) as HTMLElement;
        for (const fade of copy.querySelectorAll(".md-in")) fade.replaceWith(...fade.childNodes);
        const walker = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT), comments: Node[] = [];
        while (walker.nextNode()) comments.push(walker.currentNode);
        for (const comment of comments) comment.parentNode!.removeChild(comment);
        return copy.innerHTML;
      };
    }, script);
  });
  afterEach(async () => { await page?.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); });
  const update = (raw: string, fade = false) => page.evaluate(({ raw, fade }) => (window as any).view.update(raw, fade), { raw, fade });
  const matchesStatic = (raw: string) => page.evaluate(raw => (window as any).normalized() === (window as any).MarkdownUI.markdown(raw), raw);

  test("stream append retains the current paragraph, text, finished blocks and identical-update no-ops", async () => {
    await update("Finished.\n\nCurrent");
    const result = await page.evaluate(() => {
      const view = (window as any).view, finished = view.element.querySelector("p"), current = view.element.querySelectorAll("p")[1], text = current.firstChild;
      const observer = new MutationObserver(() => {}); observer.observe(view.element, { subtree: true, childList: true, characterData: true, attributes: true });
      view.update("Finished.\n\nCurrent words");
      const mutations = observer.takeRecords();
      const retained = finished === view.element.querySelector("p") && current === view.element.querySelectorAll("p")[1] && text === current.firstChild;
      const unchanged = view.update("Finished.\n\nCurrent words", true);
      return { retained, removals: mutations.flatMap(record => [...record.removedNodes]).length, changedText: mutations.some(record => record.type === "characterData"), unchanged, noops: observer.takeRecords().length };
    });
    expect(result).toEqual({ retained: true, removals: 0, changedText: true, unchanged: false, noops: 0 });
    expect(await matchesStatic("Finished.\n\nCurrent words")).toBe(true);
  });

  test("format, list, reference, setext and fence transitions match the unchanged sanitizer pipeline", async () => {
    const transitions = [
      "Hello **bol", "Hello **bold** and *em*.", "Title\n---\n\nBody",
      "- [ ] first\n- second", "- [x] first\n- second\n\n  loose paragraph",
      "[a][ref]\n\n[ref]: /first", "[a][ref]\n\n[ref]: /second",
      "```ts\nconst n =", "```ts\nconst n = 1;\n```", "```ts\nconst n = 2;\n```\n\nDone.",
    ];
    for (const raw of transitions) {
      await update(raw, true);
      expect(await matchesStatic(raw)).toBe(true);
    }
    expect(await page.locator("pre code .hljs-keyword").count()).toBeGreaterThan(0);
    expect(await page.locator('[data-action="copy-code"]').count()).toBe(1);
  });

  test("tables keep their scroll host, controls and existing rows while rows stream in", async () => {
    const first = "| Long option name | Quantity |\n| --- | ---: |\n| A very wide first option | 10 |";
    await update(first);
    const result = await page.evaluate(raw => {
      const view = (window as any).view, scroll = view.element.querySelector(".md-scroll"), table = view.element.querySelector("table"), row = view.element.querySelector("tbody tr"), copy = view.element.querySelector('[data-action="copy-table"]');
      scroll.scrollLeft = 40;
      const left = scroll.scrollLeft;
      view.update(raw + "\n| A second option | 20 |");
      return { scroll: scroll === view.element.querySelector(".md-scroll"), table: table === view.element.querySelector("table"), row: row === view.element.querySelector("tbody tr"), copy: copy === view.element.querySelector('[data-action="copy-table"]'), left, after: scroll.scrollLeft };
    }, first);
    expect(result.scroll && result.table && result.row && result.copy).toBe(true);
    expect(result.left).toBeGreaterThan(0);
    expect(result.after).toBe(result.left);
    expect(await matchesStatic(first + "\n| A second option | 20 |")).toBe(true);
  });

  test("same-block math keeps its identity and MathML namespace; changed formulas remain atomic and safe", async () => {
    await update("Math $x^2$ and text");
    await page.evaluate(() => { (window as any).math = document.querySelector(".math"); });
    await update("Math $x^2$ and text grows", true);
    expect(await page.evaluate(() => (window as any).math === document.querySelector(".math"))).toBe(true);
    const raw = "Math $\\frac{1}{2}$ and text grows. <script>alert(1)</script> [unsafe](javascript:alert(1))";
    await update(raw, true);
    expect(await page.evaluate(() => (window as any).math === document.querySelector(".math"))).toBe(false);
    expect(await page.locator("math mfrac").textContent()).toBe("12");
    expect(await page.locator(".math .md-in, script, a[href^='javascript:']").count()).toBe(0);
    expect(await page.locator("math").evaluate(node => [...node.querySelectorAll("*")].every(child => child.namespaceURI === "http://www.w3.org/1998/Math/MathML"))).toBe(true);
    expect(await matchesStatic(raw)).toBe(true);
  });

  test("retained fade runs continue their timeline, new words retain adaptive duration, final updates finish fades", async () => {
    await page.evaluate(() => {
      (window as any).now = 1000;
      Object.defineProperty(performance, "now", { configurable: true, value: () => (window as any).now });
      (window as any).view.update("Hello", true);
      (window as any).fade = document.querySelector(".md-in");
    });
    await page.waitForTimeout(40);
    const result = await page.evaluate(() => {
      const view = (window as any).view, span = (window as any).fade, animation = span.getAnimations()[0], time = animation?.currentTime;
      (window as any).now += 40;
      view.update("Hello there", true);
      const second = [...view.element.querySelectorAll(".md-in")].find((node: any) => node !== span) as HTMLElement;
      return { retained: view.element.querySelector(".md-in") === span, delay: span.style.animationDelay, duration: span.style.animationDuration, second: second.style.animationDuration, timeline: Boolean(animation && animation === span.getAnimations()[0] && animation.currentTime! >= time!) };
    });
    expect(result).toEqual({ retained: true, delay: "0ms", duration: "300ms", second: "120ms", timeline: true });
    await page.evaluate(() => { (window as any).now += 20; (window as any).view.update("Hello there!", false); });
    expect(await page.locator(".md-in").count()).toBeGreaterThan(0);
    expect(await matchesStatic("Hello there!")).toBe(true);
  });

  test("default and explicit false preserve the non-Windows replacement path", async () => {
    const result = await page.evaluate(() => {
      const UI = (window as any).MarkdownUI;
      return [undefined, { preserveNodes: false }].map(options => {
        const view = new UI.MarkdownView(options);
        document.body.append(view.element); view.update("Current");
        const p = view.element.querySelector("p"); view.update("Current words");
        return p !== view.element.querySelector("p") && view.element.textContent === "Current words\n";
      });
    });
    expect(result).toEqual([true, true]);
  });
});
