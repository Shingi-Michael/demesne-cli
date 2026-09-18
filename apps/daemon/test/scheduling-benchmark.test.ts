import { expect, test } from "bun:test";
import type { EventEnvelope, EventType } from "@demesne/protocol";
import { createInferenceRecycleController } from "../src/inference-recycle-controller.ts";
import type { TurnProcessor } from "../src/processor.ts";
import { collectSchedulingRounds, createSchedulingPrompt, runSchedulingBenchmark } from "../src/scheduling-benchmark.ts";

test("scheduling prompts isolate sessions and invalidate cross-pair prefix reuse", () => {
  const firstA = createSchedulingPrompt(0, 0, 2, [1, 2]);
  const firstB = createSchedulingPrompt(1, 0, 2, [1, 2]);
  const secondA = createSchedulingPrompt(0, 1, 2, [1, 2]);

  expect(firstA).not.toBe(firstB);
  expect(firstA).not.toBe(secondA);
  expect(firstA).toContain("SESSION-A: BUG: total - price should be total + price");
  expect(firstB).toContain("SESSION-B: BUG: total - price should be total + price");
  expect(firstA.match(/^Reference /gm)).toHaveLength(2);
  expect(firstA).toContain("exactly 1 read_file call");
  expect(firstA).toContain("starting with src/calculate-total.ts");
  expect(firstB).toContain("exactly 2 read_file calls");
  expect(firstB).toContain("starting with src/scheduling-step-1.txt");
});

test("scheduling benchmark requires one complete event set per provider round", () => {
  const result = collectSchedulingRounds([
    event("model.request_started", { providerCallId: "call-1" }),
    event("model.usage", { providerCallId: "call-1", inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
    event("model.metrics", { providerCallId: "call-1", queueDurationMs: 14_000, durationMs: 2_000, timeToFirstTokenMs: 500 }),
    event("model.request_completed", { providerCallId: "call-1" }),
  ]);

  expect(result).toEqual({
    valid: true,
    rounds: [{
      providerCallId: "call-1",
      outcome: "completed",
      queueDurationMs: 14_000,
      durationMs: 2_000,
      timeToFirstTokenMs: 500,
      inputTokens: 100,
      outputTokens: 10,
    }],
  });
});

test("scheduling benchmark rejects duplicate and orphan provider events", () => {
  const duplicate = collectSchedulingRounds([
    event("model.request_started", { providerCallId: "call-1" }),
    event("model.usage", { providerCallId: "call-1", inputTokens: 100, outputTokens: 10 }),
    event("model.usage", { providerCallId: "call-1", inputTokens: 100, outputTokens: 10 }),
    event("model.metrics", { providerCallId: "call-1", queueDurationMs: 1, durationMs: 2, timeToFirstTokenMs: 1 }),
    event("model.request_completed", { providerCallId: "call-1" }),
  ]);
  const orphan = collectSchedulingRounds([
    event("model.metrics", { providerCallId: "missing", queueDurationMs: 1, durationMs: 2, timeToFirstTokenMs: 1 }),
  ]);

  expect(duplicate.valid).toBe(false);
  expect(orphan.valid).toBe(false);
});

test("scheduling benchmark defers maintenance across asymmetric multi-round turns", async () => {
  const boundaries: number[] = [];
  const processor = variableRoundProcessor();
  const report = await runSchedulingBenchmark({
    fixtureId: "variable-round-test",
    model: "variable-rounds",
    providerUrl: "http://127.0.0.1:11434/v1",
    providerId: "scripted",
    inferenceSlots: 1,
    warmupRuns: 0,
    measuredRuns: 2,
    timeoutMs: 5_000,
    maxOutputTokens: 64,
    temperature: 0,
    seed: 42,
    profileLabel: "test",
    promptPaddingLines: 0,
    readChainDepths: [1, 2],
    maximumInFlightPairs: 1,
  }, {
    processor,
    inferenceBoundaryHook: async (snapshot) => { boundaries.push(snapshot.settledLeaseCount); },
    memorySnapshot: () => memory(),
    powerSnapshot: () => null,
    runnerSnapshot: () => null,
  });

  expect(report.summary.successfulRuns).toBe(2);
  expect(report.observations.map((observation) => observation.turns.map((turn) => turn.rounds.length))).toEqual([
    [2, 3],
    [2, 3],
  ]);
  expect(report.observations.map((observation) => observation.turns.map((turn) => turn.expectedProviderRounds))).toEqual([
    [2, 3],
    [2, 3],
  ]);
  expect(boundaries).toEqual([5]);
});

test("scheduling benchmark drains continuations while fresh pairs remain queued", async () => {
  let recycles = 0;
  const controller = createInferenceRecycleController({
    workThreshold: 2,
    availablePercentThreshold: 100,
    maximumRecycles: 1,
    maximumContinuationDrainMs: 5_000,
    memorySnapshot: () => memory(),
    recycle: async () => { recycles += 1; },
  });
  const report = await runSchedulingBenchmark({
    fixtureId: "continuous-variable-round-test",
    model: "variable-rounds",
    providerUrl: "http://127.0.0.1:11434/v1",
    providerId: "scripted",
    inferenceSlots: 1,
    warmupRuns: 0,
    measuredRuns: 2,
    timeoutMs: 5_000,
    maxOutputTokens: 64,
    temperature: 0,
    seed: 42,
    profileLabel: "test",
    promptPaddingLines: 0,
    readChainDepths: [1, 2],
    maximumInFlightPairs: 2,
  }, {
    processor: variableRoundProcessor(),
    inferenceBoundaryHook: controller.hook,
    memorySnapshot: () => memory(),
    powerSnapshot: () => null,
    runnerSnapshot: () => null,
  });
  const decisions = controller.report().decisions;
  const recycled = decisions.find((decision) => decision.recycled);

  expect(report.summary.successfulRuns).toBe(2);
  expect(recycles).toBe(1);
  expect(decisions.some((decision) => decision.reason === "continuation_drain")).toBe(true);
  expect(recycled?.scheduler).toMatchObject({ pendingContinuationTurnCount: 0, continuationDrainActive: true });
  expect(recycled?.completedRequestsSinceRecycle).toBeGreaterThan(2);
});

function event(type: EventType, payload: Record<string, unknown>): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: 1,
    occurredAt: "2026-08-28T00:00:00.000Z",
    workspaceId: null,
    sessionId: "session",
    turnId: "turn",
    agentRunId: null,
    type,
    payload,
  };
}

function memory() {
  return {
    observedAt: "2026-08-28T00:00:00.000Z",
    availablePercent: 50,
    swapUsedBytes: 0,
    pageSizeBytes: 4_096,
    pageOuts: 0,
    swapOuts: 0,
  };
}

function variableRoundProcessor(): TurnProcessor {
  return {
    providerId: "scripted",
    modelId: "variable-rounds",
    async listModels() { return []; },
    async *stream(messages) {
      const prompt = messages.findLast((message) => message.role === "user")?.content ?? "";
      const toolResults = messages.filter((message) => message.role === "tool").length;
      const depth = prompt.includes("src/scheduling-step-1.txt") ? 2 : 1;
      if (toolResults < depth) {
        const path = depth === 2 && toolResults === 0 ? "src/scheduling-step-1.txt" : "src/calculate-total.ts";
        yield {
          type: "tool_call_delta" as const,
          index: 0,
          idDelta: `read-${toolResults}`,
          nameDelta: "read_file",
          argumentsDelta: JSON.stringify({ path }),
        };
      } else {
        const marker = prompt.includes("SESSION-A:")
          ? "SESSION-A: BUG: total - price should be total + price"
          : "SESSION-B: BUG: total - price should be total + price";
        yield { type: "text_delta" as const, delta: marker };
      }
      yield { type: "usage" as const, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
    },
  };
}
