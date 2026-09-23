import { expect, test } from "bun:test";
import { emitKeypressEvents } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { createPainter, visibleLength } from "@demesne/brand";
import { CliContextRail } from "../src/context-rail.ts";
import { Workbench } from "../src/workbench/controller.ts";
import { computeWorkbenchLayout } from "../src/workbench/layout.ts";
import { surface } from "../src/workbench/surface.ts";

function fixture() {
  const paint = createPainter(true);
  const ui = new Workbench({ paint, contextRail: new CliContextRail({ id: "test", provider: "demo" }, "/project"), sessionTitle: "Session", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} } });
  // Exercise production input/frame integration without taking over the test runner's TTY.
  (ui as any).sessionLayout = false;
  return { ui, paint, state: ui as any };
}

test("dialog filtering maps selected results back to original IDs and scrolls past ten", async () => {
  const { ui, state } = fixture();
  const result = ui.choose("Models", Array.from({ length: 24 }, (_, i) => `model-${i}`));
  state.onKeypress("model-23", {});
  expect(state.dialogFiltered).toEqual([23]);
  state.onKeypress("", { name: "enter" });
  expect(await result).toBe(23);
  void ui.choose("Models", Array.from({ length: 24 }, (_, i) => `model-${i}`), 23);
  state.layout = computeWorkbenchLayout(80, 24, { inputLines: 14 });
  expect(stripVTControlCharacters(state.composeInput(80).lines.join("\n"))).toContain("model-23");
});

test("mixed and fragmented mouse input preserves ordinary typing", () => {
  const { state } = fixture();
  emitKeypressEvents(state.keyboard);
  let typed = "";
  state.keyboard.on("keypress", (text: string) => { typed += text ?? ""; });
  state.onData("hi\x1b");
  state.onData("[");
  state.onData("<64;10;");
  state.onData("5Mthere");
  expect(typed).toBe("hithere");
});

test("approval clicks resolve the actual button and ignore outside columns", async () => {
  const { ui, state } = fixture();
  const result = ui.askApproval({ summary: "Execute test", toolName: "run_command", allowPersist: false });
  state.layout = computeWorkbenchLayout(80, 24, { inputLines: 10 });
  state.composeFrame();
  const deny = state.mouseZones.at(-1);
  state.handleMouse({ kind: "press", button: 0, col: 70, row: deny.row });
  expect(state.mode).toBe("approval");
  state.handleMouse({ kind: "press", button: 0, col: deny.column, row: deny.row });
  expect(await result).toBe("deny");
});

test("activity frames remain bounded at narrow and wide sizes in dark and light themes", () => {
  const { ui, state, paint } = fixture();
  ui.beginTurn({ userText: "First line\nSecond line 🌿", at: "12:00" });
  ui.assistantDelta("## A response\nA response with **emphasis**.");
  for (const theme of ["demesne", "demesne-light", "catppuccin-mocha"]) {
    paint.setTheme(theme);
    for (const [width, height] of [[40, 10], [80, 24], [120, 36]]) {
      state.layout = computeWorkbenchLayout(width!, height!, { inputLines: 7, sidebar: "hidden" });
      state.rebuildConversation();
      const frame = state.composeFrame();
      expect(frame.rows).toHaveLength(height!);
      for (const row of frame.rows) expect(visibleLength(row)).toBeLessThanOrEqual(width!);
      for (const zone of state.mouseZones) expect(zone.row).toBeLessThan(height! - 1);
    }
  }
});

test("region painting restores base colors after nested resets", () => {
  const paint = createPainter(true);
  const result = surface(paint.bold("Title", "electric") + " text", 20, paint);
  expect(visibleLength(result)).toBe(20);
  expect(result).toContain("\x1b[0m\x1b[48;2;");
  expect(surface("hello", 8, createPainter(false))).toBe("hello   ");
});

test("revision index opens and closes on narrow terminals", () => {
  const { state } = fixture();
  state.layout = computeWorkbenchLayout(60, 24);
  state.onKeypress("", { ctrl: true, name: "t" });
  expect(state.sheet.kind).toBe("index");
  expect(stripVTControlCharacters(state.composeFrame().rows.join("\n"))).toContain("INSPECTOR");
  state.onKeypress("", { ctrl: true, name: "t" });
  expect(state.sheet).toBeNull();
});

test("model action preserves the draft and keyboard Plan control submits a plan", async () => {
  const { ui, state } = fixture();
  const context = { history: [], mentions: [], commands: [] };
  const first = ui.readPrompt(context);
  state.onKeypress("draft idea", {});
  state.runCommand("/model");
  expect(await first).toBe("/model");
  const second = ui.readPrompt(context);
  expect(state.editor.value).toBe("draft idea");
  state.onKeypress("", { name: "tab" });
  state.onKeypress("", { name: "return" });
  await Promise.resolve();
  state.onKeypress("", { name: "return" });
  expect(await second).toBe("/plan draft idea");
});

test("sections collapse, transcript restores event order, and the inspector opens recorded diffs", () => {
  const { ui, state } = fixture();
  state.chatView = false;
  ui.beginTurn({ userText: "Improve parser", at: "12:00" });
  ui.assistantDelta("I found the guard.");
  ui.toolRequested({ toolCallId: "edit", name: "edit_file", arguments: { path: "parser.ts", oldText: "old guard", newText: "new guard" } });
  ui.toolFinished({ toolCallId: "edit", name: "edit_file", state: "done" });
  ui.assistantDelta("The guard is updated.");
  ui.finishTurn("completed", "done");
  state.layout = computeWorkbenchLayout(100, 40, { sidebar: "hidden", inputLines: 4 });
  state.rebuildConversation();
  const section = state.sections.find((section: { key: string }) => section.key.endsWith(":Changes"));
  expect(section).toBeDefined();
  section.run();
  state.rebuildConversation();
  expect(state.collapsedSections.has(section.key)).toBe(true);
  state.onKeypress("", { ctrl: true, name: "t" });
  state.onKeypress("", { name: "return" });
  expect(state.sheet.kind).toBe("detail");
  const frame = stripVTControlCharacters(state.composeFrame().rows.join("\n"));
  expect(frame).toContain("RECORDED EDIT");
  expect(frame).toContain("old guard");
  expect(frame).toContain("new guard");
  state.onKeypress("", { name: "escape" });
  state.onKeypress("", { ctrl: true, name: "l" });
  state.rebuildConversation();
  expect(state.transcriptView).toBe(true);
  const transcript = stripVTControlCharacters(state.composeFrame().rows.join("\n"));
  expect(transcript.indexOf("I found the guard.")).toBeLessThan(transcript.indexOf("parser.ts"));
  expect(transcript.indexOf("parser.ts")).toBeLessThan(transcript.indexOf("The guard is updated."));
});

test("short terminals keep the selected approval visible and its hit target accurate", async () => {
  const { ui, state } = fixture();
  const approval = ui.askApproval({ summary: "Edit parser", toolName: "edit_file", allowPersist: true, previewRows: ["line one", "line two", "line three"] });
  state.layout = computeWorkbenchLayout(40, 10, { sidebar: "hidden", inputLines: 12 });
  for (let i = 0; i < 3; i++) state.onKeypress("", { name: "right" });
  const frame = state.composeFrame();
  expect(stripVTControlCharacters(frame.rows.join("\n"))).toContain("Deny");
  const deny = state.mouseZones.at(-1);
  expect(deny.row).toBeLessThan(9);
  state.handleMouse({ kind: "press", button: 0, col: deny.column, row: deny.row });
  expect(await approval).toBe("deny");
});

test("section keyboard navigation folds the focused heading without editing the draft", () => {
  const { ui, state } = fixture();
  state.chatView = false;
  ui.beginTurn({ userText: "Explore", at: "12:00" });
  ui.assistantDelta("An observation.");
  state.rebuildConversation();
  state.onKeypress("", { meta: true, name: "down" });
  expect(state.sectionFocus).toContain(":Updates");
  state.onKeypress("", { name: "return" });
  expect(state.collapsedSections.has(state.sectionFocus)).toBe(true);
  state.onKeypress("", { name: "escape" });
  expect(state.sectionFocus).toBeNull();
  expect(state.editor.value).toBe("");
});

test("coalesced Escape presses still interrupt a running turn immediately", () => {
  const { state } = fixture();
  let interrupts = 0;
  state.options.onInterrupt = () => { interrupts++; };
  state.mode = "streaming";
  state.onData("\x1b\x1b");
  expect(interrupts).toBe(1);
  expect(state.mouseCarry).toBe("");
});
