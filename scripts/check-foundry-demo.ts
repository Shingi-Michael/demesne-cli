/** Real Electron check for pass 221 A: on Foundry's long page a mockup sits on
 * the surface the model chose and plays the demo it wrote, with a drawn
 * pointer and the words under the stage; moving in stops it; options get a
 * stage each, named above it; nothing is drawn into the page. Run after
 * `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const chats = ["Tidy the sidebar", "Drive picks", "Release notes"];
const list = (cls = "") => `<div class="w ${cls}"><h3>Pinned</h3><div class="pins"></div><h3>Chats</h3><div class="list">${chats.map((name) => `<div class="r"><span>${name}</span><button class="pin" aria-label="Pin ${name}">📌</button></div>`).join("")}</div></div>`;
const style = `<style>body{margin:0;font:14px system-ui;background:#232326;color:#eee}.w{padding:8px;width:340px}h3{font-size:11px;color:#999;margin:8px}.r{display:flex;align-items:center;height:32px;padding:0 8px;border-radius:7px}.r span{flex:1}.r:hover{background:#2d2d31}.pin{all:unset;cursor:pointer;opacity:0}.r:hover .pin,.pins .pin{opacity:1}</style>`;
const script = `<script>document.addEventListener("click",(e)=>{const p=e.target.closest(".pin");if(!p)return;const r=p.closest(".r"),w=r.closest(".w");(r.parentElement.classList.contains("pins")?w.querySelector(".list"):w.querySelector(".pins")).append(r);});</script>`;
const pinPage = `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${list()}${script}</body></html>`;
const optionsPage = `<!doctype html><html><head><meta charset="utf-8">${style}<script src="foundry://kit/parts.js"></script></head><body><d-compare recommended="A"><section data-option="A · Pin on hover" note="quiet">${list()}</section><section data-option="B · Pin always showing">${list("alw")}</section></d-compare>${script}</body></html>`;
const demo = [{ hover: "Drive picks", say: "Point at a chat and its pin shows" }, { click: "Pin Drive picks", say: "Click the pin" }, { wait: 300, say: "It moves up to Pinned" }];

const f = await fixture({
  providerId: "fixture", modelId: "foundry-demo",
  async listModels() { return [{ id: "foundry-demo", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const request = messages[at]?.content ?? "";
    const done = messages.slice(at + 1).some((message) => message.role === "tool");
    if (done) { yield { type: "text_delta", delta: "Here it is." }; yield { type: "finish", reason: "stop" }; return; }
    const options = /options/i.test(request);
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({
      title: options ? "Pin a chat, two ways" : "Pin a chat", kind: "html", description: "Pinning a chat from the sidebar.", note: "First take",
      why: { direction: "Quiet.", look_at: "The pin.", starts_from: "new" },
      source: options ? optionsPage : pinPage, surface: options ? { frame: "window", width: 520, height: 320, title: "Demesne" } : { frame: "part", width: 360 }, demo }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `--user-data-dir=${join(f.root, "electron-demo")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  const editor = page.locator("textarea");
  const idle = () => page!.waitForFunction(() => !(window.demesneInspect?.() as { host?: { busy?: boolean } })?.host?.busy);
  await editor.fill("/foundry pin a chat"); await editor.press("Enter");
  const chips = page.locator("#conversation .fd-chip");
  await chips.first().filter({ hasText: "Pin a chat" }).waitFor();
  const pin = (await f.client.foundryList()).artifacts.find((item) => item.title === "Pin a chat")!;
  const stored = (await f.client.foundryGet(pin.id)).versions[0]!.stage;
  assert.deepEqual(stored?.surface, { frame: "part", width: 360 }, "the surface is kept with the version");
  assert.equal(stored?.demo?.length, 3, "the demo is kept with the version");
  await chips.first().click();
  const item = page.locator(`#page [data-fd="${pin.id}:1"]`), stage = item.locator(".fd-stage");
  await stage.waitFor();
  assert.match((await stage.getAttribute("class"))!, /fd-s s-part b-paper/, "the stage is the part on paper");
  const frame = (): Frame => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${pin.id}?v=1`))!;
  await step(63, async () => !!frame());
  // A part grows to its content: the stage takes the height the page says.
  await step(65, async () => Number(await stage.getAttribute("data-oh")) !== 480);
  // The demo plays with the words under the stage, and really pins the chat.
  const line = item.locator(".fd-demo");
  await step(68, async () => /Point at a chat/.test((await line.textContent()) ?? ""));
  assert.equal(await line.locator(".fd-ticks i").count(), 3, "a tick per beat");
  await step(70, async () => frame().evaluate(() => !!document.querySelector(".pins .r") && document.querySelector(".pins .r span")!.textContent === "Drive picks"), 12000);
  await step(71, async () => /moves up to Pinned/.test((await line.textContent()) ?? ""));
  assert.equal(await frame().evaluate(() => document.querySelectorAll("[data-chrome][aria-hidden=true]").length), 1, "the pointer is the only thing Foundry adds to the page");
  await item.screenshot({ path: join(output, "foundry-demo.png") });
  // It starts again from a fresh page.
  await step(75, async () => /Point at a chat/.test((await line.textContent()) ?? ""), 15000);
  await step(76, async () => frame().evaluate(() => !document.querySelector(".pins .r")));
  // Moving in stops it and hands the page over.
  const box = (await stage.boundingBox())!;
  await page.mouse.move(5, 5);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await step(81, async () => /Yours now/.test((await line.textContent()) ?? ""));
  await step(82, async () => frame().evaluate(() => getComputedStyle(document.querySelector("[data-chrome][aria-hidden=true]")!).opacity === "0"));
  assert.equal(await page.locator("#page").locator("button:not(.fd-link), form, input").count(), 0, "nothing to press on Foundry");
  console.log("PASS: a mockup sits on its surface and plays its demo under it; moving in stops it.");
  await page.mouse.move(5, 5);

  // Options: a stage each, named on the line above it, nothing drawn inside.
  await page.locator("#sidebar-chats [data-action=select-session], #sidebar-sessions .sidebar-session").first().click();
  await idle(); await page.waitForTimeout(300);
  await editor.fill("/foundry pin a chat, with options"); await editor.press("Enter");
  await chips.filter({ hasText: "Pin a chat, two ways" }).waitFor();
  const two = (await f.client.foundryList()).artifacts.find((found) => found.title === "Pin a chat, two ways")!;
  await chips.filter({ hasText: "Pin a chat, two ways" }).click();
  const both = page.locator(`#page [data-fd="${two.id}:1"]`);
  await step(95, async () => await both.locator(".fd-opt").count() === 2);
  assert.deepEqual(await both.locator(".fd-opt b").allTextContents(), ["A · Pin on hover", "B · Pin always showing"]);
  assert.equal(await both.locator(".fd-opt").first().locator(".fd-rec-pill").count(), 1, "the recommended one says so");
  assert.equal(await both.locator(".fd-stage").count(), 2, "a stage per option");
  assert.match((await both.locator(".fd-stage").first().getAttribute("class"))!, /s-window b-desk/);
  assert.equal(await both.locator(".fd-chrome span").first().textContent(), "Demesne", "the window's title on Foundry's frame");
  assert.match((await both.locator("iframe.fd-frame").nth(1).getAttribute("src"))!, /&option=1$/);
  const optionFrame = (n: number) => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${two.id}?v=1`) && (n ? found.url().endsWith("&option=1") : !found.url().includes("option=")))!;
  await step(103, async () => !!optionFrame(0) && !!optionFrame(1));
  await step(104, async () => optionFrame(0).evaluate(() => [...document.querySelectorAll("d-compare > section")].map((el) => (el as HTMLElement).hidden).join()) .then((value) => value === "false,true"));
  await step(105, async () => optionFrame(1).evaluate(() => [...document.querySelectorAll("d-compare > section")].map((el) => (el as HTMLElement).hidden).join()).then((value) => value === "true,false"));
  assert.equal(await optionFrame(0).evaluate(() => document.querySelectorAll(".dp-strip, .dp-opt").length), 0, "no strip or label inside the page");
  await both.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  await both.screenshot({ path: join(output, "foundry-options.png") });
  assert.deepEqual(errors, []);
  console.log("PASS: options get a stage each, named above it, with nothing drawn inside.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
