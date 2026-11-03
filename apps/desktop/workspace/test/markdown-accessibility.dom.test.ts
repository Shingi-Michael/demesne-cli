import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("semantic math DOM", () => {
  let browser: Browser, page: Page, script: string;
  let errors: string[];
  beforeAll(async () => {
    // Bundle the actual renderer and its sanitizer/KaTeX dependencies in memory.
    const build = await Bun.build({ entrypoints: [new URL("../markdown.ts", import.meta.url).pathname], target: "browser", format: "esm" });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    script = await build.outputs[0]!.text();
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined });
  }, 20_000);
  beforeEach(async () => {
    page = await browser.newPage();
    errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<!doctype html><div id="output"></div>');
    await page.addStyleTag({ content: readFileSync(new URL("../../node_modules/katex/dist/katex.min.css", import.meta.url), "utf8") });
    await page.evaluate(async source => {
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      try { (window as any).MarkdownUI = await import(url); }
      finally { URL.revokeObjectURL(url); }
    }, script);
  });
  afterEach(async () => { await page?.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); });
  const render = (raw: string) => page.evaluate(raw => {
    document.getElementById("output")!.innerHTML = (window as any).MarkdownUI.markdown(raw);
  }, raw);

  test("inline and display formulas keep semantic MathML through HTML serialization and cache reuse", async () => {
    const raw = 'Inline $x^2$\n\n$$\\frac{1}{2}$$';
    await render(raw);
    expect(await page.locator("math").count()).toBe(2);
    expect(await page.locator('math[display="block"]').count()).toBe(1);
    expect(await page.locator("math msup").count()).toBe(1);
    expect(await page.locator("math mfrac").count()).toBe(1);
    expect(await page.locator('.katex-html[aria-hidden="true"]').count()).toBe(2);
    expect(await page.locator(".katex-mathml").first().evaluate(node => ({ position: getComputedStyle(node).position, width: getComputedStyle(node).width }))).toEqual({ position: "absolute", width: "1px" });
    const html = await page.locator("#output").innerHTML();
    await render(raw);
    expect(await page.locator("#output").innerHTML()).toBe(html);
    expect(await page.locator("math").first().evaluate(node => node.namespaceURI)).toBe("http://www.w3.org/1998/Math/MathML");
    expect(await page.locator("#output").ariaSnapshot()).toContain("math");
  });

  test("streamed fades never inject HTML into MathML or KaTeX layout, while ordinary text still fades", async () => {
    await page.evaluate(() => {
      const view = new (window as any).MarkdownUI.MarkdownView();
      (window as any).view = view;
      document.getElementById("output")!.append(view.element);
      view.update('Stable $x^2$.\n\nNew ', true);
      (window as any).stableMath = view.element.querySelector('math');
      view.update('Stable $x^2$.\n\nNew $\\frac{1}{2}$ words.', true);
    });
    expect(await page.locator("math").count()).toBe(2);
    expect(await page.locator(".math .md-in").count()).toBe(0);
    expect(await page.locator(".md-in").count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).stableMath === document.querySelector("math"))).toBe(true);
    const namespaces = await page.locator("math").evaluateAll(nodes => nodes.flatMap(node => [...node.querySelectorAll("*")].map(child => child.namespaceURI)));
    expect(namespaces.every(namespace => namespace === "http://www.w3.org/1998/Math/MathML")).toBe(true);
    await page.evaluate(() => (window as any).view.update('Stable $x^2$.\n\nNew $\\frac{1}{3}$ words. Done.', false));
    expect(await page.locator(".math .md-in").count()).toBe(0);
    expect(await page.locator("math mfrac").textContent()).toBe("13");
  });

  test("invalid formulas remain readable; raw HTML and unsafe math links remain inert", async () => {
    await render('$\\frac{$\n\n$\\href{javascript:alert(1)}{unsafe}$\n\n<script>alert(1)</script>');
    expect(await page.locator(".katex-error").textContent()).toBe("\\frac{");
    expect(await page.locator("#output a, #output script").count()).toBe(0);
    expect(await page.locator("#output").textContent()).toContain("<script>alert(1)</script>");
  });

  test("prices and code are not interpreted as math", async () => {
    await render('Prices $5 and $10. Code `echo $HOME $PATH`.\n\n```sh\necho $a $b\n```');
    expect(await page.locator("math, .math").count()).toBe(0);
    expect(await page.locator("pre code").textContent()).toContain("echo $a $b");
  });
});
