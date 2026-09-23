import { expect, test } from "bun:test";
import type { EventEnvelope, SessionStateResponse } from "@demesne/protocol";
import { replaySession, restoreSessionEntries } from "../src/workbench/history.ts";
import { planRuns } from "../src/workbench/session.ts";
import { toolCompletion } from "../src/workbench/tool-result.ts";
import { projectRunEvidence } from "../src/workbench/evidence.ts";

const at = "2026-09-21T12:00:00Z";
const state: SessionStateResponse = {
  session: { id: "session", title: "Saved session", createdAt: at, updatedAt: at, workspace: null,
    turns: [{ id: "turn", sessionId: "session", content: "Fix lexer", responseText: "Done", status: "completed", createdAt: at, completedAt: at, permissionMode: "ask", thinkingEnabled: false }] },
  lastEventId: 7, pendingPermissions: [], latestProviderCall: null,
};
function event(eventId: number, type: EventEnvelope["type"], payload: Record<string, unknown> = {}): EventEnvelope {
  return { schemaVersion: 1, eventId, type, payload, sessionId: "session", turnId: "turn", workspaceId: null, agentRunId: null, occurredAt: at };
}
const events = [event(1, "model.request_started", { model: "saved-model" }), event(2, "message.delta", { delta: "Checking the lexer." }),
  event(3, "tool.call_requested", { toolCallId: "check", name: "run_command", arguments: JSON.stringify({ argv: ["bun", "test"] }) }),
  event(4, "tool.call_completed", { toolCallId: "check", name: "run_command", exitCode: 0, stdout: "42 passed" }),
  event(5, "model.request_started"), event(6, "message.delta", { delta: "Done" }), event(7, "turn.completed")];

test("session replay restores ordered runs, original model and command evidence", () => {
  const restored = restoreSessionEntries(state, [...events].reverse().concat(events[3]!, event(8, "message.delta", { delta: "future" })));
  const run = planRuns(restored)[0]!;
  expect(run.request?.model).toBe("saved-model");
  expect(run.answer?.raw).toBe("Done");
  expect(run.answer?.at).toBe(at);
  expect(run.status).toBe("COMPLETE");
  expect(run.tools).toHaveLength(1);
  expect(run.tools[0]).toMatchObject({ state: "done", exitCode: 0, message: "42 passed", detail: "$ bun test" });
});

test("replay retains each response's first nonempty event time and uses recorded fallback times only", () => {
  const first = "2026-09-21T12:00:03.000Z";
  const second = "2026-09-21T12:00:10.000Z";
  const recorded = events.map((entry) => ({ ...entry, occurredAt: entry.eventId === 2 ? first : entry.eventId === 6 ? second : at }));
  const restored = restoreSessionEntries(state, [event(0, "message.delta", { delta: "" }), ...recorded]);
  expect(restored.filter((entry) => entry.type === "assistant").map((entry) => entry.at)).toEqual([first, second]);
  expect(planRuns(restoreSessionEntries(state, []))[0]?.answer?.at).toBe(at);
  const old = { ...state, session: { ...state.session, turns: [{ ...state.session.turns[0]!, completedAt: null }] } };
  expect(planRuns(restoreSessionEntries(old, []))[0]?.answer?.at).toBeUndefined();
});

test("failed replay does not turn pre-tool progress into a final answer", () => {
  const failed: SessionStateResponse = { ...state, session: { ...state.session, turns: [{ ...state.session.turns[0]!, status: "failed" }] } };
  const run = planRuns(restoreSessionEntries(failed, events.slice(0, 4)))[0]!;
  expect(run.answer).toBeUndefined();
  expect(run.status).toBe("FAILED");
  expect(run.entries.find((entry) => entry.type === "assistant")?.receipt).toBeUndefined();
});

test("failed and stopped replay retain terminal receipts even when no final answer exists", () => {
  for (const status of ["failed", "interrupted"] as const) {
    const snapshot = { ...state, lastEventId: 7, session: { ...state.session, turns: [{ ...state.session.turns[0]!, status,
      completedAt: "2026-09-21T12:01:34.200Z", planOnly: true, responseText: "" }] } };
    const recorded = [
      event(1, "model.request_started", { model: "original-model", contextPlan: { estimatedInputTokens: 63900, capacityTokens: 100000 } }),
      event(2, "model.usage", { providerCallId: "call", outputTokens: 194 }),
      event(3, "model.metrics", { providerCallId: "call", durationMs: 12000, timeToFirstTokenMs: 2000 }),
      event(4, "tool.call_requested", { name: "read_file", toolCallId: "read", arguments: { path: "src/main.ts" } }),
      event(5, status === "failed" ? "tool.call_failed" : "tool.call_interrupted", { toolCallId: "read", message: "No result" }),
      event(6, status === "failed" ? "turn.failed" : "turn.interrupted", { message: "Run ended" }),
    ];
    const run = planRuns(restoreSessionEntries(snapshot, recorded))[0]!;
    expect(run.answer).toBeUndefined();
    expect(run.receipt).toEqual({ mode: "Plan", model: "original-model", durationMs: 94200, tokensPerSecond: 19.4,
      context: { used: 63900, capacity: 100000, estimated: true } });
    expect(run.status).toBe(status === "failed" ? "FAILED" : "STOPPED");
  }
});

test("replay binds response receipts to their original turns and aggregates recorded provider rounds", () => {
  const first = { ...state.session.turns[0]!, completedAt: "2026-09-21T12:00:31.100Z" };
  const second = { ...first, id: "next", content: "Plan the next step", planOnly: true,
    createdAt: "2026-09-21T12:01:00.000Z", completedAt: "2026-09-21T12:02:02.000Z" };
  const snapshot = { ...state, lastEventId: 13, session: { ...state.session, turns: [second, first] } };
  const recorded = [
    event(1, "model.request_started", { model: "first-model" }),
    event(2, "model.usage", { providerCallId: "a", outputTokens: 200 }),
    event(3, "model.metrics", { providerCallId: "a", durationMs: 12_000, timeToFirstTokenMs: 2_000 }),
    event(4, "model.request_started", { model: "first-model", contextPlan: { estimatedInputTokens: 2900, capacityTokens: 100000 } }),
    event(5, "model.usage", { providerCallId: "b", outputTokens: 100 }),
    event(6, "model.metrics", { providerCallId: "b", durationMs: 20_000, timeToFirstTokenMs: 10_000 }),
    event(7, "message.delta", { delta: "First answer" }), event(8, "turn.completed"),
    ...[
      event(9, "model.request_started", { model: "second-model" }),
      event(10, "model.metrics", { providerCallId: "c", durationMs: 5_000, timeToFirstTokenMs: 1_000 }),
      event(11, "model.usage", { providerCallId: "c", outputTokens: 120 }),
      event(12, "message.delta", { delta: "Second answer" }), event(13, "turn.completed"),
    ].map((entry) => ({ ...entry, turnId: "next" })),
  ];
  const runs = planRuns(restoreSessionEntries(snapshot, [...recorded].reverse().concat(recorded[2]!,
    event(14, "model.usage", { providerCallId: "future", outputTokens: 9999 }))));
  expect(runs[0]!.answer?.receipt).toEqual({ mode: "Build", model: "first-model", durationMs: 31_100, tokensPerSecond: 15,
    context: { used: 2900, capacity: 100000, estimated: true } });
  expect(runs[1]!.answer?.receipt).toEqual({ mode: "Plan", model: "second-model", durationMs: 62_000, tokensPerSecond: 30,
    context: { used: null, capacity: null, estimated: false } });
});

test("replay stops at the saved cursor and closes the stream", async () => {
  let closed = false;
  let signal: AbortSignal | undefined;
  const restored = await replaySession(state, async function* (id, after, abort) {
    expect(id).toBe("session"); expect(after).toBe(0); signal = abort;
    try { yield* events; throw new Error("read past snapshot"); } finally { closed = true; }
  });
  expect(restored).toHaveLength(7);
  expect(closed).toBe(true);
  expect(signal?.aborted).toBe(true);
  await expect(replaySession(state, async function* () { yield events[0]!; })).rejects.toThrow("before the saved cursor");
});

test("command completion retains failure status, exit codes and both output streams", () => {
  expect(toolCompletion(event(1, "tool.call_completed", { toolCallId: "cmd", name: "run_command", exitCode: 1, stdout: "1 failed", stderr: "diagnostic", outputTruncated: true }))).toMatchObject({
    state: "failed", exitCode: 1, message: "1 failed\nstderr:\ndiagnostic\n[Recorded output truncated]",
  });
  expect(toolCompletion(event(2, "tool.call_completed", { timedOut: true, exitCode: 0 })).state).toBe("failed");
});

test("replay clears resolved approvals and preserves interrupted tools without counting failures", () => {
  const running = { ...state, session: { ...state.session, turns: [{ ...state.session.turns[0]!, status: "running" as const, responseText: "" }] } };
  const recorded = [events[2]!, event(4, "permission.requested", { permissionId: "permission", toolCallId: "check" })];
  expect(projectRunEvidence(restoreSessionEntries(running, recorded)).verification).toBe("waiting");
  recorded.push(event(5, "permission.resolved", { permissionId: "permission", decision: "allow_once" }));
  expect(projectRunEvidence(restoreSessionEntries(running, recorded)).verification).toBe("running");
  for (const type of ["tool.call_cancelled", "tool.call_interrupted"] as const) {
    const stopped = { ...running, session: { ...running.session, turns: [{ ...running.session.turns[0]!, status: "interrupted" as const }] } };
    const withResult = [...recorded, event(6, type, { toolCallId: "check", name: "run_command", exitCode: 130, stderr: "Stopped by user" })];
    const restored = restoreSessionEntries(stopped, withResult);
    expect(planRuns(restored)[0]!.tools[0]).toMatchObject({ state: "stopped", waiting: false, exitCode: 130, message: "stderr:\nStopped by user" });
    expect(projectRunEvidence(restored)).toMatchObject({ verification: "stopped", failedOrDenied: 0 });
    // Missing per-tool completion in an interrupted journal has the same state.
    expect(projectRunEvidence(restoreSessionEntries(stopped, recorded))).toMatchObject({ verification: "stopped", failedOrDenied: 0 });
  }
});
