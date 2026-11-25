import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { specMeasure, type SpecMeasure } from "../electron/foundry-spec-measure.ts";

// Piece 7 of pass 274: a mockup measured for a hand-off, in a real page.
const PAGE = `<!doctype html><html><head><style>
body{margin:0;font:16px/24px Georgia,serif;background:#f6f4ee;color:#1a1f1c}
main{padding:48px 96px;display:flex;flex-direction:column;gap:24px}
h1{margin:0;font:700 40px/44px Georgia,serif}
.slots{display:grid;grid-template-columns:repeat(3,120px);gap:8px}
.slot{padding:8px 16px;border:1px solid rgba(26,31,28,.2);border-radius:10px;background:#fff}
.book{align-self:start;padding:10px 20px;border:0;border-radius:10px;background:#0b6e4f;color:#fff;font:600 16px/24px Georgia,serif;transition:background-color 160ms ease-out}
.sheet{animation:rise 240ms cubic-bezier(.2,.8,.2,1) 40ms both}
@keyframes rise{from{transform:translateY(100%)}to{transform:none}}
.hidden{display:none}
.book:hover{transition:transform 90ms}.nowhere{transition:opacity 1s}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body><main><h1>Book a visit</h1><p>Pick a time that suits you at Harbor Clinic.</p>
<div class="slots hidden"><div class="slot">hidden</div></div>
<div class="slots"><div class="slot">9:00</div><div class="slot">9:30</div><div class="slot">10:00</div></div>
<button class="book">Book the visit</button><div class="sheet">You are booked.</div></main></body></html>`;

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("Foundry measures a mockup for a hand-off", () => {
  let browser: Browser, tab: Page, spec: SpecMeasure;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined, executablePath: process.env.DEMESNE_CHROMIUM || undefined });
    tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await tab.setContent(PAGE);
    spec = await tab.evaluate(specMeasure([{ name: "Book button", at: ".book" }, { name: "Slots", at: ".slots" }, { name: "Gone", at: ".nowhere" }, { name: "Bad", at: "[[" }])) as SpecMeasure;
  });
  afterAll(async () => { await browser?.close(); });

  test("the page, its colours by use, its type with a sample", () => {
    expect(spec.page).toMatchObject({ width: 1280, background: "#f6f4ee", color: "#1a1f1c", font: "16px/24px Georgia" });
    const colour = (value: string) => spec.colours.find((one) => one.value === value);
    expect(colour("#f6f4ee")?.uses).toContain("ground");
    expect(colour("#0b6e4f")?.uses).toEqual(["button"]);
    expect(colour("#1a1f1c at 20%")?.uses).toEqual(["line"]);
    expect(spec.type.find((one) => one.size === "40px")).toMatchObject({ font: "Georgia", weight: "700", line: "44px", sample: "Book a visit" });
    expect(spec.spacing).toEqual(expect.arrayContaining([8, 16, 24, 48, 96]));
    expect(spec.radii).toEqual(["10px"]);
    expect(spec.words.slice(0, 2)).toEqual(["Book a visit", "Pick a time that suits you at Harbor Clinic."]);
    expect(spec.words).not.toContain("hidden");
  });

  test("each named part: where it is, how big, its type, colours, padding and corners", () => {
    const [button, slots, gone, bad] = spec.parts;
    expect(button).toMatchObject({ name: "Book button", tag: "button", text: "Book the visit", x: 96, height: 44, font: "600 16px/24px Georgia", color: "#ffffff", background: "#0b6e4f", padding: "10px 20px", radius: "10px" });
    // The first match that is drawn, not the hidden one before it.
    expect(slots).toMatchObject({ name: "Slots", width: 1088, gap: "8px", layout: "grid 3 columns", background: "none, on #f6f4ee" });
    expect(gone).toEqual({ name: "Gone", missing: true } as never);
    expect(bad).toEqual({ name: "Bad", missing: true } as never);
  });

  test("how it moves: transitions and animations with their timing", () => {
    expect(spec.motion).toContainEqual({ on: ".book", what: "background-color", duration: "160ms", easing: "ease-out", delay: "0ms" });
    expect(spec.motion).toContainEqual({ on: ".sheet", what: "animation", name: "rise", duration: "240ms", easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", delay: "40ms", frames: "0% transform: translateY(100%) → 100% transform: none" });
  });

  test("a hover rule counts, a rule that matches nothing does not", () => {
    expect(spec.motion.map((one) => one.on)).toEqual([".book", ".sheet", ".book:hover"]);
  });

  test("nothing named: the page's own landmarks stand in", async () => {
    const bare = await tab.evaluate(specMeasure()) as SpecMeasure;
    expect(bare.parts.map((part) => part.name)).toEqual(['h1 "Book a visit"', 'button.book "Book the visit"']);
  });
});
