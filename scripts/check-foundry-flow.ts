/** Real Electron check for piece 2 of pass 274, whole flows: a mockup whose
 * screens sit in a <d-flow> shows a map of them above the first screen; the
 * button inside a screen moves to the next and the map follows; a name in
 * the map jumps there; and the map says where the screen's controls lead.
 * Run after `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const screen = (name: string, body: string, button: string, to: string, back = "") => `<section data-view="${name}"><h1>${name}</h1>${body}<p class="acts">${back ? `<button class="quiet" data-go="${back}">Back</button>` : ""}<button class="go" data-go="${to}">${button}</button></p></section>`;
const FLOW = `<!doctype html><html><head><link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/parts.js"></script><style>:root{--accent:#0f766e;--paper:#fbfaf7;--ink:#1c2422} body{margin:0;padding:40px 48px;background:var(--paper);color:var(--ink)} section{max-width:460px} h1{font-family:Georgia,serif;font-size:28px;margin:0 0 8px} .slots{display:flex;gap:8px;margin:16px 0} .slots span{padding:8px 14px;border-radius:99px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.16)} .slots .on{box-shadow:inset 0 0 0 2px var(--accent);color:var(--accent);font-weight:600} .field{display:block;margin:12px 0;padding:10px 12px;border-radius:8px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.18)} .acts{display:flex;gap:10px;margin-top:24px} .go{padding:11px 18px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer} .quiet{padding:11px 14px;border:0;border-radius:10px;background:transparent;color:inherit;cursor:pointer}</style></head><body><d-flow>`
  + screen("Find a time", `<p>Harbor Clinic · Dr. Okafor · Tuesday</p><div class="slots"><span>9:00</span><span class="on">10:30</span><span>1:15</span><span>3:40</span></div>`, "Book 10:30", "Your details")
  + screen("Your details", `<span class="field">Amara Lind</span><span class="field">555 0142</span>`, "Continue", "Confirm", "Find a time")
  + screen("Confirm", `<p>Tuesday, 10:30 with Dr. Okafor. A text arrives the day before.</p>`, "Confirm visit", "Booked", "Your details")
  + screen("Booked", `<p>See you Tuesday. You can move it up to 2 hours before.</p>`, "Book another", "Find a time")
  + `</d-flow></body></html>`;
const WHY = { direction: "Calm, for patients booking a visit.", look_at: "One button per screen.", starts_from: "new", dropped: "Insurance details.",
  walkthrough: [{ what: "Booking a visit in four screens, for the clinic's patients.", parts: [{ name: "Find a time", says: "Pick a slot." }, { name: "Your details", says: "Name and phone." }, { name: "Confirm", says: "Check before booking." }, { name: "Booked", says: "What happens next." }], why: "One decision per screen." }] };

const f = await fixture({
  providerId: "fixture", modelId: "foundry-flow",
  async listModels() { return [{ id: "foundry-flow", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "Here is booking a visit, in four screens." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Booking a visit", kind: "html", description: "From picking a time to the booked screen.", note: "First take", source: FLOW, why: WHY }) };
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
  await editor.fill("/foundry mock the whole booking flow"); await editor.press("Enter");
  const chip = app.locator("#conversation .fd-chip").filter({ hasText: "Booking a visit" });
  await chip.waitFor();
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Booking a visit")!.id;
  await chip.click();
  await app.locator(`#page [data-fd="${id}:1"]`).waitFor();
  const frame = () => app.frames().find((one) => one.url().includes(id) && one.url().includes("stack=1")) as Frame | undefined;
  const map = () => frame()!.evaluate(() => ({ names: [...document.querySelectorAll(".dp-flow button")].map((el) => el.textContent), on: document.querySelector(".dp-flow button.on")?.textContent, exits: document.querySelector(".dp-flow .dp-exits")?.textContent,
    shown: [...document.querySelectorAll("d-flow > [data-view]")].filter((el) => !(el as HTMLElement).hidden).map((el) => el.getAttribute("data-view")) }));
  await step(40, async () => !!frame() && (await map().catch(() => ({ names: [] as (string | null)[] }))).names.length === 4);
  assert.deepEqual(await map(), { names: ["Find a time", "Your details", "Confirm", "Booked"], on: "Find a time", exits: "Screen 1 of 4 · from here: Book 10:30 → Your details", shown: ["Find a time"] });
  mkdirSync("output", { recursive: true });
  await app.mouse.move(5, 5);
  await app.waitForTimeout(400);
  await app.screenshot({ path: "output/foundry-flow.png" });
  console.log("PASS: a flow shows its screens as a map over the first one, and says where it leads.");

  // The button in the screen moves on, and the map follows.
  await frame()!.locator('section[data-view="Find a time"] .go').click();
  await step(49, async () => (await map()).on === "Your details");
  assert.deepEqual((await map()).shown, ["Your details"]);
  assert.equal((await map()).exits, "Screen 2 of 4 · from here: Back → Find a time · Continue → Confirm");
  await frame()!.locator('section[data-view="Your details"] .go').click();
  await step(53, async () => (await map()).on === "Confirm");
  await app.mouse.move(5, 5);
  await app.waitForTimeout(300);
  await app.screenshot({ path: "output/foundry-flow-confirm.png" });
  console.log("PASS: a screen's own button moves to the next screen and the map follows.");

  // A name in the map jumps there.
  await frame()!.locator(".dp-flow button", { hasText: "Booked" }).click();
  await step(60, async () => (await map()).on === "Booked");
  assert.deepEqual((await map()).shown, ["Booked"]);
  assert.equal((await map()).exits, "Screen 4 of 4 · from here: Book another → Find a time");
  console.log("PASS: a name in the map jumps to that screen.");
  assert.deepEqual(errors, []);
} finally {
  await window?.close().catch(() => {});
  await desktop?.close().catch(() => {});
  await f.close();
}
