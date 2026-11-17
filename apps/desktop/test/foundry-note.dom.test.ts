import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

// Pass 233 A: the script Demesne puts in a mockup's frame says which part is
// under the pointer and where the noted parts are, and draws nothing.
const NOTE = readFileSync(join(import.meta.dir, "../foundry-kit/note.js"), "utf8");
const mockup = `<!doctype html><html><head><style>
body{margin:0;font:14px system-ui}.app{padding:16px}.bar{display:flex;gap:8px;height:40px;align-items:center}
.card{width:220px;padding:14px;margin-top:12px;background:#eee;border-radius:10px}.card i{display:inline-block;width:10px;height:10px;background:#c33;border-radius:50%}
.row{display:flex;height:32px;align-items:center}.row span{flex:1}
</style></head><body><main><div class="app">
<nav class="bar"><button id="save">Save</button><a href="#" class="more">More</a></nav>
<div class="card" id="overdue"><h3>Overdue</h3><div><i></i> <span class="n">12 invoices</span></div></div>
<ul><li class="row"><span>Acme <em>new</em></span><button aria-label="Open Acme">›</button></li><li class="row"><span>Globex</span></li></ul>
<div data-chrome aria-hidden="true" style="position:fixed;right:0;bottom:0;width:30px;height:30px"></div>
</div></main><script>${NOTE.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("a mockup's frame says which part is under the pointer", () => {
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
  const last = () => tab.evaluate(() => (window as unknown as { heard: { state: string; part: { tag: string; selector: string; text: string; label: string; heading: string; kids: number; html: string; rect: { x: number; y: number; w: number; h: number } } | null; pins: { n: number; rect: unknown }[] }[] }).heard.filter((item) => item.state === "at").at(-1) ?? null);
  /// Move the pointer onto an element in the frame and say what the frame reports.
  const over = async (selector: string) => {
    const box = (await frame().locator(selector).first().boundingBox())!;
    await tab.mouse.move(box.x + box.width / 2 - 3, box.y + box.height / 2, { steps: 2 });
    await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 2 });
    await tab.waitForTimeout(80);
    return (await last())?.part ?? null;
  };

  test("a control is the part, with its place in the markup and where it is", async () => {
    const part = (await over("#save"))!;
    expect(part).toMatchObject({ tag: "button", selector: "button#save", text: "Save", kids: 0 });
    expect(part.html).toBe('<button id="save">Save</button>');
    const box = (await frame().locator("#save").boundingBox())!;
    // Its place is in the frame's own pixels: the frame sits 40px in and 60px down.
    expect([Math.round(part.rect.x + 40), Math.round(part.rect.y + 60)]).toEqual([Math.round(box.x), Math.round(box.y)]);
    expect((await over(".more"))!.selector).toBe("main > div.app > nav.bar > a.more");
  });

  test("a word or a dot belongs to the piece that holds it; a row is a row", async () => {
    // The small dot and the plain words climb to the card they sit in.
    expect(await over(".card i")).toMatchObject({ tag: "div", selector: "div#overdue", heading: "Overdue", kids: 2 });
    expect((await over(".card .n"))!.selector).toBe("div#overdue");
    expect((await over(".card h3"))!.tag).toBe("h3");
    // Words in a row name the row; the button in it is its own part.
    expect(await over("li em")).toMatchObject({ tag: "li", selector: "main > div.app > ul > li.row:nth-of-type(1)", heading: "Acme new" });
    expect(await over("li button")).toMatchObject({ tag: "button", label: "Open Acme" });
    expect((await over("li:nth-of-type(2) span"))!.selector).toBe("main > div.app > ul > li.row:nth-of-type(2)");
  });

  test("the page's own wrapper and Demesne's drawing are no part", async () => {
    await over("#save");
    const app = (await frame().locator(".app").boundingBox())!;
    await tab.mouse.move(app.x + app.width - 20, app.y + 250, { steps: 2 });
    await tab.waitForTimeout(80);
    expect((await last())!.part).toBeNull();
    await over("#save");
    expect(await over("[data-chrome]")).toBeNull();
  });

  test("it says where the noted parts are, follows them as the page moves, and lets go when told the pointer is away", async () => {
    await tab.evaluate(() => (document.getElementById("f") as HTMLIFrameElement).contentWindow!.postMessage({ demesne: "note", action: "watch", pins: [{ n: 0, selector: "button#save" }, { n: 1, selector: "div.app > ul > li.row:nth-of-type(2)" }, { n: 2, selector: "#gone" }, { n: 3, selector: "::bad(" }] }, "*"));
    await tab.waitForFunction(() => (window as unknown as { heard: { pins?: unknown[] }[] }).heard.at(-1)?.pins?.length === 4);
    const first = (await last())!.pins as { n: number; rect: { x: number; y: number; w: number; h: number } | null }[];
    expect(first.map((pin) => [pin.n, !!pin.rect])).toEqual([[0, true], [1, true], [2, false], [3, false]]);
    // The card grows: the row under it moves down, and the frame says so by itself.
    await frame().evaluate(() => { (document.querySelector(".card") as HTMLElement).style.height = "120px"; });
    await tab.waitForFunction((y) => { const pins = (window as unknown as { heard: { pins?: { n: number; rect: { y: number } | null }[] }[] }).heard.at(-1)?.pins; return !!pins?.[1]?.rect && pins[1].rect.y > y + 20; }, first[1]!.rect!.y, { timeout: 3000 });
    expect((await last())!.pins[0]).toEqual(first[0]);
    // Told the pointer is on the page's own drawing, it is on no part.
    expect(await over("#save")).not.toBeNull();
    await tab.evaluate(() => (document.getElementById("f") as HTMLIFrameElement).contentWindow!.postMessage({ demesne: "note", action: "away" }, "*"));
    await tab.waitForFunction(() => (window as unknown as { heard: { state: string; part: unknown }[] }).heard.at(-1)?.part === null);
    // It draws nothing and changes nothing in the page.
    expect(await frame().evaluate(() => document.querySelectorAll("body *").length)).toBe(await frame().evaluate(() => new DOMParser().parseFromString(document.documentElement.outerHTML, "text/html").querySelectorAll("body *").length));
    expect(await frame().evaluate(() => document.querySelectorAll("[class*=fn-], [style*=outline]").length)).toBe(0);
  });
});
