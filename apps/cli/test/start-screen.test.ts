import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { emitKeypressEvents } from "node:readline";
import { createPainter, SLASH_COMMANDS, visibleLength } from "@demesne/brand";
import type { SessionStateResponse } from "@demesne/protocol";
import { CliContextRail } from "../src/context-rail.ts";
import { Workbench } from "../src/workbench/controller.ts";
import { operationTitleRoom, START_OPERATIONS, StartScreen, startScreenLayout } from "../src/workbench/start-screen.ts";
import { loadRecentSessions, recentSession } from "../src/recent-sessions.ts";

const at = "2026-09-22T12:00:00Z";
function saved(id: string, updatedAt = at): SessionStateResponse {
  return { session: { id, title: `Saved ${id}`, createdAt: at, updatedAt, workspace: { id: "workspace", root: "/project" }, turns: [] },
    lastEventId: 0, pendingPermissions: [], latestProviderCall: null };
}
function fixture(color = true) {
  const paint = createPainter(color);
  const rail = new CliContextRail({ id: "real-model", provider: "local", contextWindow: 100_000 }, "/project");
  let queue = "";
  const ui = new Workbench({ paint, contextRail: rail, sessionTitle: "New", version: "test",
    onExit() {}, onInterrupt() {}, queue: { get: () => queue, set: (value) => { queue = value; } } });
  ui.restoreSession(saved("current"));
  ui.setRecentSessions([recentSession(saved("current")), { ...recentSession(saved("previous")), context: { used: 8192, capacity: 32768, estimated: true } }]);
  const state = ui as any;
  emitKeypressEvents(state.keyboard);
  state.keyboard.on("keypress", state.onKeypress);
  let rows: string[] = [];
  const screen = (width = 120, height = 36) => { rows = ui.frame(width, height).rows.map(stripVTControlCharacters); return rows.join("\n"); };
  const key = (name: string, modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => state.onKeypress("", { name, ...modifiers });
  const click = (label: string, offset = 0) => {
    const row = rows.findIndex((line) => line.includes(label));
    expect(row).toBeGreaterThanOrEqual(0);
    state.handleMouse({ kind: "press", button: 0, row, col: rows[row]!.indexOf(label) + offset });
  };
  const read = () => ui.readPrompt({ commands: SLASH_COMMANDS, mentions: ["src/lexer.ts", "src/parser.ts"], history: ["Earlier draft"] });
  return { ui, state, paint, rail, screen, key, click, read, queue: () => queue };
}

test("operation cards fill and focus an undoable draft without submitting; explicit send starts the conversation", async () => {
  const { ui, state, screen, click, key, read, queue } = fixture();
  const prompt = read();
  let submitted = false;
  void prompt.then(() => { submitted = true; });
  state.onKeypress("My existing draft", {});
  for (const [index, operation] of START_OPERATIONS.entries()) {
    screen(); click(`${index + 1} ${operation.label}`);
    await Promise.resolve();
    expect(submitted).toBe(false);
    expect(state.editor.value).toBe(operation.prompt);
    expect(state.sessionView.focused).toBe(false);
    expect(state.entries).toHaveLength(0);
    state.onData("\x1f");
    expect(state.editor.value).toBe("My existing draft");
  }
  screen(); click("Explore");
  screen(); click("↵ send");
  const value = await prompt;
  expect(value).toBe(START_OPERATIONS[0].prompt);
  ui.beginTurn({ userText: value, at });
  ui.reasoningDelta("Investigating the entry point.");
  expect(screen()).toContain("◇ Thinking");
  expect(screen()).not.toContain("OPERATIONS");
  expect(state.startLayout).toBeNull();
  state.onData("\x1b[200~Keep this queued\x1b[201~");
  expect(queue()).toBe("Keep this queued");
  ui.assistantDelta("The request enters through main.");
  ui.finishTurn("completed", "Complete");
  expect(screen()).toContain("The request enters through main.");
  expect(screen()).not.toContain("What are we working on?");
});

test("Figma 8:268 keeps status above the workspace and Recent in the same centered column as the hero", () => {
  const { ui, state, screen, read, click } = fixture(); void read();
  for (const [width, height] of [[110, 30], [144, 33], [232, 60]]) {
    const rows = screen(width, height).split("\n"), layout = state.startLayout;
    expect(rows[0]).toContain("● ready"); expect(rows[0]).toContain("Tab settings");
    expect(rows[2]).toContain("demesne · /project"); expect(rows[2]).toContain("Alt+H history");
    expect(layout.input.width).toBe(86);
    expect(layout.input.column).toBe(Math.floor((width! - 86) / 2));
    expect(layout.metadata).toBeLessThan(layout.input.row);
    expect(layout.recent.column).toBe(layout.input.column); expect(layout.recent.width).toBe(layout.input.width);
    expect(layout.recent.row).toBe(layout.operations.row + layout.operations.height + 1);
    expect(state.railZones).toEqual([]);
    expect(rows[layout.input.row + layout.input.height - 2]).toContain("@ files");
    expect(rows[layout.input.row + layout.input.height - 2]).toContain("↵ send");
    expect(ui.frame(width!, height!).rows[0]).not.toContain("\x1b[1m");
  }
  state.onKeypress("draft", {}); screen(); click("⇧↵ newline");
  expect(state.editor.value).toBe("draft\n"); expect(state.mode).toBe("input");
  screen(); click("/ commands"); expect(state.editor.value).toBe("/");
  screen(); expect(state.commandMenuFrame).not.toBeNull();
});

test("start controls support keyboard browsing while caret edits, multiline input and completions retain their routing", async () => {
  const { state, screen, click, key, read } = fixture();
  const prompt = read();
  state.onKeypress("ac", {});
  screen(); click("ac", 1); state.onKeypress("b", {});
  expect(state.editor.value).toBe("abc");
  key("t", { ctrl: true }); key("right"); key("return");
  expect(state.editor.value).toBe(START_OPERATIONS[1].prompt);
  expect(state.mode).toBe("input");
  key("t", { ctrl: true }); key("escape");
  expect(state.editor.value).toBe(START_OPERATIONS[1].prompt);
  key("escape");
  state.onKeypress("Explain", {});
  screen(); click("@ files");
  expect(state.editor.value).toBe("Explain @");
  expect(screen()).toContain("lexer.ts  src/");
  key("return");
  expect(state.editor.value).toBe("Explain @src/lexer.ts ");
  expect(state.mode).toBe("input");
  key("return", { shift: true }); state.onKeypress("and callers", {});
  expect(state.editor.value).toBe("Explain @src/lexer.ts \nand callers");
  screen(40, 10); screen(120, 36);
  key("return");
  expect(await prompt).toBe("Explain @src/lexer.ts \nand callers");
});

test("History and recent-session actions use the session commands and carry the draft through resume", async () => {
  const { ui, state, screen, click, key, read } = fixture();
  let prompt = read();
  state.onKeypress("Unsent draft", {});
  expect(screen()).toContain("ctx ~8.2k");
  click("Saved current");
  expect(state.mode).toBe("input");
  click("Saved previous");
  expect(await prompt).toBe("/resume previous");
  ui.restoreSession(saved("previous"));
  prompt = read();
  expect(state.editor.value).toBe("Unsent draft");
  screen(); click("Alt+H all sessions");
  expect(await prompt).toBe("/sessions");
  prompt = read();
  expect(state.editor.value).toBe("Unsent draft");
  key("h", { meta: true });
  expect(await prompt).toBe("/sessions");
});

test("settings, context and workspace return to the hero without losing the draft, and search can be replaced by a card", async () => {
  const { state, ui, screen, click, key, read } = fixture();
  const prompt = read();
  state.onKeypress("Retain me", {});
  screen(); click("Tab settings");
  expect(screen()).toContain("Settings");
  key("escape"); await Promise.resolve();
  expect(screen()).toContain("What are we working on?");
  click("ctx —/100k");
  expect(screen()).toContain("CONTEXT PLAN");
  key("escape");
  expect(screen()).toContain("What are we working on?");
  screen(); click("/project");
  await Promise.resolve();
  expect(screen()).toContain("PROJECT FOLDER");
  key("escape");
  screen();
  expect(state.editor.value).toBe("Retain me");
  key("r", { ctrl: true });
  screen(); click("Explore");
  expect(state.editor.search).toBeNull();
  expect(state.editor.value).toBe(START_OPERATIONS[0].prompt);
  key("return");
  expect(await prompt).toBe(START_OPERATIONS[0].prompt);
  ui.beginTurn({ userText: START_OPERATIONS[0].prompt, at });
  ui.finishTurn("failed", "Provider unavailable");
  void read();
  expect(screen()).not.toContain("What are we working on?");
  expect(screen()).toContain("Provider unavailable");
});

test("hero geometry bounds the caret and hit targets through resize, long paste, menus, search and feedback", () => {
  for (const enabled of [true, false]) {
    const { ui, state, paint, screen, read, key } = fixture(enabled);
    void read();
    for (const value of ["", "界 👩‍💻 ac\n".repeat(25), "/", "@src", "search"]) {
      key("escape");
      state.onData(`\x1b[200~${value}\x1b[201~`);
      if (value === "search") key("r", { ctrl: true });
      for (const [width, height] of [[40, 10], [65, 18], [80, 24], [100, 28], [120, 36], [160, 48]]) {
        for (const theme of ["demesne", "demesne-light"]) {
          paint.setTheme(theme);
          const frame = ui.frame(width!, height!);
          expect(stripVTControlCharacters(frame.rows.join("\n"))).toContain("ctx —/100k");
          expect(frame.rows).toHaveLength(height!);
          for (const row of frame.rows) expect(visibleLength(row)).toBe(width!);
          const input = state.layout.input;
          if (!state.editor.search) expect(stripVTControlCharacters(frame.rows[input.row + input.height - 2]!)).toMatch(/~[\d.]+k? tok/);
          expect(stripVTControlCharacters(frame.rows[input.row + input.height - 1]!)).toContain("╰─");
          expect(frame.cursor?.row).toBeGreaterThan(input.row);
          expect(frame.cursor?.row).toBeLessThan(input.row + input.height - 1);
          expect(frame.cursor?.column).toBeGreaterThan(input.column);
          expect(frame.cursor?.column).toBeLessThan(input.column + input.width - 1);
          for (const zone of state.mouseZones) {
            expect(zone.row).toBeGreaterThanOrEqual(0);
            expect(zone.row).toBeLessThan(height!);
            expect(zone.column).toBeGreaterThanOrEqual(0);
            expect(zone.column + zone.width).toBeLessThanOrEqual(width!);
          }
        }
      }
      key("escape"); ui.notice("Connected");
      expect(screen(40, 10)).toContain("Connected");
    }
  }
});

test("hover and focus change emphasis without moving hero controls; reduced motion settles reveals", () => {
  const { state, ui, screen } = fixture();
  const previous = process.env.DEMESNE_REDUCED_MOTION;
  process.env.DEMESNE_REDUCED_MOTION = "1";
  try {
    const rows = screen().split("\n");
    const row = rows.findIndex((line) => line.includes("Explore"));
    const column = rows[row]!.indexOf("Explore");
    const input = { ...state.layout.input };
    const before = ui.frame(120, 36).rows[row];
    state.handleMouse({ kind: "move", row, col: column });
    expect(ui.frame(120, 36).rows[row]).not.toBe(before);
    expect(screen().split("\n")[row]).toBe(rows[row]);
    expect(state.layout.input).toEqual(input);
    state.onData("\x1b[O");
    expect(ui.frame(120, 36).cursor).toBeNull();
    state.onData("\x1b[I");
    expect(ui.frame(120, 36).cursor).not.toBeNull();
    const view = new StartScreen();
    expect(view.reveal(4, 100, false)).toBe(1);
    expect(view.animating(100, false)).toBe(false);
    expect(view.reveal(1, 100, true)).toBe(0);
    expect(view.reveal(1, 800, true)).toBe(1);
    expect(view.animating(800, true)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.DEMESNE_REDUCED_MOTION;
    else process.env.DEMESNE_REDUCED_MOTION = previous;
  }
});

test("recent sessions hydrate up to three unarchived records with turns in recency order and retain missing context honestly", async () => {
  const withTurns = (state: SessionStateResponse, count = 1) => {
    state.session.turns = Array.from({ length: count }, (_, index) => ({ id: `${state.session.id}-${index}`, status: "completed" }) as any);
    return state;
  };
  const current = saved("current");
  const newest = withTurns(saved("newest", "2026-09-22T11:00:00Z"), 2);
  newest.latestProviderCall = { model: "old-model", provider: "local", contextPlan: null, metrics: null,
    usage: { inputTokens: 1000, outputTokens: 20, totalTokens: null } };
  const empty = saved("empty", "2026-09-22T11:30:00Z");
  const older = withTurns(saved("older", "2026-09-22T10:00:00Z"));
  const old = withTurns(saved("old", "2026-09-21T12:00:00Z"));
  const oldest = withTurns(saved("oldest", "2026-09-21T10:00:00Z"));
  const archived = withTurns(saved("archived")); archived.session.archivedAt = at;
  const calls: string[] = [];
  const recent = await loadRecentSessions(current, {
    list: async () => [oldest.session, archived.session, empty.session, older.session, current.session, old.session, newest.session],
    state: async (id) => { calls.push(id); if (id === "newest") return newest; throw new Error("unavailable"); },
  });
  // The current session is always empty here, and untouched launches are
  // just noise, so neither takes a Recent row.
  expect(calls).toEqual(["newest", "older", "old"]);
  expect(recent.map((session) => session.id)).toEqual(["newest", "older", "old"]);
  expect(recent[0]?.context).toEqual({ used: 1020, capacity: null, estimated: false });
  expect(recent[0]?.turns).toBe(2);
  expect(recent[1]?.context).toBeUndefined();
  expect(recent[1]?.turns).toBe(1);
  newest.latestProviderCall.usage!.inputTokens = null;
  expect(recentSession(newest).context?.used).toBeNull();
});

test("the Start from grid never clips a title: two columns when every title fits, otherwise one", () => {
  for (const width of [72, 80, 88, 89, 100, 120, 160]) {
    const layout = startScreenLayout(width, 40, 5, false);
    for (const operation of START_OPERATIONS) {
      expect(operationTitleRoom(layout.operations.width, layout.columns, operation.label)).toBeGreaterThanOrEqual(operation.title.length);
    }
  }
  expect(startScreenLayout(80, 40, 5, false).columns).toBe(1);
  expect(startScreenLayout(120, 40, 5, false).columns).toBe(2);
  const { screen } = fixture(false);
  const narrow = screen(80, 40);
  for (const operation of START_OPERATIONS) expect(narrow).toContain(`${operation.label} ${operation.title}`);
  expect(narrow).not.toContain("…");
});

test("tall terminals list recent sessions with status and turns, and leave unknown counts out", () => {
  const { ui, screen } = fixture();
  ui.setRecentSessions([
    { ...recentSession(saved("current")), turns: 4, lastStatus: "completed" as const },
    { id: "failed", title: "Failed work", updatedAt: at, turns: 1, lastStatus: "failed" as const },
    { id: "unknown", title: "Listed only", updatedAt: at },
  ]);
  const rows = screen(120, 36).split("\n");
  const current = rows.find((line) => line.includes("Saved current"))!;
  expect(current).toContain("✓");
  expect(current).toContain("4 turns");
  expect(current).toContain("current");
  expect(rows.find((line) => line.includes("Failed work"))).toContain("× ");
  expect(rows.find((line) => line.includes("Failed work"))).toContain("1 turn ·");
  expect(rows.find((line) => line.includes("Listed only"))).not.toContain("turn");
  // A short terminal keeps the one-line strip.
  expect(screen(120, 20).split("\n").filter((line) => line.includes("Saved current"))).toHaveLength(1);
});
