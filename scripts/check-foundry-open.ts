/** Real Electron check for pass 262 C, a mockup you can hold: the mockup you
 * open from the chat grows where it sits on Foundry's long page, wider than
 * the page's column and as tall as the window, under a quiet head line.
 * ‹ › step through its versions in place, the code icon shows its source,
 * Save a copy writes a file that stands on its own into Downloads, and Esc
 * closes it; the other mockups stay look-only. Run after
 * `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const board = (blue: boolean) => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css"><style>
body{padding:24px}.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.col{padding:10px;border-radius:10px;background:${blue ? "#dfe8f5" : "#ecebe7"}}
.card{all:unset;display:block;cursor:pointer;margin-top:8px;padding:8px 10px;border-radius:8px;background:#fff}</style></head><body><h1>Orders</h1>
<div class="cols"><div class="col" id="new"><b>New</b><button class="card">Flat white</button></div><div class="col" id="making"><b>Making</b></div><div class="col"><b>Ready</b></div></div>
<script>document.addEventListener("click",(e)=>{const c=e.target.closest(".card");if(c)document.getElementById("making").append(c);});</script></body></html>`;

const f = await fixture({
  providerId: "fixture", modelId: "foundry-open",
  async listModels() { return [{ id: "foundry-open", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const request = messages[at]?.content ?? "";
    const done = messages.slice(at + 1).some((message) => message.role === "tool");
    if (done) { yield { type: "text_delta", delta: "Here it is." }; yield { type: "finish", reason: "stop" }; return; }
    const blue = /blue/i.test(request);
    const list = blue ? (await f.client.foundryList()).artifacts : [];
    const id = list.find((item) => item.title === "Orders board")?.id;
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({
      ...(id ? { id } : {}), title: "Orders board", kind: "html", description: "The counter's orders, in three columns.", note: blue ? "Blue" : "First take",
      why: { direction: "Calm, for the counter.", look_at: "The columns.", starts_from: "new" }, source: board(blue), surface: { frame: "browser", width: 900, height: 420, title: "cafe.example/orders" } }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron-open")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
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
  await editor.fill("/foundry an orders board for the counter"); await editor.press("Enter");
  const chips = page.locator("#conversation .fd-chip");
  await chips.first().filter({ hasText: "Orders board" }).waitFor();
  await ready(); await page.waitForTimeout(300);
  await editor.fill("/foundry make the orders board blue"); await editor.press("Enter");
  const made = async () => (await f.client.foundryList()).artifacts.find((item) => item.title === "Orders board");
  await step(62, async () => (await made())?.version === 2);
  const mockup = (await made())!;
  await ready(); await page.waitForTimeout(300);

  // From the chat: it opens on the long page, grown, at its newest version.
  await chips.last().click();
  const open = page.locator(`#page [data-fd="${mockup.id}:2"]`);
  await open.waitFor();
  await step(71, async () => (await open.getAttribute("class"))!.includes("fd-open"));
  assert.equal(await page.locator("#page .fd-open").count(), 1, "only one grows");
  assert.equal(await page.locator("#page .fd-hd").count(), 1, "one head line, on it");
  assert.equal(await open.locator(".fd-hd-v").textContent(), "v2");
  // It takes the whole width the page has (wider than the column on a wide window), centred on it.
  const width = await open.evaluate((item) => { const host = document.getElementById("stage")!, css = getComputedStyle(host), room = host.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight), box = item.getBoundingClientRect(), stage = document.getElementById("stage")!.getBoundingClientRect(); return { item: box.width, want: Math.min(room - 56, 1720), left: box.left - stage.left, right: stage.right - box.right }; });
  assert.ok(Math.abs(width.item - width.want) <= 1, `the whole width there is (${width.item} vs ${width.want})`);
  assert.ok(Math.abs(width.left - width.right) <= 16, `centred (${width.left} / ${width.right})`);
  // The other version stays look-only: its name opens it, nothing else to press.
  const old = page.locator(`#page [data-fd="${mockup.id}:1"]`);
  assert.equal(await old.locator("button:not(.fd-link):visible").count(), 0, "the rest is look-only");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(output, "foundry-open-grown.png") });
  const frameAt = (version: number) => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${mockup.id}?v=${version}`) && found.parentFrame() === page!.mainFrame() && found.url().includes("stack=1"));
  await step(86, async () => !!frameAt(2));

  // ‹ shows v1 in the same place, with v1's own line.
  await open.getByRole("button", { name: "Earlier version (v1)" }).click();
  await step(90, async () => (await open.locator(".fd-hd-v").textContent()) === "v1");
  assert.match((await open.locator("iframe.fd-frame").getAttribute("src"))!, new RegExp(`${mockup.id}\\?v=1&`));
  assert.equal(await open.locator(".fd-ver b").first().textContent(), "v1 · First take");
  assert.equal(await open.getByRole("button", { name: "Earlier version" }).isDisabled(), true);
  await open.getByRole("button", { name: "Later version (v2)" }).click();
  await step(95, async () => (await open.locator(".fd-hd-v").textContent()) === "v2");

  // The code: the page's own source, then back to the page.
  await open.getByRole("button", { name: "Show the code" }).click();
  await step(99, async () => /#dfe8f5/.test((await open.locator(".fd-code").textContent()) ?? ""));
  await page.screenshot({ path: join(output, "foundry-open-code.png") });
  await open.getByRole("button", { name: "Show the page" }).click();
  await open.locator(".fd-stage").waitFor();

  // It works: a click moves the order along in the page.
  await step(104, async () => !!frameAt(2) && await frameAt(2)!.evaluate(() => !!document.querySelector(".card")).catch(() => false));
  await frameAt(2)!.evaluate(() => (document.querySelector(".card") as HTMLElement).click());
  await step(106, async () => frameAt(2)!.evaluate(() => !!document.querySelector("#making .card")));
  // Save a copy: into Downloads, the kit inlined, and a quiet line that says where.
  await open.getByRole("button", { name: "Save a copy to Downloads" }).click();
  await step(106, async () => /Saved Orders board v2\.html to Downloads/.test((await open.locator(".fd-said").textContent()) ?? ""));
  const file = join(downloads, "Orders board v2.html");
  assert.ok(existsSync(file), "the file is in Downloads");
  const written = readFileSync(file, "utf8");
  assert.ok(!written.includes(`href="foundry://kit/base.css"`) && written.includes("#dfe8f5"), `the copy stands on its own: ${written.slice(0, 400)}`);
  assert.equal(await open.locator(".fd-said-b").textContent(), "Show");
  assert.ok(await frameAt(2)!.evaluate(() => !!document.querySelector("#making .card")), "saving leaves the page as you had it (no reload)");
  await page.screenshot({ path: join(output, "foundry-open-saved.png") });

  // Esc closes it: back to the long page as it was, nothing to press.
  await page.mouse.click(720, 60);
  await page.keyboard.press("Escape");
  await step(117, async () => await page!.locator("#page .fd-open").count() === 0);
  assert.equal(await page.locator("#page").locator("button:not(.fd-link):not(.fn-plus):visible, form:visible, input:visible").count(), 0, "look-only again");
  // The name opens it again, here.
  await old.locator(".fd-ln b .fd-link").click();
  await step(121, async () => (await old.getAttribute("class"))!.includes("fd-open"));
  assert.deepEqual(errors, []);
  console.log("PASS: the mockup you open grows on the long page with ‹ vN ›, code, save a copy and close; the rest stays look-only.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
