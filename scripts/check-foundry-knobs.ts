/** Real Electron check for piece 5 of pass 274, knobs: a page names some of
 * its values as knobs; over the opened mockup each is a slider that changes
 * the page at once, with no model run; one line sends the settings to the
 * chat, and the model keeps them as the next version.
 * Run after `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="foundry://kit/base.css">`
  + `<meta name="knob" content="Room | --pad | 8 | 32 | px"><meta name="knob" content="Corners | --r | 0 | 20 | px"><meta name="knob" content="Warmth | --hue | 150 | 200 | ">`
  + `<style>:root{--pad:14px;--r:10px;--hue:175;--paper:#fbfaf7;--ink:#1c2422} body{margin:0;padding:40px 48px;background:var(--paper);color:var(--ink)} main{max-width:420px;padding:var(--pad);border-radius:var(--r);box-shadow:inset 0 0 0 1px rgba(0,0,0,.14)} h1{font-family:Georgia,serif;font-size:26px;margin:0 0 6px} .slots{display:flex;gap:8px;margin:16px 0} .slots span{padding:8px 14px;border-radius:var(--r);box-shadow:inset 0 0 0 1px rgba(0,0,0,.16)} .go{display:inline-block;padding:11px 18px;border-radius:var(--r);background:hsl(var(--hue) 70% 26%);color:#fff;font-weight:600}</style></head>`
  + `<body><main><h1>Book a visit</h1><p>Harbor Clinic · Dr. Okafor · Tuesday</p><div class="slots"><span>9:00</span><span>10:30</span><span>1:15</span></div><span class="go">Book 10:30</span></main></body></html>`;
const WHY = { direction: "Calm, for patients booking a visit.", look_at: "The one button.", starts_from: "new", dropped: "Insurance details.",
  walkthrough: [{ what: "A booking page for the clinic's patients.", parts: [{ name: "Times", says: "The free times to pick from." }, { name: "Book button", says: "Books the chosen time." }], why: "One decision on the page." }] };
const said: string[] = [];

const f = await fixture({
  providerId: "fixture", modelId: "foundry-knobs",
  async listModels() { return [{ id: "foundry-knobs", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user"), ask = String(messages[at]?.content ?? "");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: ask.includes("moved its knobs") ? "Kept: more room, as you set it." : "Here is the booking page. It has three knobs." }; yield { type: "finish", reason: "stop" }; return; }
    // The settings came back: the model keeps them as the next version, changing only those values.
    if (ask.includes("moved its knobs")) {
      said.push(ask);
      const id = /\(id ([\w-]+), v1\)/.exec(ask)?.[1] ?? "";
      yield { type: "tool_call_delta", index: 0, idDelta: `edit-${at}`, nameDelta: "foundry_edit", argumentsDelta: JSON.stringify({ id, base_version: 1, note: "Your settings", why: { direction: "Calm, for patients booking a visit.", look_at: "The one button, with more room around it.", dropped: "Nothing new." }, edits: [{ find: "--pad:14px", replace: "--pad:26px" }] }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Booking page", kind: "html", description: "Pick a time and book it.", note: "First take", source: PAGE, why: WHY }) };
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
  await editor.fill("/foundry mock the booking page"); await editor.press("Enter");
  const chip = app.locator("#conversation .fd-chip").filter({ hasText: "Booking page" });
  await chip.waitFor();
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Booking page")!.id;
  await chip.click();
  const item = app.locator(`#page [data-fd="${id}:1"]`);
  await item.waitFor();

  // Over the opened mockup: a slider per knob, standing where the page set it; nothing to send yet.
  const knobs = item.locator(".fd-knobs"), sliders = knobs.locator("input[type=range]"), send = knobs.locator(".fd-knobs-send");
  await knobs.waitFor();
  assert.deepEqual(await knobs.locator(".fd-knob").allInnerTexts().then((all) => all.map((one) => one.replace(/\s+/g, " ").trim())), ["Room 14px", "Corners 10px", "Warmth 175"]);
  assert.equal(await send.isHidden(), true);
  const frame = () => app.frames().find((one) => one.url().includes(id) && one.url().includes("stack=1")) as Frame | undefined;
  const drawn = () => frame()!.evaluate(() => { const main = getComputedStyle(document.querySelector("main")!), go = getComputedStyle(document.querySelector(".go")!); return { pad: main.paddingTop, radius: main.borderTopLeftRadius, go: go.backgroundColor }; });
  assert.deepEqual(await drawn(), { pad: "14px", radius: "10px", go: "rgb(20, 113, 105)" });
  console.log("PASS: an opened mockup shows a slider for each knob its page names.");

  // Moving a slider changes the page at once: no model run, no new version.
  const turn = (at: number, value: number) => sliders.nth(at).evaluate((input: HTMLInputElement, to) => { input.value = String(to); input.dispatchEvent(new Event("input", { bubbles: true })); }, value);
  await turn(0, 26);
  await step(72, async () => (await drawn()).pad === "26px");
  await turn(2, 196);
  await step(74, async () => (await drawn()).go !== "rgb(20, 113, 105)");
  assert.equal((await drawn()).radius, "10px");
  assert.deepEqual(await knobs.locator(".fd-knob output").allInnerTexts(), ["26px", "10px", "196"]);
  assert.equal(await send.isVisible(), true);
  assert.equal((await f.client.foundryGet(id)).version, 1);
  mkdirSync("output", { recursive: true });
  await app.mouse.move(5, 5);
  await app.waitForTimeout(400);
  await app.screenshot({ path: "output/foundry-knobs.png" });
  console.log("PASS: a slider changes the page at once, and the send line appears.");

  // One line sends the settings to the chat that made it; the model keeps them as the next version.
  await send.click();
  await step(86, async () => said.length === 1);
  assert.match(said[0]!, /- Room: --pad 26px \(was 14px\)/);
  assert.match(said[0]!, /- Warmth: --hue 196 \(was 175\)/);
  assert.doesNotMatch(said[0]!, /Corners/);
  await step(90, async () => (await f.client.foundryGet(id)).version === 2);
  assert.match((await f.client.foundryGet(id)).source, /--pad:26px/);
  console.log("PASS: the settings go to the chat in one message, and come back as the next version.");

  // A mockup that isn't opened has no knobs: nothing is added to the long page.
  await app.keyboard.press("Escape");
  await step(96, async () => (await app.locator("#page .fd-item.fd-open").count()) === 0);
  await app.waitForTimeout(600);
  assert.equal(await app.locator("#page .fd-knobs").count(), 0);
  console.log("PASS: knobs show only with an opened mockup.");
  assert.deepEqual(errors, []);
} finally {
  await window?.close().catch(() => {});
  await desktop?.close().catch(() => {});
  await f.close();
}
