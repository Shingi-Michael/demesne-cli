import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createPainter, visibleLength } from "@demesne/brand";
import { Workbench } from "../src/workbench/controller.ts";
import { CliContextRail } from "../src/context-rail.ts";
import { computeWorkbenchLayout } from "../src/workbench/layout.ts";
import { inspectorPanel, type InspectorRecord } from "../src/workbench/inspector.ts";

function fixture() {
  const rail = new CliContextRail({ id: "model-at-start", provider: "local" }, "/project");
  const ui = new Workbench({ paint: createPainter(true), contextRail: rail, sessionTitle: "Workbench", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} } });
  (ui as any).sessionLayout = false;
  return { ui, rail, state: ui as any };
}

test("docked inspector keeps response selection, layout and draft stable across a new turn", () => {
  const { ui, state, rail } = fixture();
  ui.beginTurn({ userText: "First task", at: "12:00" });
  ui.toolRequested({ toolCallId: "first", name: "edit_file", arguments: { path: "first.ts", oldText: "a", newText: "b" } });
  ui.toolFinished({ toolCallId: "first", name: "edit_file", state: "done" });
  ui.assistantDelta("Updated first.ts.");
  ui.finishTurn("completed", "Complete");
  rail.setModel({ id: "next-model", provider: "local" });
  state.layout = computeWorkbenchLayout(120, 36, { inputLines: 5 });
  state.rebuildConversation();
  const before = state.composeFrame();
  expect(stripVTControlCharacters(before.rows.join("\n"))).toContain("model-at-start");
  const id = state.indexEntries()[0].id;
  state.inspectEntry(id);
  state.handleMouse({ kind: "press", button: 0, row: state.layout.input.row + 2, col: 8 });
  state.onKeypress("draft survives", {});
  expect(state.editor.value).toBe("draft survives");
  ui.beginTurn({ userText: "Second task", at: "12:01" });
  ui.toolRequested({ toolCallId: "second", name: "read_file", arguments: { path: "second.ts" } });
  expect(state.inspectionEntries().some((entry: any) => entry.detail === "second.ts")).toBe(false);
  expect(state.sheet.entryId).toBe(id);
  state.rebuildConversation();
  const after = state.composeFrame();
  for (const row of after.rows) expect(visibleLength(row)).toBe(120);
  expect(stripVTControlCharacters(after.rows.join("\n"))).not.toContain("…│");
  expect(state.layout.input.width).toBe(state.layout.conversation.width);
});

test("wheel scrolling is scoped to the panel under the pointer", () => {
  const { ui, state } = fixture();
  ui.beginTurn({ userText: "Explore", at: "now" });
  ui.assistantDelta(Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.\n\n`).join(""));
  state.layout = computeWorkbenchLayout(120, 30, { inputLines: 5 });
  state.rebuildConversation();
  state.handleMouse({ kind: "wheel", direction: "up", button: 0, col: 10, row: 10 });
  const offset = state.viewport.scrollOffset;
  expect(offset).toBeGreaterThan(0);
  state.handleMouse({ kind: "wheel", direction: "down", button: 1, col: 119, row: 10 });
  expect(state.viewport.scrollOffset).toBe(offset);
  expect(state.inspectorOffset).toBe(3);
});

test("Changes filters out reads and keyboard selection is revealed in a short inspector", () => {
  const records: InspectorRecord[] = Array.from({ length: 12 }, (_, i) => ({ id: i, type: "tool", name: "edit_file", phase: "change", state: "done", detail: `file-${i}.ts`, input: {} }));
  records.push({ id: 20, type: "tool", name: "read_file", phase: "inspect", state: "done", detail: "read-only.ts", input: {} });
  const panel = inspectorPanel({ width: 38, height: 9, paint: createPainter(false), tab: "Changes", records, selected: 11, offset: 0, title: "Selected turn", context: "", revealSelected: true });
  expect(panel.lines.join("\n")).toContain("file-11.ts");
  expect(panel.lines.join("\n")).not.toContain("read-only.ts");
  expect(panel.targets.some((target) => target.entryId === 11)).toBe(true);
});

test("view cycling returns to chat without reopening a docked inspection as a modal", () => {
  const { state } = fixture();
  state.layout = computeWorkbenchLayout(120, 30, { inputLines: 5 });
  state.sheet = { kind: "index", selected: 0 };
  state.onKeypress("", { ctrl: true, name: "l" });
  expect(state.chatView).toBe(false);
  expect(state.sheet).toBeNull();
  state.onKeypress("", { ctrl: true, name: "l" });
  expect(state.transcriptView).toBe(true);
  state.onKeypress("", { ctrl: true, name: "l" });
  expect(state.chatView).toBe(true);
});
