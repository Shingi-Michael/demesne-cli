/** Real Electron check for Foundry's pictures (step 6 after pass 262 C): a
 * picture attached to the chat shows in a mockup as picture:IMAGE_ID, served
 * by Demesne and inlined in a saved copy; a picture dropped on the mockup on
 * the Foundry page is a note pinned there that carries it, sent to the chat
 * under its own name with the words to use it. Run after
 * `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const logo = await sharp({ create: { width: 120, height: 60, channels: 3, background: { r: 200, g: 60, b: 40 } } }).png().toBuffer();
const photo = await sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 40, g: 120, b: 200 } } }).png().toBuffer();
const asked: string[] = [];

const f = await fixture({
  providerId: "fixture", modelId: "foundry-pictures",
  async listModels() { return [{ id: "foundry-pictures", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const said = JSON.stringify(messages[at]?.content ?? "");
    if (messages.slice(at + 1).some((message) => message.role === "tool") || /Notes pinned/.test(said)) { if (/Notes pinned/.test(said)) asked.push(said); yield { type: "text_delta", delta: "Here it is." }; yield { type: "finish", reason: "stop" }; return; }
    const image = /image artifact ([\w-]+)\]/.exec(said)?.[1] ?? "none";
    const source = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css"></head><body><header style="padding:24px"><img id="logo" alt="Logo" src="picture:${image}"></header><h1 id="name" style="padding:24px">Café Rosa</h1></body></html>`;
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Café page", kind: "html", description: "The café's page with its logo.", note: "First take", why: { direction: "Plain.", look_at: "The logo.", starts_from: "new" }, source }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
mkdirSync(resolve("test-results/desktop"), { recursive: true });
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
  // A picture attached to the chat, then the ask.
  await page.locator("#attach-input").setInputFiles({ name: "rosa-logo.png", mimeType: "image/png", buffer: logo });
  await step(50, async () => await page!.locator("#attach-row img").count() === 1);
  await editor.fill("/foundry a page for my café with this logo"); await editor.press("Enter");
  const chip = page.locator("#conversation .fd-chip").filter({ hasText: "Café page" });
  await chip.waitFor();
  await ready(); await page.waitForTimeout(300);
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Café page")!.id;
  await chip.click();
  const item = page.locator(`#page [data-fd="${id}:1"]`);
  await item.waitFor();
  const frame = () => page!.frames().find((found) => found.url().startsWith(`foundry://artifact/${id}?v=1`) && found.url().includes("stack=1")) as Frame | undefined;
  await step(62, async () => !!frame() && await frame()!.evaluate(() => { const img = document.getElementById("logo") as HTMLImageElement; return img.complete && img.naturalWidth === 120; }).catch(() => false));
  assert.match(await frame()!.evaluate(() => (document.getElementById("logo") as HTMLImageElement).src), /^foundry:\/\/shot\//);
  console.log("PASS: a picture attached to the chat shows in the mockup (picture:IMAGE_ID, served by Demesne).");

  // A saved copy carries the picture inside it.
  await item.getByRole("button", { name: "Save a copy to Downloads" }).click();
  const copy = join(downloads, "Café page v1.html");
  await step(70, async () => existsSync(copy) && readFileSync(copy, "utf8").includes("</html>"));
  const written = readFileSync(copy, "utf8");
  assert.ok(written.includes('src="data:image/png;base64,') && !written.includes("picture:"), "the copy stands on its own");
  console.log("PASS: a saved copy has the picture inside it.");

  // Not a picture: said under the mockup, nothing pinned.
  await frame()!.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 30, clientY: 30 }));
  });
  await step(98, async () => /Only a picture can go on a mockup/.test((await item.locator(".fd-notes").textContent().catch(() => "")) ?? ""));
  // A picture dropped on the mockup is a note pinned there, carrying it.
  await frame()!.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "shop photo.png", { type: "image/png" }));
    const target = document.getElementById("name")!, box = target.getBoundingClientRect(), x = box.left + 40, y = box.top + box.height / 2;
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y }));
  }, photo.toString("base64"));
  const box = item.locator(".fn-box input");
  await step(84, async () => (await box.inputValue().catch(() => "")) === "Use this picture here");
  await item.screenshot({ path: resolve("test-results/desktop/foundry-picture-drop.png") });
  await box.press("Control+Enter");
  await step(87, async () => asked.length === 1, 20000).catch(async (error) => { console.log("notes line:", await item.locator(".fd-notes").textContent().catch(() => "?"), "box:", await item.locator(".fn-box").count(), "conv:", (await page!.locator("#conversation").textContent())?.slice(-400)); throw error; });
  const said = asked[0]!;
  assert.match(said, /Use this picture here/);
  assert.match(said, /dropped a picture on the mockup at pin 1 to use there/);
  assert.match(said, /dropped picture: attached as shop photo\.png/);
  assert.match(said, /Attached image shop photo\.png, 80×80, image artifact [\w-]+\]/);
  assert.deepEqual(errors, []);
  console.log("PASS: a picture dropped on a mockup is a note pinned there, sent to the chat under its own name with the words to use it; anything else is refused.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
process.exit(0);
