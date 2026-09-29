import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { emitKeypressEvents } from "node:readline";
import { createPainter, SLASH_COMMANDS, visibleLength } from "@demesne/brand";
import type { SessionStateResponse } from "@demesne/protocol";
import { CliContextRail } from "../src/context-rail.ts";
import { Workbench } from "../src/workbench/controller.ts";
import { START_OPERATIONS, StartScreen } from "../src/workbench/start-screen.ts";
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
  for (const operation of START_OPERATIONS) {
    screen(); click(operation.label);
    await Promise.resolve();
    expect(submitted).toBe(false);
    expect(state.editor.value).toBe(operation.prompt);
    expect(state.sessionView.focused).toBe(false);
    expect(state.entries).toHaveLength(0);
    state.onData("\x1f");
    expect(state.editor.value).toBe("My existing draft");
  }
  screen(); click("Explore");
  screen(); click("SEND ↵");
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
  expect(screen()).toContain("@src/lexer.ts");
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
  screen(); click("HISTORY");
  expect(await prompt).toBe("/sessions");
  prompt = read();
  expect(state.editor.value).toBe("Unsent draft");
  key("h", { meta: true });
  expect(await prompt).toBe("/sessions");
});

test("settings, context and the rail return to the hero without losing the draft, and search can be replaced by a card", async () => {
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
  screen(); click("≡");
  await Promise.resolve();
  expect(screen()).toContain("FILES");
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
          expect(stripVTControlCharacters(frame.rows[input.row + input.height - 1]!)).toContain("Draft ~");
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
    state.handleMouse({ kind: "move", row, col: column });
    expect(screen()).toContain("fill ↑");
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

test("recent sessions hydrate only two unarchived records in recency order and retain missing context honestly", async () => {
  const current = saved("current");
  const newest = saved("newest", "2026-09-22T11:00:00Z");
  newest.latestProviderCall = { model: "old-model", provider: "local", contextPlan: null, metrics: null,
    usage: { inputTokens: 1000, outputTokens: 20, totalTokens: null } };
  const older = saved("older", "2026-09-22T10:00:00Z");
  const oldest = saved("oldest", "2026-09-21T10:00:00Z");
  const archived = saved("archived"); archived.session.archivedAt = at;
  const calls: string[] = [];
  const recent = await loadRecentSessions(current, {
    list: async () => [oldest.session, archived.session, older.session, current.session, newest.session],
    state: async (id) => { calls.push(id); if (id === "newest") return newest; throw new Error("unavailable"); },
  });
  expect(calls).toEqual(["newest", "older"]);
  expect(recent.map((session) => session.id)).toEqual(["current", "newest", "older"]);
  expect(recent[0]?.context?.used).toBeNull();
  expect(recent[1]?.context).toEqual({ used: 1020, capacity: null, estimated: false });
  expect(recent[2]?.context).toBeUndefined();
  newest.latestProviderCall.usage!.inputTokens = null;
  expect(recentSession(newest).context?.used).toBeNull();
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
