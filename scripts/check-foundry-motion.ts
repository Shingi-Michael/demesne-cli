/** Real Electron check for piece 8 of pass 274, motion: a part marked
 * data-move plays once when its place is shown. A booking page's "Booked"
 * sheet is not there until Book is pressed; then it rises from below over
 * the page's own time (--move), ends at rest, and plays again the next time
 * it appears. Run after `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/parts.js"></script>
<style>:root{--accent:#0b6e4f;--paper:#f6f4ee;--ink:#1a1f1c;--move:900ms} body{margin:0;background:var(--paper);color:var(--ink)} main{position:relative;height:560px;padding:48px 64px;overflow:hidden}
h1{font-family:Georgia,serif;font-size:32px;margin:0 0 8px} .slots{display:flex;gap:8px;margin:20px 0} .slots span{padding:8px 16px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--hair)}
.sheet{position:absolute;left:0;right:0;bottom:0;padding:28px 64px;background:#fff;border-radius:16px 16px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.14)}</style></head><body>
<main><h1>Book a visit</h1><p>Harbor Clinic · Dr. Okafor · Tuesday</p><div class="slots"><span>9:00</span><span>10:30</span><span>1:15</span></div><button class="primary" id="book" data-go="Booked">Book 10:30</button>
<div data-view="Closed"></div><div class="sheet" data-view="Booked" data-move="rise"><b>Booked for Tuesday, 10:30</b><p>A text will arrive the day before.</p><button class="quiet" id="done" data-go="Closed">Done</button></div></main></body></html>`;
const WHY = { direction: "Calm, for patients booking a visit.", look_at: "The sheet that confirms.", starts_from: "new", dropped: "",
  walkthrough: [{ what: "Booking a visit, for the clinic's patients.", parts: [{ name: "Book button", says: "Books the slot.", at: "#book" }, { name: "Booked sheet", says: "Rises to confirm.", at: ".sheet" }], why: "The answer arrives where the eye is." }] };

const f = await fixture({
  providerId: "fixture", modelId: "foundry-motion",
  async listModels() { return [{ id: "foundry-motion", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "Here is the booking page; press Book to see the sheet rise." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Booking sheet", kind: "html", description: "A booking page whose confirmation rises from below.", note: "First take", source: PAGE, why: WHY }) };
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
  await editor.fill("/foundry mock the booking page with its confirmation"); await editor.press("Enter");
  const chip = app.locator("#conversation .fd-chip").filter({ hasText: "Booking sheet" });
  await chip.waitFor();
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Booking sheet")!.id;
  await chip.click();
  await app.locator(`#page [data-fd="${id}:1"]`).waitFor();
  const frame = () => app.frames().find((one) => one.url().includes(id) && one.url().includes("stack=1")) as Frame | undefined;
  /// The sheet now: shown or not, how far below its resting place it is drawn, and what is playing on it.
  const sheet = () => frame()!.evaluate(() => { const el = document.querySelector(".sheet") as HTMLElement, s = getComputedStyle(el), move = el.getAnimations()[0];
    return { shown: !el.hidden && s.display !== "none", below: Math.round(new DOMMatrix(s.transform === "none" ? "" : s.transform).m42), height: el.offsetHeight, name: s.animationName, duration: s.animationDuration, playing: move?.playState ?? "none", at: Math.round(Number(move?.currentTime ?? -1)) }; });
  await step(52, async () => !!frame() && !!(await frame()!.evaluate(() => !!document.querySelector(".sheet")).catch(() => false)));
  assert.equal((await sheet()).shown, false, "the sheet is not there before Book is pressed");
  // Pass 277 B: the sidebar folds as the mockup opens; a click in the first moments of a resized frame can miss.
  await app.waitForTimeout(600);

  // Press Book: the sheet appears below its place and rises over the page's own time.
  await frame()!.locator("#book").click();
  const early = await sheet();
  assert.equal(early.shown, true);
  assert.equal(early.name, "d-rise");
  assert.equal(early.duration, "0.9s", "the page's own --move is the time");
  assert.equal(early.playing, "running");
  assert(early.below > 0 && early.below <= early.height, `mid-rise the sheet is drawn below its resting place (${early.below}px of ${early.height})`);
  mkdirSync("output", { recursive: true });
  await app.screenshot({ path: "output/foundry-motion-rising.png" });
  await step(63, async () => (await sheet()).playing === "finished");
  const rest = await sheet();
  assert.equal(rest.below, 0, "it ends at rest");
  await app.mouse.move(5, 5);
  await app.screenshot({ path: "output/foundry-motion.png" });
  console.log(`PASS: the sheet rises when Book is pressed (seen ${early.below}px below its place at ${early.at}ms of 900), and ends at rest.`);

  // Done closes it; the next Book plays the rise again from the start.
  await frame()!.locator("#done").click();
  await step(70, async () => !(await sheet()).shown);
  await frame()!.locator("#book").click();
  const again = await sheet();
  assert(again.playing === "running" && again.below > 0, "it plays again each time it appears");
  console.log("PASS: it plays again the next time it appears.");
  assert.deepEqual(errors, []);
} finally {
  await window?.close().catch(() => {});
  await desktop?.close().catch(() => {});
  await f.close();
}
