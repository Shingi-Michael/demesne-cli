import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { LOOK_MEASURE, type LookMeasure } from "../electron/foundry-look-measure.ts";
import { scopeAppStyles } from "../foundry-kit/scope-app.ts";

// Pass 180: a mockup built on the parts is something to use at real size.
const kit = (name: string) => readFileSync(resolve(import.meta.dir, "../foundry-kit", name), "utf8");
// Demesne's own styles, as the app's build writes them to kit/app.css.
const appStyles = scopeAppStyles(["workspace/ui.css", "workspace/live.css", "desktop.css", "workspace.css"].map((file) => readFileSync(resolve(import.meta.dir, "..", file), "utf8"))).replace(/@font-face\{[^}]*\}/g, "");
const PAGE = `<!doctype html><html><head><style>${kit("base.css").replace(/@font-face\{[^}]*\}/g, "")}</style><style data-demesne-app>${appStyles}</style><script>${kit("parts.js")}</script></head><body style="margin:0">
<d-compare recommended="A">
<section data-option="A · Pills" note="calm"><d-demesne tabs="Calmer tabs|Settings" chats="Calmer tabs|Tidy the sidebar" chat="Calmer tabs" height="480">
<div data-view="Calmer tabs"><d-message from="you">Make the tabs calmer</d-message><d-message meta="gpt-6.1 · 4s">Pills. <button data-go="Settings">Open settings</button></d-message></div>
<div data-view="Settings"><d-row title="Keep awake"><d-toggle on></d-toggle></d-row></div>
<div data-view="Tidy the sidebar"><d-message from="you">tidy it</d-message></div>
<d-composer reply="Done, the dot is pink now.|Sure."></d-composer></d-demesne></section>
<section data-option="B · Underline"><d-demesne tabs="Calmer tabs"><d-composer></d-composer></d-demesne></section>
</d-compare></body></html>`;

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("Foundry parts you can use", () => {
  let browser: Browser, page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined, executablePath: process.env.DEMESNE_CHROMIUM || undefined });
    page = await browser.newPage({ viewport: { width: 620, height: 700 } });
    await page.setContent(PAGE);
  });
  afterAll(async () => { await browser?.close(); });
  const shell = () => page.locator('section[data-option="A · Pills"] d-demesne');
  const views = () => shell().evaluate((el) => [...el.querySelectorAll<HTMLElement>("[data-view]")].filter((view) => !view.hidden).map((view) => view.dataset.view));
  const activeTab = () => shell().locator(".bar-tab.on .bar-tab-name").textContent();

  test("in a pane-wide page Demesne lays out at the width it has instead of shrinking", async () => {
    expect(await shell().evaluate((el) => [getComputedStyle(el.querySelector("d-app")!).zoom, el.classList.contains("dp-narrow")])).toEqual(["1", true]);
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.waitForTimeout(100);
    // A little narrower than its 1100 design: scaled, never under 85%.
    expect(Number(await shell().evaluate((el) => getComputedStyle(el.querySelector("d-app")!).zoom))).toBeGreaterThanOrEqual(0.85);
    await page.setViewportSize({ width: 620, height: 700 });
    await page.waitForTimeout(100);
  });

  test("options are a strip on top, one at a time, recommended first", async () => {
    expect(await page.locator("d-compare > section").evaluateAll((all) => all.map((el) => !(el as HTMLElement).hidden))).toEqual([true, false]);
    expect(await page.locator(".dp-pick").count()).toBe(0);
    await page.locator(".dp-strip").getByRole("tab", { name: "B · Underline" }).click();
    expect(await page.locator("d-compare > section").evaluateAll((all) => all.map((el) => !(el as HTMLElement).hidden))).toEqual([false, true]);
    await page.locator(".dp-strip").getByRole("tab", { name: /A · Pills/ }).click();
  });

  test("tabs, chats and links go to the view of their name", async () => {
    expect(await views()).toEqual(["Calmer tabs"]);
    await page.getByRole("button", { name: "Open settings" }).click();
    expect(await views()).toEqual(["Settings"]);
    expect(await activeTab()).toBe("Settings");
    await shell().locator("#desktop-sidebar").getByRole("button", { name: "Tidy the sidebar", exact: true }).click();
    expect(await views()).toEqual(["Tidy the sidebar"]);
    // A chat with no tab of its own takes over the open tab, as Demesne does.
    expect(await activeTab()).toBe("Tidy the sidebar");
    await shell().getByRole("tab", { name: "Calmer tabs" }).click();
    expect(await views()).toEqual(["Calmer tabs"]);
  });

  test("the composer takes typing and answers", async () => {
    const input = shell().locator("#composer textarea");
    await input.fill("make the dot pink");
    await input.press("Enter");
    await shell().locator(".request .text").filter({ hasText: "make the dot pink" }).waitFor();
    await shell().locator(".answer .markdown").filter({ hasText: "Done, the dot is pink now." }).waitFor();
    expect(await input.inputValue()).toBe("");
  });

  test("Demesne is drawn with the app's own markup and styles, and the kit stops at its window (pass 220 A)", async () => {
    const drawn = await shell().evaluate((el) => {
      const app = el.querySelector("d-app")!, css = (selector: string) => getComputedStyle(app.querySelector(selector)!);
      const outside = document.createElement("button"); outside.textContent = "kit"; document.body.appendChild(outside);
      const inside = document.createElement("button"); inside.className = "probe"; app.querySelector("#conversation")!.appendChild(inside);
      const kit = [getComputedStyle(outside).paddingLeft, getComputedStyle(inside).paddingLeft];
      outside.remove(); inside.remove();
      return { sidebar: css("#desktop-sidebar").position, session: css(".sidebar-session-name").fontSize, bubble: [css(".request").borderRadius, css(".request .text").borderRadius].some((radius) => radius !== "0px"),
        mark: !!app.querySelector(".answer-mark use, .answer-mark svg"), composer: css("#composer .composer-box").borderRadius, kit, old: el.querySelectorAll(".dm-app, .dm-tabs, .dm-nav, .dm-chat, .dm-card, d-sidebar").length,
        theme: app.getAttribute("data-theme"), body: app.querySelector("d-body")!.className };
    });
    expect(drawn.old).toBe(0);
    expect(drawn.body).toBe("desktop");
    expect(drawn.theme).toMatch(/^demesne/);
    expect(drawn.session).toBe("14px");
    expect(drawn.bubble).toBe(true);
    expect(drawn.mark).toBe(true);
    expect(drawn.composer).not.toBe("0px");
    // The kit pads a plain button; inside the window it does not reach.
    expect(drawn.kit[0]).not.toBe("0px");
    expect(drawn.kit[1]).toBe("0px");
  });

  test("the look catches text drawn too small, even when it says 14px", async () => {
    const shrunk = await browser.newPage({ viewport: { width: 600, height: 400 } });
    await shrunk.setContent('<div style="zoom:.5"><p style="font-size:14px">Tiny words</p></div>');
    const measured = await shrunk.evaluate(LOOK_MEASURE) as LookMeasure;
    expect(measured.issues.some((issue) => issue.startsWith("Text drawn at 7.0px"))).toBe(true);
    await shrunk.close();
  });
});
