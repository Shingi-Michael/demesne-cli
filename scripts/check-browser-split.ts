/** Real Electron check (pass 248 D): the chat's browser beside the chat.
 * The window splits when the model starts browsing: the chat on the left, the
 * model's own browser on the right, live. When the model hands the page over
 * (a sign-in), your keys reach the page until you go back to the chat, and the
 * model reads the page again. The page stays after the answer until ×, and a
 * browser step opens it again.
 * Run bun scripts/prepare-desktop.ts first (Linux: xvfb-run -a). */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { electronBrowser } from "../apps/daemon/src/browser.ts";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

const root = resolve(import.meta.dir, "..");
const electronBin = process.env.DEMESNE_ELECTRON ?? join(root, "node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
const hostCommand = [electronBin, join(root, "apps/desktop/build/app"), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])];

// The app the model checks: a checkout, and an admin that wants a sign-in.
const page = (title: string, body: string) => new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;font:18px Georgia,serif;background:#fbf7f2;color:#2a211b"><main style="padding:48px 56px">${body}</main></body>`, { headers: { "Content-Type": "text/html" } });
const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/admin") return page("Sign in", `<h1 style="font:600 30px system-ui">Sign in to Slow Pour admin</h1><p><input id="email" placeholder="Email" style="font:20px system-ui;padding:12px;width:420px;border:1px solid #ccc;border-radius:8px"></p><button id="go" style="font:600 18px system-ui;padding:12px 40px;border:0;border-radius:10px;background:#111417;color:#fff">Sign in</button><p id="said"></p>
    <script>go.onclick = () => { said.textContent = "Signed in as " + email.value; document.title = "Orders"; document.querySelector("h1").textContent = "Orders"; };</script>`);
  if (url.pathname === "/cart") return page("Cart", `<h1 style="font:600 30px system-ui">Cart</h1><p>One yearly plan, £96.</p>`);
  return new Response("not here", { status: 404 });
} });
const base = `http://localhost:${site.port}`;
const browser = electronBrowser(hostCommand);

let release = () => {};
const gate = new Promise<void>((done) => { release = done; });
const f = await fixture({
  providerId: "fixture", modelId: "browser-split", contextCapacity: 262144, maxOutputTokens: 4096,
  async listModels() { return [{ id: "browser-split", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages, tools) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const steps = messages.slice(at + 1).filter((message) => message.role === "tool").length;
    if (steps === 0) {
      assert(tools.some((tool) => tool.name === "browser"), "the browser is offered");
      yield { type: "tool_call_delta" as const, index: 0, idDelta: `open-${at}`, nameDelta: "browser", argumentsDelta: JSON.stringify({ action: "open", url: `${base}/admin` }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (steps === 1) {
      yield { type: "tool_call_delta" as const, index: 0, idDelta: `hand-${at}`, nameDelta: "browser", argumentsDelta: JSON.stringify({ action: "hand_over", reason: "Sign in to the Slow Pour admin" }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    const last = JSON.stringify(messages.at(-1)?.content ?? "");
    if (steps === 2) {
      assert.match(last, /handed the page back/, "the model hears the page came back");
      yield { type: "tool_call_delta" as const, index: 0, idDelta: `click-${at}`, nameDelta: "browser", argumentsDelta: JSON.stringify({ action: "click", ref: "Sign in" }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    await gate;
    yield { type: "text_delta", delta: /Orders/.test(last) ? "Signed in. Order #1042 is at the top of Orders." : "The sign-in did not go through." };
    yield { type: "finish", reason: "stop" };
  },
}, { browser });

let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, win: Page | undefined;
const output = resolve(process.argv[2] ?? "test-results/browser-split");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), `--user-data-dir=${join(f.root, "electron-browser-split")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  win = await desktop.firstWindow();
  win.setDefaultTimeout(15000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
  const errors: string[] = [];
  win.on("pageerror", (error) => errors.push(error.message));
  await win.locator("#composer-model").waitFor();
  await win.locator("textarea").fill("Check that the admin sign-in works.");
  await win.locator("textarea").press("Enter");

  // The model opens the page: the window splits, and the page shows live on the right.
  const split = win.locator("#browser-split");
  await split.waitFor();
  await win.waitForFunction(() => (document.querySelector<HTMLCanvasElement>("#browser-split .bs-page")?.width ?? 0) > 400);
  assert.match(await split.locator(".bs-url").inputValue(), /localhost:\d+\/admin/);
  assert(await win.locator("#app.browser-split-on").count(), "the window is split");
  const box = await split.boundingBox(), chat = await win.locator("#main").boundingBox();
  assert(box && chat && box.width > 500 && chat.width > 380, `chat ${chat?.width}px, browser ${box?.width}px`);
  console.log("PASS: when the model starts browsing, the window splits and the page shows live on the right.");

  // The model hands it over: the line asks, and your keys reach the page.
  await win.waitForFunction(() => document.querySelector("#browser-split")?.classList.contains("yours"));
  assert.match(await split.locator(".bs-words").innerText(), /Sign in to the Slow Pour admin, then go back to the chat/);
  assert.match(await win.locator("#conversation").innerText(), /waiting for you/);
  await win.waitForTimeout(500);
  await win.screenshot({ path: join(output, "yours.png") });
  // Click the email field where it is on the picture, then type, Tab to Sign in, and press Space.
  const img = split.locator(".bs-page"), imgBox = (await img.boundingBox())!;
  // The page is laid out at the width the split shows it, so a spot on the page is the same spot on the picture.
  const pageWidth = imgBox.width;
  await win.mouse.click(imgBox.x + (56 + 200) / pageWidth * imgBox.width, imgBox.y + 150 / pageWidth * imgBox.width);
  await win.keyboard.type("ada@slowpour.test", { delay: 15 });
  await win.keyboard.press("Tab");
  await win.keyboard.press("Space");
  await win.waitForFunction(() => /Orders/.test(document.querySelector("#browser-split .bs-url")?.getAttribute("title") ?? ""), undefined, { timeout: 10000 });
  await win.waitForTimeout(400);
  await win.screenshot({ path: join(output, "signed-in.png") });
  // Back to the chat hands it back.
  await win.locator("textarea").click();
  console.log("PASS: a hand-over asks under the page, your click and keys reach the page, and a click in the chat hands it back.");

  // Handed back, the model clicks: a soft ring shows where.
  await win.waitForFunction(() => { const ring = document.querySelector<HTMLElement>("#browser-split .bs-ring"); return Boolean(ring && !ring.hidden && ring.classList.contains("on")); }, undefined, { timeout: 10000 });
  const ring = (await split.locator(".bs-ring").boundingBox())!, picture = (await img.boundingBox())!;
  assert(ring.x > picture.x && ring.y > picture.y && ring.x < picture.x + picture.width / 2, `the ring is on the Sign in button, at ${Math.round(ring.x - picture.x)},${Math.round(ring.y - picture.y)}`);
  await win.screenshot({ path: join(output, "ring.png") });
  console.log("PASS: where the model clicks shows as a ring on the page.");

  // Handed back: the model reads the page again and answers; the page stays until ×.
  release();
  await win.locator("#conversation .turn").filter({ hasText: "Order #1042 is at the top of Orders" }).waitFor();
  await win.waitForFunction(() => document.querySelector("#browser-split")?.classList.contains("done"));
  assert.equal(await win.locator("#browser-split.yours").count(), 0, "the model's click leaves the page the model's");
  assert.match(await split.locator(".bs-words").innerText(), /done with this page/);
  await win.mouse.move(400, 700);
  await win.waitForTimeout(400);
  await win.screenshot({ path: join(output, "done.png") });

  // You scroll it: it is yours. The address is yours to type, back and forward work, and the pages it went to stay to look back at.
  assert.equal(await split.locator(".bs-url").getAttribute("readonly"), "", "the address is not yours until you take the page");
  const pic = (await img.boundingBox())!;
  await win.mouse.move(pic.x + 200, pic.y + 200);
  await win.mouse.wheel(0, 200);
  await win.waitForFunction(() => document.querySelector("#browser-split")?.classList.contains("yours"));
  assert.match(await split.locator(".bs-words").innerText(), /The page is yours/);
  assert.equal(await split.locator(".bs-url").getAttribute("readonly"), null, "the address is yours to type");
  await split.locator(".bs-url").fill("localhost:" + site.port + "/cart");
  await split.locator(".bs-url").press("Enter");
  await win.waitForFunction(() => /\/cart$/.test((document.querySelector<HTMLInputElement>("#browser-split .bs-url"))?.value ?? ""), undefined, { timeout: 10000 });
  await split.locator('[data-go="back"]:not([disabled])').waitFor();
  await split.locator(".bs-visit").first().waitFor();
  await win.waitForTimeout(400);
  await win.screenshot({ path: join(output, "taken.png") });
  await split.locator(".bs-visit").first().click();
  await win.waitForFunction(() => /earlier page/.test(document.querySelector("#browser-split .bs-words")?.textContent ?? ""));
  await split.locator(".bs-back", { hasText: "Back to live" }).click();
  await win.waitForFunction(() => !/earlier page/.test(document.querySelector("#browser-split .bs-words")?.textContent ?? ""));
  await split.locator('[data-go="back"]').click();
  await win.waitForFunction(() => /\/admin$/.test((document.querySelector<HTMLInputElement>("#browser-split .bs-url"))?.value ?? ""), undefined, { timeout: 10000 });
  await win.locator("#conversation").click({ position: { x: 20, y: 20 } });
  await win.waitForFunction(() => !document.querySelector("#browser-split")?.classList.contains("yours"));
  console.log("PASS: a scroll makes the page yours; you can type an address, go back, look at earlier pages, and hand it back.");
  await split.locator(".bs-close").click();
  await split.waitFor({ state: "hidden" });
  assert.equal(await win.locator("#app.browser-split-on").count(), 0, "the chat has the window back");
  console.log("PASS: after the answer the page stays, and × gives the chat the whole window back.");
  assert.deepEqual(errors, []);
} catch (error) {
  if (win) await win.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  release();
  await desktop?.close();
  browser.close();
  await f.close();
  site.stop(true);
}
