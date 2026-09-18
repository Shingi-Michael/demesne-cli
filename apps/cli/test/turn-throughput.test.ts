import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type EventEnvelope, type EventType } from "@demesne/protocol";
import { TurnThroughputTracker } from "../src/turn-throughput.ts";

describe("TurnThroughputTracker", () => {
  test("accumulates output and provider time across tool rounds", () => {
    const tracker = new TurnThroughputTracker();
    const rounds = [
      { id: "round-1", output: 92, duration: 57_413.15, ttft: 51_405.66 },
      { id: "round-2", output: 121, duration: 75_400.79, ttft: 67_123.17 },
      { id: "round-3", output: 97, duration: 34_654.02, ttft: 27_918.99 },
      { id: "round-4", output: 166, duration: 19_564.48, ttft: 7_936.79 },
      { id: "round-5", output: 117, duration: 10_756.17, ttft: 2_568.23 },
      { id: "round-6", output: 1_075, duration: 99_622.07, ttft: 21_157.54 },
    ];

    for (const round of rounds) {
      tracker.apply(event("model.usage", round.id, { outputTokens: round.output }));
      tracker.apply(event("model.metrics", round.id, {
        durationMs: round.duration,
        timeToFirstTokenMs: round.ttft,
      }));
    }

    const snapshot = tracker.snapshot();
    expect(snapshot.outputTokens).toBe(1_668);
    expect(snapshot.providerDurationMs).toBeCloseTo(297_410.68, 1);
    expect(snapshot.tokensPerSecond).toBeCloseTo(5.61, 2);
    expect(snapshot.timeToFirstTokenMs).toBeCloseTo(178_110.38, 1);
    expect(snapshot.decodeTokensPerSecond).toBeCloseTo(13.98, 2);
    expect(snapshot.measuredRounds).toBe(6);
  });

  test("accepts metrics before usage", () => {
    const tracker = new TurnThroughputTracker();
    tracker.apply(event("model.metrics", "round-1", { durationMs: 60_000, timeToFirstTokenMs: 50_000 }));
    expect(tracker.snapshot().measuredRounds).toBe(0);

    tracker.apply(event("model.usage", "round-1", { outputTokens: 100 }));
    expect(tracker.snapshot()).toEqual({
      outputTokens: 100,
      providerDurationMs: 60_000,
      tokensPerSecond: 100 / 60,
      timeToFirstTokenMs: 50_000,
      decodeTokensPerSecond: 10,
      measuredRounds: 1,
    });
  });

  test("does not double count replayed events", () => {
    const tracker = new TurnThroughputTracker();
    const usage = event("model.usage", "round-1", { outputTokens: 80 });
    const metrics = event("model.metrics", "round-1", { durationMs: 7_000, timeToFirstTokenMs: 2_000 });
    tracker.apply(usage);
    tracker.apply(metrics);
    tracker.apply(usage);
    tracker.apply(metrics);

    expect(tracker.snapshot()).toEqual({
      outputTokens: 80,
      providerDurationMs: 7_000,
      tokensPerSecond: 80 / 7,
      timeToFirstTokenMs: 2_000,
      decodeTokensPerSecond: 16,
      measuredRounds: 1,
    });
  });

  test("includes provider time from a zero-output round", () => {
    const tracker = new TurnThroughputTracker();
    tracker.apply(event("model.usage", "round-1", { outputTokens: 0 }));
    tracker.apply(event("model.metrics", "round-1", { durationMs: 5_000, timeToFirstTokenMs: null }));
    tracker.apply(event("model.usage", "round-2", { outputTokens: 100 }));
    tracker.apply(event("model.metrics", "round-2", { durationMs: 5_000, timeToFirstTokenMs: 2_000 }));

    expect(tracker.snapshot()).toEqual({
      outputTokens: 100,
      providerDurationMs: 10_000,
      tokensPerSecond: 10,
      timeToFirstTokenMs: null,
      decodeTokensPerSecond: null,
      measuredRounds: 2,
    });
  });

  test("suppresses an incomplete aggregate instead of inventing a speed", () => {
    const tracker = new TurnThroughputTracker();
    tracker.apply(event("model.usage", "round-1", { outputTokens: null }));
    tracker.apply(event("model.metrics", "round-1", { durationMs: 4_000, timeToFirstTokenMs: null }));

    expect(tracker.snapshot()).toEqual({
      outputTokens: null,
      providerDurationMs: null,
      tokensPerSecond: null,
      timeToFirstTokenMs: null,
      decodeTokensPerSecond: null,
      measuredRounds: 1,
    });
  });
});

function event(type: EventType, providerCallId: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    schemaVersion: PROTOCOL_VERSION,
    eventId: 1,
    type,
    occurredAt: "2026-08-30T00:00:00.000Z",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    agentRunId: "run",
    payload: { providerCallId, ...payload },
  };
}
