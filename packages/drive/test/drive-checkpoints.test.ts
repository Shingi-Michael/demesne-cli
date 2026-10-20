import { expect, test } from "bun:test";
import {
  recordDriveCheckpoint,
  checkpointDue,
  acknowledgeCheckpoint,
  CHECKPOINT_COOLDOWN_MS,
} from "../src/drive-checkpoints.ts";
import { AgentDrive } from "../src/agent-drive.ts";
import type {
  DriveProtection,
  ReplayEvent,
  DriveObservation,
  DriveRequest,
  DriveResponse,
  DriveReview,
} from "@demesne/protocol";
const worker = (): NonNullable<DriveProtection["worker"]> => ({
  sessionId: "home",
  turnId: "worker",
  cursor: 0,
  meter: {
    inputEstimate: 0,
    characters: 0,
    input: null,
    output: null,
    total: null,
    charged: 0,
    attempt: 1,
  },
  checks: 0,
  checkCursor: 0,
  nextCheckAt: 120000,
  settled: false,
});
const event = (
  id: number,
  type: ReplayEvent["type"],
  payload: Record<string, unknown>,
): ReplayEvent => ({
  schemaVersion: 1,
  eventId: id,
  type,
  sessionId: "home",
  turnId: "worker",
  workspaceId: null,
  agentRunId: null,
  occurredAt: new Date().toISOString(),
  payload,
});
const request = (n: number, name: string, args: unknown) =>
  event(n, "tool.call_requested", {
    toolCallId: `call-${n}`,
    name,
    arguments: JSON.stringify(args),
  });
const completed = (n: number, requestId: number, name: string) =>
  event(n, "tool.call_completed", {
    toolCallId: `call-${requestId}`,
    name,
    exitCode: 0,
  });
test("checks and edit batches trigger bounded checkpoints; token streams and background servers do not", () => {
  const w = worker();
  expect(
    recordDriveCheckpoint(
      w,
      event(1, "message.delta", { delta: "Thinking..." }),
    ),
  ).toBe(false);
  recordDriveCheckpoint(
    w,
    request(2, "run_command", { argv: ["bun", "test"], background: true }),
  );
  expect(recordDriveCheckpoint(w, completed(3, 2, "run_command"))).toBe(false);
  recordDriveCheckpoint(
    w,
    request(4, "run_command", { argv: ["bun", "run", "typecheck"] }),
  );
  expect(recordDriveCheckpoint(w, completed(5, 4, "run_command"))).toBe(true);
  expect(w.checkpoint?.reason).toBe("check_completed");
  expect(checkpointDue(w, 0)).toBe(true);
  acknowledgeCheckpoint(w, 5);
  expect(w.checkpoint).toBeUndefined();
  expect(recordDriveCheckpoint(w, completed(6, 6, "edit_file"))).toBe(false);
  expect(recordDriveCheckpoint(w, completed(7, 7, "write_file"))).toBe(true);
  expect(w.checkpoint?.reason).toBe("edit_batch");
  w.checkpointReadyAt = CHECKPOINT_COOLDOWN_MS;
  expect(checkpointDue(w, 1)).toBe(false);
  expect(checkpointDue(w, CHECKPOINT_COOLDOWN_MS)).toBe(true);
});
test("repeated equivalent tool arguments are recognized and newer checkpoints survive an older review", () => {
  const w = worker();
  for (let i = 1; i <= 3; i++) {
    recordDriveCheckpoint(
      w,
      request(
        i * 2,
        "read_file",
        i % 2 ? { path: "a.ts", limit: 20 } : { limit: 20, path: "a.ts" },
      ),
    );
    recordDriveCheckpoint(w, completed(i * 2 + 1, i * 2, "read_file"));
  }
  expect(w.checkpoint?.reason).toBe("repeated_tools");
  acknowledgeCheckpoint(w, 5);
  expect(w.checkpoint?.cursor).toBe(7);
  acknowledgeCheckpoint(w, 7);
  expect(w.checkpoint).toBeUndefined();
});
test("a live checkpoint is reviewed before the interval, coalesces evidence and observes cooldown", async () => {
  let now = 0;
  const calls: DriveRequest[] = [];
  let screen: DriveObservation = {
    id: "screen",
    sessionId: "home",
    workspace: "/repo",
    title: "Test",
    mode: "input",
    ready: true,
    draft: "",
    surface: "response",
    rows: [],
    controls: [],
    width: 80,
    height: 24,
  };
  const review: DriveReview = {
    id: "review",
    sessionId: "home",
    turnId: "worker",
    revision: "a".repeat(64),
    cursor: 2,
    capturedAt: "now",
    queueMs: 20,
    reason: "check_completed",
    status: "running",
    waitingForHuman: false,
    rows: ["Check bun test: completed, current"],
  };
  const drive = new AgentDrive({
    checkpointReviews: true,
    now: () => now,
    delayMs: 60000,
    observe: () => screen,
    changed() {},
    cancelWorker: async () => false,
    perform: async () => "Sent through the visible composer: Run tests",
    decide: async (r) => {
      calls.push(r);
      return {
        provider: "test",
        model: "test",
        imageInspected: false,
        ...(r.checkIn ? { review } : {}),
        decision: {
          action: r.checkIn
            ? { kind: "keep_working" }
            : { kind: "compose", text: "Run tests" },
          note: "Aligned",
          notes: "",
          remaining: [],
          completed: [],
          evidence: [],
        },
      } as DriveResponse;
    },
  });
  try {
    drive.start("Verify parser");
    await drive.step();
    drive.workerStarted("home", "Run tests", "worker");
    screen = { ...screen, mode: "streaming", ready: false };
    drive.workerEvent(request(1, "run_command", { argv: ["bun", "test"] }));
    drive.workerEvent(completed(2, 1, "run_command"));
    await drive.step();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.checkIn).toMatchObject({
      freshEvidence: true,
      reason: "check_completed",
    });
    drive.workerEvent(request(3, "run_command", { argv: ["bun", "test"] }));
    drive.workerEvent(completed(4, 3, "run_command"));
    await drive.step();
    expect(calls).toHaveLength(2);
    now = CHECKPOINT_COOLDOWN_MS;
    await drive.step();
    expect(calls).toHaveLength(3);
  } finally {
    drive.dispose();
  }
});

test("malformed tool arguments cannot crash checkpoint tracking", () => {
  const w = worker();
  for (const args of [
    null,
    [],
    42,
    { argv: [{ toString: 12 }] },
    { path: { toString: 1 } },
    JSON.parse("[".repeat(1000) + "0" + "]".repeat(1000)),
  ]) {
    expect(() =>
      recordDriveCheckpoint(w, request(1, "run_command", args)),
    ).not.toThrow();
  }
  expect(w.recentTools?.every((call) => !call.check)).toBe(true);
});
