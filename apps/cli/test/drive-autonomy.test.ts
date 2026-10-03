import { expect, test } from "bun:test";
import { DrivePlanningError, validateDriveDecisionContext, type DriveAction, type DriveDecision, type DriveObservation, type DriveRequest, type DriveResponse } from "@demesne/protocol";
import { AgentDrive } from "../src/agent-drive.ts";

const screen = (): DriveObservation => ({ id: crypto.randomUUID(), sessionId: "home", workspace: "/project", title: "Mission", mode: "input", ready: true, draft: "", surface: "log", width: 100, height: 30, rows: ["Check passed"], controls: [] });
const choose = (action: DriveAction, extra: Partial<DriveDecision> = {}): DriveResponse => ({ provider: "test", model: "test", imageInspected: false,
  decision: { action, note: "Review the task", notes: "Keep project constraints", completed: [], remaining: [], evidence: [], ...extra } });

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
