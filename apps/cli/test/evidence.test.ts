import { expect, test } from "bun:test";
import type { EventEnvelope, SessionStateResponse, Turn } from "@demesne/protocol";
import {
  aggregateVerification,
  projectRunEvidence,
} from "../src/workbench/evidence.ts";
import type { ToolEntry } from "../src/workbench/entries.ts";
import { restoreSessionEntries } from "../src/workbench/history.ts";

let nextId = 1;
function tool(overrides: Partial<ToolEntry> & Pick<ToolEntry, "name" | "phase">): ToolEntry {
  return {
    id: nextId++,
    type: "tool",
    toolCallId: `call-${nextId}`,
    input: {},
    state: "done",
    startedAt: 0,
    ...overrides,
  };
}
const read = (path: string, overrides: Partial<ToolEntry> = {}) => tool({ name: "read_file", phase: "inspect", detail: path, ...overrides });
const edit = (path: string, overrides: Partial<ToolEntry> = {}) =>
  tool({ name: "edit_file", phase: "change", detail: path, diff: { oldText: "old", newText: "new" }, ...overrides });
const createFile = (path: string, overrides: Partial<ToolEntry> = {}) =>
  tool({ name: "write_file", phase: "change", detail: path, created: true, ...overrides });
const move = (from: string, to: string, overrides: Partial<ToolEntry> = {}) =>
  tool({ name: "move_path", phase: "change", detail: `${from} → ${to}`, ...overrides });
const remove = (path: string, overrides: Partial<ToolEntry> = {}) =>
  tool({ name: "delete_path", phase: "change", detail: path, ...overrides });
const check = (command: string, overrides: Partial<ToolEntry> = {}) =>
  tool({ name: "run_command", phase: "verify", detail: `$ ${command}`, exitCode: 0, ...overrides });
const verification = (outcome: "passed" | "failed" | "running" | "waiting" | "denied" | "stopped") =>
  ({ id: nextId++, toolCallId: `v-${nextId}`, name: "run_command", command: "bun test", outcome });

test("a question-only run records no changes and no verification", () => {
  const evidence = projectRunEvidence([read("a.ts"), read("b.ts")]);
  expect(evidence.hasChanges).toBe(false);
  expect(evidence.changes).toHaveLength(0);
  expect(evidence.verifications).toHaveLength(0);
  expect(evidence.verification).toBe("not-run");
  expect(evidence.failedOrDenied).toBe(0);
});

test("a coding run projects a successful change and a passing verification", () => {
  const evidence = projectRunEvidence([edit("src/lexer.ts"), check("bun test")]);
  expect(evidence.hasChanges).toBe(true);
  expect(evidence.successfulChanges).toBe(1);
  expect(evidence.failedChanges).toBe(0);
  expect(evidence.changes[0]).toMatchObject({ operation: "M", outcome: "done", path: "src/lexer.ts", diff: { oldText: "old", newText: "new" } });
  expect(evidence.verification).toBe("passed");
  expect(evidence.verifications[0]).toMatchObject({ command: "bun test", outcome: "passed", exitCode: 0 });
});

test("change operations map create/modify/move/delete to A/M/R/D", () => {
  const evidence = projectRunEvidence([createFile("a.ts"), edit("b.ts"), move("c.ts", "d.ts"), remove("e.ts")]);
  expect(evidence.changes.map((change) => change.operation)).toEqual(["A", "M", "R", "D"]);
  expect(evidence.successfulChanges).toBe(4);
});

test("a failed write is never reported as a successful change", () => {
  const evidence = projectRunEvidence([edit("src/lexer.ts", { state: "failed" })]);
  expect(evidence.hasChanges).toBe(true);
  expect(evidence.successfulChanges).toBe(0);
  expect(evidence.failedChanges).toBe(1);
  expect(evidence.changes[0]!.outcome).toBe("failed");
  expect(evidence.failedOrDenied).toBe(1);
});

test("a denied write is classified denied and counted as a failed change", () => {
  const evidence = projectRunEvidence([edit("src/lexer.ts", { state: "denied" })]);
  expect(evidence.changes[0]!.outcome).toBe("denied");
  expect(evidence.successfulChanges).toBe(0);
  expect(evidence.failedChanges).toBe(1);
  expect(evidence.failedOrDenied).toBe(1);
});

test("an in-flight change is pending, not successful and not failed", () => {
  const evidence = projectRunEvidence([edit("src/lexer.ts", { state: "running", waiting: true })]);
  expect(evidence.changes[0]!.outcome).toBe("pending");
  expect(evidence.successfulChanges).toBe(0);
  expect(evidence.failedChanges).toBe(0);
  expect(evidence.failedOrDenied).toBe(0);
});

test("a non-zero exit code fails the verification", () => {
  const evidence = projectRunEvidence([check("bun test", { state: "failed", exitCode: 1, message: "3 failed" })]);
  expect(evidence.verification).toBe("failed");
  expect(evidence.verifications[0]).toMatchObject({ outcome: "failed", exitCode: 1, output: "3 failed" });
  expect(evidence.failedOrDenied).toBe(1);
});

test("a running check keeps the verification running", () => {
  const evidence = projectRunEvidence([check("bun test", { state: "running" })]);
  expect(evidence.verification).toBe("running");
});

test("a completed command with no recorded exit code never claims verification passed", () => {
  const evidence = projectRunEvidence([check("bun test", { exitCode: undefined })]);
  expect(evidence.verification).toBe("unknown");
  expect(aggregateVerification([...evidence.verifications, verification("passed")])).toBe("unknown");
});

test("a denied check retains its denied outcome", () => {
  const evidence = projectRunEvidence([check("bun test", { state: "denied" })]);
  expect(evidence.verifications[0]!.outcome).toBe("denied");
  expect(evidence.verification).toBe("denied");
});

test("approval and interruption are distinct from execution and failure, including signal exits", () => {
  const waiting = projectRunEvidence([check("bun test", { state: "running", waiting: true, exitCode: undefined })]);
  expect(waiting.verification).toBe("waiting");
  const stopped = projectRunEvidence([check("bun test", { state: "stopped", exitCode: 130 }), edit("a.ts", { state: "stopped" })]);
  expect(stopped.verification).toBe("stopped");
  expect(stopped.failedOrDenied).toBe(0);
  expect(stopped.failedChanges).toBe(0);
  expect(stopped.successfulChanges).toBe(0);
  expect(stopped.changes[0]!.outcome).toBe("stopped");
  expect(aggregateVerification([...waiting.verifications, ...stopped.verifications])).toBe("waiting");
  expect(aggregateVerification([...waiting.verifications, verification("running")])).toBe("running");
});

test("aggregate verification prefers running, then failed, then stopped", () => {
  expect(aggregateVerification([])).toBe("not-run");
  expect(aggregateVerification([verification("passed")])).toBe("passed");
  expect(aggregateVerification([verification("passed"), verification("running")])).toBe("running");
  expect(aggregateVerification([verification("passed"), verification("failed")])).toBe("failed");
  expect(aggregateVerification([verification("stopped")])).toBe("stopped");
});

test("git calls classified as verify are not treated as verification commands", () => {
  const evidence = projectRunEvidence([tool({ name: "git_status", phase: "verify" })]);
  expect(evidence.verifications).toHaveLength(0);
  expect(evidence.verification).toBe("not-run");
});

test("repeated edits to one file stay separate and keep their own diffs", () => {
  const evidence = projectRunEvidence([
    edit("src/lexer.ts", { diff: { oldText: "a", newText: "b" } }),
    edit("src/lexer.ts", { diff: { oldText: "b", newText: "c" } }),
  ]);
  expect(evidence.changes).toHaveLength(2);
  expect(evidence.changes.map((change) => change.diff)).toEqual([
    { oldText: "a", newText: "b" },
    { oldText: "b", newText: "c" },
  ]);
});

test("failedOrDenied counts failed, denied, and non-zero-exit tools across all phases", () => {
  const evidence = projectRunEvidence([
    read("ok.ts"),
    read("x.ts", { state: "failed" }),
    edit("a.ts", { state: "denied" }),
    check("bun test", { state: "done", exitCode: 2 }),
  ]);
  expect(evidence.failedOrDenied).toBe(3);
});

test("the projection is a pure function of the recorded entries", () => {
  const entries = [read("a.ts"), edit("b.ts"), check("bun test")];
  expect(projectRunEvidence(entries)).toEqual(projectRunEvidence(entries));
});

test("replayed sessions project identically to their recorded evidence", () => {
  const createdAt = "2026-01-01T00:00:00Z";
  const turn: Turn = {
    id: "t1", sessionId: "s1", content: "Accept Unicode identifiers", responseText: "Done.",
    status: "completed", createdAt, completedAt: "2026-01-01T00:00:05Z", permissionMode: "ask", thinkingEnabled: null,
  };
  const session: SessionStateResponse = {
    session: { id: "s1", title: "Session", createdAt, updatedAt: createdAt, workspace: null, turns: [turn] },
    lastEventId: 100, pendingPermissions: [], latestProviderCall: null,
  };
  const at = "2026-01-01T00:00:01Z";
  const envelope = (eventId: number, type: EventEnvelope["type"], payload: Record<string, unknown>): EventEnvelope =>
    ({ schemaVersion: 1, eventId, type, occurredAt: at, workspaceId: null, sessionId: "s1", turnId: "t1", agentRunId: null, payload });
  const events: EventEnvelope[] = [
    envelope(1, "model.request_started", { model: "test-model" }),
    envelope(2, "tool.call_requested", { name: "edit_file", toolCallId: "e1", arguments: { path: "src/lexer.ts", oldText: "a", newText: "b" } }),
    envelope(3, "tool.call_completed", { name: "edit_file", toolCallId: "e1", exitCode: 0, durationMs: 10 }),
    envelope(4, "tool.call_requested", { name: "run_command", toolCallId: "c1", arguments: { argv: ["bun", "test"] } }),
    envelope(5, "tool.call_completed", { name: "run_command", toolCallId: "c1", exitCode: 0, durationMs: 100 }),
    envelope(6, "turn.completed", { message: "Completed" }),
  ];
  const evidence = projectRunEvidence(restoreSessionEntries(session, events));
  expect(evidence.hasChanges).toBe(true);
  expect(evidence.successfulChanges).toBe(1);
  expect(evidence.changes[0]).toMatchObject({ operation: "M", outcome: "done", path: "src/lexer.ts", diff: { oldText: "a", newText: "b" } });
  expect(evidence.verification).toBe("passed");
  expect(evidence.verifications[0]).toMatchObject({ command: "bun test", outcome: "passed", exitCode: 0 });
});
