import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPainter, SLASH_COMMANDS } from "@demesne/brand";
import { DrivePlanningError, parseDriveRequest, validateDriveDecisionContext, type DriveAction, type DriveDecision, type DriveObservation, type DriveRequest, type DriveResponse } from "@demesne/protocol";
import { AgentDrive } from "../src/agent-drive.ts";
import { Workbench } from "../src/workbench/controller.ts";
import { CliContextRail } from "../src/context-rail.ts";

const screen = (): DriveObservation => ({ id: crypto.randomUUID(), sessionId: "home", workspace: "/project", title: "Mission", mode: "input", ready: true, draft: "", surface: "log", width: 100, height: 30, rows: ["Check passed"], controls: [] });
const choose = (action: DriveAction, extra: Partial<DriveDecision> = {}): DriveResponse => ({ provider: "test", model: "test", imageInspected: false,
  decision: { action, note: "Review the task", notes: "Keep project constraints", completed: [], remaining: [], evidence: [], ...extra } });

test("continuous Drive reviews two tasks, consults through the real composer, and persists its next-work phase", async () => {
  const root = mkdtempSync(join(tmpdir(), "drive-continuous-")), path = join(root, "drive.json");
  const ui = new Workbench({ paint: createPainter(false), contextRail: new CliContextRail({ id: "test", provider: "test" }, "/project"), sessionTitle: "Mission", version: "test",
    onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} }, drive: { control() {}, intervene() {}, waitForFrame: async () => {} } });
  (ui as unknown as { sessionId: string }).sessionId = "home";
  const checked = (task: string) => {
    ui.beginTurn({ userText: task, at: "now" });
    ui.toolRequested({ toolCallId: task, name: "run_command", arguments: { argv: ["bun", "test"] } });
    ui.toolFinished({ toolCallId: task, name: "run_command", state: "done", exitCode: 0, message: "Check passed" });
    ui.assistantDelta("Implementation finished."); ui.finishTurn("completed", "Done");
  };
  let next: (request: DriveRequest) => DriveResponse = () => choose({ kind: "key", key: "ctrl+b" });
  const services = { path, continuous: true, delayMs: 60_000, observe: () => ui.observeDrive(), changed: (state: AgentDrive["state"]) => ui.setDrive(state),
    perform: (action: DriveAction, observation: DriveObservation, signal: AbortSignal) => ui.performDrive(action, observation, signal),
    decide: async (request: DriveRequest) => next(parseDriveRequest(request)) };
  const drive = new AgentDrive(services);
  let restored: AgentDrive | undefined;
  try {
    checked("Fix parser"); void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.frame(140, 40);
    drive.start("Fix parser and improve reliability. No commits."); await drive.step();
    const complete = (request: DriveRequest) => choose({ kind: "complete" }, { completed: ["Reviewed passing check"], evidence: [{ observationId: request.observation.id, quote: "bun test" }] });
    next = complete; await drive.step();
    expect(drive.active).toBe(true); expect(drive.state?.autonomy?.phase).toBe("discovering");
    expect(drive.state?.autonomy?.history).toHaveLength(1);
    const consultation = "Based on the parser fix and reliability goal, what concrete improvement should we tackle next and how would we check it? Assess only; no edits or commits.";
    // Re-arm the prompt so the actual UI route's submitted text can be inspected.
    const outgoing = ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] });
    next = () => choose({ kind: "compose", text: consultation }); await drive.step();
    expect(await outgoing).toBe(consultation); expect(drive.state?.autonomy?.consulted).toBe(true);
    ui.beginTurn({ userText: consultation, at: "now" }); ui.assistantDelta("Handle empty parser input; add an empty-input regression check."); ui.finishTurn("completed", "Done");
    void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] });
    drive.control("pause"); restored = new AgentDrive(services);
    expect(restored.state?.status).toBe("paused"); expect(restored.state?.autonomy).toEqual(drive.state?.autonomy);
    restored.control("resume");
    next = (request) => choose({ kind: "next_task", task: "Handle empty parser input and verify the regression" }, {
      evidence: [{ observationId: request.observation.id, quote: "Handle empty parser input" }],
    });
    await restored.step();
    expect(restored.state?.autonomy).toMatchObject({ phase: "working", cycle: 2, consulted: false });
    expect(restored.state?.mission).toContain("No commits");
    const second = ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] });
    const instruction = "Handle empty parser input and add the regression check, then run it. No commits.";
    next = () => choose({ kind: "compose", text: instruction }); await restored.step(); expect(await second).toBe(instruction);
    checked(instruction); void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] });
    next = () => choose({ kind: "key", key: "ctrl+b" }); await restored.step(); next = complete; await restored.step();
    expect(restored.state?.autonomy?.history).toHaveLength(2); expect(restored.active).toBe(true);
    const finalQuestion = ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] });
    next = () => choose({ kind: "compose", text: "Assess whether any useful reliability work remains; do not edit." });
    await restored.step(); await finalQuestion;
    ui.beginTurn({ userText: "Assess remaining work", at: "now" }); ui.assistantDelta("No worthwhile reliability work remains in this scope."); ui.finishTurn("completed", "Done");
    void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] });
    next = (request) => choose({ kind: "idle" }, { note: "Both fixes reviewed; no worthwhile work remains in scope.", evidence: [{ observationId: request.observation.id, quote: "No worthwhile reliability work remains" }] });
    await restored.step(); expect(restored.state?.status).toBe("idle");
    restored.control("resume"); expect(restored.state?.autonomy?.consulted).toBe(false); expect(restored.active).toBe(true);
  } finally { restored?.dispose(); drive.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("next-task selection requires a consultation and its latest completed answer, not old or unfinished output", () => {
  const observation = { ...screen(), answerRows: ["Fix empty input"], latestAnswerRows: ["Fix empty input"], rows: ["Fix empty input"] };
  const request: DriveRequest = { mission: "Improve parser", homeSessionId: "home", observation, memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] },
    autonomy: { phase: "discovering", task: "Previous fix", cycle: 1, consulted: true, history: [] } };
  const decision = choose({ kind: "next_task", task: "Fix empty input" }, { evidence: [{ observationId: observation.id, quote: "Fix empty input" }] }).decision;
  expect(() => validateDriveDecisionContext(decision, request)).not.toThrow();
  expect(() => validateDriveDecisionContext(decision, { ...request, autonomy: { ...request.autonomy!, consulted: false } })).toThrow("compose a focused question");
  expect(() => validateDriveDecisionContext(decision, { ...request, observation: { ...observation, latestAnswerRows: [] } })).toThrow("latestAnswerRows");
  expect(() => validateDriveDecisionContext(decision, { ...request, observation: { ...observation, mode: "streaming" } })).toThrow();
  expect(() => validateDriveDecisionContext(decision, { ...request, autonomy: { ...request.autonomy!, history: [{ task: "Fix empty input", summary: "Already done", at: "now" }] } })).toThrow("already finished");
  expect(() => validateDriveDecisionContext(choose({ kind: "complete", basis: "answer" }).decision, request)).toThrow("previous task is already finished");
});

test.each(["socket", "validation"])("Drive recovers %s planning failures from a fresh observation and performs only the validated action", async (kind) => {
  const requests: DriveRequest[] = []; let actions = 0;
  const drive = new AgentDrive({ observe: screen, changed() {}, delayMs: 60_000, retryDelaysMs: [0, 0, 0], perform: async () => { actions++; return "Opened log"; },
    decide: async (request, _signal, progress) => {
      requests.push(request);
      if (requests.length === 1) {
        progress({ type: "reasoning.delta", delta: "Partial thought before failure" });
        throw kind === "socket" ? new Error("The socket connection was closed unexpectedly.") : new DrivePlanningError("action.key missing", "decision");
      }
      return choose({ kind: "key", key: "ctrl+b" });
    } });
  try {
    drive.start("Review"); await drive.step();
    expect(drive.state?.status).toBe("waiting"); expect(actions).toBe(0); expect(drive.state?.recovery?.attempt).toBe(1);
    expect(drive.state?.traces?.[0]?.reasoning).toContain("Partial thought"); expect(drive.state?.traces?.[0]?.status).toBe("failed");
    await drive.step(); expect(actions).toBe(1); expect(drive.state?.status).toBe("running");
    expect(requests[1]?.observation.id).not.toBe(requests[0]?.observation.id);
    expect(requests[1]?.memory.feedback).toContain("No new UI action was executed"); expect(drive.state?.feedback).toBeUndefined();
  } finally { drive.dispose(); }
});

test("planning retries are bounded and pausing during backoff cancels recovery", async () => {
  let calls = 0;
  const drive = new AgentDrive({ observe: screen, changed() {}, delayMs: 60_000, retryDelaysMs: [0, 0], perform: async () => { throw new Error("must not act"); },
    decide: async () => { calls++; throw new Error("fetch failed"); } });
  try {
    drive.start("Review"); await drive.step(); drive.control("pause"); await drive.step(); expect(calls).toBe(1);
    drive.control("resume"); await drive.step(); await drive.step(); await drive.step();
    expect(calls).toBe(4); expect(drive.state?.status).toBe("blocked"); expect(drive.state?.activity).toBe("fetch failed");
  } finally { drive.dispose(); }
});

test("an ambiguous failure after UI execution starts is never automatically retried", async () => {
  let calls = 0, actions = 0;
  const drive = new AgentDrive({ observe: screen, changed() {}, delayMs: 60_000, retryDelaysMs: [0],
    decide: async () => { calls++; return choose({ kind: "compose", text: "Implement the fix" }); },
    perform: async () => { actions++; throw new Error("socket connection closed after sending"); } });
  try {
    drive.start("Implement"); await drive.step(); await drive.step();
    expect(drive.state?.status).toBe("blocked"); expect(calls).toBe(1); expect(actions).toBe(1);
  } finally { drive.dispose(); }
});
