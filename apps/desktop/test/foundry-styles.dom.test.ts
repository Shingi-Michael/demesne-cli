import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

// Pass 246 A, a range of styles: the page is written once on the kit's values
// and <d-styles> sets them. On its own (the model's look) the page is drawn in
// the recommended style, and the styles themselves draw nothing.
const kit = (name: string) => readFileSync(resolve(import.meta.dir, "../foundry-kit", name), "utf8");
const page = (recommended: string) => `<!doctype html><html><head><style>${kit("base.css").replace(/@font-face\{[^}]*\}/g, "")}</style><script>${kit("parts.js")}</script></head><body>
<d-styles recommended="${recommended}">
<d-style name="Clean counter" made="Inter throughout" vars="--paper:#ffffff; --ink:#111417; --accent:#1f6f4a; --head:Inter,sans-serif; --font:Inter,sans-serif; --radius:8px"></d-style>
<d-style name="Roastery label" made="Mono headings" vars="--paper:#1d1613; --ink:#f3e9da; --accent:#e0a93b; --head:'Courier New',monospace; --font:Arial,sans-serif; --radius:2px; --bad:url(http://x/y); color:red"></d-style>
</d-styles><h1>Checkout</h1><p>Two bags a month</p><button class="primary">Pay €200</button></body></html>`;

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("a page of styles, drawn by the kit", () => {
  let browser: Browser, tab: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined, executablePath: process.env.DEMESNE_CHROMIUM || undefined });
    tab = await browser.newPage({ viewport: { width: 760, height: 500 } });
  });
  afterAll(async () => { await browser?.close(); });
  const look = () => tab.evaluate(() => {
    const root = document.documentElement, button = getComputedStyle(document.querySelector("button")!);
    return { style: root.dataset.style, paper: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color, head: getComputedStyle(document.querySelector("h1")!).fontFamily,
      body: getComputedStyle(document.querySelector("p")!).fontFamily, button: button.backgroundColor, on: button.color, corner: button.borderRadius, scheme: root.style.colorScheme,
      large: root.style.getPropertyValue("--radius-lg"), bad: root.style.getPropertyValue("--bad"), shown: getComputedStyle(document.querySelector("d-styles")!).display };
  });

  test("the recommended style is the one drawn, with the kit following its values", async () => {
    await tab.setContent(page("Roastery"));
    expect(await look()).toEqual({ style: "Roastery label", paper: "rgb(29, 22, 19)", ink: "rgb(243, 233, 218)", head: '"Courier New", monospace', body: "Arial, sans-serif",
      button: "rgb(224, 169, 59)", on: "rgb(17, 17, 17)", corner: "2px", scheme: "dark", large: "calc(2px * 1.5)", bad: "", shown: "none" });
  });

  test("another pick draws the other style; no pick draws the first", async () => {
    // A fresh tab each time: the kit defines its parts once per window.
    await tab.close(); tab = await browser.newPage({ viewport: { width: 760, height: 500 } });
    await tab.setContent(page("Clean counter"));
    expect(await look()).toMatchObject({ style: "Clean counter", paper: "rgb(255, 255, 255)", button: "rgb(31, 111, 74)", on: "rgb(255, 255, 255)", corner: "8px", scheme: "light" });
    await tab.close(); tab = await browser.newPage({ viewport: { width: 760, height: 500 } });
    await tab.setContent(page(""));
    expect((await look()).style).toBe("Clean counter");
  });
});
