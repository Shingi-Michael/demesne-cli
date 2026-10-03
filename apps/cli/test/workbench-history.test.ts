import { expect, test } from "bun:test";
import type { EventEnvelope, SessionReplayPage, SessionStateResponse } from "@demesne/protocol";
import { ApiRequestError } from "@demesne/client";
import { replaySession } from "../src/workbench/history.ts";
import { toolCompletion } from "../src/workbench/tool-result.ts";

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

test("bulk history rejects gaps, overlaps, future ranges and partial-page failures", async () => {
  const stream = async function* (): AsyncGenerator<EventEnvelope> { throw new Error("Unexpected SSE fallback"); };
  const invalid: SessionReplayPage[] = [
    { throughEventId: 8, events, nextCursor: null },
    { throughEventId: 7, events: [], nextCursor: null },
    { throughEventId: 7, events: events.slice(0, 2), nextCursor: null },
    { throughEventId: 7, events: [events[0]!, events[0]!], nextCursor: 1 },
    { throughEventId: 7, events: [{ ...events[0]!, throughEventId: 8, deltaCount: 2 }], nextCursor: null },
    { throughEventId: 7, events, nextCursor: 7 },
  ];
  for (const page of invalid) await expect(replaySession(state, stream, async () => page)).rejects.toThrow();
  let calls = 0;
  await expect(replaySession(state, stream, async () => {
    if (++calls === 1) return { throughEventId: 7, events: events.slice(0, 2), nextCursor: 2 };
    throw new ApiRequestError("Missing page", 404, "not_found");
  })).rejects.toThrow("Missing page");
});

test("command completion retains failure status, exit codes and both output streams", () => {
  expect(toolCompletion(event(1, "tool.call_completed", { toolCallId: "cmd", name: "run_command", exitCode: 1, stdout: "1 failed", stderr: "diagnostic", outputTruncated: true }))).toMatchObject({
    state: "failed", exitCode: 1, message: "1 failed\nstderr:\ndiagnostic\n[Recorded output truncated]",
  });
  expect(toolCompletion(event(2, "tool.call_completed", { timedOut: true, exitCode: 0 })).state).toBe("failed");
});
