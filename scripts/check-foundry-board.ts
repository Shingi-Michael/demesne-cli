/** Real Electron check for step 4 of pass 273 A, whiteboards: a board the
 * model saves is drawn on Foundry as notes, groups and arrows; a note drags
 * (its arrow follows), a group's name brings its notes along, double-clicking
 * empty space makes a new note, a note's dot dragged to another adds an arrow,
 * and all of it is still there after the page is drawn again. The card on the
 * front page shows the board, and Make something new offers Whiteboard.
 * Run after `bun scripts/prepare-desktop.ts`, under xvfb-run -a. */
import { _electron as electron, type Frame, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const step = async (line: number, check: () => Promise<boolean>, ms = 10000) => { try { await eventually(check, ms); } catch { throw new Error(`Did not happen: the wait on line ${line}`); } };
const BOARD = JSON.stringify({
  groups: [{ label: "Before the visit", x: 20, y: 20, w: 460, h: 220 }, { label: "On the day", x: 520, y: 20, w: 460, h: 220 }],
  notes: [
    { id: "find", text: "Finds the clinic online", x: 50, y: 70, tone: "sky" },
    { id: "book", text: "Books a time", x: 270, y: 70, tone: "sky" },
    { id: "arrive", text: "Arrives and checks in", x: 550, y: 70, tone: "sand" },
    { id: "wait", text: "Waits, unsure how long", x: 770, y: 70, tone: "rose" },
    { id: "idea", text: "Idea: text when the room is ready", x: 600, y: 330, tone: "mint" },
  ],
  arrows: [{ from: "find", to: "book" }, { from: "book", to: "arrive", label: "a week later" }, { from: "arrive", to: "wait" }],
});

const f = await fixture({
  providerId: "fixture", modelId: "foundry-board",
  async listModels() { return [{ id: "foundry-board", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex((message) => message.role === "user");
    if (messages.slice(at + 1).some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "Here is the clinic visit as a whiteboard." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${at}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Clinic visit", kind: "board", description: "A patient's visit, from finding the clinic to the wait.", note: "First take", source: BOARD,
      why: { direction: "Two stages side by side.", look_at: "The wait.", starts_from: "new", dropped: "Staff steps." } }) };
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
  await editor.fill("/foundry make a whiteboard of a clinic visit"); await editor.press("Enter");
  const chip = app.locator("#conversation .fd-chip").filter({ hasText: "Clinic visit" });
  await chip.waitFor();
  const id = (await f.client.foundryList()).artifacts.find((item) => item.title === "Clinic visit")!.id;
  assert.equal((await f.client.foundryGet(id)).kind, "board");
  assert.match((await chip.textContent())!, /Whiteboard/);
  await chip.click();
  await app.locator(`#page [data-fd="${id}:1"]`).waitFor();
  const frame = () => app.frames().find((one) => one.url().startsWith(`foundry://artifact/${id}?v=1`) && one.url().includes("stack=1")) as Frame | undefined;
  const notes = () => frame()!.evaluate(() => [...document.querySelectorAll(".note")].map((el) => ({ id: (el as HTMLElement).dataset.id!, text: el.textContent, x: parseInt((el as HTMLElement).style.left), y: parseInt((el as HTMLElement).style.top) })));
  const arrowCount = () => frame()!.evaluate(() => document.querySelectorAll("#arrows path").length);
  const arrowStart = () => frame()!.evaluate(() => document.querySelector("#arrows path")!.getAttribute("d"));
  await step(50, async () => !!frame() && (await notes().catch(() => [])).length === 5);
  assert.deepEqual(await frame()!.evaluate(() => [...document.querySelectorAll(".group b")].map((el) => el.textContent)), ["Before the visit", "On the day"]);
  assert.equal(await arrowCount(), 3);
  assert.equal(await frame()!.evaluate(() => document.querySelector("svg.lines text")!.textContent), "a week later");
  mkdirSync("output", { recursive: true });
  await app.mouse.move(5, 5);
  await app.waitForTimeout(300);
  await app.screenshot({ path: "output/foundry-board.png" });
  console.log("PASS: a board is drawn as groups, notes and arrows with their labels.");

  const centre = async (selector: string) => { const box = (await frame()!.locator(selector).first().boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }; };
  const dragTo = async (from: { x: number; y: number }, to: { x: number; y: number }) => { await app.mouse.move(from.x, from.y); await app.mouse.down(); await app.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 }); await app.mouse.move(to.x, to.y, { steps: 4 }); await app.mouse.up(); };

  // A note drags, and its arrow follows.
  const before = await arrowStart();
  const idea = await centre('.note[data-id="idea"]');
  await dragTo(idea, { x: idea.x - 300, y: idea.y + 20 });
  const moved = (await notes()).find((one) => one.id === "idea")!;
  assert.ok(Math.abs(moved.x - 300) <= 3 && Math.abs(moved.y - 350) <= 3, `the note moved: ${JSON.stringify(moved)}`);
  const find = await centre('.note[data-id="find"]');
  await dragTo(find, { x: find.x, y: find.y + 40 });
  assert.notEqual(await arrowStart(), before, "the arrow follows its note");
  await dragTo({ x: find.x, y: find.y + 40 }, find);
  console.log("PASS: a note drags and its arrow follows.");

  // A group's name brings the notes inside it along.
  const label = await centre(".group b");
  await dragTo(label, { x: label.x + 10, y: label.y + 30 });
  const shifted = await notes();
  assert.deepEqual(shifted.filter((one) => one.id === "find" || one.id === "book").map((one) => [one.x, one.y]), [[60, 100], [280, 100]]);
  assert.equal(shifted.find((one) => one.id === "arrive")!.y, 70, "notes outside the group stay");
  console.log("PASS: a group's name moves the group and its notes.");

  // Double-click empty space for a new note, type, click away.
  const empty = await centre("#board");
  const frameBox = empty.box;
  await app.mouse.dblclick(frameBox.x + 300, frameBox.y + 520);
  await step(88, async () => frame()!.evaluate(() => !!document.querySelector(".note[contenteditable]")));
  await app.keyboard.type("Ask how long the wait is");
  await app.mouse.click(frameBox.x + 900, frameBox.y + 600);
  await step(92, async () => (await notes()).some((one) => one.text === "Ask how long the wait is"));
  const added = (await notes()).find((one) => one.text === "Ask how long the wait is")!;

  // A note's dot dragged to another note adds an arrow.
  await app.mouse.move((await centre(`.note[data-id="${added.id}"]`)).x, (await centre(`.note[data-id="${added.id}"]`)).y);
  const dot = await centre(`.note[data-id="${added.id}"] .dot`);
  const target = await centre('.note[data-id="idea"]');
  await dragTo(dot, target);
  await step(101, async () => (await arrowCount()) === 4);
  await step(102, async () => ((await frame()!.locator("#said").textContent()) ?? "") === "Saved");
  await app.mouse.move(5, 5);
  await app.waitForTimeout(300);
  await app.screenshot({ path: "output/foundry-board-changed.png" });
  console.log("PASS: double-click makes a note, and a note's dot makes an arrow.");

  // Drawn again: leave Foundry and come back to it.
  await app.locator("#page .fg-back").click();
  await app.locator("#page .fg-card").filter({ hasText: "Clinic visit" }).waitFor();
  assert.match((await app.locator("#page .fg-card .fg-meta").first().textContent())!, /^Whiteboard · /);
  assert.ok((await app.locator("#page .fg-mk").allTextContents()).includes("Whiteboard"));
  await app.waitForTimeout(800);
  await app.screenshot({ path: "output/foundry-board-card.png" });
  await app.locator("#page .fg-card").filter({ hasText: "Clinic visit" }).locator(".fg-go").click();
  await step(115, async () => !!frame() && (await notes().catch(() => [])).length === 6);
  const kept = await notes();
  assert.ok(kept.some((one) => one.text === "Ask how long the wait is"));
  assert.ok(Math.abs(kept.find((one) => one.id === "idea")!.x - 300) <= 3);
  assert.equal(await arrowCount(), 4);
  console.log("PASS: what you moved, wrote and connected is kept.");
  assert.deepEqual(errors, []);
} finally {
  await window?.close().catch(() => {});
  await desktop?.close().catch(() => {});
  await f.close();
}
