import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPainter, SLASH_COMMANDS, visibleLength } from "@demesne/brand";
import { parseDriveDecision, parseDriveRequest, type DriveAction, type DriveDecision, type DriveObservation, type DriveRequest, type DriveResponse } from "@demesne/protocol";
import { AgentDrive, DriveJournal } from "../src/agent-drive.ts";
import { Workbench, type WorkbenchOptions, type InputZone } from "../src/workbench/controller.ts";
import type { MouseEvent } from "../src/mouse.ts";
import { CliContextRail } from "../src/context-rail.ts";
import { renderDrivePanel } from "../src/workbench/drive-panel.ts";
import { drawDriveFeedback, driveTypingChunks } from "../src/workbench/drive-feedback.ts";
import type { SessionView } from "../src/workbench/session.ts";

const decision = (action: DriveAction, extra: Partial<DriveDecision> = {}): DriveDecision => ({ action, note: "Inspect the result", notes: "Recovered the goal", completed: [], remaining: ["Verify"], evidence: [], ...extra });
const response = (value: DriveDecision): DriveResponse => ({ decision: value, provider: "test", model: "test", imageInspected: false });
const observation = (): DriveObservation => ({ id: crypto.randomUUID(), sessionId: "home", workspace: "/project", title: "Mission", mode: "input", ready: true, draft: "", surface: "response", width: 100, height: 30, rows: ["Done", "test suite: 12 passed"], controls: [] });

test("Drive defers inference for running turns, approvals, loading and existing drafts", async () => {
  let current = observation(), calls = 0;
  const drive = new AgentDrive({ observe: () => current, perform: async () => "", decide: async () => { calls++; return response(decision({ kind: "wait" })); }, changed() {}, delayMs: 60_000 });
  try {
    drive.start("Finish the parser");
    for (const mode of ["streaming", "approval"] as const) { current = { ...current, mode }; await drive.step(); expect(drive.state?.status).toBe("waiting"); }
    current = { ...current, mode: "input", ready: false }; await drive.step();
    current = { ...current, ready: true, draft: "human draft" }; await drive.step();
    expect(calls).toBe(0); expect(drive.state?.status).toBe("blocked");
  } finally { drive.dispose(); }
});

test("Resume explains missing or completed missions instead of silently returning", async () => {
  const screen = { ...observation(), surface: "log" };
  const drive = new AgentDrive({ observe: () => screen, perform: async () => "", decide: async () => response(decision({ kind: "complete" }, {
    remaining: [], evidence: [{ observationId: screen.id, quote: "test suite: 12 passed" }],
  })), changed() {}, delayMs: 60_000, retryDelaysMs: [] });
  try {
    expect(() => drive.control("resume")).toThrow("No saved Drive mission");
    drive.start("Verify the result"); await drive.step();
    expect(() => drive.control("resume")).toThrow("mission is complete");
  } finally { drive.dispose(); }
});

test("pause aborts a pending decision and ignores a late action; resume observes afresh", async () => {
  const gate = Promise.withResolvers<DriveResponse>(); let calls = 0, actions = 0, signal: AbortSignal | undefined;
  const drive = new AgentDrive({ observe: observation, perform: async () => { actions++; return "sent"; }, decide: async (_, input) => { signal = input; return ++calls === 1 ? gate.promise : response(decision({ kind: "key", key: "alt+d" })); }, changed() {}, delayMs: 60_000 });
  try {
    drive.start("Finish"); const pending = drive.step(); drive.intervene();
    expect(signal?.aborted).toBe(true);
    gate.resolve(response(decision({ kind: "compose", text: "Never submit this stale instruction" })));
    await pending; expect(actions).toBe(0); expect(drive.state?.status).toBe("paused");
    drive.control("resume"); await drive.step(); expect(actions).toBe(1);
  } finally { drive.dispose(); }
});

test.each(["invented", "response-only", "own-notes", "remaining", "verified"])("completion evidence gate: %s", async (kind) => {
  const current = { ...observation(), surface: kind === "own-notes" ? "drive" : kind === "response-only" ? "response" : "log" };
  const drive = new AgentDrive({ observe: () => current, perform: async () => "", decide: async () => response(decision({ kind: "complete" }, {
    evidence: [{ observationId: current.id, quote: kind === "invented" ? "made up result" : "test suite: 12 passed" }], remaining: kind === "remaining" ? ["Still broken"] : [],
  })), changed() {}, delayMs: 60_000, retryDelaysMs: [] });
  try { drive.start("Finish"); await drive.step(); expect(drive.state?.status).toBe(kind === "verified" ? "completed" : "blocked"); }
  finally { drive.dispose(); }
});

test.each(["answer", "request", "thinking", "drive-notes", "implementation", "old-observation"])("advisory completion is grounded in a visible completed answer: %s", async (source) => {
  const screen = { ...observation(), surface: "drive", rows: ["Earlier audit recommends removing duplicate menu wiring."],
    evidenceRows: ["Earlier audit recommends removing duplicate menu wiring."], answerRows: source === "answer" || source === "implementation" || source === "old-observation" ? ["Earlier audit recommends removing duplicate menu wiring."] : [] };
  const drive = new AgentDrive({ observe: () => screen, perform: async () => "", decide: async () => response(decision({ kind: "complete", basis: source === "implementation" ? "verified-work" : "answer" }, {
    note: "The earlier audit recommends consolidating the menu paths. Inspect current consumers before deleting helpers.", remaining: [],
    evidence: [{ observationId: source === "old-observation" ? "old" : screen.id, quote: "removing duplicate menu wiring" }],
  })), changed() {}, delayMs: 60_000, retryDelaysMs: [] });
  try {
    drive.start(source === "implementation" ? "Implement menu cleanup" : "What can we improve?"); await drive.step();
    expect(drive.state?.status).toBe(source === "answer" ? "completed" : "blocked");
  } finally { drive.dispose(); }
});

test("a rejected completion is available to the planner on resume and after journal recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "drive-feedback-")), path = join(root, "mission.json");
  const screen = { ...observation(), surface: "response", answerRows: ["Done"] }; let calls = 0;
  const services = { path, observe: () => screen, changed() {}, perform: async () => "Opened log", delayMs: 60_000, retryDelaysMs: [],
    decide: async (request: DriveRequest) => {
      if (++calls > 1) {
        expect(request.memory.feedback).toContain("verified-work completion requires");
        expect(request.memory.feedback).toContain('"kind":"complete"');
        return response(decision({ kind: "key", key: "ctrl+b" }));
      }
      return response(decision({ kind: "complete" }, { remaining: [], evidence: [{ observationId: screen.id, quote: "Done" }] }));
    } };
  const drive = new AgentDrive(services);
  try {
    drive.start("Verify the implementation"); await drive.step(); expect(drive.state?.status).toBe("blocked");
    // An existing failed journal predating memory.feedback recovers the failed
    // trace's reason too; it must not resend only the stale successful notes.
    const old = JSON.parse(readFileSync(path, "utf8")); delete old.feedback;
    writeFileSync(path, JSON.stringify(old));
    const restored = new AgentDrive(services);
    try { restored.control("resume"); await restored.step(); expect(restored.state?.feedback).toBeUndefined(); expect(restored.state?.status).toBe("running"); }
    finally { restored.dispose(); }
  } finally { drive.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("journal restores paused, holds a single writer, and does not replay prepared submissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-drive-")); const path = join(root, "drive.json");
  let performs = 0;
  const services = { path, observe: observation, perform: async () => { performs++; return "sent"; }, decide: async () => response(decision({ kind: "compose", text: "Implement the recovered goal" })), changed() {}, delayMs: 60_000 };
  const drive = new AgentDrive(services);
  try {
    drive.start("Finish parser"); await drive.step();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => new DriveJournal(path).acquire()).toThrow("another workbench");
    const restored = new AgentDrive(services); expect(restored.state?.status).toBe("paused"); await restored.step();
    expect(performs).toBe(1); expect(restored.state?.steps[0]?.result).toBe("sent");
    expect(readFileSync(path, "utf8")).toContain("Recovered the goal");
    restored.dispose(); drive.control("pause"); restored.control("resume"); restored.dispose();
  } finally { drive.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test.each([true, false])("docked Drive accepts conversation evidence while excluding its own notes: %s", async (visibleResult) => {
  const screen = { ...observation(), surface: "drive", rows: ["test suite: 12 passed | Drive notes: all done"], evidenceRows: ["test suite: 12 passed"] };
  let actions = 0;
  const drive = new AgentDrive({ observe: () => screen, perform: async () => { actions++; return "opened Diff"; }, decide: async () => response(decision({ kind: "key", key: "alt+d" }, {
    evidence: [{ observationId: screen.id, quote: visibleResult ? "test suite: 12 passed" : "Drive notes: all done" }],
  })), changed() {}, delayMs: 60_000 });
  try { drive.start("Review"); await drive.step(); expect(actions).toBe(visibleResult ? 1 : 0); }
  finally { drive.dispose(); }
});

test("Drive cannot submit work or /plan into a history session, and detects no-progress loops", async () => {
  let current = observation(); let next = decision({ kind: "compose", text: "/plan change parser" }); let performed = 0;
  const drive = new AgentDrive({ observe: () => current, perform: async () => { performed++; return "no change"; }, decide: async () => response(next), changed() {}, delayMs: 60_000, retryDelaysMs: [] });
  try {
    drive.start("Finish"); current = { ...current, sessionId: "old" }; await drive.step();
    expect(drive.state?.status).toBe("blocked"); expect(performed).toBe(0);
    drive.control("resume"); next = decision({ kind: "key", key: "down" });
    for (let i = 0; i < 4; i++) await drive.step();
    expect(drive.state?.status).toBe("blocked"); expect(drive.state?.activity).toContain("repeated an action");
  } finally { drive.dispose(); }
});

function workbench(drive?: WorkbenchOptions["drive"]) {
  const ui = new Workbench({ paint: createPainter(false), contextRail: new CliContextRail({ id: "test", provider: "test" }, "/project"), sessionTitle: "Mission", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} }, drive });
  const internals = ui as unknown as { sessionId: string; onData(data: string): void; onKeypress(text: string, key: { name?: string; meta?: boolean }): void };
  internals.sessionId = "home";
  ui.frame(120, 36);
  return { ui, internals };
}

test.each([80, 120])("reading the Drive panel does not pause a mission; conversation input still does (%s columns)", async (width) => {
  let drive: AgentDrive;
  const { ui, internals } = workbench({ intervene: () => drive.intervene(), control: (control) => drive.control(control) });
  const mouse = ui as unknown as { handleMouse(event: MouseEvent): void; drivePanelBounds: { column: number; width: number; height: number }; mouseZones: InputZone[] };
  drive = new AgentDrive({ observe: () => ui.observeDrive(), changed: (state) => ui.setDrive(state), perform: (action, screen, signal) => ui.performDrive(action, screen, signal),
    decide: async () => response(decision({ kind: "wait" })), delayMs: 60_000 });
  try {
    ui.beginTurn({ userText: "Review", at: "now" }); ui.assistantDelta("Ready to review."); ui.finishTurn("completed", "Done");
    void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.frame(width, 30); drive.start("Review the recorded results");
    const prior = ui.observeDrive();
    internals.onKeypress("", { name: "j", meta: true }); ui.frame(width, 30);
    expect(drive.state?.status).toBe("running"); expect(ui.observeDrive().surface).toBe("drive");
    expect(await ui.performDrive({ kind: "key", key: "alt+d" }, prior, new AbortController().signal)).toContain("UI changed");
    internals.onKeypress("", { name: "pagedown" }); internals.onKeypress("", { name: "up" });
    const column = mouse.drivePanelBounds.column + 2;
    mouse.handleMouse({ kind: "wheel", button: 1, direction: "down", row: 6, col: column });
    mouse.handleMouse({ kind: "press", button: 0, row: 5, col: column });
    expect(drive.state?.status).toBe("running");
    ui.frame(width, 30);
    const close = mouse.mouseZones.find((zone) => zone.row === 0 && zone.identity === '{"kind":"panel-close"}')!;
    mouse.handleMouse({ kind: "press", button: 0, row: close.row, col: close.column! });
    expect(drive.state?.status).toBe("running"); expect(ui.observeDrive().surface).not.toBe("drive");
    internals.onKeypress("", { name: "j", meta: true }); ui.frame(width, 30);
    internals.onKeypress("", { name: "escape" });
    expect(drive.state?.status).toBe("running");
    internals.onKeypress("my instruction", {});
    expect(drive.state?.status).toBe("paused"); expect(drive.state?.activity).toContain("Resume"); expect(ui.observeDrive().draft).toBe("my instruction");
  } finally { drive.dispose(); }
});

test("pointer motion and horizontal trackpad noise leave a pending Drive action usable", async () => {
  let takeovers = 0;
  const { ui, internals } = workbench({ control() {}, intervene() { takeovers++; }, waitForFrame: async () => {} });
  ui.beginTurn({ userText: "Review", at: "now" }); ui.assistantDelta("Recorded result"); ui.finishTurn("completed", "Done");
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] });
  const screen = ui.observeDrive();
  for (const code of [35, 51, 66, 67]) {
    const bytes = `\x1b[<${code};10;5M`;
    for (let split = 1; split < bytes.length; split++) {
      internals.onData(bytes.slice(0, split)); internals.onData(bytes.slice(split));
    }
  }
  expect(takeovers).toBe(0);
  expect(await ui.performDrive({ kind: "key", key: "alt+h" }, screen, new AbortController().signal)).toContain("Surface: response → history.");
  expect(ui.observeDrive().surface).toBe("history");
});

test("scrolling while Drive plans keeps the mission running and re-observes before acting", async () => {
  let drive: AgentDrive, calls = 0;
  const gate = Promise.withResolvers<DriveResponse>();
  const { ui, internals } = workbench({ control: (control) => drive.control(control), intervene: () => drive.intervene(), waitForFrame: async () => {} });
  ui.beginTurn({ userText: "Review", at: "now" }); ui.assistantDelta("Recorded result\n".repeat(100)); ui.finishTurn("completed", "Done");
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] });
  drive = new AgentDrive({ observe: () => ui.observeDrive(), changed: (state) => ui.setDrive(state), perform: (action, screen, signal) => ui.performDrive(action, screen, signal),
    decide: async () => ++calls === 1 ? gate.promise : response(decision({ kind: "key", key: "alt+h" })), delayMs: 60_000 });
  try {
    drive.start("Review the recorded results"); const pending = drive.step();
    internals.onData("\x1b[<64;10;5M");
    expect(drive.state?.status).toBe("running");
    gate.resolve(response(decision({ kind: "key", key: "alt+h" }))); await pending;
    expect(drive.state?.steps.at(-1)?.result).toContain("UI changed since observation");
    expect(ui.observeDrive().surface).not.toBe("history");
    await drive.step();
    expect(drive.state?.status).toBe("running"); expect(calls).toBe(2);
    expect(ui.observeDrive().surface).toBe("history");
  } finally { drive.dispose(); }
});

test("scrolling during a highlighted Drive click defers it without pausing", async () => {
  const gate = Promise.withResolvers<void>(); let takeovers = 0;
  const { ui, internals } = workbench({ control() {}, intervene() { takeovers++; }, waitForFrame: async () => gate.promise });
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.showDrive();
  const screen = ui.observeDrive(), close = screen.controls.find((control) => control.label.includes("×"))!;
  const pending = ui.performDrive({ kind: "click", target: close.id }, screen, new AbortController().signal);
  internals.onData("\x1b[<65;10;5M"); gate.resolve();
  expect(await pending).toContain("UI changed before the click");
  expect(takeovers).toBe(0); expect(ui.observeDrive().surface).toBe("drive");
});

test("reading Drive's excluded notes does not invalidate its pending navigation", async () => {
  const { ui, internals } = workbench({ control() {}, intervene() {}, waitForFrame: async () => {} });
  ui.beginTurn({ userText: "Review", at: "now" }); ui.assistantDelta("Recorded result"); ui.finishTurn("completed", "Done");
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.showDrive(); ui.frame(140, 36);
  const screen = ui.observeDrive(), pane = screen.panes!.find((pane) => pane.surface === "drive")!;
  internals.onData(`\x1b[<64;${pane.column + 3};7M`);
  expect(await ui.performDrive({ kind: "key", key: "ctrl+b" }, screen, new AbortController().signal)).toContain("Surface: drive → log");
});

test("scrolling throughout visible composer entry still submits exactly once", async () => {
  let takeovers = 0, sent = 0;
  const { ui, internals } = workbench({ control() {}, intervene() { takeovers++; }, waitForFrame: async () => {
    internals.onData("\x1b[<64;10;5M\x1b[<35;11;5M");
  } });
  ui.beginTurn({ userText: "Review", at: "now" }); ui.assistantDelta("Recorded result\n".repeat(100)); ui.finishTurn("completed", "Done");
  const submitted = ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }).then((value) => { sent++; return value; });
  const instruction = "Review the parser changes and verify their tests.";
  expect(await ui.performDrive({ kind: "compose", text: instruction }, ui.observeDrive(), new AbortController().signal)).toContain("Sent through the visible composer");
  expect(await submitted).toBe(instruction); expect(sent).toBe(1); expect(takeovers).toBe(0);
  ui.beginTurn({ userText: instruction, at: "now" }); ui.reasoningDelta("NEW WORKER THINKING\n".repeat(100));
  const screen = ui.frame(120, 36).rows.join("\n");
  expect(screen).toContain("Recorded result"); expect(screen).not.toContain("NEW WORKER THINKING");
});

test.each(["drive", "log", "history"])("Drive hands %s inspection back to live worker Thinking when it submits work", async (surface) => {
  for (const width of [80, 140]) {
    const { ui } = workbench({ control() {}, intervene() {}, waitForFrame: async () => {} });
    const view = (ui as unknown as { sessionView: SessionView }).sessionView;
    for (let turn = 1; turn <= 2; turn++) {
      ui.beginTurn({ userText: `Old task ${turn}`, at: "now" }); ui.assistantDelta(`Old recorded result ${turn}\n`.repeat(50)); ui.finishTurn("completed", "Done");
    }
    const submitted = ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.frame(width, 36);
    if (surface === "drive") ui.showDrive();
    else {
      await ui.performDrive({ kind: "key", key: surface === "log" ? "ctrl+b" : "alt+h" }, ui.observeDrive(), new AbortController().signal);
      if (surface === "history") {
        await ui.performDrive({ kind: "key", key: "home" }, ui.observeDrive(), new AbortController().signal);
        await ui.performDrive({ kind: "key", key: "return" }, ui.observeDrive(), new AbortController().signal);
        expect(view.selectedId).not.toBeNull();
      }
    }
    const prompt = width === 80 ? "Implement the parser fix" : "/plan Implement the parser fix";
    await ui.performDrive({ kind: "compose", text: prompt }, ui.observeDrive(), new AbortController().signal);
    expect(await submitted).toBe(prompt);
    ui.beginTurn({ userText: "Implement the parser fix", at: "now" });
    ui.reasoningDelta(Array.from({ length: 100 }, (_, index) => `Worker thinking line ${index}`).join("\n"));
    expect(ui.frame(width, 36).rows.join("\n")).toContain("Worker thinking line 99");
    expect(view.paused).toBe(false); expect(view.panelOpen).toBe(false); expect(view.selectedId).toBeNull();
    ui.showDrive();
    ui.reasoningDelta("\nWorker thinking continues\n".repeat(50));
    const frame = ui.frame(width, 36).rows.join("\n");
    expect(view.paused).toBe(false);
    if (width >= 100) expect(frame).toContain("Worker thinking continues");
    view.act({ kind: "panel-close" });
    expect(ui.frame(width, 36).rows.join("\n")).toContain("Worker thinking continues");
  }
});

test("human scrollback before a fresh Drive observation stays held through the worker handoff", async () => {
  const { ui, internals } = workbench({ control() {}, intervene() {}, waitForFrame: async () => {} });
  ui.beginTurn({ userText: "Review", at: "now" }); ui.assistantDelta("Reading earlier result\n".repeat(100)); ui.finishTurn("completed", "Done");
  const submitted = ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.frame(140, 36);
  internals.onData("\x1b[<64;10;5M"); ui.frame(140, 36);
  await ui.performDrive({ kind: "compose", text: "Implement the next change" }, ui.observeDrive(), new AbortController().signal);
  await submitted;
  ui.beginTurn({ userText: "Implement the next change", at: "now" }); ui.reasoningDelta("NEW THINKING\n".repeat(100));
  expect(ui.frame(140, 36).rows.join("\n")).toContain("Reading earlier result");
  expect(ui.frame(140, 36).rows.join("\n")).not.toContain("NEW THINKING");
  const view = (ui as unknown as { sessionView: SessionView }).sessionView;
  view.act({ kind: "follow" });
  expect(ui.frame(140, 36).rows.join("\n")).toContain("NEW THINKING");
});

test("sessions-picker wheel navigation does not become a keyboard takeover", async () => {
  let takeovers = 0;
  const { ui, internals } = workbench({ control() {}, intervene() { takeovers++; }, waitForFrame: async () => {} });
  const selected = ui.choose("Recent sessions", ["First session", "Second session"]);
  const before = ui.observeDrive();
  internals.onData("\x1b[<65;10;5M");
  expect(takeovers).toBe(0);
  expect(await ui.performDrive({ kind: "key", key: "return" }, before, new AbortController().signal)).toContain("UI changed since observation");
  await ui.performDrive({ kind: "key", key: "return" }, ui.observeDrive(), new AbortController().signal);
  expect(await selected).toBe(1); expect(takeovers).toBe(0);
  internals.onKeypress("my input", {}); expect(takeovers).toBe(1);
});

test("real composer displays a Drive instruction, then submits once through Enter; user intervention preserves it", async () => {
  const { ui, internals } = workbench();
  let sent: string | undefined;
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }).then((value) => { sent = value; });
  const before = ui.observeDrive();
  const pending = ui.performDrive({ kind: "compose", text: "/sessions parser" }, before, new AbortController().signal);
  expect(ui.frame(120, 36).rows.join("\n")).toContain("DRIVE · Typing in composer"); expect(sent).toBeUndefined();
  expect(ui.frame(120, 36).rows.join("\n")).toContain("/ses");
  await pending; expect(sent).toBe("/sessions parser");
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }).then((value) => { sent = value; });
  const again = ui.performDrive({ kind: "compose", text: "Fix parser" }, ui.observeDrive(), new AbortController().signal);
  internals.onKeypress(" carefully", {}); await again;
  expect(sent).toBe("/sessions parser"); expect(ui.observeDrive().draft).toBe("Fix  carefully");
});

test("Drive shows a real click target before dispatch and cancels the click immediately on takeover", async () => {
  const gate = Promise.withResolvers<void>();
  const { ui, internals } = workbench({ control() {}, intervene() {}, waitForFrame: async () => gate.promise });
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.showDrive();
  const screen = ui.observeDrive(); const close = screen.controls.find((control) => control.label.includes("×"))!;
  const pending = ui.performDrive({ kind: "click", target: close.id }, screen, new AbortController().signal);
  expect(ui.frame(120, 36).rows.join("\n")).toContain("DRIVE · Click");
  expect(ui.frame(120, 36).rows.join("\n")).toContain("AGENT DRIVE");
  internals.onKeypress("my draft", {}); gate.resolve();
  expect(await pending).toContain("UI changed before the click");
  expect(ui.observeDrive().surface).toBe("drive"); expect(ui.observeDrive().draft).toBe("my draft");
});

test("paced composer entry shows intermediate text and Enter before submitting, without splitting graphemes", async () => {
  const text = "Review 👩‍💻 Unicode identifiers and run the tests.";
  expect(driveTypingChunks(text).join("")).toBe(text);
  expect(driveTypingChunks(text).some((chunk) => chunk.includes("👩‍💻"))).toBe(true);
  expect(driveTypingChunks("x".repeat(16_000)).length).toBeLessThanOrEqual(30);
  const frames: string[] = [];
  const { ui } = workbench({ control() {}, intervene() {}, waitForFrame: async () => { frames.push(ui.frame(120, 36).rows.join("\n")); } });
  let sent: string | undefined;
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }).then((value) => { sent = value; });
  await ui.performDrive({ kind: "compose", text }, ui.observeDrive(), new AbortController().signal);
  expect(frames.length).toBeGreaterThan(3);
  expect(frames[0]).toContain("DRIVE · Typing"); expect(frames[0]).not.toContain("run the tests.");
  expect(frames.at(-1)).toContain("DRIVE · Sending · Enter"); expect(frames.at(-1)).toContain("run the tests.");
  expect(sent).toBe(text); expect(ui.frame(120, 36).rows.join("\n")).toContain("DRIVE · Sent through composer");
  expect(ui.observeDrive().rows.join("\n")).not.toContain("DRIVE · Sent through composer");
});

test("action cursor and label fit narrow screens and remain visible without color", () => {
  for (const width of [40, 80, 140]) {
    const rows = Array.from({ length: 10 }, (_, index) => index === 4 ? "  History".padEnd(width) : " ".repeat(width));
    const frame = drawDriveFeedback(rows, width, width, createPainter(false), { label: "Click · History", target: { row: 4, column: 2, width: 7 } });
    expect(frame[0]).toContain("DRIVE · Click"); expect(frame[4]).toContain("▷ History");
    expect(frame.every((row) => visibleLength(row) <= width)).toBe(true);
  }
});

test("pausing midway through visible typing preserves the partial draft and never presses Enter", async () => {
  const gate = Promise.withResolvers<void>(); const controller = new AbortController();
  const { ui } = workbench({ control() {}, intervene() {}, waitForFrame: async () => gate.promise });
  let submitted = false;
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }).then(() => { submitted = true; });
  const pending = ui.performDrive({ kind: "compose", text: "Do not send this after pausing" }, ui.observeDrive(), controller.signal);
  expect(ui.frame(120, 36).rows.join("\n")).toContain("Typing in composer");
  controller.abort(new DOMException("Paused", "AbortError")); gate.resolve();
  await expect(pending).rejects.toThrow("Paused");
  expect(submitted).toBe(false); expect(ui.observeDrive().draft).toBe("Do n");
  expect(ui.frame(120, 36).rows.join("\n")).not.toContain("Typing in composer");
});

test("UI actions use visible controls, reject stale observations and cannot interact with approvals", async () => {
  const { ui, internals } = workbench();
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] });
  ui.showDrive();
  const observed = ui.observeDrive();
  expect(observed.rows.join("\n")).toContain("AGENT DRIVE");
  const close = observed.controls.find((item) => item.label.includes("×")); expect(close).toBeDefined();
  await ui.performDrive({ kind: "click", target: close!.id }, observed, new AbortController().signal);
  expect(ui.observeDrive().surface).not.toBe("drive");
  const stale = ui.observeDrive(); internals.onKeypress("user text", {});
  expect(await ui.performDrive({ kind: "key", key: "alt+d" }, stale, new AbortController().signal)).toContain("UI changed");
  let approved = false;
  void ui.askApproval({ summary: "Write parser", allowPersist: false }).then(() => { approved = true; });
  const approval = ui.observeDrive(); expect(approval.controls).toHaveLength(0);
  await ui.performDrive({ kind: "key", key: "return" }, approval, new AbortController().signal);
  expect(approved).toBe(false);
});

test.each([80, 140])("Drive reports the actual log pane after Ctrl+B from composer focus (%s columns)", async (width) => {
  const { ui } = workbench({ control() {}, intervene() {}, waitForFrame: async () => {} });
  ui.beginTurn({ userText: "Verify the audit", at: "now" });
  ui.toolRequested({ toolCallId: "check", name: "run_command", arguments: { argv: ["bun", "test"] } });
  ui.toolFinished({ toolCallId: "check", name: "run_command", state: "done", exitCode: 0, message: "999 pass / 0 fail" });
  ui.assistantDelta("Audit complete."); ui.finishTurn("completed", "Done");
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.frame(width, 36);
  const before = ui.observeDrive(); expect(before.focus).toBe("composer");
  const receipt = await ui.performDrive({ kind: "key", key: "ctrl+b" }, before, new AbortController().signal);
  expect(receipt).toContain("Surface: response → log. Focus: content.");
  const screen = ui.observeDrive(), pane = screen.panes!.find((pane) => pane.surface === "log")!;
  expect(pane).toBeDefined(); expect(screen.surface).toBe("log");
  expect(screen.rows.slice(pane.row, pane.row + pane.height).map((row) => row.slice(pane.column, pane.column + pane.width)).join("\n")).toContain("EXECUTION LOG");
  expect(parseDriveRequest({ mission: "Review", homeSessionId: "home", observation: screen, memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] } }).observation.panes).toEqual(screen.panes);
});

test("Drive reports a scroll outside the content rather than claiming progress", async () => {
  const { ui } = workbench({ control() {}, intervene() {}, waitForFrame: async () => {} });
  ui.beginTurn({ userText: "Review", at: "now" }); ui.assistantDelta("Done"); ui.finishTurn("completed", "Done");
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] });
  const screen = ui.observeDrive();
  expect(await ui.performDrive({ kind: "scroll", row: screen.height - 1, column: 1, amount: -12 }, screen, new AbortController().signal)).toContain("Scroll did not move the target");
});

test("Drive's scroll beside its own panel moves the observed report and survives subsequent paints", async () => {
  const { ui } = workbench({ control() {}, intervene() {}, waitForFrame: async () => {} });
  ui.beginTurn({ userText: "What can improve? USER REQUEST ONLY", at: "now" });
  ui.reasoningDelta("PRIVATE WORKER THINKING");
  ui.assistantDelta(Array.from({ length: 80 }, (_, index) => `Audit finding ${String(index).padStart(3, "0")}: recorded recommendation.\n\n`).join(""));
  ui.finishTurn("completed", "Done");
  ui.beginTurn({ userText: "Interrupted follow-up", at: "now" }); ui.reasoningDelta("PARTIAL THINKING ONLY"); ui.finishTurn("stopped", "Stopped");
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.frame(255, 63); ui.showDrive();
  let before = ui.observeDrive();
  expect(before.answerRows!.length).toBeGreaterThan(0);
  expect(before.answerRows!.join("\n")).not.toMatch(/USER REQUEST ONLY|PRIVATE WORKER THINKING|PARTIAL THINKING ONLY|AGENT DRIVE/);
  const first = (screen: DriveObservation) => Number(screen.answerRows?.join("\n").match(/Audit finding (\d+)/)?.[1]);
  for (const amount of [-8, -6]) {
    const result = await ui.performDrive({ kind: "scroll", row: 25, column: 100, amount }, before, new AbortController().signal);
    expect(result).toContain(`Scrolled ${amount} rows`);
    const after = ui.observeDrive();
    expect(first(after)).toBeLessThan(first(before));
    const repainted = ui.observeDrive();
    expect(repainted.answerRows).toEqual(after.answerRows);
    before = repainted;
  }
  ui.frame(80, 30); // Drive overlays the conversation on a narrow terminal.
  expect(ui.observeDrive().answerRows).toEqual([]);
  expect(ui.observeDrive().latestAnswerRows).toEqual([]);
});

test.each([80, 140])("Drive Diff scroll bounds and direction match visible hunks and survive file navigation (%s columns)", async (width) => {
  const { ui } = workbench({ control() {}, intervene() {}, waitForFrame: async () => {} });
  ui.beginTurn({ userText: "Implement", at: "now" });
  for (const path of ["first.ts", "second.ts"]) {
    const content = Array.from({ length: 90 }, (_, index) => `export const line${index} = ${index};`).join("\n");
    ui.toolRequested({ toolCallId: path, name: "write_file", arguments: { path, content } });
    ui.toolFinished({ toolCallId: path, name: "write_file", state: "done", changes: [{ path, before: null, after: content, beforeExists: false, afterExists: true }] });
  }
  ui.finishTurn("completed", "Done"); void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.frame(width, 36);
  const key = async (key: "alt+d" | "left" | "right") => ui.performDrive({ kind: "key", key }, ui.observeDrive(), new AbortController().signal);
  await key("alt+d");
  const before = ui.observeDrive(), region = before.scrollRegions!.find((region) => region.surface === "diff-code")!;
  expect(region).toBeDefined(); expect(region.maximum).toBeGreaterThan(20); expect(region.offset).toBe(0);
  expect(parseDriveRequest({ mission: "Review", homeSessionId: "home", observation: before, memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] } }).observation.scrollRegions).toEqual(before.scrollRegions);
  const action: DriveAction = { kind: "scroll", row: region.row + 1, column: region.column + 1, amount: 12 };
  expect(await ui.performDrive(action, before, new AbortController().signal)).toContain("diff-code offset 12/");
  expect(ui.observeDrive().scrollRegions!.find((region) => region.surface === "diff-code")!.offset).toBe(12);
  await key("left"); await key("right");
  expect(ui.observeDrive().scrollRegions!.find((region) => region.surface === "diff-code")!.offset).toBe(12);
  const up = { ...action, amount: -12 };
  await ui.performDrive(up, ui.observeDrive(), new AbortController().signal);
  expect(await ui.performDrive(up, ui.observeDrive(), new AbortController().signal)).toContain("Scroll did not move");
});

test("Drive can jump directly to a long recorded tool result's tail and back to its head", async () => {
  const { ui } = workbench({ control() {}, intervene() {}, waitForFrame: async () => {} });
  ui.beginTurn({ userText: "Verify the audit", at: "now" });
  ui.toolRequested({ toolCallId: "check", name: "run_command", arguments: { argv: ["bun", "test"] } });
  ui.toolFinished({ toolCallId: "check", name: "run_command", state: "done", exitCode: 0,
    message: `TEST OUTPUT START\n${"(pass) recorded check\n".repeat(3000)}999 pass\n0 fail\nRan 999 tests across 114 files.` });
  ui.finishTurn("completed", "Done"); void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.frame(140, 36);
  await ui.performDrive({ kind: "key", key: "ctrl+b" }, ui.observeDrive(), new AbortController().signal);
  const log = ui.observeDrive(), tool = log.controls.find((control) => /\+[\d.]+s ✓ Check +bun test/.test(control.label))!;
  await ui.performDrive({ kind: "click", target: tool.id }, log, new AbortController().signal);
  expect(ui.observeDrive().rows.join("\n")).not.toContain("999 pass");
  await ui.performDrive({ kind: "key", key: "end" }, ui.observeDrive(), new AbortController().signal);
  const tail = ui.observeDrive().rows.join("\n"); expect(tail).toContain("999 pass"); expect(tail).toContain("0 fail");
  await ui.performDrive({ kind: "key", key: "home" }, ui.observeDrive(), new AbortController().signal);
  expect(ui.observeDrive().rows.join("\n")).toContain("TEST OUTPUT START");
});

test("Drive validation names the failing decision or request field", () => {
  expect(() => parseDriveDecision(decision({ kind: "key" } as DriveAction))).toThrow("action.key");
  expect(() => parseDriveDecision(decision({ kind: "wait" }, { notes: "x".repeat(8001) }))).toThrow("notes");
  expect(() => parseDriveRequest({ mission: "Review", homeSessionId: "home", observation: observation(),
    memory: { notes: "", completed: [], remaining: ["x".repeat(1001)], evidence: [], steps: [] } })).toThrow("memory.remaining[0]");
});

test("Drive panel fits compact terminals, scrolls notes and retains fixed controls", () => {
  const drive = new AgentDrive({ observe: observation, perform: async () => "", decide: async () => response(decision({ kind: "wait" })), changed() {}, delayMs: 60_000 });
  try {
    drive.start("Implement and verify a long mission ".repeat(30));
    for (const width of [20, 34, 60, 100]) for (const height of [5, 12, 30]) {
      const panel = renderDrivePanel(width, height, createPainter(false), drive.state, 20);
      expect(panel.rows).toHaveLength(height); expect(panel.rows.every((row) => visibleLength(row) <= width)).toBe(true);
      expect(panel.rows[2]).toContain("Pause"); expect(panel.rows[2]).toContain("Stop");
    }
  } finally { drive.dispose(); }
});

test("protocol rejects arbitrary commands, keys, invalid payload sizes and coordinates", () => {
  for (const text of ["/exit", "/undo", "/model other", "/custom-task"]) expect(() => parseDriveDecision(decision({ kind: "compose", text }))).toThrow();
  expect(() => parseDriveDecision(decision({ kind: "key", key: "ctrl+c" as never }))).toThrow();
  expect(() => parseDriveDecision(decision({ kind: "scroll", row: -1, column: 0, amount: 1 }))).toThrow();
  expect(() => parseDriveRequest({ mission: "a".repeat(8001), homeSessionId: "home", observation: observation(), memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] } })).toThrow();
});
