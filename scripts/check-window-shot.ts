/** Screenshots that land in a card (pass 187 A) against the real Electron app
 * on X11: a browser window in front, Ctrl+Alt+Space, and the window glides
 * into a card after the last card; the next message takes the picture and
 * it joins the chat's pile (pass 202 A). Also takes the window directly with
 * packages/screen, as the model's capture_window does.
 * Needs an X display with a window manager (openbox) plus xprop, xwininfo,
 * xdotool and ImageMagick's import:
 *   xvfb-run -a -s "-screen 0 1600x1000x24" sh -c 'openbox & sleep 1; bun scripts/check-window-shot.ts'
 * Run bun scripts/prepare-desktop.ts first. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";
import { captureWindow, frontWindow, listWindows } from "../packages/screen/src/index.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const output = resolve(process.argv[2] ?? "test-results/window-shot");
mkdirSync(output, { recursive: true });
const { _electron: electron, chromium } = await import("playwright");
const sh = async (...args: string[]) => { const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }); const text = await new Response(child.stdout).text(); await child.exited; return text.trim(); };

const failures: string[] = [];
const expect = (ok: boolean, what: string) => { if (!ok) failures.push(what); console.log(ok ? "ok  " : "FAIL", what); };
let lastAsk = "";
const f = await fixture({
  providerId: "test", modelId: "vision-model", contextCapacity: 200000, maxOutputTokens: 4096,
  async listModels() { return [{ id: "vision-model", provider: "test", contextWindow: 200000 }]; },
  async *stream(messages: ProviderMessage[]): AsyncGenerator<ProviderStreamEvent> {
    lastAsk = JSON.stringify(messages.at(-1));
    yield { type: "text_delta", delta: lastAsk.includes("here it is") ? "I see it: Save is in the footer now." : "Can you show me where it is now?" };
    yield { type: "finish", reason: "stop" };
  },
});
// The window you're looking at: a page in a browser, left of Demesne.
const other = await chromium.launch({ headless: false, executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium", args: ["--window-position=40,60", "--window-size=760,620"] });
const site = await other.newPage();
await site.setContent(`<title>Settings – Acme</title><body style="font:15px sans-serif;margin:30px;background:#f5f5f7"><h1>Settings</h1><p>Team name</p><input><p>Billing email</p><input><div style="position:fixed;right:30px;bottom:30px"><button>Cancel</button> <button style="background:#0071e3;color:#fff">Save</button></div></body>`);
await site.waitForTimeout(800);
const browserWindow = (await sh("xdotool", "search", "--name", "Settings – Acme")).split("\n")[0]!;
expect(Boolean(browserWindow), `the browser window is on screen (${browserWindow})`);

// The model's capture_window path, straight through packages/screen.
await sh("xdotool", "windowactivate", "--sync", browserWindow);
const listed = await listWindows();
expect(listed.some((window) => window.title.includes("Settings – Acme")), `windows listed: ${listed.map((w) => `${w.app}·${w.title}`).join(" | ")}`);
const front = await frontWindow();
const direct = await captureWindow(front, { text: true });
expect(front.title.includes("Settings – Acme") && direct.png.length > 2000 && direct.png[0] === 137, `the front window taken directly: ${front.app} · ${front.title} · ${direct.png.length} bytes`);
expect(Boolean(direct.textNote?.includes("Linux")), "on Linux it says the text isn't read yet");
writeFileSync(join(output, "direct.png"), direct.png);

const app = await electron.launch({ args: [join(desktop, "build/app"), `--user-data-dir=${join(f.root, "electron")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") } });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 860 });
  const editor = page.locator("#composer [contenteditable], #composer textarea, [contenteditable='true']").first();
  await editor.waitFor({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.type("the save button moved after the update, why?");
  await page.keyboard.press("Enter");
  await page.getByText("Can you show me where it is now?").first().waitFor({ timeout: 20_000 });
  // Back to the browser, then the keys.
  await sh("xdotool", "windowactivate", "--sync", browserWindow);
  await page.waitForTimeout(400);
  await sh("xdotool", "key", "--clearmodifiers", "ctrl+alt+space");
  const card = page.locator("#cards .card.shot").first();
  await card.waitFor({ state: "attached", timeout: 20_000 });
  await page.waitForTimeout(350);
  expect(await page.locator(".shot-copy").count() === 1, "a copy of the window is gliding in");
  await page.screenshot({ path: join(output, "landing.png") });
  await page.waitForTimeout(1600);
  expect(await page.locator(".shot-copy").count() === 0, "the copy is gone once it lands");
  const head = await card.locator(".shot-head").innerText();
  expect(head.includes("Settings – Acme"), `the card names the window: ${head.replace(/\s+/g, " ")}`);
  const natural = await card.locator(".shot-pic img").evaluate((img) => (img as HTMLImageElement).naturalWidth);
  expect(natural > 300, `the card shows the picture (${natural}px wide)`);
  const order = await page.locator("#cards > .card").evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.card));
  expect(order.at(-1)?.startsWith("shot-") === true, `the screenshot is the last card (${order.join(", ")})`);
  const note = await page.locator("#attach-row").innerText();
  expect(/goes with this/.test(note), `the composer says it goes with the next message: ${note}`);
  await page.screenshot({ path: join(output, "landed.png") });
  await card.locator(".shot-pic").click();
  await page.waitForTimeout(200);
  expect(await card.locator(".shot-pic.big").count() === 1, "a click shows the whole window in the card");
  await page.screenshot({ path: join(output, "big.png") });
  await editor.click();
  await page.keyboard.type("here it is");
  await page.keyboard.press("Enter");
  await page.getByText("I see it: Save is in the footer now.").first().waitFor({ timeout: 20_000 });
  expect(/image/i.test(lastAsk), "the model got the picture with the message");
  expect(lastAsk.includes("here it is"), "and the words");
  await page.waitForTimeout(400);
  // Used: the picture is in your bubble now, so its card goes.
  expect(await page.locator("#cards .card.shot").count() === 0, "the card goes once it's sent");
  expect(await page.locator("#attach-row .shot-note-att").count() === 0, "the composer note is gone");
  await page.mouse.move(10, 10);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(output, "sent.png") });
  // Sent, it joins the chat's pile (pass 202 A), and stays.
  const pile = page.locator("#cards .card.pile");
  await pile.waitFor({ timeout: 10_000 });
  expect(await pile.locator(".pile-shot").count() === 1 && await pile.locator(".pile-n").count() === 0, "the sent screenshot is on the chat's pile");
  expect((await pile.innerText()).trim() === "", "the pile is just the picture, no words");
  await page.waitForFunction(() => (document.querySelector<HTMLImageElement>("#cards .pile-shot")?.naturalWidth ?? 0) > 300, null, { timeout: 10_000 }).then(() => expect(true, "the pile shows its picture"), () => expect(false, "the pile shows its picture"));
  // A second one lands on top.
  await sh("xdotool", "windowactivate", "--sync", browserWindow);
  await page.waitForTimeout(400);
  await sh("xdotool", "key", "--clearmodifiers", "ctrl+alt+space");
  await page.locator("#cards .card.shot").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1600);
  await editor.click();
  await page.keyboard.type("and again, here it is");
  await page.keyboard.press("Enter");
  await page.locator("#cards .pile-n", { hasText: "2" }).waitFor({ timeout: 20_000 });
  expect(await page.locator("#cards .pile-shot.landing").count() === 1, "the new one drops onto the pile");
  await page.waitForTimeout(1300);
  expect(await pile.locator(".pile-shot").count() === 2, "two screenshots on the pile");
  const rest = await page.locator("#cards .pile-shot").last().boundingBox();
  await page.locator("#cards .pile-stack").hover();
  await page.waitForTimeout(900);
  const fanned = await page.locator("#cards .pile-shot").last().boundingBox();
  expect(Boolean(rest && fanned && Math.abs(rest.x - fanned.x) > 20), "hovering fans the pile out");
  await page.screenshot({ path: join(output, "pile-fanned.png") });
  await page.locator("#cards .pile-stack").click();
  const view = page.locator(".pile-view");
  await view.waitFor({ timeout: 5_000 });
  expect((await view.locator(".pile-nav").innerText()).includes("2 of 2"), "a click opens the newest, full size");
  await page.keyboard.press("ArrowLeft");
  expect((await view.locator(".pile-nav").innerText()).includes("1 of 2"), "the arrow keys flip through");
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(output, "pile-view.png") });
  await view.locator(".pile-remove").click();
  await page.waitForTimeout(300);
  expect(await view.locator(".pile-nav").count() === 0, "Remove takes it off the pile");
  await page.keyboard.press("Escape");
  expect(await page.locator(".pile-view").count() === 0, "Escape closes it");
  await page.waitForTimeout(300);
  expect(await pile.locator(".pile-shot").count() === 1, "the pile has one left");
  await page.mouse.move(10, 10);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(output, "pile.png") });
} catch (error) {
  failures.push(String(error));
  console.log("FAIL", error);
} finally {
  await app.close();
  await other.close();
  f.server.stop?.(true);
}
if (failures.length) { console.log(`${failures.length} failed`); process.exit(1); }
console.log("all passed");
process.exit(0);
