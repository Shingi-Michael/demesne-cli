import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

// Pass 240 A: a review starts from the real screen. <d-shot> shows a picture
// the chat took, at its own size: the whole screen with each part outlined
// and numbered where it sits, and each part's Today cut from it.
const kit = (name: string) => readFileSync(resolve(import.meta.dir, "../foundry-kit", name), "utf8");
// A screen to take a picture of: a top bar 40pt tall, a sidebar 180pt wide, at 2x.
const SCREEN = `<body style="margin:0;width:720px;height:450px;font:13px system-ui"><div style="height:40px;background:#333;color:#fff">Top bar</div><div style="display:flex;height:410px"><nav style="width:180px;background:#ddd">Chats</nav><main style="flex:1;background:#fff">Chat</main></div></body>`;
const page = (shots: string) => `<!doctype html><html><head><style>${kit("base.css").replace(/@font-face\{[^}]*\}/g, "")}</style><script>window.__demesneShots=${shots};</script><script>${kit("parts.js")}</script></head><body>
<d-review>
<section data-today><d-shot src="s1" marks="0,0,1440,80 | 0,80,360,820"></d-shot></section>
<section data-part="Top bar" why="It is one dark block.">
<d-compare recommended="Lighter">
<section data-option="Today"><d-shot src="s1" box="0,0,1440,80"></d-shot></section>
<section data-option="Lighter"><div style="height:40px;background:#eee">Top bar</div></section>
<section data-option="Gone"><div style="height:8px"></div></section>
</d-compare></section>
<section data-part="Sidebar" why="It reads as a wall.">
<d-compare recommended="Quiet">
<section data-option="Today"><d-shot src="s1" box="0,80,360,820" pad="0"></d-shot></section>
<section data-option="Quiet"><nav style="width:180px;height:410px">Chats</nav></section>
<section data-option="Folded"><nav style="width:40px;height:410px"></nav></section>
</d-compare></section>
</d-review><d-shot id="gone" src="missing"></d-shot></body></html>`;

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("A real picture in a review", () => {
  let browser: Browser, view: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined, executablePath: process.env.DEMESNE_CHROMIUM || undefined });
    const shooter = await browser.newPage({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
    await shooter.setContent(SCREEN);
    const png = await shooter.screenshot();
    const url = `data:image/png;base64,${png.toString("base64")}`;
    view = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    await view.route("https://review.test/**", (route) => route.fulfill({ contentType: "text/html", body: page(JSON.stringify({ s1: { url, width: 1440, height: 900, scale: 2 } })) }));
    await view.goto("https://review.test/");
    await view.waitForTimeout(1500);
  });
  afterAll(async () => { await browser?.close(); });

  test("the screen as it is shows at its own size, each part outlined and numbered where it sits", async () => {
    const got = await view.evaluate(() => {
      const shot = document.querySelector("[data-today] d-shot")!.getBoundingClientRect();
      const rings = [...document.querySelectorAll(".dr-ring")].map((ring) => { const at = ring.getBoundingClientRect(); return { n: ring.textContent, x: Math.round(at.left - shot.left), y: Math.round(at.top - shot.top), w: Math.round(at.width), h: Math.round(at.height) }; });
      return { width: Math.round(shot.width), height: Math.round(shot.height), rings };
    });
    // 1440 pixels at 2x is 720 points wide, never stretched to the room there is.
    expect(got.width).toBe(720);
    expect(got.height).toBe(450);
    // The outlines sit 3px outside each piece (the drawn review's rule).
    expect(got.rings).toEqual([{ n: "1", x: -3, y: -3, w: 726, h: 46 }, { n: "2", x: -3, y: 37, w: 186, h: 416 }]);
  });

  test("each part's Today is that piece cut from the picture, at its own size", async () => {
    const cuts = await view.evaluate(() => [...document.querySelectorAll("[data-part] [data-option=Today] d-shot")].map((shot) => {
      const at = shot.getBoundingClientRect(), image = shot.querySelector("img")!.getBoundingClientRect();
      return { w: Math.round(at.width), h: Math.round(at.height), x: Math.round(image.left - at.left), y: Math.round(image.top - at.top), iw: Math.round(image.width) };
    }));
    // The top bar with 8pt of room below it (none above or beside: that is the picture's edge).
    expect(cuts[0]).toEqual({ w: 720, h: 48, x: 0, y: 0, iw: 720 });
    // The sidebar with no room, the picture moved up by the bar.
    expect(cuts[1]).toEqual({ w: 180, h: 410, x: 0, y: -40, iw: 720 });
    // The picture is really there: its pixels decoded.
    expect(await view.evaluate(() => [...document.querySelectorAll("d-shot img")].every((image) => (image as HTMLImageElement).naturalWidth === 1440))).toBe(true);
  });

  test("a wide piece puts the options one under another, and a picture that is not kept says so", async () => {
    expect(await view.evaluate(() => document.querySelector("[data-part='Top bar'] d-compare")!.classList.contains("dr-wide"))).toBe(true);
    expect(await view.locator("#gone").innerText()).toBe("This picture is not kept with the mockup.");
  });
});
