/** Real Electron check (pass 210 A): show puts the app being built (live) and
 * a picture from the project in one quiet card on the right, the newest
 * replacing the last; the chat keeps the keyboard and never scrolls. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

// The app being built: a page on a local port.
const app = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<!doctype html><title>Roaster</title><body style=\"margin:0;font:48px system-ui;background:#f3efe6\"><h1 style=\"padding:40px\">Roaster pricing</h1><p style=\"padding:0 40px\">Three plans, one page.</p></body>", { headers: { "content-type": "text/html" } }) });
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const f = await fixture({
  providerId: "fixture", modelId: "open-show",
  async listModels() { return [{ id: "open-show", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages, tools) {
    const at = messages.findLastIndex(message => message.role === "user");
    const request = messages[at]?.content ?? "";
    const current = messages.slice(at + 1).filter(message => message.role === "tool");
    if (!current.length) {
      assert(tools.some(tool => tool.name === "show"), "show is offered in a chat you're in");
      assert(tools.some(tool => tool.name === "open"), "open is offered in a chat you're in");
      const input = /picture/.test(request) ? { path: "design.png" } : { url: `http://127.0.0.1:${app.port}/`, title: "Roaster pricing" };
      yield { type: "tool_call_delta" as const, index: 0, idDelta: `show-${at}`, nameDelta: "show", argumentsDelta: JSON.stringify(input) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "It's on the right." };
    yield { type: "finish", reason: "stop" };
  },
});
writeFileSync(join(f.workspace, "design.png"), pixel);
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), `--user-data-dir=${join(f.root, "electron-open-show")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 900));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  const editor = page.locator("textarea");
  const send = async (text: string) => {
    await page!.waitForFunction(() => !(window.demesneInspect?.() as { host?: { busy?: boolean } })?.host?.busy);
    await page!.waitForTimeout(200);
    await editor.fill(text); await editor.press("Enter");
  };
  await send("show me the app");
  const card = page.locator('#cards [data-card="shown"]');
  await card.waitFor();
  assert.match((await card.textContent())!, /Roaster pricing/);
  assert.match((await card.locator(".fp-foot").textContent())!, /Live · the app/);
  assert.equal(await card.locator(".pv-live").count(), 1, "a live dot");
  assert.equal(await card.locator(`iframe[src="http://127.0.0.1:${app.port}/"]`).count(), 1, "the app runs live in the card");
  await page.locator("#conversation .turn").filter({ hasText: "It's on the right." }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "the chat keeps the keyboard");
  const box = await card.locator(".fp-box").boundingBox();
  assert(box && Math.abs(box.width / box.height - 4 / 3) < 0.05, `a 4:3 preview (${box?.width}×${box?.height})`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(output, "open-show-live.png") });
  // Bigger on click, back on a second.
  await card.locator(".fp-box").click();
  await card.and(page.locator(".wide")).waitFor();
  await page.screenshot({ path: join(output, "open-show-big.png") });
  await card.locator(".fp-box").click();
  await page.locator('#cards [data-card="shown"]:not(.wide)').waitFor();
  console.log("PASS: show puts the running app live in a 4:3 card on the right, bigger on click, and the chat keeps the keyboard.");
  // A picture goes to the file preview, and replaces the app's card.
  await send("show the picture");
  await page.locator('#cards [data-card="file-preview"]').waitFor();
  await card.waitFor({ state: "detached" });
  await page.screenshot({ path: join(output, "open-show-file.png") });
  console.log("PASS: a file shows in the file preview card, the newest replacing the last.");
  // × puts it away and it stays away.
  await send("show me the app");
  await card.waitFor();
  await page.locator('#cards [data-card="file-preview"]').waitFor({ state: "detached" });
  await card.locator(".fp-x").click();
  await card.waitFor({ state: "detached" });
  await page.waitForTimeout(500);
  assert.equal(await card.count(), 0, "a closed card stays closed");
  console.log("PASS: × puts the card away.");
  assert.deepEqual(errors, []);
} catch (error) {
  if (page) await page.screenshot({ path: join(output, "open-show-failure.png") }).catch(() => {});
  throw error;
} finally {
  await desktop?.close();
  await f.close();
  app.stop(true);
}
