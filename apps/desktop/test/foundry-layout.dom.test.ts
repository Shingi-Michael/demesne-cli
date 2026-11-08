import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { LOOK_MEASURE, type LookMeasure } from "../electron/foundry-look-measure.ts";

// Pass 200 A: Foundry's look names a crooked layout, and stays quiet on an even one.
const page = (crooked: boolean) => `<!doctype html><html><head><style>
body{margin:0;font:14px/1.45 system-ui;background:#f7f6f3;color:#1d1d1f}
.pg{padding:${crooked ? "28px 18px 32px 40px" : "28px 32px 32px"}}
h1{margin:0 0 4px 0;font-size:22px}${crooked ? "h1{margin-left:-3px}" : ""}
p{margin:0 0 20px}
.stats,.row2{display:grid;gap:16px;margin-bottom:16px}
.stats{grid-template-columns:${crooked ? "1.05fr 1fr .95fr;gap:14px 22px;align-items:start" : "repeat(3,1fr)"}}
.row2{grid-template-columns:2fr 1fr${crooked ? ";align-items:start" : ""}}
.c{background:#fff;border-radius:12px;padding:16px}
${crooked ? ".stats .c:nth-child(2){padding:20px 14px 12px;margin-top:6px}" : ""}
.bars{height:120px}
</style></head><body><div class="pg"><h1>Roastery this week</h1><p>Orders, beans and what's running low</p>
<div class="stats"><div class="c"><small>Orders</small><b>412</b></div><div class="c"><small>Revenue</small><b>$9,840</b></div><div class="c"><small>Subscribers</small><b>1,206</b></div></div>
<div class="row2"><div class="c"><small>Orders by day</small><div class="bars"></div></div><div class="c"><small>Running low</small><div>Ethiopia Guji</div></div></div>
</div></body></html>`;

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("Foundry's look sees a crooked layout", () => {
  let browser: Browser, tab: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined, executablePath: process.env.DEMESNE_CHROMIUM || undefined });
    tab = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  });
  afterAll(async () => { await browser?.close(); });
  const issues = async (crooked: boolean) => { await tab.setContent(page(crooked)); return (await tab.evaluate(LOOK_MEASURE) as LookMeasure).issues; };

  test("a crooked dashboard: off-top cards, uneven gaps, near-equal widths, uneven margins, a title off its edge", async () => {
    const found = await issues(true);
    expect(found.some((text) => text.startsWith("Cards side by side don't line up at the top"))).toBe(true);
    expect(found.some((text) => text.startsWith("Left and right margins differ: 40px vs 18px"))).toBe(true);
    expect(found.some((text) => /h1 "Roastery this week" starts 3px left of the edge/.test(text))).toBe(true);
    expect(found.length).toBeLessThanOrEqual(12);
  });

  test("the same dashboard laid out evenly has nothing to say", async () => {
    expect(await issues(false)).toEqual([]);
  });

  test("a deliberate 2fr/1fr row with cards of clearly different heights is left alone", async () => {
    await tab.setContent(`<div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;padding:32px;align-items:start"><div style="background:#fff;height:300px">Chart</div><div style="background:#fff;height:120px">Side</div></div>`);
    expect((await tab.evaluate(LOOK_MEASURE) as LookMeasure).issues).toEqual([]);
  });
});
