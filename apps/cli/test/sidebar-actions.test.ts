import { expect, test } from "bun:test";
import { createPainter } from "@demesne/brand";
import { CliContextRail } from "../src/context-rail.ts";
import { Workbench } from "../src/workbench/controller.ts";

test("rail buttons open distinct real surfaces and a dismissed file load stays dismissed", async () => {
  let finish!: (files: string[]) => void;
  const ui = new Workbench({ paint: createPainter(false), contextRail: new CliContextRail({ id: "test", provider: "test" }, "/project"),
    sessionTitle: "Test", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} },
    files: () => new Promise((resolve) => { finish = resolve; }),
    preview: { content: async () => new Uint8Array(), open: async () => {} } });
  const state = ui as any;
  const screen = () => ui.frame(120, 36).rows.join("\n");
  ui.beginTurn({ userText: "Inspect", at: "now" }); ui.assistantDelta("Done"); ui.finishTurn("completed", "Done");
  screen(); state.handleMouse({ kind: "press", button: 0, row: 3, col: 117 });
  expect(screen()).toContain("Loading workspace files");
  state.sessionView.act({ kind: "panel-close" });
  finish(["src/main.ts"]); await Promise.resolve(); await Promise.resolve();
  expect(state.sessionView.panelOpen).toBe(false);
  screen(); state.handleMouse({ kind: "press", button: 0, row: 3, col: 117 });
  finish(["src/main.ts"]); await Promise.resolve(); await Promise.resolve();
  expect(screen()).toContain("src/main.ts");
  state.sessionView.act({ kind: "panel-close" });
  screen(); state.handleMouse({ kind: "press", button: 0, row: 5, col: 117 });
  expect(screen()).toContain("CHANGES");
  state.sessionView.act({ kind: "panel-close" });
  screen(); state.handleMouse({ kind: "press", button: 0, row: 7, col: 117 });
  expect(screen()).toContain("PREVIEW");
});
