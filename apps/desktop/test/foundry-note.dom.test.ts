import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

// Pass 233 A, pass 242 A: the script Demesne puts in a mockup's frame says
// where the pointer is, turns a click into a pin held by the smallest piece
// under it, says where the noted parts are, and draws nothing.
const NOTE = readFileSync(join(import.meta.dir, "../foundry-kit/note.js"), "utf8");
const mockup = `<!doctype html><html><head><style>
body{margin:0;font:14px system-ui}.app{padding:16px}.bar{display:flex;gap:8px;height:40px;align-items:center}
.card{width:220px;padding:14px;margin-top:12px;background:#eee;border-radius:10px}.card i{display:inline-block;width:10px;height:10px;background:#c33;border-radius:50%}
.row{display:flex;height:32px;align-items:center}.row span{flex:1}
</style></head><body><main><div class="app">
<nav class="bar"><button id="save">Save</button><a href="#" class="more">More</a></nav>
<div class="card" id="overdue"><h3>Overdue</h3><div><i></i> <span class="n">12 invoices</span></div></div>
<ul><li class="row"><span>Acme <em>new</em></span><button aria-label="Open Acme">›</button></li><li class="row"><span>Globex</span></li></ul>
<button class="deck-next" id="next">Next</button>
<div data-chrome aria-hidden="true" style="position:fixed;right:0;bottom:0;width:30px;height:30px"></div>
</div></main><script>window.pressed = []; document.addEventListener("click", (e) => pressed.push(e.target.id || e.target.tagName));</script><script>${NOTE.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("a mockup's frame says where the pointer is and pins where you click", () => {
  let browser: Browser, tab: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined, executablePath: process.env.DEMESNE_CHROMIUM || undefined });
    tab = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await tab.setContent(`<!doctype html><body style="margin:0"><div style="height:60px"></div><iframe id="f" style="display:block;margin-left:40px;width:700px;height:500px;border:0" sandbox="allow-scripts"></iframe>
      <script>window.heard = []; addEventListener("message", (e) => { if (e.data && e.data.demesne === "note") heard.push(e.data); });</script></body>`);
    await tab.evaluate((html) => { (document.getElementById("f") as HTMLIFrameElement).srcdoc = html; }, mockup);
    await tab.waitForFunction(() => (window as unknown as { heard: { state: string }[] }).heard.some((item) => item.state === "ready"));
  });
  afterAll(async () => { await browser?.close(); });
  const frame = () => tab.frames().find((found) => found !== tab.mainFrame())!;
  type Part = { tag: string; selector: string; text: string; label: string; heading: string; kids: number; html: string; rect: { x: number; y: number; w: number; h: number } };
  type Heard = { state: string; point?: { x: number; y: number } | null; part?: Part | null; fx?: number; fy?: number; pins?: { n: number; rect: unknown }[] };
  const heard = () => tab.evaluate(() => (window as unknown as { heard: unknown[] }).heard) as Promise<Heard[]>;
  const last = async (state = "at") => (await heard()).filter((item) => item.state === state).at(-1) ?? null;
  /// Click an element in the frame, a little off its middle, and say what pin the frame reports.
  const pin = async (selector: string, dx = 0.25, dy = 0.5) => {
    const box = (await frame().locator(selector).first().boundingBox())!;
    const before = (await heard()).length;
    await tab.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
    await tab.waitForFunction((n) => (window as unknown as { heard: { state: string }[] }).heard.slice(n).some((item) => item.state === "pin"), before);
    return (await last("pin"))!;
  };

  test("it says where the pointer is, in the frame's own pixels, and nothing about parts", async () => {
    const box = (await frame().locator("#overdue").boundingBox())!;
    await tab.mouse.move(box.x + 30, box.y + 20, { steps: 2 });
    await tab.waitForTimeout(80);
    const at = (await last())!;
    // The frame sits 40px in and 60px down.
    expect(at.point).toEqual({ x: Math.round(box.x + 30 - 40), y: Math.round(box.y + 20 - 60) });
    expect(at.part).toBeUndefined();
  });

  const post = (message: object) => tab.evaluate((data) => (document.getElementById("f") as HTMLIFrameElement).contentWindow!.postMessage({ demesne: "note", ...data }, "*"), message);
  const pins = async () => (await heard()).filter((item) => item.state === "pin").length;

  test("a page the Foundry page takes no notes on keeps every click", async () => {
    const box = (await frame().locator("#overdue h3").boundingBox())!;
    await tab.mouse.click(box.x + 5, box.y + 5);
    await tab.waitForTimeout(80);
    expect(await pins()).toBe(0);
    expect(await frame().evaluate(() => (window as unknown as { pressed: string[] }).pressed)).toEqual(["H3"]);
    await frame().evaluate(() => { (window as unknown as { pressed: string[] }).pressed = []; });
    // Once it watches for notes, clicks are pins.
    await post({ action: "watch", pins: [] });
  });

  test("a click is a pin, held by the smallest piece under it, at the exact spot on it", async () => {
    const heading = await pin("#overdue h3", 0.25, 0.5);
    expect(heading.part).toMatchObject({ tag: "h3", selector: "div#overdue > h3", text: "Overdue", html: "<h3>Overdue</h3>" });
    // The pointer lands on whole pixels, so the spot is as near as a pixel allows.
    expect(Math.abs(heading.fx! - 0.25)).toBeLessThan(0.03);
    expect(Math.abs(heading.fy! - 0.5)).toBeLessThan(0.1);
    // The click is the pin's: the mockup never sees it.
    expect(await frame().evaluate(() => (window as unknown as { pressed: string[] }).pressed)).toEqual([]);
    // A word or a dot belongs to the piece that holds it; a row is a row.
    expect((await pin(".card i", 0.5, 0.5)).part).toMatchObject({ tag: "div", selector: "div#overdue", heading: "Overdue" });
    expect((await pin("li em", 0.5, 0.5)).part).toMatchObject({ tag: "li", selector: "main > div.app > ul > li.row:nth-of-type(1)" });
    // On no part, the page itself holds the pin, and moves with it.
    const app = (await frame().locator(".app").boundingBox())!;
    await tab.mouse.click(app.x + app.width - 20, app.y + 250);
    await tab.waitForTimeout(80);
    const bare = (await last("pin"))!;
    expect(bare.part).toMatchObject({ tag: "html", selector: "html", html: "" });
    expect(bare.fx!).toBeGreaterThan(0.9);
  });

  test("a control still works when clicked, and is pinned through the + where the pointer rested", async () => {
    const before = await pins();
    await frame().locator("#save").click();
    await frame().locator("#next").click();
    await tab.waitForTimeout(80);
    expect(await pins()).toBe(before);
    expect(await frame().evaluate(() => (window as unknown as { pressed: string[] }).pressed)).toEqual(["save", "next"]);
    const box = (await frame().locator("#save").boundingBox())!;
    await post({ action: "pin-at", x: box.x - 40 + box.width * 0.75, y: box.y - 60 + box.height / 2 });
    await tab.waitForFunction((n) => (window as unknown as { heard: { state: string }[] }).heard.filter((item) => item.state === "pin").length > n, before);
    const save = (await last("pin"))!;
    expect(save.part).toMatchObject({ tag: "button", selector: "button#save", text: "Save" });
    expect(Math.abs(save.fx! - 0.75)).toBeLessThan(0.03);
  });

  test("it says where the noted parts are, follows them as the page moves, and lets go when told the pointer is away", async () => {
    await tab.evaluate(() => (document.getElementById("f") as HTMLIFrameElement).contentWindow!.postMessage({ demesne: "note", action: "watch", pins: [{ n: 0, selector: "button#save" }, { n: 1, selector: "div.app > ul > li.row:nth-of-type(2)" }, { n: 2, selector: "#gone" }, { n: 3, selector: "::bad(" }] }, "*"));
    await tab.waitForFunction(() => (window as unknown as { heard: { pins?: unknown[] }[] }).heard.at(-1)?.pins?.length === 4);
    const first = (await last())!.pins! as { n: number; rect: { x: number; y: number; w: number; h: number } | null }[];
    expect(first.map((pin) => [pin.n, !!pin.rect])).toEqual([[0, true], [1, true], [2, false], [3, false]]);
    // The card grows: the row under it moves down, and the frame says so by itself.
    await frame().evaluate(() => { (document.querySelector(".card") as HTMLElement).style.height = "120px"; });
    await tab.waitForFunction((y) => { const pins = (window as unknown as { heard: { pins?: { n: number; rect: { y: number } | null }[] }[] }).heard.at(-1)?.pins; return !!pins?.[1]?.rect && pins[1].rect.y > y + 20; }, first[1]!.rect!.y, { timeout: 3000 });
    expect((await last())!.pins![0]).toEqual(first[0]);
    // Told the pointer is on the page's own drawing, it is not on the mockup.
    const box = (await frame().locator("#save").boundingBox())!;
    await tab.mouse.move(box.x + 5, box.y + 5, { steps: 2 });
    await tab.waitForFunction(() => !!(window as unknown as { heard: { state: string; point?: unknown }[] }).heard.filter((item) => item.state === "at").at(-1)?.point);
    await tab.evaluate(() => (document.getElementById("f") as HTMLIFrameElement).contentWindow!.postMessage({ demesne: "note", action: "away" }, "*"));
    await tab.waitForFunction(() => (window as unknown as { heard: { state: string; point?: unknown }[] }).heard.filter((item) => item.state === "at").at(-1)?.point === null);
    // It draws nothing and changes nothing in the page.
    expect(await frame().evaluate(() => document.querySelectorAll("body *").length)).toBe(await frame().evaluate(() => new DOMParser().parseFromString(document.documentElement.outerHTML, "text/html").querySelectorAll("body *").length));
    expect(await frame().evaluate(() => document.querySelectorAll("[class*=fn-], [style*=outline]").length)).toBe(0);
  });
});
