/** Real Electron check (pass 247 A): screenshots leave when the chat is done
 * with them. While a turn runs, the window the chat captured is on the pile
 * on the right. When the answer is done the pile lifts away, and the picture
 * stays as a small one beside the step count, and on the step that took it
 * once the steps are unfolded; a click opens it full size.
 * Nothing piles up over later asks. The window capture is a stand-in, so this
 * runs where windows can't be pictured.
 * Run bun scripts/prepare-desktop.ts first (Linux: xvfb-run -a). */
import { _electron as electron, chromium, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";

// The window the chat "captures": a small checkout page, pictured once.
const browser = await chromium.launch({ executablePath: process.env.DEMESNE_CHROMIUM });
const site = await browser.newPage({ viewport: { width: 900, height: 620 } });
await site.setContent(`<body style="margin:0;font:16px Georgia,serif;background:#fbf7f2;color:#2a211b"><main style="padding:48px 56px"><h1 style="margin:0 0 6px">Checkout</h1><p style="margin:0 0 28px;color:#7d6a5d">Daily · two bags a month</p><div style="padding:18px;border:2px solid #b9643c;border-radius:14px;background:#fff;margin-bottom:12px">Yearly · €200</div><div style="padding:18px;border:1px solid #ece2d8;border-radius:14px;background:#fff">Monthly · €20</div><button style="margin-top:28px;padding:12px 40px;border:0;border-radius:12px;background:#c98563;color:#fff;font:600 16px system-ui">Pay €200</button></main></body>`);
const png = new Uint8Array(await site.screenshot());
await browser.close();

let release = () => {};
let gate = new Promise<void>((done) => { release = done; });
const f = await fixture({
  providerId: "fixture", modelId: "shot-leaves", contextCapacity: 262144, maxOutputTokens: 4096,
  async listModels() { return [{ id: "shot-leaves", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages, tools) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const asked = JSON.stringify(messages[at]?.content ?? "");
    const stepped = messages.slice(at + 1).some((message) => message.role === "tool");
    if (/checkout/.test(asked) && !stepped) {
      assert(tools.some((tool) => tool.name === "capture_window"), "capture_window is offered");
      yield { type: "tool_call_delta" as const, index: 0, idDelta: `capture-${at}`, nameDelta: "capture_window", argumentsDelta: "{}" };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    // The answer waits until the check has looked at the pile.
    if (stepped) await gate;
    yield { type: "text_delta", delta: stepped ? "The button sat 4px lower than the total beside it." : "The gift page has the same button, so it is fine." };
    yield { type: "finish", reason: "stop" };
  },
}, { vision: true, windowCapture: {
  list: async () => [{ id: "7", app: "Slow Pour", title: "Checkout" }],
  capture: async (window) => ({ ...window, png, text: "Checkout Pay €200" }),
} });

let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve(process.argv[2] ?? "test-results/shot-leaves");
mkdirSync(output, { recursive: true });
try {
  desktop = await electron.launch({ args: [resolve("apps/desktop/build/app"), `--user-data-dir=${join(f.root, "electron-shot-leaves")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 900));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#composer-model").waitFor();
  const editor = page.locator("textarea");
  const send = async (text: string) => {
    await page!.waitForFunction(() => !(window.demesneInspect?.() as { host?: { busy?: boolean } })?.host?.busy);
    await page!.waitForTimeout(200);
    await editor.fill(text); await editor.press("Enter");
  };

  // While it works: the captured window is on the pile, and not yet on its step.
  await send("The Pay button looks off on the checkout. Take a look.");
  const pile = page.locator("#cards .card.pile");
  await pile.locator(".pile-shot").waitFor();
  await page.waitForFunction(() => (document.querySelector<HTMLImageElement>("#cards .pile-shot")?.naturalWidth ?? 0) > 300);
  assert.equal(await pile.locator(".pile-shot").count(), 1, "one picture on the pile");
  assert.equal(await page.locator("#conversation .step-shot").count(), 0, "no small picture on the step while the pile shows it");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(output, "working.png") });
  await pile.locator(".pile-stack").click();
  const view = page.locator(".pile-view");
  await view.waitFor();
  assert.match((await view.locator("figcaption").innerText()), /Checkout · the chat took it$/);
  assert.equal(await view.locator(".pile-remove").count(), 0, "nothing to remove: the pile goes by itself");
  await page.keyboard.press("Escape");
  await view.waitFor({ state: "detached" });
  console.log("PASS: while the model works, the window it captured is on the pile on the right.");

  // The answer is done: the pile lifts away, and the picture is on its step.
  release();
  await page.locator("#conversation .turn").filter({ hasText: "The button sat 4px lower" }).waitFor();
  const leaving = await page.locator("#cards .card.pile.leaving").waitFor({ timeout: 2000 }).then(() => true, () => false);
  assert(leaving, "the pile lifts away rather than vanishing");
  await pile.waitFor({ state: "detached", timeout: 4000 });
  // The steps are folded under the answer, so the picture sits beside the step count.
  const foot = page.locator("#conversation .turn-receipt .receipt-shots .step-shot");
  await foot.waitFor();
  assert.equal(await foot.count(), 1, "one small picture beside the step count");
  await page.waitForFunction(() => (document.querySelector<HTMLImageElement>("#conversation .step-shot img")?.naturalWidth ?? 0) > 300);
  const small = await foot.boundingBox();
  assert(small && small.height <= 22 && small.width <= 46, `the picture is small (${small?.width}×${small?.height})`);
  await page.mouse.move(700, 800);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(output, "done.png") });
  // Unfolded, it is on the step that took it, at the end of its line.
  await page.locator("#conversation .receipt-steps").click();
  const shot = page.locator("#conversation .step-line.shot-line .step-shot");
  await shot.waitFor();
  assert.equal(await page.locator("#conversation .step-shot").count(), 1, "one small picture, now on the step that took it");
  const size = await shot.boundingBox(), row = await page.locator("#conversation .step-line.shot-line .tool-row").boundingBox();
  assert(size && size.height <= 26 && size.width <= 46, `the picture is small (${size?.width}×${size?.height})`);
  assert(row && size && Math.abs((row.y + row.height / 2) - (size.y + size.height / 2)) < 3 && size.x > row.x + row.width - 2, "it sits at the end of its step's line");
  await page.mouse.move(700, 800);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(output, "steps.png") });
  await shot.click();
  const big = page.locator(".pl-big");
  await big.waitFor();
  assert.equal(await big.locator("figcaption").innerText(), "Checkout");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(output, "opened.png") });
  await page.keyboard.press("Escape");
  await big.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => localStorage.getItem("demesne-pile-hidden")), null, "nothing is kept about removed pictures");
  console.log("PASS: when the answer is done the pile leaves, and the picture stays small on its step and opens full size.");

  // A later ask: nothing has piled up, and the earlier picture is still on its step.
  gate = Promise.resolve();
  await send("Same for the gift page?");
  await page.locator("#conversation .turn").filter({ hasText: "The gift page has the same button" }).waitFor();
  await page.waitForTimeout(600);
  assert.equal(await pile.count(), 0, "no pile after a later ask");
  assert.equal(await page.locator("#conversation .step-shot").count(), 1, "the earlier picture is still on its step");
  await page.mouse.move(700, 800);
  await page.screenshot({ path: join(output, "later.png") });
  console.log("PASS: a later ask finds nothing piled up on the right.");
  assert.deepEqual(errors, []);
} catch (error) {
  if (page) await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  release();
  await desktop?.close();
  await f.close();
}
