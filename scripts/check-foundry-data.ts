/** Real Electron check for Foundry's real data (step 5 after pass 262 C):
 * a mockup reads a CSV from its project and lists a folder (demesne.read,
 * demesne.list) and never .env; its first demesne.fetch of a site asks you
 * on one quiet line under it; Not now refuses, Allow lets the page's call
 * through to the web. Run after `bun scripts/prepare-desktop.ts`, under
 * xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Sales</h1><ul id="rows"></ul><p id="files"></p><p id="env"></p>
<button id="live">Live</button><p id="said"></p>
<script>
demesne.read("data/sales.csv").then((text) => { for (const line of text.trim().split("\\n").slice(1)) { const li = document.createElement("li"); li.textContent = line; rows.append(li); } });
demesne.list("data").then((names) => { files.textContent = names.join(", "); });
demesne.read(".env").then(() => { env.textContent = "read"; }, (error) => { env.textContent = error.message; });
live.onclick = () => demesne.fetch("https://example.com/").then((answer) => { said.textContent = "got " + answer.status; }, (error) => { said.textContent = error.message; });
</script></body></html>`;

const f = await fixture({
  providerId: "fixture", modelId: "foundry-data",
  async listModels() { return [{ id: "foundry-data", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "Here it is." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Sales", kind: "html", description: "This week's sales, from the project's CSV.", note: "First take", why: { direction: "Plain.", look_at: "The rows.", starts_from: "new" }, source: PAGE }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
mkdirSync(join(f.workspace, "data"), { recursive: true });
writeFileSync(join(f.workspace, "data/sales.csv"), "day,orders\nMon,31\nTue,44\n");
writeFileSync(join(f.workspace, "data/notes.md"), "# notes");
writeFileSync(join(f.workspace, ".env"), "SECRET=1");
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
mkdirSync(resolve("test-results/desktop"), { recursive: true });
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
  await editor.fill("/foundry this week's sales from data/sales.csv"); await editor.press("Enter");
  const chip = page.locator("#conversation .fd-chip").filter({ hasText: "Sales" });
  await chip.waitFor();
  await ready(); await page.waitForTimeout(300);
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Sales")!.id;
  await chip.click();
  const item = page.locator(`#page [data-fd="${id}:1"]`);
  await item.waitFor();
  const frame = () => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${id}?v=1`) && found.url().includes("stack=1")) as Frame | undefined;
  await step(58, async () => !!frame() && await frame()!.evaluate(() => document.querySelectorAll("#rows li").length === 2).catch(() => false));
  assert.deepEqual(await frame()!.evaluate(() => [...document.querySelectorAll("#rows li")].map((li) => li.textContent)), ["Mon,31", "Tue,44"]);
  await step(60, async () => (await frame()!.evaluate(() => document.getElementById("files")!.textContent)) === "notes.md, sales.csv");
  await step(61, async () => /kept from pages/.test((await frame()!.evaluate(() => document.getElementById("env")!.textContent)) ?? ""));
  console.log("PASS: a mockup reads its project's CSV and lists a folder; .env is kept from it.");

  // The first fetch of a site asks under the mockup; Not now refuses.
  await frame()!.evaluate(() => (document.getElementById("live") as HTMLElement).click());
  const line = item.locator(".fd-site");
  await step(67, async () => /This page wants live data from example\.com/.test((await line.textContent().catch(() => "")) ?? ""));
  await item.screenshot({ path: resolve("test-results/desktop/foundry-data-ask.png") });
  await line.getByRole("button", { name: "Not now" }).click();
  await step(70, async () => /isn't allowed for this page yet/.test((await frame()!.evaluate(() => document.getElementById("said")!.textContent)) ?? ""));
  assert.equal(await item.locator(".fd-site").count(), 0, "the line goes once answered");
  // Allow: the page's call goes through to the web (an answer, or the network's own error here).
  await frame()!.evaluate(() => (document.getElementById("live") as HTMLElement).click());
  await step(74, async () => await item.locator(".fd-site").count() === 1);
  await item.locator(".fd-site").getByRole("button", { name: "Allow" }).click();
  await step(76, async () => { const said = (await frame()!.evaluate(() => document.getElementById("said")!.textContent)) ?? ""; return !!said && !/isn't allowed/.test(said); }, 20000);
  const said = await frame()!.evaluate(() => document.getElementById("said")!.textContent);
  // Asked again, it isn't asked: the site is kept for this mockup.
  await frame()!.evaluate(() => { document.getElementById("said")!.textContent = ""; (document.getElementById("live") as HTMLElement).click(); });
  await step(80, async () => !!(await frame()!.evaluate(() => document.getElementById("said")!.textContent)), 20000);
  assert.equal(await item.locator(".fd-site").count(), 0, "allowed once, not asked again");
  assert.deepEqual(errors, []);
  console.log(`PASS: a mockup's first fetch of a site asks under it; Not now refuses, Allow lets it through (${said}) and is kept.`);
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
