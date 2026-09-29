import { expect, spyOn, test } from "bun:test";
import { emitKeypressEvents } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { createPainter, visibleLength } from "@demesne/brand";
import { Workbench } from "../src/workbench/controller.ts";
import { CliContextRail } from "../src/context-rail.ts";
import { SessionView, planRuns } from "../src/workbench/session.ts";
import { projectRunEvidence } from "../src/workbench/evidence.ts";
import { contextMeter, contextTone } from "../src/workbench/session-chrome.ts";
import { seedSession, type PreviewState } from "../../../scripts/session-fixture.ts";

function fixture(scenario?: PreviewState) {
  let queue = "";
  let interrupted = 0;
  const paint = createPainter(true);
  const rail = new CliContextRail({ id: "original-model", provider: "demo" }, "/project");
  const ui = new Workbench({ paint, contextRail: rail, sessionTitle: "Session", workspaceRoot: "/project", version: "test",
    onExit() {}, onInterrupt() { interrupted++; }, queue: { get: () => queue, set: (value) => { queue = value; } } });
  if (scenario) seedSession(ui, scenario);
  const state = ui as any;
  const view = state.sessionView as SessionView;
  const key = (name: string, modifiers: { ctrl?: boolean; meta?: boolean } = {}) => state.onKeypress("", { name, ...modifiers });
  const screen = (width = 80, height = 24) => stripVTControlCharacters(ui.frame(width, height).rows.join("\n"));
  return { ui, paint, rail, state, view, key, screen, queue: () => queue, interrupts: () => interrupted };
}

test("live inference shares its dots across card and send while keeping activity labels out of the footer", () => {
  const { ui, paint, screen } = fixture();
  ui.beginTurn({ userText: "Inspect the project", at: "now" });
  const initial = screen(120, 36);
  expect(initial.match(/···/g)).toHaveLength(2);
  expect(initial.split("\n").at(-1)).not.toMatch(/RUNNING|THINKING|WORKING|···/);
  expect(initial).toContain("demesne");
  expect(ui.frame(120, 36).rows.join("\n")).toContain(paint.text("[", "thinking"));
  ui.reasoningDelta("Inspecting the entry point.");
  expect(screen(120, 36).match(/···/g)).toHaveLength(2);
  ui.assistantDelta("The entry point is main.ts.");
  ui.finishTurn("completed", "Complete");
  expect(ui.frame(120, 36).rows.join("\n")).toContain(paint.text("[", "electric"));
  expect(screen(120, 36)).not.toContain("···");
});

test("run projection keeps progress out of completed answers and preserves failed evidence", () => {
  const { ui, state } = fixture("working");
  ui.toolFinished({ toolCallId: "check", name: "run_command", state: "done", exitCode: 1, message: "Regression failed" });
  ui.finishTurn("failed", "Failed");
  const runs = planRuns(state.entries);
  expect(runs).toHaveLength(2);
  expect(runs[0]!.answer?.raw).toContain("boundary");
  expect(runs[1]!.answer).toBeUndefined();
  expect(runs[1]!.status).toBe("FAILED");
  expect(runs[1]!.tools.at(-1)?.exitCode).toBe(1);
});

test("all run views and inspection remain cell-bounded in both themes and compact layouts", () => {
  const { ui, view, paint, state } = fixture("complete");
  for (const theme of ["demesne", "demesne-light", "catppuccin-mocha"]) {
    paint.setTheme(theme);
    for (const [width, height] of [[40, 10], [80, 24], [120, 40], [160, 44]]) {
      ui.frame(width!, height!);
      for (const surface of (["response", "review", "log"] as const)) {
        view.act({ kind: "surface", surface });
        for (const inspect of [false, true]) {
          if (inspect && surface !== "response") view.key({ name: "return" });
          const frame = ui.frame(width!, height!);
          expect(frame.rows).toHaveLength(height!);
          for (const row of frame.rows) expect(visibleLength(row)).toBe(width!);
          for (const zone of state.mouseZones) {
            expect(zone.row).toBeLessThan(height!);
            expect((zone.column ?? 0) + (zone.width ?? width!)).toBeLessThanOrEqual(width!);
          }
        }
      }
    }
  }
});

test("pinned runs retain view, scroll, model and selection while later work streams", () => {
  const { ui, view, key, screen, rail } = fixture("complete");
  screen();
  view.act({ kind: "run", id: view.current!.id });
  view.act({ kind: "surface", surface: "review" });
  key("return");
  screen();
  key("down");
  const pinned = view.current!.id;
  const detail = view.memory.detail;
  const offset = view.memory.detailOffsets.get(detail!);
  rail.setModel({ id: "next-model", provider: "demo" });
  ui.beginTurn({ userText: "Next request", at: "now" });
  ui.assistantDelta("A newer answer.");
  screen(120, 40);
  expect(view.current!.id).toBe(pinned);
  expect(view.current!.request?.model).toBe("original-model");
  expect(view.memory.detail).toBe(detail);
  // Growing the viewport may clamp an offset but never changes the selected record.
  expect(view.memory.detailOffsets.get(detail!)).toBeLessThanOrEqual(offset!);
  view.act({ kind: "run", id: null });
  expect(view.current!.request?.text).toBe("Next request");
  view.act({ kind: "run", id: pinned });
  expect(view.memory.surface).toBe("review");
  expect(view.memory.detail).toBe(detail);
});

test("inspection replaces the compact stage, preserves the answer position and survives resizing", () => {
  const { ui, view, screen, key } = fixture("complete");
  ui.assistantDelta(Array.from({ length: 50 }, (_, i) => `Paragraph ${i}.\n\n`).join(""));
  screen();
  key("pageup");
  screen();
  const anchor = view.memory.anchor;
  expect(view.memory.flowOffset).toBeGreaterThan(0);
  view.act({ kind: "surface", surface: "review" });
  expect(screen()).toContain("src/lexer.ts");
  key("return");
  expect(screen()).toContain("RECORDED CHANGE");
  const detail = view.memory.detail;
  expect(screen(120, 40)).toContain("RECORDED CHANGE");
  expect(view.memory.detail).toBe(detail);
  screen();
  key("escape");
  key("escape");
  expect(view.memory.surface).toBe("response");
  expect(view.memory.anchor?.key).toBe(anchor?.key);
});

test("wheel over evidence scrolls its output independently from the list and answer", () => {
  const { ui, view, state, screen } = fixture("complete");
  ui.toolRequested({ toolCallId: "verbose", name: "run_command", arguments: { argv: ["bun", "test"] } });
  ui.toolFinished({ toolCallId: "verbose", name: "run_command", state: "failed", exitCode: 1, message: Array.from({ length: 80 }, (_, i) => `failure ${i}`).join("\n") });
  screen(160, 40);
  view.act({ kind: "surface", surface: "review" });
  view.key({ name: "down" });
  view.key({ name: "down" });
  view.key({ name: "return" });
  screen(160, 40);
  const selection = view.memory.reviewSelection;
  const flowOffset = view.memory.flowOffset;
  const region = (view as any).regions.find((region: { recordId?: number }) => region.recordId !== undefined);
  state.handleMouse({ kind: "wheel", direction: "down", col: region.column, row: region.row });
  screen(160, 40);
  expect(view.memory.reviewSelection).toBe(selection);
  expect([...view.memory.detailOffsets.values()].some((offset) => offset > 0)).toBe(true);
  expect(view.memory.flowOffset).toBe(flowOffset);
  expect(screen(160, 40)).toContain("failure");
});

test("the prompt retains drafts and queued instructions when focus changes", async () => {
  const { ui, view, state, key, screen, queue, interrupts } = fixture("complete");
  const prompt = ui.readPrompt({ history: [], mentions: [], commands: [] });
  state.onKeypress("Keep this draft", {});
  key("t", { ctrl: true });
  expect(view.focused).toBe(true);
  key("right");
  expect(state.editor.value).toBe("Keep this draft");
  ui.frame(80, 24);
  state.handleMouse({ kind: "press", button: 0, col: 70, row: state.layout.input.row + 1 });
  expect(view.focused).toBe(false);
  key("return");
  expect(await prompt).toBe("Keep this draft");
  state.onKeypress("Next step", {});
  expect(queue()).toBe("Next step");
  // The queued draft labels its automatic handoff even while editing it.
  expect(screen()).toContain("Next step");
  expect(screen()).toContain("Queued · sends after this turn");
  expect(screen()).toContain("│  ···   │");
  key("t", { ctrl: true });
  key("c", { ctrl: true });
  expect(interrupts()).toBe(1);
});

test("approval controls remain visible and correctly clickable on a ten-row terminal", async () => {
  const { ui, screen, state } = fixture("approval");
  const approval = ui.askApproval({ summary: "Run test suite", toolName: "run_command", allowPersist: false });
  expect(screen(40, 10)).toContain("Approval required");
  expect(screen(40, 10)).toContain("Deny");
  expect(screen(40, 10)).toContain("Run test suite");
  const deny = state.mouseZones.at(-1);
  state.handleMouse({ kind: "press", button: 0, col: deny.column, row: deny.row });
  expect(await approval).toBe("deny");
});

test("double Escape interrupts a run even while inspection has focus", async () => {
  const { ui, state, view, screen, interrupts } = fixture("working");
  void ui.readPrompt({ history: [], mentions: [], commands: [] });
  state.onKeypress("Begin", {});
  state.onKeypress("", { name: "return" });
  screen();
  view.act({ kind: "surface", surface: "review" });
  state.onData("\x1b\x1b");
  await Bun.sleep(60);
  expect(interrupts()).toBe(1);
});

test("Escape plus a coalesced wheel report does not interrupt the coding turn", async () => {
  const { ui, state, view, screen, interrupts, queue } = fixture("working");
  void ui.readPrompt({ history: [], mentions: [], commands: [] });
  state.onKeypress("Begin", {}); state.onKeypress("", { name: "return" });
  screen(); view.act({ kind: "surface", surface: "review" });
  state.onData("\x1b\x1b[<65;229;33M");
  await Bun.sleep(60);
  expect(interrupts()).toBe(0); expect(queue()).toBe("");
});

test("approval keyboard routing and selected buttons survive the compact input budget", async () => {
  const { ui, key, screen } = fixture("approval");
  const approval = ui.askApproval({ summary: "Run test suite", toolName: "run_command", allowPersist: false });
  screen(40, 10);
  key("left");
  key("return");
  expect(await approval).toBe("allow_once");
});

test("scrolling live thinking pins it when a response arrives and live follow releases it", () => {
  const { ui, view, key, screen } = fixture();
  ui.beginTurn({ userText: "Investigate", at: "now" });
  ui.reasoningDelta(Array.from({ length: 30 }, (_, i) => `Reasoning line ${i}.`).join("\n"));
  screen();
  key("pageup");
  screen();
  const offset = view.memory.flowOffset;
  ui.assistantDelta("The answer arrived.");
  expect(screen()).not.toContain("The answer arrived.");
  expect(view.memory.flowOffset).toBe(offset);
  key("g", { ctrl: true });
  expect(screen()).toContain("The answer arrived.");
});

test("compact drafts preserve three reading rows and inset caret clicks land on the text", () => {
  const { ui, state, screen, view } = fixture("complete");
  void ui.readPrompt({ history: [], mentions: [], commands: [] });
  state.onKeypress("ac", {});
  const rows = screen(160, 40).split("\n");
  const row = rows.findIndex((line) => / +ac +/.test(line));
  state.handleMouse({ kind: "press", button: 0, col: rows[row]!.indexOf("ac") + 1, row });
  state.onKeypress("b", {});
  expect(state.editor.value).toBe("abc");
  state.onKeypress("\nlong draft\n".repeat(30), {});
  screen(40, 10);
  expect((view as any).regions.find((region: { target: string }) => region.target === "flow").height).toBeGreaterThanOrEqual(3);
});

test("verification and failure links open the relevant recorded output directly", () => {
  const { ui, view, screen, state } = fixture("failed-change");
  ui.toolRequested({ toolCallId: "check-failed", name: "run_command", arguments: { argv: ["bun", "test"] } });
  ui.toolFinished({ toolCallId: "check-failed", name: "run_command", state: "failed", exitCode: 2, message: "CHECK_OUTPUT_SENTINEL" });
  ui.beginRound(); ui.assistantDelta("The check failed."); ui.finishTurn("completed", "Done");
  let rows = screen().split("\n");
  const row = rows.findIndex((line) => line.includes("Verification: failed"));
  state.handleMouse({ kind: "press", button: 0, row, col: rows[row]!.indexOf("Verification:") });
  expect(screen()).toContain("CHECK_OUTPUT_SENTINEL");
  expect(screen()).toContain("exit 2");
  view.act({ kind: "back" });
  expect(view.memory.surface).toBe("response");
  view.act({ kind: "failure" });
  expect(screen()).toContain("The edit could not be applied");
});

test("empty sessions show a starting prompt and session feedback", () => {
  const { ui, screen } = fixture();
  expect(screen()).toContain("WHAT WOULD YOU LIKE TO WORK ON?");
  ui.notice("Connection established");
  expect(screen()).toContain("Connection established");
});

test("typing from inspection resumes the draft at its cursor without closing evidence", async () => {
  const { ui, state, view, screen, key } = fixture("complete");
  const prompt = ui.readPrompt({ history: [], mentions: [], commands: [] });
  state.onKeypress("ac", {});
  key("left");
  screen();
  view.act({ kind: "surface", surface: "review" });
  key("return");
  const detail = view.memory.detail;
  state.onKeypress("b", {});
  expect(state.editor.value).toBe("abc");
  expect(view.focused).toBe(false);
  expect(view.memory.detail).toBe(detail);
  key("return");
  expect(await prompt).toBe("abc");
});

test("fragmented multiline paste is atomic and never submits or activates commands", async () => {
  const { ui, state, key } = fixture();
  emitKeypressEvents(state.keyboard);
  state.keyboard.on("keypress", state.onKeypress);
  const prompt = ui.readPrompt({ history: [], mentions: [], commands: [] });
  let submitted = false;
  void prompt.then(() => { submitted = true; });
  for (const part of ["\x1b[20", "0~first\r\n/model\n", "last\x1b[20", "1~"]) state.onData(part);
  await Promise.resolve();
  expect(submitted).toBe(false);
  expect(state.editor.value).toBe("first\n/model\nlast");
  key("return");
  expect(await prompt).toBe("first\n/model\nlast");
});

test("queued follow-ups support caret editing and keep the running control visible for long drafts", () => {
  const { state, key, queue, screen } = fixture("working");
  state.onKeypress("ac", {});
  key("left");
  state.onKeypress("b", {});
  expect(queue()).toBe("abc");
  key("return");
  expect(queue()).toBe("abc");
  state.onKeypress("\n" + "a long follow-up\n".repeat(20), {});
  expect(screen(40, 10)).toContain("│  ···   │");
  expect(screen(40, 10)).toContain("Clear queue");
  expect(screen(40, 10)).toContain("Type to queue");
});

test("model picker keeps the selected result visible on a ten-row terminal", async () => {
  const { ui, state, screen, key } = fixture("complete");
  const picked = ui.choose("Models", Array.from({ length: 30 }, (_, index) => `model-${index}`), 29);
  expect(screen(40, 10)).toContain("model-29");
  key("up");
  expect(screen(40, 10)).toContain("model-28");
  state.handleMouse({ kind: "wheel", direction: "up", col: 8, row: 5 });
  expect(screen(40, 10)).toContain("model-27");
  key("return");
  expect(await picked).toBe(27);
});

test("history search returns a match to the composer without submitting it", async () => {
  const { ui, state, screen, key } = fixture();
  const prompt = ui.readPrompt({ history: ["fix parser", "test lexer"], mentions: [], commands: [] });
  key("r", { ctrl: true });
  state.onKeypress("parser", {});
  expect(screen()).toContain("fix parser");
  key("return");
  expect(state.editor.value).toBe("fix parser");
  key("return");
  expect(await prompt).toBe("fix parser");
});

test("switching sessions clears old inspection, queue and evidence", () => {
  const { ui, state, view, screen } = fixture("complete");
  screen();
  view.act({ kind: "surface", surface: "review" });
  view.key({ name: "return" });
  ui.showPanel(["OLD SESSION OUTPUT"]);
  const at = new Date().toISOString();
  const session = { id: "new", title: "Fresh session", createdAt: at, updatedAt: at, workspace: null, turns: [] };
  ui.restoreSession({ session, lastEventId: 0, pendingPermissions: [], latestProviderCall: null });
  const frame = screen();
  expect(frame).not.toContain("OLD SESSION OUTPUT");
  expect(frame).not.toContain("lexer.ts");
  expect(frame).not.toContain("tok/s");
  expect(state.entries).toHaveLength(0);
  expect(view.memory.surface).toBe("response");
  expect(view.memory.detail).toBeNull();
});

test("interruption settles unfinished tools so the stage cannot remain waiting", () => {
  const { ui, state, screen } = fixture("working");
  ui.finishTurn("stopped", "Stopped");
  const run = planRuns(state.entries).at(-1)!;
  expect(run.tools.every((tool) => tool.state !== "running" && !tool.waiting)).toBe(true);
  expect(run.tools.at(-1)?.state).toBe("stopped");
  expect(projectRunEvidence(run.entries)).toMatchObject({ verification: "stopped", failedOrDenied: 0 });
  expect(screen()).not.toContain("Waiting for approval");
  expect(screen()).not.toContain("failed / denied");
});

test("the status strip tracks execution and approval never claims a running verification", () => {
  const { ui, screen, view, key } = fixture();
  ui.beginTurn({ userText: "Check the parser", at: "now" });
  expect(screen().match(/··· THINKING/g)).toHaveLength(1);
  ui.toolRequested({ toolCallId: "check", name: "run_command", arguments: { argv: ["bun", "test"] } });
  expect(screen()).not.toContain("Verification: running");
  expect(screen().split("\n").at(-1)).not.toMatch(/RUNNING|THINKING|···/);
  expect(screen().split("\n").at(-1)).not.toMatch(/tok\/s|\d+\.\d+s/);
  ui.toolWaiting("check", true);
  expect(screen()).toContain("awaiting approval");
  expect(view.evidence.verification).toBe("waiting");
  view.act({ kind: "surface", surface: "review" });
  expect(screen(120, 36)).toContain("AWAITING APPROVAL");
  ui.toolWaiting("check", false);
  expect(screen(120, 36)).toContain("RUNNING");
  ui.toolFinished({ toolCallId: "check", name: "run_command", state: "failed", exitCode: 1, message: "CHECK_FAILURE" });
  ui.finishTurn("failed", "The parser check failed.");
  key("g", { ctrl: true });
  const failed = screen();
  expect(failed.match(/The parser check failed\./g)).toHaveLength(1);
  expect(failed).toContain("CHECK_FAILURE");
  expect(failed.split("\n").at(-1)).toContain("● failed");
});

test("Response navigation reveals the answer start, preserves draft and historical anchors, and returns to live", () => {
  for (const [width, height] of [[40, 10], [80, 24], [120, 36]]) {
    const { ui, screen, state, view, key } = fixture();
    ui.beginTurn({ userText: "Explain the parser", at: "now" });
    ui.assistantDelta("ANSWER_START\n\n" + Array.from({ length: 35 }, (_, index) => `Detail ${index}.\n\n`).join(""));
    ui.finishTurn("completed", "Done");
    void ui.readPrompt({ history: [], mentions: [], commands: [] });
    state.onKeypress("ac", {}); key("left");
    const rows = screen(width, height).split("\n");
    expect(rows.join("\n")).not.toContain("ANSWER_START");
    const row = rows.length - 1;
    state.handleMouse({ kind: "press", button: 0, row, col: rows[row]!.indexOf("●") });
    expect(screen(width, height)).toContain("ANSWER_START");
    expect(view.focused).toBe(true);
    expect(view.memory.followFlow).toBe(false);
    const anchor = view.memory.anchor;
    const original = view.current!.id;
    state.onKeypress("b", {});
    expect(state.editor.value).toBe("abc");
    expect(view.focused).toBe(false);
    ui.beginTurn({ userText: "Next turn", at: "now" });
    ui.assistantDelta("NEW_RESPONSE");
    expect(screen(width, height)).toContain("ANSWER_START");
    expect(view.memory.anchor).toEqual(anchor);
    key("g", { ctrl: true });
    expect(screen(width, height)).toContain("NEW_RESPONSE");
    view.act({ kind: "run", id: original });
    key("r", { meta: true });
    expect(screen(width, height)).toContain("ANSWER_START");
    expect(view.current!.id).toBe(original);
  }
});

test("Copy click, shortcut and Enter on a selected action copy the answer with temporary response-local feedback", () => {
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  const writes: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((data: any) => { writes.push(String(data)); return true; });
  const fixtures: Workbench[] = [];
  try {
    for (const method of ["mouse", "shortcut", "selection"]) {
      clock.mockReturnValue(1000);
      const { ui, state, view, key, screen } = fixture("question");
      fixtures.push(ui);
      let rows = screen().split("\n");
      const receipt = { ...view.current!.answer!.receipt! };
      expect(rows.join("\n")).not.toContain("copy");
      if (method === "mouse") {
        const answerRow = rows.findIndex((line) => line.includes("The identifier boundary"));
        state.handleMouse({ kind: "move", button: 3, row: answerRow, col: 10 });
        clock.mockReturnValue(1200);
        rows = screen().split("\n");
        const row = rows.findIndex((line) => line.includes("copy"));
        expect(rows[row]!.indexOf("copy")).toBeLessThan(rows[row]!.indexOf("[ COMPLETE ]"));
        state.handleMouse({ kind: "press", button: 0, row, col: rows[row]!.indexOf("copy") });
      } else if (method === "shortcut") key("y", { ctrl: true });
      else { key("t", { ctrl: true }); key("tab"); key("tab"); expect(screen()).toContain("copy"); key("return"); }
      expect(writes.at(-1)).toBe(`\x1b]52;c;${Buffer.from(view.current!.answer!.raw).toString("base64")}\x07`);
      expect(screen()).toContain("copied");
      expect(view.current!.answer!.receipt).toEqual(receipt);
      clock.mockReturnValue(2900);
      expect(screen()).not.toContain("copied");
      if (method === "shortcut") expect(screen()).not.toContain("copy");
      else expect(screen()).toContain("copy");
    }
    expect(writes).toHaveLength(3);
  } finally { for (const ui of fixtures) ui.stop(); write.mockRestore(); clock.mockRestore(); }
});

test("hover reveals lowercase copy only on the pointed response without moving the transcript or draft", () => {
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  const motion = process.env.DEMESNE_REDUCED_MOTION;
  process.env.DEMESNE_REDUCED_MOTION = "0";
  try {
    for (const theme of ["demesne", "demesne-light"]) {
      clock.mockReturnValue(1000);
      const { ui, state, screen, view, paint } = fixture("question");
      paint.setTheme(theme);
      ui.beginTurn({ userText: "Second request", at: "12:34" });
      ui.assistantDelta("SECOND_RESPONSE"); ui.finishTurn("completed", "Done");
      void ui.readPrompt({ history: [], mentions: [], commands: [] });
      state.onKeypress("Keep this draft", {});
      const before = ui.frame(120, 36);
      const rows = before.rows.map(stripVTControlCharacters);
      const answer = rows.findIndex((line) => line.includes("The identifier boundary"));
      const receipt = rows.findIndex((line, index) => index > answer && line.includes("Build ·"));
      const offset = view.memory.flowOffset;
      state.handleMouse({ kind: "move", button: 3, row: answer, col: 10 });
      clock.mockReturnValue(1040);
      const midway = ui.frame(120, 36);
      clock.mockReturnValue(1200);
      const hovered = ui.frame(120, 36);
      expect(hovered.rows[receipt]).not.toBe(before.rows[receipt]);
      expect(hovered.rows[receipt]).not.toBe(midway.rows[receipt]);
      expect(hovered.rows.map(stripVTControlCharacters)).toEqual(midway.rows.map(stripVTControlCharacters));
      expect(stripVTControlCharacters(hovered.rows.join("\n")).match(/copy/g)).toHaveLength(1);
      expect(state.editor.value).toBe("Keep this draft");
      expect(view.memory.flowOffset).toBe(offset);
      expect(view.memory.followFlow).toBe(true);
      const request = rows.findIndex((line) => line.includes("What is the identifier boundary"));
      state.handleMouse({ kind: "move", button: 3, row: request, col: 10 });
      clock.mockReturnValue(1400);
      const promptHover = ui.frame(120, 36);
      expect(stripVTControlCharacters(promptHover.rows.join("\n"))).not.toContain("copy");
      expect(promptHover.rows[request]).not.toBe(before.rows[request]);
      state.handleMouse({ kind: "press", button: 0, row: request, col: 10 });
      expect(screen(120, 36)).toContain("14:28 · original-model");
      expect(state.editor.value).toBe("Keep this draft");
    }
  } finally {
    clock.mockRestore();
    if (motion === undefined) delete process.env.DEMESNE_REDUCED_MOTION; else process.env.DEMESNE_REDUCED_MOTION = motion;
  }
});

test("terminal focus changes the prompt outline and caret while Unicode draft counts track paste and queued edits", () => {
  const { ui, state, screen, queue, rail } = fixture("question");
  void ui.readPrompt({ history: [], mentions: [], commands: [] });
  state.onData("\x1b[200~ab日本語🙂\x1b[201~");
  expect(screen()).toContain("~5 tok");
  const focused = ui.frame(80, 24);
  state.onData("\x1b["); state.onData("O");
  const blurred = ui.frame(80, 24);
  expect(blurred.cursor).toBeNull();
  expect(blurred.rows[state.layout.input.row]).not.toBe(focused.rows[state.layout.input.row]);
  state.onData("\x1b[I");
  expect(ui.frame(80, 24).rows[state.layout.input.row]).toBe(focused.rows[state.layout.input.row]);
  expect(ui.frame(80, 24).cursor).toEqual(focused.cursor);
  expect(state.editor.value).toBe("ab日本語🙂");
  rail.setModel({ id: "original-model", provider: "demo", contextWindow: 100000 });
  rail.apply({ schemaVersion: 1, eventId: 1, sessionId: "session", turnId: "turn", workspaceId: null, agentRunId: null,
    occurredAt: new Date().toISOString(), type: "model.usage", payload: { totalTokens: 4000 } });
  // A short, wide terminal puts the token counter beside the shortcut hints.
  const compact = screen(120, 10).split("\n").at(-2)!;
  expect(compact).toContain("~5 tok");
  expect(compact).toContain("/ commands · @ files");
  state.onKeypress("", { name: "return" });
  expect(screen()).not.toContain("~0 tok");
  state.onData("\x1b[200~日本語\x1b[201~");
  expect(screen(40, 10)).toContain("~3 tok");
  expect(queue()).toBe("日本語");
  state.onKeypress("", { name: "backspace" });
  expect(screen(40, 10)).toContain("~2 tok");
});

test("message timestamps keep their first-event time while the header clock advances even with reduced motion", () => {
  const start = Date.parse("2026-09-22T12:34:56Z");
  const clock = spyOn(Date, "now").mockReturnValue(start);
  const motion = process.env.DEMESNE_REDUCED_MOTION;
  process.env.DEMESNE_REDUCED_MOTION = "1";
  try {
    const { ui, view, screen } = fixture();
    ui.beginTurn({ userText: "Record the time", at: "12:34" });
    const at = new Date(start - 10_000).toISOString();
    ui.assistantDelta("First text", at);
    clock.mockReturnValue(start + 1000);
    ui.assistantDelta(" and later text", new Date(start).toISOString());
    ui.finishTurn("completed", "Done");
    const before = screen(120, 36).split("\n");
    expect(view.current?.answer?.at).toBe(at);
    expect(before.find((row, index) => index > 1 && row.includes("demesne"))).toContain(new Date(at).toTimeString().slice(0, 8));
    clock.mockReturnValue(start + 2000);
    const after = screen(120, 36).split("\n");
    expect(after[1]).toContain(new Date(start + 2000).toTimeString().slice(0, 8));
    expect(after[1]).toContain("+00:02");
    expect(after[1]).not.toBe(before[1]);
    expect(after.slice(2)).toEqual(before.slice(2));
  } finally {
    clock.mockRestore();
    if (motion === undefined) delete process.env.DEMESNE_REDUCED_MOTION; else process.env.DEMESNE_REDUCED_MOTION = motion;
  }
});

test("one card header precedes the full multi-round stream and keeps its original timestamp after failure", () => {
  const start = Date.parse("2026-09-23T12:34:56Z");
  const clock = spyOn(Date, "now").mockReturnValue(start);
  try {
    const { ui, screen, view, state } = fixture();
    ui.beginTurn({ userText: "Trace the request flow", at: "12:34" });
    ui.reasoningDelta("Inspect the entry point.");
    clock.mockReturnValue(start + 3000);
    ui.toolRequested({ toolCallId: "first", name: "read_file", arguments: { path: "main.ts" } });
    ui.toolFinished({ toolCallId: "first", name: "read_file", state: "done" });
    ui.beginRound(); ui.assistantDelta("The entry point forwards the request.");
    clock.mockReturnValue(start + 6000);
    ui.toolRequested({ toolCallId: "second", name: "read_file", arguments: { path: "engine.ts" } });
    ui.toolFinished({ toolCallId: "second", name: "read_file", state: "failed", message: "Unable to read engine.ts" });
    ui.finishTurn("failed", "Run ended");
    const rows = screen(120, 36).split("\n");
    const headers = rows.flatMap((line, index) => index > 1 && line.includes("demesne") ? [index] : []);
    expect(headers).toHaveLength(1);
    const header = headers[0]!;
    expect(rows[header]).toContain(new Date(start).toTimeString().slice(0, 8));
    expect(header).toBeLessThan(rows.findIndex((line) => line.includes("THINKING")));
    expect(rows[header - 1]).toContain("[");
    expect(view.current!.answer).toBeUndefined();
    state.handleMouse({ kind: "move", row: header, col: 10 });
    clock.mockReturnValue(start + 9000);
    const after = screen(120, 36).split("\n");
    expect(after[header]).toBe(rows[header]);
    expect(after.join("\n")).toContain("copy");
    expect(after.join("\n")).toContain("[ FAILED ]");
  } finally { clock.mockRestore(); }
});

test("Thinking uses the reference's closed and open chevrons and preserves its disclosure under reduced motion", () => {
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  const motion = process.env.DEMESNE_REDUCED_MOTION;
  process.env.DEMESNE_REDUCED_MOTION = "0";
  try {
    const { ui, screen, key, view } = fixture();
    ui.beginTurn({ userText: "Think", at: "now" });
    ui.reasoningDelta("TRACE"); ui.assistantDelta("ANSWER"); ui.finishTurn("completed", "Done");
    expect(screen()).toMatch(/THINKING · .* ▸/);
    key("x", { ctrl: true });
    expect(screen()).toContain("TRACE");
    clock.mockReturnValue(1040);
    const opened = screen();
    expect(opened).toMatch(/THINKING · .* ▾/);
    clock.mockReturnValue(1200);
    const expanded = screen();
    expect(expanded).toBe(opened);
    process.env.DEMESNE_REDUCED_MOTION = "1";
    key("x", { ctrl: true });
    expect(screen()).toMatch(/THINKING · .* ▸/);
    expect(screen()).not.toContain("TRACE");
    expect(view.animating()).toBe(false);
  } finally {
    clock.mockRestore();
    if (motion === undefined) delete process.env.DEMESNE_REDUCED_MOTION; else process.env.DEMESNE_REDUCED_MOTION = motion;
  }
});

test("pulsing dots mark inline Thinking from the first-token wait through live reasoning and settle under reduced motion", () => {
  const clock = spyOn(Date, "now").mockReturnValue(0);
  const motion = process.env.DEMESNE_REDUCED_MOTION;
  process.env.DEMESNE_REDUCED_MOTION = "0";
  try {
    const { ui, screen, state } = fixture();
    ui.beginTurn({ userText: "Consider this", at: "now" });
    for (const [width, height] of [[40, 10], [80, 24], [120, 36]]) {
      clock.mockReturnValue(0);
      const rows = screen(width, height).split("\n");
      const at = rows.findIndex((row) => row.includes("··· THINKING"));
      expect(at).toBeGreaterThan(rows.findIndex((row) => row.includes("Consider this")));
      expect(at).toBeLessThan(height! - 3);
      expect(rows.slice(-3).join("\n")).not.toMatch(/[\u2800-\u28ff]/);
      const before = ui.frame(width!, height!).rows[at];
      clock.mockReturnValue(180);
      expect(screen(width, height).split("\n")[at]).toContain("··· THINKING");
      expect(ui.frame(width!, height!).rows[at]).not.toBe(before);
    }
    expect(state.entries.filter((entry: { type: string }) => entry.type === "reasoning")).toHaveLength(0);
    ui.reasoningDelta("Inspecting the parser boundary.");
    expect(screen()).toContain("··· THINKING");
    expect(screen().match(/··· THINKING/g)).toHaveLength(1);
    expect(screen()).toContain("boundary.▌");
    process.env.DEMESNE_REDUCED_MOTION = "1";
    const reduced = ui.frame(80, 24).rows;
    clock.mockReturnValue(680);
    expect(ui.frame(80, 24).rows.slice(0, -1)).toEqual(reduced.slice(0, -1));
    process.env.DEMESNE_REDUCED_MOTION = "0";
    state.options.paint = createPainter(false);
    expect(screen()).toContain("··· THINKING");
    ui.assistantDelta("The response.");
    expect(screen()).not.toContain("··· THINKING");
    expect(screen()).not.toContain("boundary.▌");
    ui.finishTurn("completed", "Complete");
    expect(screen().split("\n").at(-1)).toContain("● ready");
    expect(screen()).toContain("[ COMPLETE ]");
    expect(screen()).not.toContain("···");
  } finally {
    clock.mockRestore();
    if (motion === undefined) delete process.env.DEMESNE_REDUCED_MOTION;
    else process.env.DEMESNE_REDUCED_MOTION = motion;
  }
});

test("a long live trace keeps its thinking heading visible and clickable inside the conversation", () => {
  const { ui, screen, state } = fixture();
  ui.beginTurn({ userText: "Investigate", at: "now" });
  ui.reasoningDelta(Array.from({ length: 40 }, (_, index) => `Observation ${index}`).join("\n"));
  state.onKeypress("Keep this draft", {});
  for (const [width, height] of [[40, 10], [80, 24], [120, 36]]) {
    const rows = screen(width, height).split("\n");
    const at = rows.findIndex((row) => row.includes("··· THINKING"));
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(height! - 3);
    expect(rows.join("\n")).toContain("Observation 39");
    expect(rows.slice(-3).join("\n")).not.toMatch(/[\u2800-\u28ff]/);
    state.handleMouse({ kind: "press", button: 0, row: at, col: rows[at]!.indexOf("THINKING") });
    expect(screen(width, height)).toContain("··· THINKING");
    expect(screen(width, height)).not.toContain("Observation 39");
    const collapsed = screen(width, height).split("\n");
    const header = collapsed.findIndex((row) => row.includes("··· THINKING"));
    state.handleMouse({ kind: "press", button: 0, row: header, col: collapsed[header]!.indexOf("THINKING") });
    expect(screen(width, height)).toContain("··· THINKING");
    expect(screen(width, height)).toContain("Keep this draft");
    state.sessionView.act({ kind: "follow" });
  }
});

test("thinking resumes after tools and stays scoped to the current run during history inspection", () => {
  const { ui, screen, view } = fixture("question");
  screen();
  const original = view.current!.id;
  ui.beginTurn({ userText: "Read the parser", at: "now" });
  expect(screen()).toContain("··· THINKING");
  view.act({ kind: "run", id: original });
  expect(screen()).not.toMatch(/[\u2800-\u28ff]/);
  view.act({ kind: "follow" });
  ui.toolRequested({ toolCallId: "read", name: "read_file", arguments: { path: "parser.ts" } });
  expect(screen()).toMatch(/[\u2800-\u28ff] Read/);
  expect(screen()).not.toContain("··· THINKING");
  ui.toolWaiting("read", true);
  expect(screen()).not.toMatch(/[\u2800-\u28ff]/);
  ui.toolFinished({ toolCallId: "read", name: "read_file", state: "done" });
  ui.beginRound();
  const text = screen();
  expect(text).toContain("··· THINKING");
  expect(text.indexOf("THINKING", text.indexOf("Read parser.ts"))).toBeGreaterThan(text.indexOf("Read parser.ts"));
  ui.finishTurn("stopped", "Stopped");
  expect(screen()).not.toContain("··· THINKING");
});

test("each completed response owns its mode, model, duration and speed above the prompt", () => {
  const start = 1_700_000_000_000;
  const clock = spyOn(Date, "now").mockReturnValue(start);
  try {
    const { ui, rail, screen, view } = fixture();
    rail.setModel({ id: "original-model", provider: "demo", contextWindow: 100_000 });
    ui.beginTurn({ userText: "First request", at: "now" });
    ui.assistantDelta("First model response.");
    expect(screen().split("\n").at(-1)).not.toContain("tok/s");
    clock.mockReturnValue(start + 31_100);
    const envelope = { schemaVersion: 1 as const, eventId: 1, occurredAt: new Date().toISOString(), sessionId: "session", turnId: "turn", workspaceId: null, agentRunId: null };
    rail.apply({ ...envelope, type: "model.usage", payload: { inputTokens: 2465, outputTokens: 435, totalTokens: 2900 } });
    rail.apply({ ...envelope, type: "model.metrics", payload: { durationMs: 12_000, timeToFirstTokenMs: 2_000 } });
    expect(screen().split("\n").at(-1)).not.toMatch(/tok\/s|\d+\.\d+s/);
    ui.finishTurn("completed", "Complete");
    const receipt = "Build · original-model · elapsed 31.1s · speed 43.5 tok/s";
    const completed = screen();
    expect(completed.indexOf(receipt)).toBeGreaterThan(completed.indexOf("First model response."));
    expect(completed.indexOf(receipt)).toBeLessThan(completed.indexOf("Continue the conversation..."));
    expect(completed.split("\n").slice(-3).join("\n")).not.toContain("tok/s");
    ui.notice("Session renamed");
    const withNotice = screen();
    expect(withNotice.indexOf(receipt)).toBeLessThan(withNotice.indexOf("Session renamed"));
    const firstRun = view.current!.id;
    for (const [width, height] of [[40, 10], [80, 24]]) {
      const frame = screen(width, height);
      expect(frame).toContain("43.5 tok/s");
      expect(frame.match(/tok\/s/g)).toHaveLength(1);
      expect(frame).toContain("/100k");
      for (const row of ui.frame(width!, height!).rows) expect(visibleLength(row)).toBe(width!);
    }
    clock.mockReturnValue(start + 60_000);
    expect(screen()).toContain(receipt);
    rail.setModel({ id: "next-model", provider: "demo" });
    rail.begin(undefined);
    ui.beginTurn({ userText: "Next request", at: "now", planOnly: true });
    expect(screen().split("\n").at(-1)).not.toContain("tok/s");
    ui.assistantDelta("Second model response.");
    clock.mockReturnValue(start + 518_000);
    ui.finishTurn("completed", "Complete", { tokensPerSecond: 31.2 });
    const both = screen(120, 36);
    expect(both).toContain(receipt);
    expect(both).toContain("Plan · next-model · elapsed 458.0s · speed 31.2 tok/s");
    view.act({ kind: "run", id: firstRun });
    expect(screen()).toContain(receipt);
    expect(screen()).not.toContain("458.0s");
    expect(view.current!.answer?.receipt?.model).toBe("original-model");
    expect(view.current!.answer?.receipt?.context).toEqual({ used: 2900, capacity: 100_000, estimated: false });
  } finally { clock.mockRestore(); }
});

test("a restored response uses its own recorded timing and exposes missing measurements", () => {
  const { ui, screen } = fixture();
  const at = "2026-09-22T10:00:00.000Z";
  const turn = { id: "turn", sessionId: "session", content: "Saved request", responseText: "Saved response", status: "completed" as const,
    createdAt: at, completedAt: "2026-09-22T10:00:31.100Z", permissionMode: "ask" as const, thinkingEnabled: null };
  const session = { id: "session", title: "Saved session", createdAt: at, updatedAt: at, workspace: null, turns: [turn] };
  ui.restoreSession({ session, lastEventId: 0, pendingPermissions: [], latestProviderCall: null });
  expect(screen()).toContain("Build · Model not recorded · elapsed 31.1s · speed — tok/s");
  expect(screen().split("\n").slice(-3).join("\n")).not.toContain("31.1s");
  ui.restoreSession({ session: { ...session, turns: [{ ...turn, completedAt: null }] }, lastEventId: 0, pendingPermissions: [], latestProviderCall: null });
  expect(screen()).toContain("Build · Model not recorded · elapsed —s · speed — tok/s");
});

test("failed cards without a final response retain their own measurements, context meter and terminal badge", () => {
  const { ui, state, rail, screen, view } = fixture();
  rail.setModel({ id: "failed-model", provider: "demo", contextWindow: 100000 });
  ui.beginTurn({ userText: "Trace the request", at: "now", planOnly: true });
  ui.toolRequested({ toolCallId: "read", name: "read_file", arguments: { path: "src/main.ts" } });
  ui.toolFinished({ toolCallId: "read", name: "read_file", state: "failed", message: "Unable to read 日本語.ts" });
  rail.apply({ schemaVersion: 1, eventId: 1, sessionId: "session", turnId: "turn", workspaceId: null, agentRunId: null,
    occurredAt: new Date().toISOString(), type: "model.usage", payload: { totalTokens: 63900 } });
  ui.finishTurn("failed", "Model round limit exceeded", { durationMs: 94200, tokensPerSecond: 19.4 });
  let rows = screen(120, 36).split("\n");
  expect(rows.join("\n")).toContain("No final response recorded");
  expect(rows.join("\n")).toContain("Plan · failed-model · elapsed 94.2s · speed 19.4 tok/s");
  expect(rows.join("\n")).toContain("63.9k/100k ───╴── 64%");
  expect(rows.join("\n")).toContain("[ FAILED ]");
  expect(rows.at(-1)).toContain("● failed");
  expect(view.current?.answer).toBeUndefined();
  const receipt = structuredClone(view.current!.receipt);
  const runId = view.current!.id;
  const row = rows.findIndex((line) => line.includes("failed-model"));
  state.handleMouse({ kind: "move", row, col: 10 });
  expect(screen(120, 36)).not.toContain("copy");
  rail.setModel({ id: "next-model", provider: "demo", contextWindow: 32000 });
  rail.begin(false);
  ui.beginTurn({ userText: "New request", at: "now" });
  ui.assistantDelta("New answer"); ui.finishTurn("completed", "Done");
  view.act({ kind: "run", id: runId });
  expect(view.current!.receipt).toEqual(receipt);
  expect(screen(120, 36)).toContain("19.4 tok/s");
});

test("a shared tool and turn failure appears once with the missing-response explanation", () => {
  const { screen, view } = fixture("round-limit");
  expect(screen(120, 40).match(/Turn exceeded the model round limit\./g)).toHaveLength(1);
  expect(screen(120, 40)).toContain("No final response recorded");
  const tool = view.current!.tools.at(-1)!;
  view.act({ kind: "toggle", runId: view.current!.id, key: `entry:${tool.id}` });
  const expanded = screen(120, 40);
  expect(expanded.match(/Turn exceeded the model round limit\./g)).toHaveLength(1);
  expect(expanded).toContain("Arguments");
  expect(expanded).toContain("[ FAILED ]");
});

test("context meters preserve unknown measurements and distinguish safe, amber and red usage in both themes", () => {
  for (const name of ["demesne", "demesne-light"]) {
    const paint = createPainter(true, name);
    for (const [used, tone] of [[0, "secondary"], [50000, "secondary"], [51000, "thinking"], [80000, "thinking"], [81000, "signal"], [150000, "signal"]] as const) {
      const context = { used, capacity: 100000, estimated: true };
      expect(contextTone(context)).toBe(tone);
      expect(contextMeter(context, paint)).toContain(paint.text(`${Math.round(used / 1000)}%`, tone === "secondary" ? "muted" : tone));
      expect(visibleLength(contextMeter(context, paint))).toBeLessThanOrEqual(13);
    }
    expect(contextMeter({ used: null, capacity: 100000, estimated: false }, paint)).toBe("");
    expect(contextMeter({ used: 4000, capacity: null, estimated: false }, paint)).toBe("");
    expect(contextMeter({ used: 4000, capacity: 0, estimated: false }, paint)).toBe("");
  }
});

test("live reasoning is visible by default and the full trace remains accessible after the answer", () => {
  const { ui, screen, key, view } = fixture();
  ui.beginTurn({ userText: "Investigate", at: "now" });
  ui.reasoningDelta("First observation.\nChecking the parser boundary.");
  expect(screen()).toContain("··· THINKING");
  expect(screen()).toContain("Checking the parser boundary.");
  ui.reasoningDelta("\nA later observation.");
  expect(screen(40, 10)).toContain("A later observation.");
  key("x", { ctrl: true });
  expect(screen()).toContain("··· THINKING");
  expect(screen()).not.toContain("Checking the parser boundary.");
  key("x", { ctrl: true });
  expect(screen()).toContain("Checking the parser boundary.");
  expect(view.memory.surface).toBe("response");
  ui.assistantDelta("The final answer.");
  ui.finishTurn("completed", "Finished");
  expect(screen()).toContain("The final answer.");
  expect(screen()).toContain("THINKING");
  key("x", { ctrl: true });
  expect(screen()).not.toContain("Checking the parser boundary.");
  key("x", { ctrl: true });
  expect(screen()).toContain("Checking the parser boundary.");
});

test("thinking, tool execution and subsequent model rounds stay in chronological order", () => {
  const { ui, state, screen, key } = fixture();
  ui.beginTurn({ userText: "Investigate", at: "now" });
  ui.reasoningDelta("First round reasoning.");
  ui.toolRequested({ toolCallId: "read", name: "read_file", arguments: { path: "parser.ts" } });
  expect(screen()).toContain("Read parser.ts");
  expect(screen()).toContain("parser.ts");
  expect(screen()).not.toContain("First round reasoning.");
  key("x", { ctrl: true });
  expect(screen()).toContain("First round reasoning.");
  ui.toolFinished({ toolCallId: "read", name: "read_file", state: "done" });
  ui.beginRound();
  ui.reasoningDelta("Second round reasoning.");
  expect(screen()).toContain("Second round reasoning.");
  expect(state.entries.filter((entry: { type: string }) => entry.type === "reasoning")).toHaveLength(2);
  key("x", { ctrl: true });
  expect(screen()).not.toContain("Second round reasoning.");
  key("x", { ctrl: true });
  expect(screen()).toContain("Second round reasoning.");
  expect(screen()).toContain("First round reasoning.");
  expect(screen().indexOf("First round reasoning.")).toBeLessThan(screen().indexOf("Read parser.ts"));
  expect(screen().indexOf("Read parser.ts")).toBeLessThan(screen().indexOf("Second round reasoning."));
});

test("thinking detail keeps the reference's inset inside the response column at every width", () => {
  const { ui, screen, key } = fixture();
  ui.beginTurn({ userText: "Investigate", at: "now" });
  ui.reasoningDelta("First observation.\nChecking the parser boundary.");
  ui.assistantDelta("The answer stays readable while reasoning streams.");
  expect(screen()).not.toContain("First observation.");
  key("x", { ctrl: true });
  for (const width of [60, 80, 120, 160]) {
    const text = screen(width, 36);
    const lines = text.split("\n");
    const thinking = lines.findIndex((line) => line.includes("First observation."));
    const answer = lines.findIndex((line) => line.includes("The answer stays readable"));
    expect(thinking).toBeGreaterThan(0);
    expect(answer).toBeGreaterThan(thinking);
    expect(lines[thinking]!.indexOf("First observation.")).toBe(lines[answer]!.indexOf("The answer stays readable") + 2);
  }
  key("x", { ctrl: true });
  expect(screen()).not.toContain("Checking the parser boundary.");
  expect(screen()).toContain("The answer stays readable");
});

test("settled reasoning expands inline without replacing the answer on narrow screens", () => {
  const { ui, screen, key } = fixture();
  ui.beginTurn({ userText: "Investigate", at: "now" });
  ui.reasoningDelta("First observation.\nChecking the parser boundary.");
  ui.assistantDelta("The answer stays in the conversation.");
  ui.finishTurn("completed", "Finished");
  key("x", { ctrl: true });
  const narrow = screen(60, 24);
  expect(narrow).toMatch(/THINKING · [\d.]+s ▾/);
  expect(narrow).toContain("First observation.");
  expect(narrow).toContain("The answer stays");
  key("x", { ctrl: true });
  expect(screen(60, 24)).toContain("The answer stays");
  expect(screen(60, 24)).not.toContain("Checking the parser boundary.");
});

test("context capacity and project path stay visible in narrow frames and open details without losing drafts", async () => {
  const { ui, rail, state, screen, key } = fixture();
  rail.setModel({ id: "original-model", provider: "demo", contextWindow: 100_000 });
  const prompt = ui.readPrompt({ history: [], mentions: [], commands: [] });
  state.onKeypress("preserve this draft", {});
  expect(screen(40, 10)).toContain("/project");
  expect(screen(40, 10)).toContain("ctx —/100k");
  key("c", { meta: true });
  expect(screen()).toContain("100k token capacity");
  expect(state.editor.value).toBe("preserve this draft");
  key("escape");
  // The session-line path and prompt-side context remain live mouse targets.
  const heading = screen().split("\n")[1]!;
  state.handleMouse({ kind: "press", button: 0, row: 1, col: heading.indexOf("/project") });
  expect(screen()).toContain("PROJECT FOLDER");
  expect(screen()).toContain("/project");
  key("escape");
  const context = state.mouseZones.find((zone: { row: number }) => zone.row === state.layout.height - 1);
  state.handleMouse({ kind: "press", button: 0, row: context.row, col: context.column });
  expect(screen()).toContain("▪ CONTEXT");
  key("escape");
  key("return");
  expect(await prompt).toBe("preserve this draft");
});

test("closing context and project details during inference does not count as double Escape", () => {
  const { key, screen, state, interrupts } = fixture("thinking");
  key("c", { meta: true });
  expect(screen()).toContain("▪ CONTEXT");
  key("escape");
  key("p", { meta: true });
  expect(screen()).toContain("PROJECT FOLDER");
  key("escape");
  expect(interrupts()).toBe(0);
  for (const target of ["ctx", "/project"]) {
    const rows = screen().split("\n");
    const row = rows.findLastIndex((line) => line.includes(target));
    state.handleMouse({ kind: "press", button: 0, row, col: rows[row]!.indexOf(target) });
    expect(screen()).toContain(target === "ctx" ? "▪ CONTEXT" : "PROJECT FOLDER");
    key("escape");
    expect(interrupts()).toBe(0);
  }
  expect(screen()).toContain("THINKING");
});

test("session command output opens above pinned evidence and returns to it on Escape", () => {
  const { ui, view, key, screen } = fixture("complete");
  screen();
  view.act({ kind: "run", id: view.current!.id });
  view.act({ kind: "surface", surface: "review" });
  key("return");
  const detail = view.memory.detail;
  ui.showPanel(["CONTEXT PLAN", "Only measured context goes here."]);
  expect(screen()).toContain("SESSION OUTPUT");
  expect(screen()).toContain("CONTEXT PLAN");
  expect(view.focused).toBe(true);
  key("escape");
  expect(screen()).toContain("RECORDED CHANGE");
  expect(view.memory.detail).toBe(detail);
});

test("uncolored long responses remain readable through to the end", () => {
  const { ui, state, view, key, screen } = fixture();
  state.options.paint = createPainter(false);
  ui.beginTurn({ userText: "Explain", at: "now" });
  ui.assistantDelta("A long explanation. ".repeat(40) + "END_OF_ANSWER");
  ui.finishTurn("completed", "Finished");
  screen(40, 16);
  key("g", { ctrl: true });
  let viewed = "";
  for (let page = 0; page < 20; page++) {
    viewed += screen(40, 16);
    if (view.memory.flowOffset === 0) break;
    key("pageup");
  }
  expect(viewed).toContain("END_OF_ANSWER");
});

test("Tab moves between panel records while preserving the detail view", () => {
  const { ui, view, screen, state } = fixture("complete");
  ui.toolRequested({ toolCallId: "second-check", name: "run_command", arguments: { argv: ["bun", "run", "typecheck"] } });
  screen(120, 40);
  view.act({ kind: "surface", surface: "review" });
  view.key({ name: "return" });
  const first = view.memory.detail;
  screen(120, 40);
  view.key({ name: "tab" });
  view.key({ name: "tab" });
  expect(view.memory.detail).not.toBe(first);
  expect(screen(120, 40)).toContain("typecheck");
});

test("a new run does not inherit verification classification from earlier edits", () => {
  const { ui, state } = fixture("complete");
  ui.beginTurn({ userText: "Inspect the worktree", at: "now" });
  ui.toolRequested({ toolCallId: "status", name: "git_status", arguments: {} });
  expect(planRuns(state.entries).at(-1)!.tools[0]!.phase).toBe("inspect");
});

test("live answers follow output until the reader scrolls, then hold their position", () => {
  const { ui, view, screen, key } = fixture();
  ui.beginTurn({ userText: "Explain", at: "now" });
  ui.assistantDelta(Array.from({ length: 40 }, (_, i) => `Paragraph ${i}.\n\n`).join(""));
  screen();
  expect(view.memory.flowOffset).toBeGreaterThan(0);
  key("pageup");
  screen();
  const offset = view.memory.flowOffset;
  ui.assistantDelta("More output.\n\n".repeat(10));
  screen();
  expect(view.memory.flowOffset).toBe(offset);
  key("g", { ctrl: true });
  screen();
  expect(view.memory.flowOffset).toBeGreaterThan(offset);
});

test("wheel momentum rests at both edges without changing the viewport and scrolling down resumes live", () => {
  // The header clock and elapsed time are part of each frame; a second
  // boundary between two snapshots must not read as a viewport change.
  const clock = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 29, 0, 43, 37));
  try {
    for (const theme of ["demesne", "demesne-light"]) for (const [width, height] of [[40, 10], [80, 24], [120, 36]]) {
      const { view, paint, screen, key } = fixture("long");
      paint.setTheme(theme);
      const before = screen(width, height);
      expect(before).not.toContain("╎");
      const region = (view as any).regions.find((region: { target: string }) => region.target === "flow");
      const anchor = view.memory.anchor;
      const bottom = view.memory.flowOffset;
      for (let index = 0; index < 60; index++) expect(view.wheel(region.row, region.column, 3)).toBe(false);
      key("pagedown");
      expect(screen(width, height)).toBe(before);
      expect(view.memory.followFlow).toBe(true);
      expect(view.memory.anchor).toEqual(anchor);
      expect(view.wheel(region.row, region.column, -3)).toBe(bottom > 0);
      screen(width, height);
      expect(view.memory.flowOffset).toBe(Math.max(0, bottom - 3));
      expect((view as any).regions.find((region: { target: string }) => region.target === "flow").height).toBe(region.height);
      view.wheel(region.row, region.column, -10_000);
      const top = screen(width, height);
      for (let index = 0; index < 60; index++) expect(view.wheel(region.row, region.column, -3)).toBe(false);
      expect(screen(width, height)).toBe(top);
      view.wheel(region.row, region.column, 10_000);
      expect(screen(width, height)).toBe(before);
      expect(view.memory.followFlow).toBe(true);
    }
  } finally { clock.mockRestore(); }
});

test("completed transcript stays at the bottom through raw diagonal trackpad wheel events", () => {
  for (const [width, height] of [[40, 10], [80, 24], [120, 36]]) {
    const { state, view, screen } = fixture("long");
    screen(width, height);
    const region = (view as any).regions.find((region: { target: string }) => region.target === "flow");
    const bottom = view.memory.flowOffset;
    for (let tick = 0; tick < 20; tick++) {
      // Trackpads can report both axes in one downward gesture. Horizontal
      // wheel buttons must not masquerade as vertical scrolling.
      for (const button of [65, 66, 65, 67]) {
        const sequence = `\x1b[<${button};${region.column + 1};${region.row + 1}M`;
        state.onData(sequence.slice(0, 5));
        state.onData(sequence.slice(5));
        screen(width, height);
        expect(view.memory.flowOffset).toBe(bottom);
        expect(view.memory.followFlow).toBe(true);
      }
    }
    state.onData(`\x1b[<64;${region.column + 1};${region.row + 1}M`);
    screen(width, height);
    expect(view.memory.flowOffset).toBe(Math.max(0, bottom - 3));
  }
});

// About 1,350 full frames (3 sizes × 50 deltas × 9 renders) at a steady
// ~1.5 ms each: under 2 s locally, but past bun's 5 s default on slow runners.
test("downward wheel momentum during streaming never snaps back to an older response window", () => {
  for (const [width, height] of [[40, 10], [80, 24], [120, 36]]) {
    const { ui, view, screen } = fixture();
    ui.beginTurn({ userText: "Explain", at: "now" });
    for (let line = 0; line < 50; line++) {
      ui.assistantDelta(`Line ${line}\n`);
      screen(width, height);
      const region = (view as any).regions.find((region: { target: string }) => region.target === "flow");
      for (let tick = 0; tick < 8; tick++) {
        view.wheel(region.row, region.column, 3);
        const requested = view.memory.flowOffset;
        screen(width, height);
        expect(view.memory.flowOffset).toBeGreaterThanOrEqual(requested);
      }
    }
  }
}, 20_000);

test("streaming prose follows only overflowing rows and respects manual reading", () => {
  for (const [width, height] of [[40, 10], [80, 24], [120, 36]]) {
    const { ui, view, screen, key } = fixture();
    ui.beginTurn({ userText: "Explain the implementation", at: "now" });
    ui.reasoningDelta(Array.from({ length: 45 }, (_, index) => `Observation ${index}`).join("\n"));
    screen(width, height);
    const seen = new Set<string>();
    let advances = 0;
    let previous = -1;
    for (let index = 0; index < 45; index++) {
      const label = `STREAM_${String(index).padStart(2, "0")}`;
      ui.assistantDelta(`${index ? "\n" : ""}- ${label} is readable.`);
      const rows = screen(width, height).split("\n");
      const region = (view as any).regions.find((region: { target: string }) => region.target === "flow");
      const tail = rows.findIndex((row) => row.includes(label));
      expect(tail).toBeGreaterThanOrEqual(region.row);
      expect(tail).toBeLessThan(region.row + region.height - 1);
      if (index === 0) expect(tail - region.row).toBeLessThanOrEqual(2);
      for (const match of rows.join("\n").matchAll(/STREAM_\d+/g)) seen.add(match[0]);
      if (previous >= 0 && view.memory.flowOffset !== previous) {
        advances++;
        expect(view.memory.flowOffset - previous).toBeGreaterThanOrEqual(1);
        expect(view.memory.flowOffset - previous).toBeLessThanOrEqual(width === 40 ? 2 : 1);
        expect(view.memory.flowOffset - previous).toBeLessThan(region.height);
      }
      previous = view.memory.flowOffset;
    }
    expect(seen.size).toBe(45);
    expect(advances).toBeGreaterThan(0);
    expect(advances).toBeLessThan(45);
    key("pageup");
    screen(width, height);
    const anchor = view.memory.anchor;
    const offset = view.memory.flowOffset;
    ui.assistantDelta("\n- MORE_OUTPUT\n" + "- Later content.\n".repeat(30) + "- LAST_OUTPUT");
    expect(screen(width, height)).not.toContain("LAST_OUTPUT");
    expect(view.memory.anchor).toEqual(anchor);
    expect(view.memory.flowOffset).toBe(offset);
    key("g", { ctrl: true });
    expect(screen(width, height)).toContain("LAST_OUTPUT");
    ui.finishTurn("completed", "Done");
    const settled = screen(width, height);
    expect(settled).toContain("LAST_OUTPUT");
    expect(settled).toContain("tok/s");
    // The wall clock in the header can tick between these two renders.
    expect(screen(width, height).split("\n").slice(2)).toEqual(settled.split("\n").slice(2));
  }
});

test("folding completed reasoning leaves breathing room without a visible scrollbar", () => {
  const { ui, view, screen } = fixture();
  ui.beginTurn({ userText: "Explain", at: "now" });
  ui.reasoningDelta("An observation.\n".repeat(5));
  screen();
  ui.assistantDelta("SHORT_RESPONSE");
  const rows = screen().split("\n");
  const region = (view as any).regions.find((region: { target: string }) => region.target === "flow");
  expect(view.memory.flowOffset).toBe(0);
  expect((view as any).flowRows.length).toBeLessThan(region.height);
  expect(rows[1]).toContain("history");
  expect(rows.join("\n")).toContain("SHORT_RESPONSE");
  expect(rows.join("\n")).not.toContain("╎");
});

test("streaming bursts advance one row per frame and drain through settlement without skipping prose", () => {
  for (const [width, height] of [[40, 10], [80, 24], [120, 36]]) {
    const { ui, state, view, screen } = fixture();
    let now = 1_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    state.started = true;
    try {
      ui.beginTurn({ userText: "Explain", at: "now" });
      screen(width, height);
      ui.assistantDelta("Introduction\n");
      now += 16; screen(width, height);
      const before = view.memory.flowOffset;
      ui.assistantDelta(Array.from({ length: 45 }, (_, index) => `BURST_${String(index).padStart(2, "0")}\n`).join(""));
      now += 16;
      const seen = new Set<string>();
      const observe = () => {
        const text = screen(width, height);
        for (const match of text.matchAll(/BURST_\d+/g)) seen.add(match[0]);
        return text;
      };
      expect(observe()).not.toContain("BURST_44");
      expect(view.memory.flowOffset - before).toBe(1);
      expect(view.animating(now)).toBe(true);
      const offset = view.memory.flowOffset;
      observe(); // Multiple paints at one instant must not accelerate scrolling.
      expect(view.memory.flowOffset).toBe(offset);
      now += 1000; observe(); // A delayed frame must not jump to catch up.
      expect(view.memory.flowOffset).toBe(offset + 1);
      ui.finishTurn("completed", "Done");
      let previous = view.memory.flowOffset;
      let frame = "";
      for (let tick = 0; tick < 150; tick++) {
        now += 16; frame = observe();
        expect(view.memory.flowOffset - previous).toBeGreaterThanOrEqual(0);
        expect(view.memory.flowOffset - previous).toBeLessThanOrEqual(1);
        previous = view.memory.flowOffset;
        if (!view.animating(now)) break;
      }
      expect(view.animating(now)).toBe(false);
      expect(seen.size).toBe(45);
      expect(frame).toContain("COMPLETE");
      expect(observe()).toBe(frame);
    } finally { state.started = false; ui.stop(); clock.mockRestore(); }
  }
});

test("scrolling up stops catch-up immediately and Live jumps directly to the latest text", () => {
  const { ui, state, view, screen, key } = fixture();
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  state.started = true;
  try {
    ui.beginTurn({ userText: "Explain", at: "now" }); screen();
    ui.assistantDelta("Start\n" + "A line\n".repeat(60));
    for (let tick = 0; tick < 20; tick++) { now += 16; screen(); }
    expect(view.animating(now)).toBe(true);
    key("pageup"); screen();
    const offset = view.memory.flowOffset;
    const anchor = view.memory.anchor;
    ui.assistantDelta("\nLAST_OUTPUT");
    now += 1000;
    expect(screen()).not.toContain("LAST_OUTPUT");
    expect(view.memory.flowOffset).toBe(offset);
    expect(view.memory.anchor).toEqual(anchor);
    expect(view.animating(now)).toBe(false);
    key("g", { ctrl: true });
    expect(screen()).toContain("LAST_OUTPUT");
    expect(view.animating(now)).toBe(false);
  } finally { state.started = false; ui.stop(); clock.mockRestore(); }
});

test("later-round thinking drains past earlier prose even after provider deltas pause", () => {
  for (const [width, height] of [[40, 10], [80, 24], [120, 36]]) {
    const { ui, state, view, screen } = fixture();
    let now = 1000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    state.started = true;
    try {
      const draw = () => { now += 16; return screen(width, height); };
      ui.beginTurn({ userText: "Investigate", at: "now" }); draw();
      ui.assistantDelta("I will inspect the parser."); draw();
      ui.toolRequested({ toolCallId: "read", name: "read_file", arguments: { path: "parser.ts" } });
      ui.toolFinished({ toolCallId: "read", name: "read_file", state: "done", message: "Parser source" });
      ui.beginRound(); draw();
      ui.reasoningDelta(Array.from({ length: 75 }, (_, index) => `TRACE_${String(index).padStart(2, "0")}`).join("\n"));
      let previous = view.memory.flowOffset;
      const seen = new Set<string>();
      let text = "";
      for (let tick = 0; tick < 120; tick++) {
        text = draw();
        for (const match of text.matchAll(/TRACE_\d+/g)) seen.add(match[0]);
        expect(view.memory.flowOffset - previous).toBeGreaterThanOrEqual(0);
        expect(view.memory.flowOffset - previous).toBeLessThanOrEqual(1);
        previous = view.memory.flowOffset;
        if (!view.animating(now)) break;
      }
      expect(view.animating(now)).toBe(false);
      expect(text).toContain("TRACE_74");
      expect(seen.size).toBe(75);
      const offset = view.memory.flowOffset;
      for (let tick = 0; tick < 5; tick++) {
        expect(draw()).toContain("TRACE_74");
        expect(view.memory.flowOffset).toBe(offset);
      }
    } finally { state.started = false; ui.stop(); clock.mockRestore(); }
  }
});

test.each(["wheel", "pagedown", "live"] as const)("%s reaches paused later-round thinking without the next paint resetting to earlier prose", (navigation) => {
  for (const [width, height] of [[40, 10], [80, 24], [120, 36]]) {
    const { ui, state, view, screen, key } = fixture();
    let now = 1000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    state.started = true;
    try {
      const draw = () => { now += 16; return screen(width, height); };
      ui.beginTurn({ userText: "Investigate", at: "now" }); draw();
      ui.assistantDelta("I will inspect the parser."); draw();
      ui.toolRequested({ toolCallId: "read", name: "read_file", arguments: { path: "parser.ts" } });
      ui.toolFinished({ toolCallId: "read", name: "read_file", state: "done", message: "Parser source" });
      ui.beginRound(); draw();
      ui.reasoningDelta(Array.from({ length: 75 }, (_, index) => `TRACE_${String(index).padStart(2, "0")}`).join("\n"));
      draw();
      const region = (view as any).regions.find((region: { target: string }) => region.target === "flow");
      if (navigation === "live") { key("g", { ctrl: true }); draw(); }
      else for (let tick = 0; tick < 80 && view.memory.flowOffset < (view as any).flowMaximum; tick++) {
        if (navigation === "wheel") state.onData(`\x1b[<65;${region.column + 1};${region.row + 1}M`);
        else key("pagedown");
        draw();
      }
      expect(view.memory.followFlow).toBe(true);
      const bottom = view.memory.flowOffset;
      expect(bottom).toBeGreaterThan(50);
      for (let tick = 0; tick < 8; tick++) {
        expect(draw()).toContain("TRACE_74");
        expect(view.memory.flowOffset).toBe(bottom);
        expect(view.animating(now)).toBe(false);
      }
      // Moving upward still pins the trace when subsequent output arrives.
      key("pageup"); draw();
      const anchor = view.memory.anchor;
      ui.reasoningDelta("\nMORE_THINKING"); draw();
      expect(view.memory.anchor).toEqual(anchor);
      ui.assistantDelta("A final response."); draw();
      expect(view.memory.anchor).toEqual(anchor);
    } finally { state.started = false; ui.stop(); clock.mockRestore(); }
  }
});

test("resize and reduced motion resolve pending scroll without a stale animation", () => {
  const { ui, state, view, screen } = fixture();
  const reduced = process.env.DEMESNE_REDUCED_MOTION;
  delete process.env.DEMESNE_REDUCED_MOTION;
  state.started = true;
  try {
    ui.beginTurn({ userText: "Explain", at: "now" }); screen();
    ui.assistantDelta("A line\n".repeat(60) + "BEFORE_RESIZE"); screen();
    expect(view.animating()).toBe(true);
    expect(screen(120, 36)).toContain("BEFORE_RESIZE");
    expect(view.animating()).toBe(false);
    ui.assistantDelta("\n" + "Another line\n".repeat(60) + "AFTER_BURST"); screen(120, 36);
    expect(view.animating()).toBe(true);
    process.env.DEMESNE_REDUCED_MOTION = "1";
    expect(screen(120, 36)).toContain("AFTER_BURST");
    expect(view.animating()).toBe(false);
  } finally {
    state.started = false; ui.stop();
    if (reduced === undefined) delete process.env.DEMESNE_REDUCED_MOTION;
    else process.env.DEMESNE_REDUCED_MOTION = reduced;
  }
});

test("production painting continues scroll catch-up after the last provider delta", async () => {
  const { ui, state, view } = fixture();
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  state.started = true;
  try {
    ui.beginTurn({ userText: "Explain", at: "now" }); state.render();
    ui.assistantDelta("Line\n".repeat(24)); state.render();
    ui.finishTurn("completed", "Done");
    const before = view.memory.flowOffset;
    await Bun.sleep(100);
    expect(view.memory.flowOffset).toBeGreaterThan(before);
    for (let tick = 0; tick < 40 && view.animating(); tick++) await Bun.sleep(25);
    expect(view.animating()).toBe(false);
    expect(state.renderTimer).toBeNull();
  } finally { state.started = false; ui.stop(); write.mockRestore(); }
});

test("terminal painting coalesces input bursts, writes atomic padded frames, and emits nothing for an unchanged frame", async () => {
  // The header clock is intentionally live. Hold it still while asserting that
  // an otherwise unchanged frame emits no output across asynchronous redraws.
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  const { ui, state, view } = fixture("long");
  const writes: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((data: any) => { writes.push(String(data)); return true; });
  try {
    state.started = true;
    state.render();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toStartWith("\x1b[?2026h\x1b[?25l");
    expect(writes[0]).toEndWith("\x1b[?2026l");
    expect(writes[0]).not.toContain("\x1b[2K");
    const region = (view as any).regions.find((region: { target: string }) => region.target === "flow");
    const wheel = (direction: string) => state.handleMouse({ kind: "wheel", direction, row: region.row, col: region.column });
    for (let index = 0; index < 60; index++) wheel("down");
    state.render();
    expect(writes).toHaveLength(1);
    expect(state.renderTimer).toBeNull();
    for (let index = 0; index < 60; index++) wheel("up");
    expect(writes).toHaveLength(1);
    await Bun.sleep(30);
    expect(writes).toHaveLength(2);
    state.render();
    expect(writes).toHaveLength(2);
    expect(view.memory.flowOffset).toBe(0);
    expect(writes[1]).not.toContain("\x1b[2K");
    ui.tick(); ui.tick();
    await Bun.sleep(30);
    expect(writes).toHaveLength(2);
    for (let index = 0; index < 3; index++) {
      state.onKeypress("", { name: "l", ctrl: true });
      for (const row of ui.frame(80, 24).rows) expect(visibleLength(row)).toBe(80);
    }
  } finally { state.started = false; ui.stop(); write.mockRestore(); clock.mockRestore(); }
});

test("run history opens on demand and restores the selected run's view", () => {
  const { ui, view, screen, key } = fixture("complete");
  screen(120, 40);
  view.act({ kind: "surface", surface: "review" });
  key("return");
  const selected = view.current!.id;
  const detail = view.memory.detail;
  key("h", { meta: true });
  expect(screen(80, 24)).toContain("History");
  key("escape");
  expect(view.current!.id).toBe(selected);
  expect(view.memory.detail).toBe(detail);
  key("h", { meta: true });
  key("up");
  key("return");
  expect(view.current!.number).toBe(1);
  expect(screen(80, 24)).toContain("boundary");
  ui.frame(40, 10);
  key("g", { ctrl: true });
  expect(view.current!.id).toBe(selected);
});

test("scrollback crosses turn boundaries and stays anchored when a queued turn starts", () => {
  const { ui, view, key, screen } = fixture();
  ui.beginTurn({ userText: "First request", at: "now" });
  ui.reasoningDelta(Array.from({ length: 35 }, (_, index) => `Observation ${index}`).join("\n"));
  screen();
  key("pageup");
  const reading = () => screen().split("\n").slice(4, 12).map((line) => line.replaceAll("╎", " ").slice(0, 74).trimEnd());
  const before = reading();
  const anchor = view.memory.anchor;
  ui.assistantDelta("First answer arrived.");
  ui.finishTurn("completed", "Finished");
  ui.beginTurn({ userText: "Queued second request", at: "now" });
  ui.assistantDelta("Second answer arrived.");
  expect(reading()).toEqual(before);
  expect(view.memory.anchor).toEqual(anchor);
  expect(view.selectedId).toBeNull();
  key("g", { ctrl: true });
  expect(screen()).toContain("Second answer arrived.");
  for (let page = 0; page < 8; page++) { key("pageup"); screen(); }
  expect(screen()).toContain("First request");
});

test("tool output and arguments expand inline with mouse and keyboard while preserving the draft", () => {
  const { ui, view, state, key, screen } = fixture("verify-only");
  void ui.readPrompt({ history: [], mentions: [], commands: [] });
  state.onKeypress("Keep my draft", {});
  screen(100, 36);
  key("t", { ctrl: true });
  key("tab"); // Request disclosure precedes the tool.
  key("tab");
  key("return");
  let rows = screen(100, 36).split("\n");
  expect(rows.join("\n")).toContain("Parser regression suite (preview fixture)");
  expect(rows.join("\n")).toContain("No files were changed.");
  expect(view.memory.surface).toBe("response");
  const argsRow = rows.findIndex((line) => line.includes("Arguments"));
  state.handleMouse({ kind: "press", button: 0, row: argsRow, col: rows[argsRow]!.indexOf("Arguments") });
  expect(screen(100, 36)).toContain('"argv"');
  rows = screen(100, 36).split("\n");
  const toolRow = rows.findIndex((line) => line.includes("exit 0"));
  state.handleMouse({ kind: "press", button: 0, row: toolRow, col: rows[toolRow]!.indexOf("bun test") });
  expect(screen(100, 36)).not.toContain("Parser regression suite (preview fixture)");
  expect(state.editor.value).toBe("Keep my draft");
});

test("an inspected read stays expanded when a later read forms an activity group", () => {
  const { ui, view, screen, key } = fixture();
  ui.beginTurn({ userText: "Inspect", at: "now" });
  ui.toolRequested({ toolCallId: "one", name: "read_file", arguments: { path: "first.ts" } });
  ui.toolFinished({ toolCallId: "one", name: "read_file", state: "done", message: "FIRST_FILE_CONTENT" });
  screen();
  key("t", { ctrl: true }); key("tab"); key("tab"); key("return");
  expect(screen()).toContain("FIRST_FILE_CONTENT");
  ui.toolRequested({ toolCallId: "two", name: "read_file", arguments: { path: "second.ts" } });
  ui.toolFinished({ toolCallId: "two", name: "read_file", state: "done", message: "SECOND_FILE_CONTENT" });
  expect(screen()).toContain("Read 2 files");
  expect(screen()).toContain("FIRST_FILE_CONTENT");
  expect(view.memory.surface).toBe("response");
});

test("a long request expands in the conversation and remains scrollable alongside the response", () => {
  const { ui, view, screen, key } = fixture();
  ui.beginTurn({ userText: Array.from({ length: 30 }, (_, i) => `Request constraint ${i}`).join("\n"), at: "now" });
  ui.assistantDelta("I can see all thirty constraints.");
  ui.finishTurn("completed", "Done");
  expect(screen()).not.toContain("Request constraint 29");
  view.act({ kind: "request" });
  screen();
  key("pagedown");
  let text = screen();
  key("pagedown");
  text += screen();
  expect(text).toContain("Request constraint 29");
  expect(text).toContain("I can see all thirty constraints.");
  expect(view.memory.surface).toBe("response");
});

test("historical verification opens recorded evidence inline without changing the active turn", () => {
  const { ui, view, state, screen } = fixture();
  ui.beginTurn({ userText: "Earlier request", at: "then" });
  ui.toolRequested({ toolCallId: "old", name: "run_command", arguments: { argv: ["bun", "test"] } });
  ui.toolFinished({ toolCallId: "old", name: "run_command", state: "failed", exitCode: 1, message: "ORIGINAL_CHECK_FAILURE" });
  ui.beginRound(); ui.assistantDelta("Earlier response."); ui.finishTurn("completed", "Done");
  ui.beginTurn({ userText: "Current request", at: "now" });
  ui.assistantDelta("Current response."); ui.finishTurn("completed", "Done");
  const rows = screen(100, 40).split("\n");
  const latest = view.current!.id;
  const row = rows.findIndex((line) => line.includes("Verification: failed"));
  state.handleMouse({ kind: "press", button: 0, row, col: rows[row]!.indexOf("Verification:") });
  expect(view.current!.id).toBe(latest);
  expect(view.memory.surface).toBe("response");
  expect(screen(100, 40)).toContain("ORIGINAL_CHECK_FAILURE");
  expect(screen(100, 40)).toContain("Current response.");
  view.act({ kind: "back" });
  expect(view.selectedId).toBeNull();
  expect(screen(100, 40)).toContain("Earlier response.");
  expect(screen(100, 40)).toContain("Current response.");
  expect(screen(100, 40)).not.toContain("Close ×");
});

test("read batches compress while changes, checks, pending, denied and unknown results remain exposed", () => {
  const { ui, state, view, screen, key } = fixture();
  ui.beginTurn({ userText: "Update and verify", at: "now" });
  ui.toolRequested({ toolCallId: "read", name: "read_file", arguments: { path: "parser.ts" } });
  ui.toolFinished({ toolCallId: "read", name: "read_file", state: "done", message: "ORIGINAL_SOURCE" });
  ui.toolRequested({ toolCallId: "read-two", name: "read_file", arguments: { path: "lexer.ts" } });
  ui.toolFinished({ toolCallId: "read-two", name: "read_file", state: "done" });
  ui.toolRequested({ toolCallId: "edit", name: "edit_file", arguments: { path: "parser.ts", oldText: "before", newText: "after" } });
  ui.toolFinished({ toolCallId: "edit", name: "edit_file", state: "done" });
  ui.toolRequested({ toolCallId: "pending", name: "run_command", arguments: { argv: ["check-pending"] } });
  expect(screen()).toContain("Read 2 files");
  expect(screen()).toContain("Edit parser.ts");
  expect(screen()).toContain("check-pending");
  ui.toolWaiting("pending", true);
  expect(screen()).toContain("awaiting approval");
  ui.toolFinished({ toolCallId: "pending", name: "run_command", state: "denied", message: "USER_DENIED" });
  ui.toolRequested({ toolCallId: "unknown", name: "run_command", arguments: { argv: ["check-unknown"] } });
  ui.toolFinished({ toolCallId: "unknown", name: "run_command", state: "done", message: "No status" });
  expect(screen()).toContain("USER_DENIED");
  expect(screen()).toContain("exit unknown");
  key("t", { ctrl: true }); key("tab"); key("tab"); key("return");
  expect(screen()).toContain("Read parser.ts");
  const rows = screen().split("\n");
  const row = rows.findIndex((line) => line.includes("Read parser.ts"));
  state.handleMouse({ kind: "press", button: 0, row, col: rows[row]!.indexOf("Read") });
  expect(screen()).toContain("ORIGINAL_SOURCE");
  expect(view.memory.surface).toBe("response");
});

test("opening evidence near the viewport edge reveals the record beside its response", () => {
  const { ui, state, screen } = fixture("complete");
  void ui.readPrompt({ history: [], mentions: [], commands: [] });
  state.onKeypress("Keep this draft", {});
  const rows = screen(100, 36).split("\n");
  const row = rows.findIndex((line) => line.includes("1 file changed"));
  state.handleMouse({ kind: "press", button: 0, row, col: rows[row]!.indexOf("1 file changed") });
  const expanded = screen(100, 36);
  expect(expanded).toContain("▪ DIFF");
  expect(expanded).toContain("@@");
  expect(expanded).toMatch(/2\s+−\s+return \/\[a-zA-Z_\]\//);
  expect(expanded).not.toContain("Arguments ▸");
  expect(expanded).toContain("Unicode identifiers are accepted");
  expect(expanded).toContain("Keep this draft");
});

test("inline evidence navigates original records, prefers failures and retains its place during newer output", () => {
  const { ui, state, view, paint, key, screen } = fixture();
  ui.beginTurn({ userText: "Run the checks", at: "then" });
  for (const [id, exitCode] of [["pass", 0], ["fail", 2]] as const) {
    ui.toolRequested({ toolCallId: id, name: "run_command", arguments: { argv: ["bun", "test", `${id}.test.ts`] } });
    ui.toolFinished({ toolCallId: id, name: "run_command", state: "done", exitCode, message: `${id.toUpperCase()}_RECORDED_OUTPUT\n  ${"日本語".repeat(15)}` });
  }
  ui.beginRound(); ui.assistantDelta("One check failed."); ui.finishTurn("completed", "Complete");
  screen();
  const original = view.current!.id;
  view.act({ kind: "artifact", runId: original, target: "verification" });
  expect(screen(100, 36)).toContain("FAIL_RECORDED_OUTPUT");
  expect(screen(100, 36)).toContain("One check failed.");
  view.act({ kind: "artifact-step", step: -1 });
  expect(screen(100, 36)).toContain("PASS_RECORDED_OUTPUT");
  const rows = screen(100, 36).split("\n");
  const row = rows.findIndex((line) => line.includes("Arguments"));
  state.handleMouse({ kind: "press", button: 0, row, col: rows[row]!.indexOf("Arguments") });
  expect(screen(100, 36)).toContain('"argv"');
  const anchor = view.memory.anchor;
  ui.beginTurn({ userText: "Later request", at: "now" });
  ui.assistantDelta("Later response.");
  expect(screen(100, 36)).toContain("PASS_RECORDED_OUTPUT");
  expect(view.memory.anchor).toEqual(anchor);
  for (const theme of ["demesne", "demesne-light"]) {
    paint.setTheme(theme);
    for (const [width, height] of [[40, 10], [80, 24], [120, 36]]) {
      const frame = ui.frame(width!, height!);
      expect(frame.rows).toHaveLength(height!);
      for (const line of frame.rows) expect(visibleLength(line)).toBe(width!);
      for (const zone of state.mouseZones) {
        expect(zone.row).toBeLessThan(height!);
        expect(zone.column + zone.width).toBeLessThanOrEqual(width!);
      }
    }
  }
  key("escape");
  expect(screen(100, 36)).not.toContain("PASS_RECORDED_OUTPUT");
  expect(view.memory.surface).toBe("response");
  expect(screen(100, 36)).toContain("Later response.");
});

test("a reading anchor follows a running tool into a confirmed batch", () => {
  const { ui, state, view, screen } = fixture();
  ui.beginTurn({ userText: "Read the files", at: "now" });
  for (let index = 0; index < 25; index++) ui.toolRequested({ toolCallId: `read-${index}`, name: "read_file", arguments: { path: `file-${index}.ts` } });
  ui.toolFinished({ toolCallId: "read-0", name: "read_file", state: "done" });
  screen();
  const second = state.entries.find((entry: { toolCallId?: string }) => entry.toolCallId === "read-1");
  view.memory.followFlow = false;
  view.memory.anchor = { key: `entry:${second.id}`, line: 0 };
  const bodyRow = (view as any).regions.find((region: { target: string }) => region.target === "flow").row;
  expect(screen().split("\n")[bodyRow]).toContain("file-1.ts");
  ui.toolFinished({ toolCallId: "read-1", name: "read_file", state: "done" });
  expect(screen().split("\n")[bodyRow]).toContain("Read 2 files");
  expect(view.memory.followFlow).toBe(false);
});

test("dismissing utility output restores the conversation and leaves its record in the log", () => {
  const { ui, view, screen, key } = fixture("question");
  ui.showPanel(["CONTEXT_DETAIL_SENTINEL", "Budget details"]);
  expect(screen()).toContain("CONTEXT_DETAIL_SENTINEL");
  key("escape");
  expect(screen()).not.toContain("CONTEXT_DETAIL_SENTINEL");
  expect(screen()).toContain("identifier boundary");
  view.act({ kind: "log" });
  screen();
  key("down"); key("down"); key("down"); key("return");
  expect(screen()).toContain("CONTEXT_DETAIL_SENTINEL");
});

test("a completed command without recorded exit status stays unknown in the conversation", () => {
  const { ui, screen } = fixture();
  ui.beginTurn({ userText: "Check", at: "now" });
  ui.toolRequested({ toolCallId: "unknown", name: "run_command", arguments: { argv: ["bun", "test"] } });
  ui.toolFinished({ toolCallId: "unknown", name: "run_command", state: "done", message: "Exit status unavailable" });
  ui.finishTurn("completed", "Finished");
  const text = screen();
  expect(text).toContain("exit unknown");
  expect(text).toContain("Verification: unknown");
  expect(text).not.toContain("Verification: passed");
  expect(text).not.toContain("✓ bun test");
});

test("inline keyboard selection remains visible without color at forty columns", () => {
  const { ui, state, key, screen } = fixture("complete");
  state.options.paint = createPainter(false);
  void ui.readPrompt({ history: [], mentions: [], commands: [] });
  screen(40, 10);
  key("t", { ctrl: true });
  for (const label of ["copy", "1 file ▸", "✓ Verification passed"]) {
    key("tab");
    expect(screen(40, 10)).toContain(`›${label}`);
  }
});

test("inline command output preserves indentation and CJK at odd cell boundaries", () => {
  const { ui, key, screen } = fixture();
  const output = "  " + "日本語".repeat(18) + "END";
  ui.beginTurn({ userText: "Read output", at: "now" });
  ui.toolRequested({ toolCallId: "unicode", name: "run_command", arguments: { argv: ["check"] } });
  ui.toolFinished({ toolCallId: "unicode", name: "run_command", state: "done", exitCode: 0, message: output });
  ui.finishTurn("completed", "Done");
  screen(41, 36);
  key("t", { ctrl: true }); key("tab"); key("tab"); key("return");
  const rows = screen(41, 36).split("\n");
  const lines = rows.slice(rows.findIndex((line) => line.includes("日本語")), rows.findIndex((line) => line.includes("Arguments")));
  expect(lines.map((line) => line.slice(7, line.indexOf("│", 7)).trimEnd()).join("")).toBe(output);
  for (const row of ui.frame(41, 36).rows) expect(visibleLength(row)).toBe(41);
});

test("the log shortcut opens a real log and docked evidence scrolls independently at both boundaries", () => {
  const { ui, view, state, screen, key } = fixture();
  ui.beginTurn({ userText: "Run a detailed check", at: "now" });
  ui.toolRequested({ toolCallId: "check", name: "run_command", arguments: { argv: ["check"] } });
  ui.toolFinished({ toolCallId: "check", name: "run_command", state: "done", exitCode: 0,
    message: Array.from({ length: 70 }, (_, index) => `OUTPUT_${index}`).join("\n") });
  ui.beginRound(); ui.assistantDelta("CHECK_RESPONSE"); ui.finishTurn("completed", "Complete");
  const rows = screen(120, 36).split("\n");
  key("b", { ctrl: true });
  expect(screen(120, 36)).toContain("EXECUTION LOG");
  expect(view.panelOpen).toBe(true);
  const selection = view.memory.logSelection;
  key("c", { meta: true });
  expect(screen(80, 24)).toContain("▪ CONTEXT");
  key("down"); key("return");
  expect(view.memory.logSelection).toBe(selection);
  expect(view.memory.detail).toBeNull();
  expect((view as any).contextOffset).toBeGreaterThan(0);
  key("escape");
  expect(screen(120, 36)).toContain("EXECUTION LOG");
  key("escape");
  expect(view.panelOpen).toBe(false);
  view.act({ kind: "artifact", runId: view.current!.id, target: "verification" });
  expect(screen(120, 36)).toContain("OUTPUT_0");
  expect(screen(120, 36)).toContain("CHECK_RESPONSE");
  const region = (view as any).regions.find((region: { recordId?: number }) => region.recordId !== undefined);
  const flow = view.memory.flowOffset;
  expect(view.wheel(region.row, region.column, -1000)).toBe(false);
  expect(view.wheel(region.row, region.column, 1000)).toBe(true);
  expect(screen(120, 36)).toContain("OUTPUT_69");
  const settled = screen(120, 36);
  for (let count = 0; count < 20; count++) expect(view.wheel(region.row, region.column, 3)).toBe(false);
  expect(screen(120, 36)).toBe(settled);
  expect(view.memory.flowOffset).toBe(flow);
  expect(screen(80, 24)).toContain("VERIFICATION");
  expect(screen(80, 24)).not.toContain("CHECK_RESPONSE");
  expect(screen(120, 36)).toContain("CHECK_RESPONSE");
  const close = screen(120, 36).split("\n")[0]!;
  state.handleMouse({ kind: "press", button: 0, row: 0, col: close.lastIndexOf("×") });
  expect(view.panelOpen).toBe(false);
  expect(screen(120, 36)).toContain("CHECK_RESPONSE");
});

test("a queue returned after a stopped or failed turn is labelled until it is sent, cleared or emptied", async () => {
  const { ui, state, key, screen } = fixture("complete");
  const prompt = ui.readPrompt({ history: [], mentions: [], commands: [], draft: "Also add a digit test" });
  expect(state.editor.value).toBe("Also add a digit test");
  expect(screen()).toContain("Restored · not sent · the turn did not finish");
  expect(screen(50, 24)).toContain("Clear ×");

  // Clear empties the editor and ends the label.
  const rows = screen().split("\n");
  const row = rows.findIndex((line) => line.includes("Clear ×"));
  state.handleMouse({ kind: "press", button: 0, row, col: rows[row]!.indexOf("Clear ×") + 1 });
  expect(state.editor.value).toBe("");
  state.onKeypress("Something new", {});
  expect(screen()).not.toContain("Restored");
  key("return");
  expect(await prompt).toBe("Something new");
});

test("editing a restored draft away removes its label, and ordinary prompts never show it", async () => {
  const { ui, state, key, screen } = fixture("complete");
  const restored = ui.readPrompt({ history: [], mentions: [], commands: [], draft: "ab" });
  key("backspace");
  expect(screen()).toContain("Restored · not sent");
  key("backspace");
  state.onKeypress("new", {});
  expect(screen()).not.toContain("Restored");
  key("return");
  expect(await restored).toBe("new");

  const { ui: plain, state: plainState, screen: plainScreen } = fixture("complete");
  void plain.readPrompt({ history: [], mentions: [], commands: [] });
  plainState.onKeypress("typed by hand", {});
  expect(plainScreen()).not.toContain("Restored");
});
