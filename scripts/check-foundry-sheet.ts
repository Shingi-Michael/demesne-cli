/** Real Electron check for step 3 of pass 273 A, sheets: a CSV the model
 * saves is drawn on Foundry as a table; pressing a column's name sorts it, a
 * cell takes typing and the total at the foot follows, Add a row adds one,
 * and what you typed is still there after the page is drawn again. The card
 * on the front page shows the table, and Make something new offers Sheet.
 * Run after `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const CSV = "Plot,Crop,pH,Nitrogen (ppm),Cost\nA1,Wheat,6.4,22,$120.00\nB2,Barley,7.1,18,$95.50\nC3,Oats,5.9,30,$110.00\nD4,Rye,6.8,25,$88.25\n";

const f = await fixture({
  providerId: "fixture", modelId: "foundry-sheet",
  async listModels() { return [{ id: "foundry-sheet", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "Here are the soil samples as a sheet." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Soil samples", kind: "sheet", description: "This season's plots, their pH, nitrogen and cost.", note: "First take", source: CSV,
      why: { direction: "One row per plot.", look_at: "pH and nitrogen side by side.", starts_from: "new", dropped: "Charts." } }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, window: Page | undefined;
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron-data")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  window = await desktop.firstWindow();
  const app = window;
  app.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  const errors: string[] = [];
  app.on("pageerror", (error) => errors.push(error.message));
  await app.locator("#composer-model").waitFor();
  const editor = app.locator("textarea");
  await app.waitForFunction(() => { try { const host = (window.demesneInspect?.() as { host?: { session?: string; busy?: boolean } })?.host; return !!host?.session && !host.busy; } catch { return false; } });
  await app.waitForTimeout(200);
  await editor.fill("/foundry make a sheet of the soil samples"); await editor.press("Enter");
  const chip = app.locator("#conversation .fd-chip").filter({ hasText: "Soil samples" });
  await chip.waitFor();
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Soil samples")!.id;
  assert.equal((await f.client.foundryGet(id)).kind, "sheet");
  assert.match((await chip.textContent())!, /Sheet/);
  await chip.click();
  await app.locator(`#page [data-fd="${id}:1"]`).waitFor();
  const frame = () => app.frames().find((one) => one.url().startsWith(`foundry://artifact/${id}?v=1`) && one.url().includes("stack=1")) as Frame | undefined;
  const cells = (column: number) => frame()!.evaluate((at) => [...document.querySelectorAll("tbody tr")].map((row) => row.children[at]!.textContent), column);
  const totals = () => frame()!.evaluate(() => [...document.querySelectorAll("tfoot td")].map((cell) => cell.textContent));
  await step(48, async () => !!frame() && (await cells(0).catch(() => [])).length === 4);
  assert.deepEqual(await frame()!.evaluate(() => [...document.querySelectorAll("thead th")].map((cell) => cell.textContent)), ["Plot", "Crop", "pH", "Nitrogen (ppm)", "Cost"]);
  assert.deepEqual(await totals(), ["Total", "", "26.2", "95", "$413.75"]);
  console.log("PASS: a sheet is drawn as a table with its totals at the foot.");

  // Pressing a column's name sorts by it, again the other way, a third time back.
  await frame()!.locator("thead th").nth(2).click();
  assert.deepEqual(await cells(0), ["C3", "A1", "D4", "B2"]);
  await frame()!.locator("thead th").nth(2).click();
  assert.deepEqual(await cells(0), ["B2", "D4", "A1", "C3"]);
  await frame()!.locator("thead th").nth(2).click();
  assert.deepEqual(await cells(0), ["A1", "B2", "C3", "D4"]);
  console.log("PASS: a column's name sorts it, both ways and back.");

  // Typing in a cell moves the total; Add a row adds one; it is kept.
  const nitrogen = frame()!.locator("tbody tr").nth(1).locator("td").nth(3);
  await nitrogen.click();
  await app.keyboard.press("Control+A"); await app.keyboard.type("40");
  await step(66, async () => (await totals())[3] === "117");
  await frame()!.locator("#add").click();
  await app.keyboard.type("E5");
  await step(69, async () => (await cells(0)).length === 5 && (await cells(0))[4] === "E5");
  await step(70, async () => ((await frame()!.locator("#said").textContent()) ?? "") === "Saved");
  mkdirSync("output", { recursive: true });
  await app.mouse.move(5, 5);
  await app.screenshot({ path: "output/foundry-sheet.png" });
  // Drawn again: leave Foundry and come back to it.
  await app.locator("#page .fg-back").click();
  await app.locator("#page .fg-card").filter({ hasText: "Soil samples" }).waitFor();
  assert.match((await app.locator("#page .fg-card .fg-meta").first().textContent())!, /^Sheet · /);
  assert.ok((await app.locator("#page .fg-mk").allTextContents()).includes("Sheet"));
  await app.waitForTimeout(800);
  await app.screenshot({ path: "output/foundry-sheet-card.png" });
  await app.locator("#page .fg-card").filter({ hasText: "Soil samples" }).locator(".fg-go").click();
  await step(83, async () => !!frame() && JSON.stringify(await cells(3).catch(() => [])) === JSON.stringify(["22", "40", "30", "25", ""]));
  assert.equal((await cells(0))[4], "E5");
  assert.equal((await totals())[3], "117");
  console.log("PASS: typing moves the total, Add a row adds one, and what you typed is kept.");
  assert.deepEqual(errors, []);
} finally {
  await window?.close().catch(() => {});
  await desktop?.close().catch(() => {});
  await f.close();
}
