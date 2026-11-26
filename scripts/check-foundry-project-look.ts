/** Real Electron check for piece 1 of pass 274, your project's look: a
 * project whose Tailwind config names its colours and fonts has its look on
 * Foundry's front page as one quiet line; a mockup drawn off that look goes
 * back to the model once and comes out in the project's values, and its page
 * says "Project look: Checked against tailwind.config.ts: 2 things fixed
 * before you saw it".
 * Run after `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const TAILWIND = `export default { theme: { extend: {
  colors: { primary: { DEFAULT: "#0f766e", 600: "#0d5f59" }, paper: "#fbfaf7", ink: "#1c2422", warn: "#b45309" },
  fontFamily: { display: ["Georgia", "serif"], sans: ["Inter", "system-ui"] },
  borderRadius: { card: "10px" },
} } };`;
const page = (accent: string, font: string) => `<!doctype html><html><head><link rel="stylesheet" href="foundry://kit/base.css"><style>:root{--accent:${accent};--paper:#fbfaf7;--ink:#1c2422} body{margin:0;padding:48px;background:var(--paper);color:var(--ink)} h1{font-family:${font};font-size:32px;margin:0 0 8px} .go{display:inline-block;margin-top:24px;padding:12px 20px;border-radius:10px;background:var(--accent);color:#fff;font-weight:600}</style></head><body><main><h1>Book a visit</h1><p>Harbor Clinic · Dr. Okafor · Tuesday, 10:30</p><span class="go">Book 10:30</span></main></body></html>`;
const WHY = { direction: "Calm, for patients booking a visit.", look_at: "The Book button.", starts_from: "new", dropped: "The map.",
  walkthrough: [{ what: "A booking page for the clinic's patients.", parts: [{ name: "Heading", says: "Says what you are doing." }, { name: "Book button", says: "Books the chosen time." }], why: "One thing to do, so one button." }] };
const saves: string[] = [];

const f = await fixture({
  providerId: "fixture", modelId: "foundry-look",
  async listModels() { return [{ id: "foundry-look", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const results = messages.slice(at + 1).filter((message) => message.role === "tool");
    const last = results.at(-1);
    const said = last ? (typeof last.content === "string" ? last.content : JSON.stringify(last.content)) : "";
    if (last && !said.includes("[look]")) { yield { type: "text_delta", delta: "Here is the booking page, in the clinic's own colours and type." }; yield { type: "finish", reason: "stop" }; return; }
    if (last) saves.push(said);
    // First drawn in a look of its own (purple, Poppins); after the note, in the project's.
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}-${results.length}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Booking page", kind: "html", description: "Pick a time and book it.", note: "First take",
      source: last ? page("#0f766e", "Georgia, serif") : page("#7c3aed", '"Poppins", sans-serif'), why: WHY }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
mkdirSync(join(f.workspace, "src/components/ui"), { recursive: true });
writeFileSync(join(f.workspace, "tailwind.config.ts"), TAILWIND);
for (const name of ["Button", "DayPicker", "SlotPill", "Field"]) writeFileSync(join(f.workspace, "src/components", `${name}.tsx`), "export {};\n");
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
  // Before anything is made, the front page says the project's look, read from its code.
  await app.locator('[data-action="page-open"][data-args*="foundry"]').first().click();
  const lookLine = app.locator("#page .fg-look");
  await lookLine.waitFor();
  const words = (await lookLine.textContent())!;
  assert.match(words, /’s look/);
  assert.match(words, /Georgia and Inter/);
  assert.match(words, /10px corners/);
  assert.match(words, /4 components/);
  assert.match(words, /read from tailwind\.config\.ts/);
  assert.equal(await lookLine.locator(".fg-look-sw i").count(), 5);
  assert.equal(await lookLine.locator("button, a, input").count(), 0, "the look line has nothing to press");
  mkdirSync("output", { recursive: true });
  await app.screenshot({ path: "output/foundry-look-front.png" });
  console.log("PASS: the front page shows the project's look, read from its code.");

  // A mockup drawn off the look goes back once, and comes out in the project's values.
  await app.locator('[data-action="page-open"][data-args*="foundry"]').first().click();
  await editor.fill("/foundry make a booking page"); await editor.press("Enter");
  const chip = app.locator("#conversation .fd-chip").filter({ hasText: "Booking page" });
  await chip.waitFor();
  assert.equal(saves.length, 1, "sent back once");
  assert.match(saves[0]!, /colour #7c3aed is far from every colour of its palette \(nearest: primary #0f766e\)/);
  assert.match(saves[0]!, /font Poppins is not one of the project's \(Georgia, Inter\)/);
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Booking page")!.id;
  const made = await f.client.foundryGet(id);
  assert.equal(made.version, 1, "the purple take was never kept");
  assert.ok(made.source.includes("#0f766e") && !made.source.includes("#7c3aed"));
  console.log("PASS: a mockup off the look goes back to the model once, with what to use instead.");

  // Its page says so, on one quiet line.
  await chip.click();
  await app.locator(`#page [data-fd="${id}:1"]`).waitFor();
  const why = app.locator(`#page [data-fd="${id}:1"] .fd-why`);
  await step(80, async () => /Project look\s*Checked against tailwind\.config\.ts: 2 things fixed before you saw it/.test(((await why.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ")));
  // And it is drawn in them: what the page sets wins over the kit's own values.
  const frame = () => app.frames().find((one) => one.url().includes(id) && one.url().includes("&"));
  await step(84, async () => !!frame() && await frame()!.evaluate(() => !!document.querySelector(".go")).catch(() => false));
  const drawn = await frame()!.evaluate(() => ({ button: getComputedStyle(document.querySelector(".go")!).backgroundColor, heading: getComputedStyle(document.querySelector("h1")!).fontFamily }));
  assert.equal(drawn.button, "rgb(15, 118, 110)", "the button is the project's teal");
  assert.match(drawn.heading, /^Georgia/, "the heading is in the project's display face");
  await app.mouse.move(5, 5);
  await app.waitForTimeout(600);
  await app.screenshot({ path: "output/foundry-look-page.png" });
  console.log("PASS: the mockup's page says it was checked against the project's look.");
  assert.deepEqual(errors, []);
} finally {
  await window?.close().catch(() => {});
  await desktop?.close().catch(() => {});
  await f.close();
}
