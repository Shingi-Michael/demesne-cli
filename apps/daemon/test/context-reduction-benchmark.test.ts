import { expect, test } from "bun:test";
import type { RuntimeProfileStatus } from "@demesne/protocol";
import type { TurnProcessor } from "../src/processor.ts";
import {
  createContextReductionFixture,
  runContextReductionBenchmark,
  type ContextReductionBenchmarkConfig,
} from "../src/context-reduction-benchmark.ts";

const QUALITY_GOLD = {
  stableFirstRecord: "S-001: ssssssss",
  stableLastRecord: "S-090: ssssssss",
  latestChangingFirstRecord: "B-001: bbbbbbbbbb",
  latestChangingLastRecord: "B-020: bbbbbbbbbb",
  latestReadSet: "B",
};

test("context reduction fixture has a stable production planner contract", async () => {
  const fixture = await createContextReductionFixture();

  expect(fixture.rawMessages).toHaveLength(10);
  expect(fixture.reducedMessages).toHaveLength(6);
  expect(fixture.tools.map((tool) => tool.name)).toEqual([
    "command_logs",
    "command_stop",
    "delete_path",
    "edit_file",
    "git_diff",
    "git_status",
    "list_files",
    "move_path",
    "read_file",
    "read_files",
    "run_command",
    "search_files",
    "write_file",
  ]);
  expect(fixture.plan).toMatchObject({
    schemaVersion: 3,
    originalEstimatedInputTokens: 7_314,
    estimatedInputTokens: 5_368,
    estimatedToolDefinitionTokens: 2_478,
    maximumPlannedInputTokens: 5_376,
    hardInputLimitTokens: 6_656,
    budgetStatus: "within_soft_limit",
  });
  expect(fixture.plan.actions).toEqual([
    expect.objectContaining({
      kind: "deduplicate_historical_file_content",
      messageIndex: 3,
      retainedMessageIndex: 7,
      path: "data/stable.txt",
    }),
    expect.objectContaining({
      kind: "truncate_historical_tool_output",
      messageIndex: 7,
      removedLines: 65,
    }),
    expect.objectContaining({
      kind: "drop_historical_turn",
      turnId: "turn-a",
      messageStartIndex: 1,
      messageCount: 4,
    }),
  ]);
  expect(fixture.toolDefinitionsSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(fixture.requestFixtureSha256).toMatch(/^[a-f0-9]{64}$/);
});

test("context reduction benchmark counterbalances order and reports paired latency", async () => {
  const clock = { value: 0 };
  const report = await runContextReductionBenchmark(benchmarkConfig(), {
    processor: benchmarkProcessor(clock, true),
    endpoint: "http://127.0.0.1:11435/v1",
    backendVersion: "test-backend",
    modelDigest: "test-digest",
    sourceRevision: "test-revision",
    now: () => clock.value,
    memorySnapshot: () => null,
    powerSnapshot: () => ({
      observedAt: "2026-08-28T00:00:00.000Z",
      source: "ac",
      batteryPercent: 80,
      batteryStatus: "AC attached",
      currentPowerMode: 2,
      batteryPowerMode: 1,
      acPowerMode: 2,
    }),
    runnerSnapshot: stableRunner,
  });

  expect(report.observations.map((observation) => observation.order)).toEqual([
    ["raw", "reduced"],
    ["reduced", "raw"],
    ["raw", "reduced"],
    ["reduced", "raw"],
  ]);
  expect(new Set(report.observations.map((observation) => observation.requestNonce)).size).toBe(4);
  expect(report.observations.map((observation) => [observation.raw.predecessor, observation.reduced.predecessor])).toEqual([
    [null, "raw"],
    ["reduced", "reduced"],
    ["raw", "raw"],
    ["reduced", "reduced"],
  ]);
  expect(report.summary).toMatchObject({
    measuredPairs: 2,
    validPairs: 2,
    experimentValid: true,
    provenanceComplete: true,
    rawQualityRate: 1,
    reducedQualityRate: 1,
    reducedOnlyFailures: 0,
    medianRawInputTokens: 6_300,
    medianReducedInputTokens: 4_500,
    medianRawCachedInputTokens: null,
    medianReducedCachedInputTokens: null,
    medianInputTokenSaving: 1_800,
    medianRawTimeToFirstOutputMs: 30,
    medianReducedTimeToFirstOutputMs: 20,
    meanPairedTimeToFirstOutputSavingMs: 10,
    medianPairedDurationSavingMs: 10,
    geometricMeanRawToReducedTimeToFirstOutputRatio: 1.5,
  });
  expect(report.summary.geometricMeanRatio95PercentConfidenceInterval).toEqual([1.5, 1.5]);
});

test("context reduction benchmark excludes reduced quality regressions", async () => {
  const clock = { value: 0 };
  const report = await runContextReductionBenchmark(benchmarkConfig(), {
    processor: benchmarkProcessor(clock, false),
    endpoint: "http://127.0.0.1:11435/v1",
    backendVersion: "test-backend",
    modelDigest: "test-digest",
    sourceRevision: "test-revision",
    now: () => clock.value,
    memorySnapshot: () => null,
    powerSnapshot: () => ({
      observedAt: "2026-08-28T00:00:00.000Z",
      source: "ac",
      batteryPercent: 80,
      batteryStatus: "AC attached",
      currentPowerMode: 2,
      batteryPowerMode: 1,
      acPowerMode: 2,
    }),
    runnerSnapshot: stableRunner,
  });

  expect(report.summary).toMatchObject({
    validPairs: 2,
    experimentValid: false,
    rawQualityRate: 1,
    reducedQualityRate: 0,
    reducedOnlyFailures: 2,
  });
  expect(report.observations.filter((observation) => observation.phase === "measured")
    .every((observation) => observation.exclusionReason === null)).toBe(true);
});

function benchmarkConfig(): ContextReductionBenchmarkConfig {
  return {
    model: "test-model",
    warmupPairs: 2,
    measuredPairs: 2,
    timeoutMs: 10_000,
    maxOutputTokens: 1_536,
    temperature: 0,
    seed: 42,
    contextWindow: 8_192,
    externalPowerContext: "controlled-test-power",
  };
}

function benchmarkProcessor(clock: { value: number }, preserveReducedQuality: boolean): TurnProcessor {
  const status: RuntimeProfileStatus = {
    profile: "balanced-32gb",
    state: "verified",
    expected: {
      contextWindow: 8_192,
      batchSize: 512,
      microBatchSize: 512,
      parallelSequences: 1,
      keyCacheType: "q8_0",
      valueCacheType: "q8_0",
      flashAttention: "on",
      loadedModels: 1,
    },
    observed: {
      model: "test-model",
      contextWindow: 8_192,
      batchSize: 512,
      microBatchSize: 512,
      parallelSequences: 1,
      keyCacheType: "q8_0",
      valueCacheType: "q8_0",
      flashAttention: "on",
      loadedModels: 1,
      runnerProcesses: 1,
    },
    mismatches: [],
    observedAt: "2026-08-28T00:00:00.000Z",
  };
  return {
    providerId: "test-provider",
    modelId: "test-model",
    contextCapacity: 8_192,
    maxOutputTokens: 1_536,
    temperature: 0,
    seed: 42,
    runtimeStatus: () => status,
    async listModels() {
      return [{ id: this.modelId, provider: this.providerId, contextWindow: this.contextCapacity }];
    },
    async *stream(messages, _tools, _signal, _thinkingEnabled, onFirstProviderEvent) {
      const raw = messages.length === 10;
      clock.value += raw ? 30 : 20;
      onFirstProviderEvent?.();
      const response = raw || preserveReducedQuality
        ? QUALITY_GOLD
        : { ...QUALITY_GOLD, latestReadSet: "A" };
      const text = JSON.stringify(response);
      yield { type: "text_delta" as const, delta: text };
      clock.value += 5;
      const inputTokens = raw ? 6_300 : 4_500;
      yield {
        type: "usage" as const,
        usage: { inputTokens, outputTokens: 40, totalTokens: inputTokens + 40 },
      };
    },
  };
}

function stableRunner() {
  return {
    observedAt: "2026-08-28T00:00:00.000Z",
    processes: [{ pid: 100, commandLine: "ollama runner --ctx-size 8192" }],
  };
}
