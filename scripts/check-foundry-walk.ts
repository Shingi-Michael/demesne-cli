/** Real Electron check for pass 263 A, variants as tabs and every one
 * explained: a mockup with four variants shows them as tabs over one stage,
 * the shown variant's walkthrough under it with its parts numbered on the
 * page, a tab switching both; and the opened mockup runs edge to edge across
 * Foundry. Run after `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const style = "<style>body{margin:0;font:14px Inter,sans-serif;background:#f4f4f2;color:#26282b}main{padding:24px}h2{margin:0 0 14px;font-size:18px}.week{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}.day b{display:block;margin-bottom:6px}.cl{background:#fff;border-radius:8px;padding:8px;margin-bottom:6px}.row{display:flex;justify-content:space-between;background:#fff;padding:12px;border-bottom:1px solid #e6e6e3}.bk{background:#26282b;color:#fff;border-radius:8px;padding:4px 10px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.card{background:#fff;border-radius:10px;padding:14px}table{width:100%;border-collapse:collapse;background:#fff}td,th{padding:6px 10px;border-bottom:1px solid #e6e6e3;text-align:left}</style>";
const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const PAGE = `<!doctype html><html><head><meta charset="utf-8">${style}<script src="foundry://kit/parts.js"></script></head><body><d-compare recommended="Week grid">
<section data-option="Week grid" note="the whole week"><main><h2 class="title">Classes this week</h2><div class="week">${days.map((day) => `<div class="day"><b class="dh">${day}</b><div class="cl">7:00 Sunrise flow</div><div class="cl">18:30 Yin</div></div>`).join("")}</div><p class="key">Gentle · Flow · Strong</p></main></section>
<section data-option="Day view" note="today, large"><main><h2 class="title">Tuesday</h2>${["7:00 Sunrise flow", "12:15 Lunch stretch", "19:00 Power"].map((row) => `<div class="row"><span>${row}</span><span class="bk">Book</span></div>`).join("")}</main></section>
<section data-option="By teacher" note="a card each"><main><h2 class="title">Our teachers</h2><div class="cards">${["Ana", "Mei", "Joe"].map((name) => `<div class="card"><b>${name}</b><p>Flow, mornings</p></div>`).join("")}</div></main></section>
<section data-option="Compact" note="front desk"><main><table><tr><th>Day</th><th>Class</th><th class="booked">Booked</th></tr><tr><td>Mon</td><td>Sunrise flow</td><td>12/16</td></tr></table></main></section>
</d-compare></body></html>`;
const entry = (option: string, parts: [string, string, string?][]) => ({ option, what: `${option}: how this week's classes could read.`, parts: parts.map(([name, says, at]) => ({ name, says, ...(at ? { at } : {}) })), why: "Regulars plan around work.", differs: `${option} is its own shape.`, next: "Fold to a list on a phone." });
const WALK = [
  entry("Week grid", [["Today's column", "marked so you find your place.", ".day:nth-child(2) .dh"], ["A class", "time and name.", ".cl"], ["The level key", "explains the colours.", ".key"]]),
  entry("Day view", [["The day", "is the heading.", ".title"], ["Book", "on every row.", ".bk"]]),
  entry("By teacher", [["A teacher's card", "face and classes.", ".card"], ["What they teach", "in a line.", ".card p"]]),
  entry("Compact", [["Booked", "spots taken of the room's size.", ".booked"], ["A row", "one class.", "td"]]),
];

const f = await fixture({
  providerId: "fixture", modelId: "foundry-walk",
  async listModels() { return [{ id: "foundry-walk", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "Four ways to lay out the schedule; I'd use Week grid." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Class schedule", kind: "html", description: "This week's classes, four ways.", note: "First take",
      why: { direction: "Calm, for a small studio.", look_at: "The week.", starts_from: "new", dropped: "A month view.", walkthrough: WALK }, source: PAGE }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron-data")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  const editor = page.locator("textarea");
  const ready = () => page!.waitForFunction(() => { try { const host = (window.demesneInspect?.() as { host?: { session?: string; busy?: boolean } })?.host; return !!host?.session && !host.busy; } catch { return false; } });
  await ready(); await page.waitForTimeout(200);
  await editor.fill("/foundry mock the class schedule, a few ways"); await editor.press("Enter");
  const chip = page.locator("#conversation .fd-chip").filter({ hasText: "Class schedule" });
  await chip.waitFor();
  await ready(); await page.waitForTimeout(300);
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Class schedule")!.id;
  await chip.click();
  const item = page.locator(`#page [data-fd="${id}:1"]`);
  await item.waitFor();
  const frame = () => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${id}?v=1`) && found.url().includes("stack=1")) as Frame | undefined;

  // The variants are tabs over one stage, the pick first and on, with its walkthrough under it.
  const tabs = item.locator(".fd-tabs [role=tab]");
  await step(58, async () => await tabs.count() === 4);
  assert.deepEqual(await tabs.allTextContents(), ["Week grid", "Day view", "By teacher", "Compact"]);
  assert.equal(await tabs.first().getAttribute("aria-selected"), "true");
  assert.equal(await item.locator(".fd-tabs .fd-tab-pick").count(), 1);
  assert.equal(await item.locator(".fd-stage").count(), 1, "one stage, not one per option");
  const shownWalk = () => item.locator(".fd-walk-v:not([hidden])");
  assert.equal(await shownWalk().getAttribute("data-option"), "Week grid");
  assert.equal(await shownWalk().locator("li").count(), 3);
  assert.ok((await item.locator(".fd-why").textContent())?.includes("A month view."), "what was dropped stays above");
  console.log("PASS: four variants are tabs over one stage, the pick first, its walkthrough under it.");

  // Its parts are numbered on the page where the walkthrough points.
  const dots = () => frame()!.evaluate(() => [...document.querySelectorAll("#demesne-marks i")].map((dot) => dot.textContent)).catch(() => [] as (string | null)[]);
  await step(71, async () => !!frame() && (await dots()).length === 3);
  assert.deepEqual(await dots(), ["1", "2", "3"]);
  await shownWalk().locator("li").nth(2).hover();
  await step(75, async () => await frame()!.evaluate(() => document.querySelectorAll("#demesne-marks b").length === 1).catch(() => false));
  await page.mouse.move(5, 5);
  console.log("PASS: the parts are numbered on the page, and resting on a line rings its piece.");

  // A tab shows that variant in the stage and its walkthrough under it.
  await tabs.nth(1).click();
  await step(81, async () => !!frame()?.url().includes("option=1") && await frame()!.evaluate(() => !!document.querySelector(".bk")).catch(() => false));
  assert.equal(await shownWalk().getAttribute("data-option"), "Day view");
  assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true");
  await step(85, async () => JSON.stringify(await dots()) === JSON.stringify(["1", "2"]));
  console.log("PASS: a tab shows its variant, its walkthrough and its numbers.");

  // Opened, it runs edge to edge across Foundry, with no box.
  const widths = await item.evaluate((node) => {
    const stage = node.querySelector<HTMLElement>(".fd-stage")!, room = document.querySelector<HTMLElement>("#stage")!;
    return { stage: Math.round(stage.getBoundingClientRect().width), room: Math.round(room.getBoundingClientRect().width), left: Math.round(stage.getBoundingClientRect().left - room.getBoundingClientRect().left), radius: getComputedStyle(stage).borderTopRightRadius };
  });
  assert.ok(Math.abs(widths.stage - widths.room) <= 16 && widths.left <= 8, `edge to edge: ${JSON.stringify(widths)}`);
  assert.equal(widths.radius, "0px");
  console.log("PASS: the opened mockup runs edge to edge across Foundry.");
  mkdirSync(resolve("test-results/desktop"), { recursive: true });
  await tabs.nth(0).click();
  await step(99, async () => (await dots()).length === 3);
  await page.locator("#page").evaluate((node) => { node.closest("#stage")?.scrollTo(0, 0); });
  await page.screenshot({ path: resolve("test-results/desktop/foundry-walk.png") });
  await item.locator(".fd-walk").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve("test-results/desktop/foundry-walk-under.png") });
  assert.deepEqual(errors, []);
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
