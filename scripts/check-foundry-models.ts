/** Real Electron check for piece 3 of pass 274, every model draws it: with
 * two models connected, the chat's model draws its take and calls
 * foundry_models; the other model draws from the brief alone; both come
 * back as tabs of one mockup, each named by its model, each in its own
 * colours (one stylesheet never reaches the other tab), each with its
 * walkthrough.
 * Run after `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const BRIEF = "A booking page for Harbor Clinic's patients: pick a day and a time with Dr. Okafor in two taps. Desktop width. Calm, trustworthy, one clear button.";
const take = (name: string, accent: string, body: string, why: string) => ({ name, css: `:root{--accent:${accent}} body{padding:40px 48px;background:#fbfaf7;color:#1c2422} h1{font-family:Georgia,serif;font-size:28px;margin:0 0 6px} .go{display:inline-block;margin-top:20px;padding:11px 18px;border-radius:10px;background:var(--accent);color:#fff;font-weight:600} .slots{display:flex;gap:8px;margin-top:16px} .slots span{padding:8px 14px;border-radius:99px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.16)} .list{display:grid;gap:8px;max-width:320px;margin-top:16px} .list span{padding:10px 12px;border-radius:8px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.16)}`,
  html: `<main><h1>Book a visit</h1><p>Harbor Clinic · Dr. Okafor</p>${body}<span class="go">Book 10:30</span></main>`,
  what: "A booking page for the clinic's patients.", parts: [{ name: "Times", says: "The free times to pick from." }, { name: "Book button", says: "Books the chosen time." }], why });
const MINE = take("Days first", "#0f766e", `<div class="slots"><span>9:00</span><span>10:30</span><span>1:15</span></div>`, "Days across the top, so the week reads at a glance.");
const THEIRS = take("Slots first", "#7c2d12", `<div class="list"><span>Tue 10:30</span><span>Tue 1:15</span><span>Wed 9:00</span></div>`, "The next free times as a list, soonest first.");
const asked: { model: string; system: string; prompt: string }[] = [];

async function* answer(model: string, messages: { role: string; content: unknown; toolCalls?: unknown }[]) {
  const system = String(messages.find((message) => message.role === "system")?.content ?? "");
  const at = messages.findLastIndex((message) => message.role === "user");
  // The other model, in the design round: it sees the brief and nothing else, and answers with its drawing.
  if (system.includes("design round")) {
    asked.push({ model, system, prompt: String(messages[at]?.content ?? "") });
    yield { type: "text_delta" as const, delta: "```json\n" + JSON.stringify(THEIRS) + "\n```" };
    yield { type: "finish" as const, reason: "stop" as const };
    return;
  }
  if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta" as const, delta: "Two takes: mine puts the days first, the other lists the next free times. I would pick mine." }; yield { type: "finish" as const, reason: "stop" as const }; return; }
  yield { type: "tool_call_delta" as const, index: 0, idDelta: `models-${at}`, nameDelta: "foundry_models", argumentsDelta: JSON.stringify({ title: "Booking page", description: "Pick a time and book it.", brief: BRIEF, mine: MINE }) };
  yield { type: "finish" as const, reason: "tool_calls" as const };
}
const MODELS = [{ id: "fixture-one", provider: "fixture" }, { id: "fixture-two", provider: "other-lab" }];
const f = await fixture({
  providerId: "fixture", modelId: "fixture-one", contextCapacity: 262144,
  async listModels() { return MODELS.map((model) => ({ ...model, contextWindow: 262144 })); },
  availableModels() { return MODELS; },
  createTurnInference(thinkingEnabled: boolean | undefined, overrides?: { model?: string }) {
    const model = MODELS.find((one) => one.id === overrides?.model) ?? MODELS[0]!;
    return { providerId: model.provider, modelId: model.id, profile: null, thinkingEnabled, preservesPromptCache: false, contextCapacity: 262144, maxOutputTokens: 16384,
      stream: (messages: Parameters<typeof answer>[1]) => answer(model.id, messages) };
  },
  async *stream(messages) { yield* answer("fixture-one", messages as Parameters<typeof answer>[1]); },
} as unknown as Parameters<typeof fixture>[0]);
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
  await editor.fill("/foundry have every model draw the booking page"); await editor.press("Enter");
  const chip = app.locator("#conversation .fd-chip").filter({ hasText: "Booking page" });
  await chip.waitFor();
  // The other model was asked once, with the brief and the design guide, and nothing of the chat.
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.model, "fixture-two");
  assert.ok(asked[0]!.prompt.includes(BRIEF) && !asked[0]!.prompt.includes("Days first"));
  assert.ok(asked[0]!.system.includes("# Design guide"));
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Booking page")!.id;
  const made = await f.client.foundryGet(id);
  assert.equal(made.version, 1);
  assert.deepEqual(made.versions[0]!.why!.walk!.map((one) => one.option), ["Fixture-one · Days first", "Fixture-two · Slots first"]);
  console.log("PASS: the brief went to the other model alone, and both takes were saved as one mockup.");

  // On Foundry: a tab per model, each in its own colours.
  await chip.click();
  const item = app.locator(`#page [data-fd="${id}:1"]`);
  await item.waitFor();
  const tabs = item.locator(".fd-tab, [role=tab]");
  await step(60, async () => (await tabs.allTextContents()).filter((name) => /Fixture-/.test(name)).length === 2);
  const names = (await tabs.allTextContents()).map((name) => name.replace(/\s*recommended\s*/i, "").trim());
  assert.deepEqual(names, ["Fixture-one · Days first", "Fixture-two · Slots first"]);
  const frame = () => app.frames().filter((one) => one.url().includes(id) && one.url().includes("stack=1")).at(-1) as Frame | undefined;
  const button = () => frame()!.evaluate(() => { const go = [...document.querySelectorAll(".go")].find((el) => (el as HTMLElement).offsetParent !== null) as HTMLElement | undefined; return go ? getComputedStyle(go).backgroundColor : null; });
  await step(65, async () => !!frame() && (await button().catch(() => null)) === "rgb(15, 118, 110)");
  mkdirSync("output", { recursive: true });
  await app.mouse.move(5, 5);
  await app.waitForTimeout(400);
  await app.screenshot({ path: "output/foundry-models.png" });
  await tabs.nth(1).click();
  await step(70, async () => (await button().catch(() => null)) === "rgb(124, 45, 18)");
  await app.mouse.move(5, 5);
  await app.waitForTimeout(400);
  await app.screenshot({ path: "output/foundry-models-other.png" });
  console.log("PASS: each model's take is a tab named by the model, and each keeps its own colours.");
  assert.deepEqual(errors, []);
} finally {
  await window?.close().catch(() => {});
  await desktop?.close().catch(() => {});
  await f.close();
}
