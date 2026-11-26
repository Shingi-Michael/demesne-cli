/** Real Electron check for pass 223 A and pass 240 A: a review of something
 * that exists is one sheet on Foundry's long page, made from a real picture
 * of the app. The picture is the screen as it is, with its parts outlined
 * and numbered; each part shows Today cut from the picture, the pick, then
 * the other options. The picture is kept with the mockup and served from
 * inside the app. Foundry adds no stage per option and nothing to press. Run after
 * `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 15000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const app = (attributes = "") => `<d-demesne tabs="Tidy the sidebar|Settings|Drive picks" chats="Tidy the sidebar|Drive picks" height="520" ${attributes}></d-demesne>`;
// The pieces' boxes in the app's own picture, measured before it is taken.
const boxes = { bar: "", nav: "" };
const reviewPage = (shot: string) => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/parts.js"></script></head><body>
<d-review>
<section data-today><d-shot src="${shot}" marks="${boxes.bar} | ${boxes.nav}"></d-shot></section>
<section data-part="Top bar" why="Three tabs, the Drive pill and the menu compete in one row.">
<d-compare recommended="Fewer">
<section data-option="Today"><d-shot src="${shot}" box="${boxes.bar}"></d-shot></section>
<section data-option="Two tabs"><d-crop to="#desktop-toolbar">${app('tabs="Tidy the sidebar|Settings"')}</d-crop></section>
<section data-option="Fewer things"><d-crop to="#desktop-toolbar">${app('tabs="Tidy the sidebar" drive="none"')}</d-crop></section>
</d-compare></section>
<section data-part="Sidebar actions" why="Four actions with the same weight sit above the chats.">
<d-compare recommended="Quiet">
<section data-option="Today"><d-shot src="${shot}" box="${boxes.nav}"></d-shot></section>
<section data-option="Quiet"><d-crop to=".sidebar-nav">${app()}<style>d-app .sidebar-nav > button:not(:first-child){opacity:.6}</style></d-crop></section>
<section data-option="Two lines"><d-crop to=".sidebar-nav">${app()}</d-crop></section>
</d-compare></section>
</d-review></body></html>`;

const f = await fixture({
  providerId: "fixture", modelId: "foundry-review",
  async listModels() { return [{ id: "foundry-review", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const tools = messages.slice(at + 1).filter((message) => message.role === "tool");
    if (tools.length) { yield { type: "text_delta", delta: "1 Top bar: fewer things. 2 Sidebar actions: quiet." }; yield { type: "finish", reason: "stop" }; return; }
    // The person pasted a picture of the app: it is the look, and the review's Today.
    const shot = /image artifact ([\w-]+)\]/.exec(String(messages[at]!.content))?.[1] ?? "none";
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({
      title: "Demesne, what needs work", kind: "html", description: "The two parts of the window that most need work.", note: "First review",
      why: { direction: "Keep the window, fix two parts.", look_at: "The top bar.", starts_from: "the picture of the window you attached", walkthrough: [{ what: "A page for a check.", parts: [{ name: "Top", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the check." }] },
      // Whatever surface a review names, it is one sheet that grows.
      source: reviewPage(shot), surface: { frame: "window", width: 900, height: 600 } }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron-review")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  // The app as it is: a real picture of its window, and where its top bar and sidebar actions sit in it.
  await page.waitForTimeout(800);
  const box = async (selector: string) => { const at = (await page!.locator(selector).first().boundingBox())!; return [at.x, at.y, at.width, at.height].map(Math.round).join(","); };
  boxes.bar = await box("#desktop-toolbar"); boxes.nav = await box(".sidebar-nav");
  const screen = (await page.screenshot()).toString("base64");
  const editor = page.locator("textarea");
  // A message typed while the window is still settling can be dropped: ask until the chat shows the turn.
  const chips = page.locator("#conversation .fd-chip");
  // Pasted the way a person pastes a screenshot.
  await editor.evaluate((el, data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0)), transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "demesne.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, screen);
  // It waits as a picture beside the composer (or on the right) until it is sent.
  await step(79, async () => page!.evaluate(() => [...document.querySelectorAll("img")].some((image) => image.src.startsWith("data:image/") && !image.closest("#conversation"))));
  for (let attempt = 0; attempt < 3; attempt++) {
    await editor.fill("/foundry look at Demesne and show me what most needs work"); await editor.press("Enter");
    if (await eventually(async () => ((await page!.locator("#conversation").innerText()).trim().length > 0), 8000).then(() => true, () => false)) break;
  }
  // The link arrives with the finished turn.
  await chips.first().filter({ hasText: "Demesne, what needs work" }).waitFor({ timeout: 30000 });
  const made = (await f.client.foundryList()).artifacts.find((item) => item.title === "Demesne, what needs work")!;
  assert.deepEqual((await f.client.foundryGet(made.id)).versions[0]!.stage?.surface, { frame: "page" }, "a review is saved as one growing sheet");
  await chips.first().click();
  const item = page.locator(`#page [data-fd="${made.id}:1"]`), stage = item.locator(".fd-stage");
  await stage.first().waitFor();
  assert.match((await stage.first().getAttribute("class"))!, /fd-s s-page b-white fd-fluid/, "the sheet fills the column");
  const frame = (): Frame => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${made.id}?v=1&`))!;
  await step(93, async () => !!frame());
  // The sheet takes the height its parts need.
  await step(95, async () => Number(await stage.first().getAttribute("data-oh")) > 1200);
  // The screen as it is is the real picture, served from inside the app and kept with the mockup.
  const detail = await f.client.foundryGet(made.id);
  assert.ok(detail.source.includes('<d-shot src="') && !detail.source.includes('src="none"'), "the review names the picture the person attached");
  assert.equal(detail.shots?.length, 1, "the picture is kept with the mockup");
  assert.equal(detail.shots![0]!.width, 1440);
  await step(101, async () => frame().evaluate(() => { const image = document.querySelector("[data-today] d-shot img") as HTMLImageElement | null; return !!image && image.complete && image.naturalWidth === 1440 && image.src.startsWith("foundry://shot/"); }));
  // Its parts are outlined and numbered where they sit in it.
  await step(103, async () => frame().evaluate(() => [...document.querySelectorAll(".dr-ring")].map((ring) => ring.textContent).join()).then((marks) => marks === "1,2"));
  const [barX, , barW] = boxes.bar.split(",").map(Number);
  await step(105, async () => frame().evaluate(([x, w]) => {
    const ring = document.querySelector(".dr-ring")!.getBoundingClientRect(), shot = document.querySelector("[data-today] d-shot")!.getBoundingClientRect(), k = shot.width / 1440;
    return shot.width > 300 && Math.abs(ring.left - shot.left - (x! * k - 3)) < 4 && Math.abs(ring.width - (w! * k + 6)) < 6;
  }, [barX, barW]));
  // Today, then the pick, then the rest; every option on the one sheet.
  const order = await frame().evaluate(() => [...document.querySelectorAll("d-review d-compare")].map((compare) => [...compare.children].map((option) => (option.querySelector(".dp-opt") as HTMLElement).innerText.replace(/\s+/g, " ").trim())));
  assert.deepEqual(order, [["Today", "Fewer things recommended", "Two tabs"], ["Today", "Quiet recommended", "Two lines"]]);
  // Each crop shows the piece alone: the top bar wide and stacked, the sidebar's actions narrow and side by side.
  await step(113, async () => frame().evaluate(() => [...document.querySelectorAll("d-review d-compare")].map((compare) => compare.classList.contains("dr-wide")).join()).then((wide) => wide === "true,false"));
  const crops = await frame().evaluate(() => [...document.querySelectorAll("d-crop, [data-part] d-shot")].map((crop) => Math.round(crop.getBoundingClientRect().height)));
  assert.equal(crops.length, 6);
  assert.ok(crops.every((height) => height > 20 && height < 260), `each crop is the piece, not the window: ${crops.join(", ")}`);
  // Foundry splits nothing: no stage per option, no option lines, no demo line.
  await page.waitForTimeout(1500);
  assert.equal(await item.locator(".fd-stage").count(), 1, "one stage for the whole review");
  assert.equal(await item.locator(".fd-opt").count(), 0, "no option lines from Foundry's page");
  assert.equal(await item.locator(".fd-demo").count(), 0, "no demo line");
  assert.equal(await item.locator(".fd-why").count(), 0, "why is said part by part on the sheet, not in lines above it");
  await item.scrollIntoViewIfNeeded();
  await item.screenshot({ path: join(output, "foundry-review.png") });
  // The parts sit under the screen: the end of the sheet, as the window shows it.
  await stage.first().evaluate((el) => el.scrollIntoView({ block: "end" }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(output, "foundry-review-parts.png") });
  assert.deepEqual(errors, []);
  console.log("PASS: a review is one sheet from a real picture: the screen with its parts outlined, then each part with Today cut from it, the pick and the other options.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
