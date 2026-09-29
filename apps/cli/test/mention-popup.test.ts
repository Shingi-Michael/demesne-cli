import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createPainter, SLASH_COMMANDS, visibleLength } from "@demesne/brand";
import { CliContextRail } from "../src/context-rail.ts";
import { Workbench } from "../src/workbench/controller.ts";
import { seedSession } from "../../../scripts/session-fixture.ts";

function fixture(start = false) {
  const ui = new Workbench({ paint: createPainter(true), contextRail: new CliContextRail({ id: "test", provider: "test" }, "/project"),
    sessionTitle: "Mentions", workspaceRoot: "/project", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} } });
  if (!start) seedSession(ui, "long");
  const files = Array.from({ length: 8 }, (_, index) => `src/file-${index}.ts`);
  const result = ui.readPrompt({ history: ["prior prompt"], commands: SLASH_COMMANDS, mentions: files });
  const state = ui as any;
  const key = (name: string, extra: object = {}) => state.onKeypress("", { name, ...extra });
  const type = (text: string) => state.onKeypress(text, {});
  const screen = (width = 110, height = 30) => stripVTControlCharacters(ui.frame(width, height).rows.join("\n"));
  return { ui, state, files, key, type, screen, result };
}

test("mention popup stays above the composer and preserves a held conversation, draft and caret on dismissal", () => {
  const f = fixture(); f.screen(); f.key("pageup"); f.screen();
  const input = { ...f.state.layout.input }, offset = f.state.sessionView.memory.flowOffset, anchor = f.state.sessionView.memory.anchor;
  f.type("Fix @"); f.screen();
  const menu = f.state.mentionMenuFrame;
  expect(menu.rect.row + menu.rect.height).toBe(input.row);
  expect(menu.rect.width).toBe(input.width);
  expect(f.state.layout.input).toEqual(input);
  expect(f.screen().split("\n").findIndex(row => row.includes("file-0.ts"))).toBeLessThan(input.row);
  f.type("src/file-3"); expect(f.screen()).toContain("file-3.ts"); expect(f.screen()).not.toContain("file-4.ts");
  const caret = f.state.editor.cursor;
  f.key("escape"); f.screen();
  expect(f.state.mentionMenuFrame).toBeNull(); expect(f.state.editor.value).toBe("Fix @src/file-3"); expect(f.state.editor.cursor).toBe(caret);
  expect(f.state.layout.input).toEqual(input); expect(f.state.sessionView.memory.flowOffset).toBe(offset); expect(f.state.sessionView.memory.anchor).toEqual(anchor);
  f.type("."); f.screen(); expect(f.state.mentionMenuFrame).not.toBeNull();
  f.key("tab"); f.screen(); expect(f.state.editor.value).toBe("Fix @src/file-3.ts "); expect(f.state.mode).toBe("input");
  f.key("_", { ctrl: true }); expect(f.state.editor.value).toBe("Fix @src/file-3.");
});

test("popup hover, wheel and one click select a file without clicking or scrolling through to history", () => {
  const f = fixture(); f.screen(); f.key("pageup"); f.screen();
  const offset = f.state.sessionView.memory.flowOffset;
  f.type("@"); f.screen(); const rect = f.state.mentionMenuFrame.rect;
  f.state.handleMouse({ kind: "press", button: 0, row: rect.row, col: 2 });
  expect(f.state.editor.value).toBe("@");
  f.state.handleMouse({ kind: "wheel", direction: "down", row: rect.row + 2, col: 2 }); f.screen();
  expect(f.state.editor.mentionSelected).toBe(3); expect(f.state.sessionView.memory.flowOffset).toBe(offset);
  f.key("pagedown"); f.screen(); expect(f.state.editor.mentionSelected).toBe(7);
  f.key("pageup"); f.screen(); expect(f.state.editor.mentionSelected).toBe(2);
  const row = f.state.mentionMenuFrame.zones.find((zone: any) => zone.index === 5).row;
  f.state.handleMouse({ kind: "move", row, col: 20 }); expect(f.state.editor.mentionSelected).toBe(5);
  f.state.handleMouse({ kind: "press", button: 0, row, col: 20 }); f.screen();
  expect(f.state.editor.value).toBe("@src/file-5.ts "); expect(f.state.mode).toBe("input"); expect(f.state.mentionMenuFrame).toBeNull();
});

test("mentions remain reachable in the hero, narrow terminals and docked panels without covering the editor", () => {
  for (const start of [false, true]) {
    const f = fixture(start); f.type("@");
    for (const [width, height] of [[40, 10], [65, 18], [110, 30], [160, 48]]) {
      for (const theme of ["demesne", "demesne-light"]) {
        f.state.options.paint.setTheme(theme);
        for (let index = 0; index < 8; index++) {
          f.key("down"); const frame = f.ui.frame(width!, height!), menu = f.state.mentionMenuFrame;
          expect(menu).not.toBeNull(); expect(menu.rect.row).toBeGreaterThanOrEqual(0); expect(menu.rect.height).toBeLessThanOrEqual(12);
          expect(menu.zones.some((zone: any) => zone.index === f.state.editor.mentionSelected)).toBe(true);
          expect(menu.rect.row + menu.rect.height).toBe(f.state.layout.input.row);
          expect(frame.cursor!.row).toBeGreaterThanOrEqual(f.state.layout.input.row);
          expect(frame.rows.every(row => visibleLength(row) === width)).toBe(true);
        }
      }
    }
    if (!start) {
      f.state.sessionView.act({ kind: "log" }); f.screen(160, 48);
      expect(f.state.mentionMenuFrame.rect.width).toBe(f.state.layout.input.width);
      expect(f.state.mentionMenuFrame.rect.width).toBeLessThan(150);
    }
  }
}, 60000);

test("reverse search, approvals and streaming suppress mention suggestions without damaging input", () => {
  const f = fixture(); f.type("@"); f.screen(); f.key("r", { ctrl: true }); f.screen();
  expect(f.state.mentionMenuFrame).toBeNull(); f.key("escape"); f.screen(); expect(f.state.editor.value).toBe("@");
  expect(f.state.mentionMenuFrame).not.toBeNull();
  void f.ui.askApproval({ summary: "Approval", toolName: "run_command", allowPersist: false }); f.screen();
  expect(f.state.mentionMenuFrame).toBeNull(); f.key("n");
  f.ui.beginTurn({ userText: "Run", at: "now" }); f.screen(); expect(f.state.mentionMenuFrame).toBeNull();
});
