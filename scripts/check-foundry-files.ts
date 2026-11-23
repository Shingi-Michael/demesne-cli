/** Real Electron check for a Foundry page made of several files (step 6
 * after pass 262 C): its stylesheet, script and data file go in where the
 * page links them, in its frame and in a saved copy, and the code view shows
 * each file under its name; and (step 7) a new mockup starts from the
 * version shown and opens in its place. Run after `bun scripts/prepare-desktop.ts`,
 * under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css"><link rel="stylesheet" href="styles.css"></head><body><h1 id="title">Orders</h1><ul id="list"></ul><script type="application/json" id="data" src="data.json"></script><script src="app.js"></script></body></html>';
const FILES = { "styles.css": "h1{color:rgb(51, 51, 102)}", "data.json": '[{"name":"Flat white"},{"name":"Cortado"}]', "app.js": "for (const o of JSON.parse(document.getElementById('data').textContent)) document.getElementById('list').append(Object.assign(document.createElement('li'), { textContent: o.name }));" };

const f = await fixture({
  providerId: "fixture", modelId: "foundry-files",
  async listModels() { return [{ id: "foundry-files", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "Here it is." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Orders", kind: "html", description: "Orders from a data file.", note: "First take", why: { direction: "Plain.", look_at: "The list.", starts_from: "new", walkthrough: [{ what: "A page for a check.", parts: [{ name: "Top", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the check." }] }, source: PAGE, files: FILES }) };
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
  const downloads = join(f.root, "downloads");
  mkdirSync(downloads, { recursive: true });
  await desktop.evaluate(({ app }, path) => app.setPath("downloads", path), downloads);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  const editor = page.locator("textarea");
  const ready = () => page!.waitForFunction(() => { try { const host = (window.demesneInspect?.() as { host?: { session?: string; busy?: boolean } })?.host; return !!host?.session && !host.busy; } catch { return false; } });
  await ready(); await page.waitForTimeout(200);
  await editor.fill("/foundry an orders page"); await editor.press("Enter");
  const chip = page.locator("#conversation .fd-chip").filter({ hasText: "Orders" });
  await chip.waitFor();
  await ready(); await page.waitForTimeout(300);
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Orders")!.id;
  await chip.click();
  const item = page.locator(`#page [data-fd="${id}:1"]`);
  await item.waitFor();
  const frame = () => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${id}?v=1`) && found.url().includes("stack=1")) as Frame | undefined;
  await step(52, async () => !!frame() && await frame()!.evaluate(() => document.querySelectorAll("#list li").length === 2).catch(() => false));
  assert.equal(await frame()!.evaluate(() => getComputedStyle(document.getElementById("title")!).color), "rgb(51, 51, 102)");
  console.log("PASS: a page's stylesheet, script and data file go in where it links them.");
  await item.getByRole("button", { name: "Show the code" }).click();
  await step(56, async () => /── styles\.css/.test((await item.locator(".fd-code").textContent().catch(() => "")) ?? ""));
  console.log("PASS: the code view shows each file under its name.");
  await item.getByRole("button", { name: "Show the page" }).click();
  await item.getByRole("button", { name: "Save a copy to Downloads" }).click();
  const copy = join(downloads, "Orders v1.html");
  await step(61, async () => existsSync(copy) && readFileSync(copy, "utf8").includes("</html>"));
  const written = readFileSync(copy, "utf8");
  assert.ok(written.includes('data-file="app.js"') && written.includes("Cortado") && !written.includes('src="app.js"'), "the copy carries its files");
  console.log("PASS: a saved copy carries its files and stands on its own.");

  // Step 7: a new one from this version opens in its place, with the same page and files; the first stays.
  await item.getByRole("button", { name: "Start a new one from v1" }).click();
  await step(68, async () => (await f.client.foundryList()).artifacts.some((one) => one.title === "Orders 2"));
  const made = (await f.client.foundryList()).artifacts.find((one) => one.title === "Orders 2")!;
  const opened = page.locator(`#page [data-fd="${made.id}:1"]`);
  await step(71, async () => /Started “Orders 2” from v1/.test((await opened.locator(".fd-said").textContent().catch(() => "")) ?? ""));
  const second = () => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${made.id}?v=1`) && found.url().includes("stack=1")) as Frame | undefined;
  await step(73, async () => !!second() && await second()!.evaluate(() => document.querySelectorAll("#list li").length === 2).catch(() => false));
  assert.deepEqual((await f.client.foundryGet(made.id)).basedOn, { id, version: 1 });
  assert.equal((await f.client.foundryGet(id)).version, 1, "the first stays as it was");
  await opened.screenshot({ path: resolve("test-results/desktop/foundry-branch.png") });
  assert.deepEqual(errors, []);
  console.log("PASS: a new mockup starts from the version shown, opens in its place with the same page and files, and the first stays.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
