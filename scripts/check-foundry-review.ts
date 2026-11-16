/** Real Electron check for pass 223 A: a review of something that exists is
 * one sheet on Foundry's long page. The screen as it is has its parts
 * outlined and numbered; each part shows Today, the pick, then the other
 * options, a piece of the app cropped to its own size. Foundry adds no
 * stage per option and nothing to press. Run after
 * `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 15000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const app = (attributes = "") => `<d-demesne tabs="Tidy the sidebar|Settings|Drive picks" chats="Tidy the sidebar|Drive picks" height="520" ${attributes}></d-demesne>`;
const reviewPage = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/parts.js"></script></head><body>
<d-review>
<section data-today marks="#desktop-toolbar | .sidebar-nav">${app()}</section>
<section data-part="Top bar" why="Three tabs, the Drive pill and the menu compete in one row.">
<d-compare recommended="Fewer">
<section data-option="Today"><d-crop to="#desktop-toolbar">${app()}</d-crop></section>
<section data-option="Two tabs"><d-crop to="#desktop-toolbar">${app('tabs="Tidy the sidebar|Settings"')}</d-crop></section>
<section data-option="Fewer things"><d-crop to="#desktop-toolbar">${app('tabs="Tidy the sidebar" drive="none"')}</d-crop></section>
</d-compare></section>
<section data-part="Sidebar actions" why="Four actions with the same weight sit above the chats.">
<d-compare recommended="Quiet">
<section data-option="Today"><d-crop to=".sidebar-nav">${app()}</d-crop></section>
<section data-option="Quiet"><d-crop to=".sidebar-nav">${app()}<style>d-app .sidebar-nav > button:not(:first-child){opacity:.6}</style></d-crop></section>
<section data-option="Two lines"><d-crop to=".sidebar-nav">${app()}</d-crop></section>
</d-compare></section>
</d-review></body></html>`;

const f = await fixture({
  providerId: "fixture", modelId: "foundry-review",
  async listModels() { return [{ id: "foundry-review", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "1 Top bar: fewer things. 2 Sidebar actions: quiet." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({
      title: "Demesne, what needs work", kind: "html", description: "The two parts of the window that most need work.", note: "First review",
      why: { direction: "Keep the window, fix two parts.", look_at: "The top bar.", starts_from: "could not look: a fixture" },
      // Whatever surface a review names, it is one sheet that grows.
      source: reviewPage, surface: { frame: "window", width: 900, height: 600 } }) };
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
  const editor = page.locator("textarea");
  // A message typed while the window is still settling can be dropped: ask until the chat shows the turn.
  const chips = page.locator("#conversation .fd-chip");
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
  const frame = (): Frame => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${made.id}?v=1`))!;
  await step(71, async () => !!frame());
  // The sheet takes the height its parts need.
  await step(73, async () => Number(await stage.first().getAttribute("data-oh")) > 1200);
  // Its parts are outlined and numbered on the screen as it is.
  await step(75, async () => frame().evaluate(() => [...document.querySelectorAll(".dr-ring")].map((ring) => ring.textContent).join()).then((marks) => marks === "1,2"));
  await step(76, async () => frame().evaluate(() => {
    const ring = document.querySelector(".dr-ring")!.getBoundingClientRect(), bar = document.querySelector("[data-today] #desktop-toolbar")!.getBoundingClientRect();
    return bar.width > 300 && Math.abs(ring.left - bar.left) < 6 && Math.abs(ring.width - bar.width) < 10;
  }));
  // Today, then the pick, then the rest; every option on the one sheet.
  const order = await frame().evaluate(() => [...document.querySelectorAll("d-review d-compare")].map((compare) => [...compare.children].map((option) => (option.querySelector(".dp-opt") as HTMLElement).innerText.replace(/\s+/g, " ").trim())));
  assert.deepEqual(order, [["Today", "Fewer things recommended", "Two tabs"], ["Today", "Quiet recommended", "Two lines"]]);
  // Each crop shows the piece alone: the top bar wide and stacked, the sidebar's actions narrow and side by side.
  await step(83, async () => frame().evaluate(() => [...document.querySelectorAll("d-review d-compare")].map((compare) => compare.classList.contains("dr-wide")).join()).then((wide) => wide === "true,false"));
  const crops = await frame().evaluate(() => [...document.querySelectorAll("d-crop")].map((crop) => Math.round(crop.getBoundingClientRect().height)));
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
  console.log("PASS: a review is one sheet: the screen with its parts outlined, then each part with Today, the pick and the other options.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
