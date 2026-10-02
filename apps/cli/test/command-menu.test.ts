import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createPainter, SLASH_COMMANDS, visibleLength, type SlashCommand } from "@demesne/brand";
import { CliContextRail } from "../src/context-rail.ts";
import { Workbench } from "../src/workbench/controller.ts";
import { seedSession } from "../../../scripts/session-fixture.ts";

function fixture(start = false, commands: readonly SlashCommand[] = SLASH_COMMANDS) {
  const paint = createPainter(true);
  const ui = new Workbench({ paint, contextRail: new CliContextRail({ id: "demo", provider: "test" }, "/project"),
    sessionTitle: "Menu", workspaceRoot: "/project", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} } });
  if (!start) seedSession(ui, "long");
  const result = ui.readPrompt({ history: ["older draft"], mentions: ["src/main.ts"], commands });
  const state = ui as any;
  const key = (name: string) => state.onKeypress("", { name });
  const type = (text: string) => state.onKeypress(text, {});
  const screen = (width = 100, height = 32) => stripVTControlCharacters(ui.frame(width, height).rows.join("\n"));
  return { ui, state, paint, key, type, screen, result };
}

test("slash overlay filters and dismisses without reflowing a pinned conversation or clearing the query", () => {
  const { state, key, type, screen } = fixture();
  screen(); key("pageup"); screen();
  const input = { ...state.layout.input };
  const offset = state.sessionView.memory.flowOffset;
  const anchor = state.sessionView.memory.anchor;
  type("/");
  let rows = screen().split("\n");
  const menu = state.commandMenuFrame;
  expect(menu.rect.row + menu.rect.height).toBe(input.row);
  expect(menu.rect.column).toBe(input.column + 2);
  expect(menu.rect.width).toBe(input.width - 4);
  expect(rows.findIndex((line) => line.includes("Start a fresh session"))).toBeLessThan(input.row);
  expect(rows.findIndex((line) => line.includes("SESSION"))).toBeLessThan(rows.findIndex((line) => line.includes("/new")));
  expect(rows.find((line) => line.includes("/new"))!.indexOf("Start a fresh session"))
    .toBe(rows.find((line) => line.includes("/sessions"))!.indexOf("Browse or search"));
  type("mo");
  const filtered = screen();
  // Figma 14:9 groups: /model belongs to SESSION.
  expect(filtered).toMatch(/SESSION +\d/);
  expect(filtered).toContain("Switch the active model");
  expect(filtered).not.toContain("Start a fresh session");
  key("escape");
  expect(screen()).not.toContain("Switch the active model");
  expect(state.editor.value).toBe("/mo");
  expect(state.editor.cursor).toBe(3);
  expect(state.layout.input).toEqual(input);
  expect(state.sessionView.memory.flowOffset).toBe(offset);
  expect(state.sessionView.memory.anchor).toEqual(anchor);
  type("d");
  expect(screen()).toContain("Switch the active model");
  key("return");
  expect(state.editor.value).toBe("/model ");
  expect(screen()).not.toContain("Switch the active model");
  expect(state.mode).toBe("input");
});

test("wheel, keyboard and clicks address visible commands without reaching controls beneath the popup", async () => {
  const { state, type, key, screen, result } = fixture();
  screen(); key("pageup"); screen();
  const offset = state.sessionView.memory.flowOffset;
  type("/"); screen();
  const rect = state.commandMenuFrame.rect;
  for (let i = 0; i < 8; i++) {
    state.handleMouse({ kind: "wheel", direction: "down", row: rect.row + 2, col: 2 });
    screen();
  }
  expect(state.matchingCommands()[state.editor.menuSelected].name).toBe("/exit");
  expect(state.commandMenuFrame.zones.some((zone: any) => zone.index === state.editor.menuSelected)).toBe(true);
  expect(state.sessionView.memory.flowOffset).toBe(offset);
  key("up"); screen();
  expect(state.matchingCommands()[state.editor.menuSelected].name).toBe("/help");
  key("pageup"); screen();
  expect(state.sessionView.memory.flowOffset).toBe(offset);
  state.editor = { ...state.editor, value: "/", cursor: 1, menuSelected: 0 };
  screen();
  const rename = state.commandMenuFrame.zones.find((zone: any) => state.matchingCommands()[zone.index].name === "/rename");
  state.handleMouse({ kind: "press", button: 0, row: rename.row, col: 20 });
  expect(state.editor.value).toBe("/rename ");
  expect(state.mode).toBe("input");
  screen(); key("escape"); type("/help"); screen();
  const help = state.commandMenuFrame.zones[0];
  state.handleMouse({ kind: "press", button: 0, row: help.row, col: 20 });
  expect(await result).toBe("/help");
});

// Renders the menu across many sizes, themes and layouts: ~3 s locally,
// past bun's 5 s default on slower CI runners.
test("every custom command stays reachable and selected through resizing, themes, hero and panel layouts", () => {
  const commands: SlashCommand[] = [...SLASH_COMMANDS, ...Array.from({ length: 26 }, (_, i): SlashCommand => ({
    id: `custom:${i}`, name: `/custom-${i}`, section: "session", argument: "optional", aliases: [], description: `Inspect 界 ${i}`,
  }))];
  for (const start of [true, false]) {
    const { ui, paint, state, type, key, screen } = fixture(start, commands);
    type("/");
    expect(state.matchingCommands()).toHaveLength(commands.length);
    for (const theme of ["demesne", "demesne-light", "catppuccin-mocha"]) for (const enabled of [true, false]) {
      paint.setTheme(theme);
      // A disabled painter exercises the same geometry without ANSI selection.
      state.options.paint = enabled ? paint : createPainter(false, theme);
      for (const [width, height] of [[40, 10], [65, 18], [80, 24], [160, 48]]) {
        screen(width, height);
        for (let i = 0; i < commands.length; i++) {
          key("down");
          const frame = ui.frame(width!, height!);
          const menu = state.commandMenuFrame;
          expect(menu).not.toBeNull();
          expect(menu.zones.some((zone: any) => zone.index === state.editor.menuSelected)).toBe(true);
          expect(menu.rect.row).toBeGreaterThanOrEqual(0);
          expect(menu.rect.height).toBeLessThanOrEqual(12);
          expect(frame.cursor!.row).toBeGreaterThanOrEqual(state.layout.input.row);
          for (const row of frame.rows) expect(visibleLength(row)).toBe(width!);
        }
      }
    }
    if (!start) {
      state.sessionView.act({ kind: "log" });
      screen(160, 48);
      expect(state.commandMenuFrame.rect.width).toBe(state.layout.input.width - 4);
      expect(state.commandMenuFrame.rect.width).toBeLessThan(150);
    }
  }
}, 30_000);

test("the slash menu follows Figma 14:9: group counts, argument hints, aliases, and a keycap footer with what is below", () => {
  const { type, screen } = fixture();
  type("/");
  const text = screen(120, 32);
  expect(text).toMatch(/SESSION +8/);
  expect(text).toMatch(/\/new \[title\] +Start a fresh session +↵/);
  expect(text).toMatch(/\/resume <id> +Switch to a session +\/switch/);
  expect(text).toMatch(/↑↓ select {2}↵ run {2}Tab complete {2}Esc close +19 commands · \d+ more below ↓/);
});
