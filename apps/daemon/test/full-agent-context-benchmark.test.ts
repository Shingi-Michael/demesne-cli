import { expect, test } from "bun:test";
import type { RuntimeProfileStatus } from "@demesne/protocol";
import type {
  AgentBenchmarkConfig,
  AgentBenchmarkDependencies,
  AgentBenchmarkObservation,
  AgentBenchmarkReport,
} from "../src/agent-benchmark.ts";
import {
  CACHE_TIMING_FULL_AGENT_FIXTURE_IDS,
  PAIRED_FULL_AGENT_FIXTURE_IDS,
} from "../src/agent-benchmark.ts";
import {
  runFullAgentContextBenchmark,
  type FullAgentContextBenchmarkConfig,
  type FullAgentContextBenchmarkDependencies,
} from "../src/full-agent-context-benchmark.ts";
import type { TurnProcessor } from "../src/processor.ts";

test("full-agent context benchmark counterbalances fixtures and paired policies", async () => {
  const calls: Array<{ fixtureId: string; condition: string; nonce: string | undefined }> = [];
  const report = await runFullAgentContextBenchmark(config(), dependencies(async (benchmarkConfig, benchmarkDependencies) => {
    calls.push({
      fixtureId: benchmarkConfig.fixtureId,
      condition: benchmarkConfig.contextPolicy ?? "schema3",
      nonce: benchmarkDependencies.systemPromptNonce,
    });
    return agentReport(benchmarkConfig, true);
  }));

  expect(report.observations).toHaveLength(PAIRED_FULL_AGENT_FIXTURE_IDS.length * 2);
  expect(report.schemaVersion).toBe(3);
  expect(report.config.comparison).toBe("raw-schema3");
  expect(report.observations.map((observation) => observation.fixtureId)).toEqual([
    ...PAIRED_FULL_AGENT_FIXTURE_IDS,
    ...PAIRED_FULL_AGENT_FIXTURE_IDS.slice(1),
    PAIRED_FULL_AGENT_FIXTURE_IDS[0],
  ]);
  for (const fixtureId of PAIRED_FULL_AGENT_FIXTURE_IDS) {
    expect(report.observations.filter((observation) => observation.fixtureId === fixtureId)
      .map((observation) => observation.order)).toEqual([
        ["raw", "schema3"],
        ["schema3", "raw"],
      ]);
  }
  expect(new Set(report.observations.map((observation) => observation.requestNonce)).size).toBe(
    PAIRED_FULL_AGENT_FIXTURE_IDS.length * 2,
  );
  for (const observation of report.observations) {
    expect(observation).toMatchObject({
      baselineCondition: "raw",
      treatmentCondition: "schema3",
      baseline: {
        condition: "raw",
        firstReductionProviderRoundOrdinal: null,
        softBandRoundCount: 1,
        preservedSoftBandRoundCount: 1,
        totalCachedInputTokens: 1_000,
        totalUncachedInputTokens: 5_000,
      },
      treatment: {
        condition: "schema3",
        firstReductionProviderRoundOrdinal: 1,
        softBandRoundCount: 1,
        preservedSoftBandRoundCount: 0,
        totalCachedInputTokens: 500,
        totalUncachedInputTokens: 4_000,
      },
    });
    const pairCalls = calls.filter((call) => call.fixtureId === observation.fixtureId
      && call.nonce === observation.requestNonce);
    expect(pairCalls.map((call) => call.condition)).toEqual(observation.order);
    expect(new Set(pairCalls.map((call) => call.nonce)).size).toBe(1);
  }
  expect(report.summary).toMatchObject({
    measuredPairs: PAIRED_FULL_AGENT_FIXTURE_IDS.length * 2,
    operationallyValidPairs: PAIRED_FULL_AGENT_FIXTURE_IDS.length * 2,
    experimentValid: true,
    discriminatingPairs: 0,
    timingDiscriminated: true,
    provenanceComplete: true,
    workspaceQualityEligible: true,
    baselineSuccessRate: 1,
    treatmentSuccessRate: 1,
    treatmentOnlyFailures: 0,
    baselineOnlyFailures: 0,
    medianBaselineMinusTreatmentInputTokens: 1_500,
    medianBaselineMinusTreatmentProviderDurationMs: 40,
    medianBaselineMinusTreatmentTaskDurationMs: 30,
    medianBaselineMinusTreatmentTimeToFirstOutputMs: 40,
    geometricMeanBaselineToTreatmentTimeToFirstOutputRatio: 5 / 3,
  });
  expect(report.fixtureSummaries.every((summary) => summary.baselineSuccessRate === 1
    && summary.treatmentSuccessRate === 1
    && summary.medianBaselineMinusTreatmentInputTokens === 1_500)).toBe(true);
});

test("full-agent context benchmark compares soft and delayed-hard policies with generic labels", async () => {
  const report = await runFullAgentContextBenchmark(
    { ...config(), comparison: "soft-delayed-hard" },
    dependencies(async (benchmarkConfig) => agentReport(benchmarkConfig, true)),
  );

  expect(report.observations).toHaveLength(CACHE_TIMING_FULL_AGENT_FIXTURE_IDS.length * 2);
  for (const fixtureId of CACHE_TIMING_FULL_AGENT_FIXTURE_IDS) {
    expect(report.observations.filter((observation) => observation.fixtureId === fixtureId)
      .map((observation) => observation.order)).toEqual([
        ["schema3", "delayed-hard"],
        ["delayed-hard", "schema3"],
      ]);
  }
  expect(report.observations[0]).toMatchObject({
    baselineCondition: "schema3",
    treatmentCondition: "delayed-hard",
    baseline: { condition: "schema3", reductionActionCount: 1, preservedSoftBandRoundCount: 0 },
    treatment: {
      condition: "delayed-hard",
      reductionActionCount: 0,
      firstReductionProviderRoundOrdinal: null,
      softBandRoundCount: 1,
      preservedSoftBandRoundCount: 1,
      totalCachedInputTokens: 2_000,
      totalUncachedInputTokens: 4_000,
    },
    paired: { baselineMinusTreatmentInputTokens: -1_500 },
  });
  expect(report.summary).toMatchObject({
    experimentValid: true,
    discriminatingPairs: PAIRED_FULL_AGENT_FIXTURE_IDS.length * 2,
    timingDiscriminated: true,
    hardBoundaryReductionPairs: 2,
    hardBoundaryExercised: true,
    baselineSuccessRate: 1,
    treatmentSuccessRate: 1,
    treatmentOnlyFailures: 0,
    medianBaselineMinusTreatmentInputTokens: -1_500,
    medianBaselineMinusTreatmentProviderDurationMs: -30,
  });
});

test("full-agent context benchmark retains treatment-only failures as quality evidence", async () => {
  const report = await runFullAgentContextBenchmark(config(), dependencies(async (benchmarkConfig) => agentReport(
    benchmarkConfig,
    benchmarkConfig.contextPolicy !== "schema3" || benchmarkConfig.fixtureId !== PAIRED_FULL_AGENT_FIXTURE_IDS[2],
  )));

  expect(report.summary).toMatchObject({
    measuredPairs: PAIRED_FULL_AGENT_FIXTURE_IDS.length * 2,
    operationallyValidPairs: PAIRED_FULL_AGENT_FIXTURE_IDS.length * 2,
    experimentValid: false,
    workspaceQualityEligible: false,
    baselineSuccessRate: 1,
    treatmentSuccessRate: (PAIRED_FULL_AGENT_FIXTURE_IDS.length - 1) / PAIRED_FULL_AGENT_FIXTURE_IDS.length,
    treatmentOnlyFailures: 2,
  });
  expect(report.fixtureSummaries[2]).toMatchObject({
    fixtureId: PAIRED_FULL_AGENT_FIXTURE_IDS[2],
    baselineSuccessRate: 1,
    treatmentSuccessRate: 0,
    treatmentOnlyFailures: 2,
  });
});

test("full-agent context benchmark excludes an invalid delayed-hard policy", async () => {
  const report = await runFullAgentContextBenchmark(
    { ...config(), comparison: "soft-delayed-hard" },
    dependencies(async (benchmarkConfig) => agentReport(benchmarkConfig, true, {
      invalidDelayedPolicy: benchmarkConfig.contextPolicy === "delayed-hard",
    })),
  );

  expect(report.observations.every((observation) => !observation.operationallyValid
    && observation.exclusionReason === "delayed-hard condition violated its context policy")).toBe(true);
  expect(report.summary).toMatchObject({ operationallyValidPairs: 0, experimentValid: false });
});

test("full-agent context benchmark reports cache totals only with complete per-round telemetry", async () => {
  const report = await runFullAgentContextBenchmark(
    { ...config(), comparison: "soft-delayed-hard" },
    dependencies(async (benchmarkConfig) => agentReport(benchmarkConfig, true, {
      omitCachedUsage: benchmarkConfig.contextPolicy === "delayed-hard",
    })),
  );

  expect(report.observations[0]?.baseline).toMatchObject({
    totalCachedInputTokens: 500,
    totalUncachedInputTokens: 4_000,
  });
  expect(report.observations[0]?.treatment).toMatchObject({
    totalCachedInputTokens: null,
    totalUncachedInputTokens: null,
  });
});

test("soft-delayed comparison fails closed without a timing-discriminating pair", async () => {
  const report = await runFullAgentContextBenchmark(
    { ...config(), comparison: "soft-delayed-hard" },
    dependencies(async (benchmarkConfig) => agentReport(benchmarkConfig, true, { noSoftBand: true })),
  );

  expect(report.summary).toMatchObject({
    discriminatingPairs: 0,
    timingDiscriminated: false,
    experimentValid: false,
  });
});

test("full-agent context benchmark rejects an unknown comparison", async () => {
  await expect(runFullAgentContextBenchmark({
    ...config(),
    comparison: "unknown" as "raw-schema3",
  }, dependencies(async (benchmarkConfig) => agentReport(benchmarkConfig, true)))).rejects.toThrow(
    "comparison is invalid",
  );
});

test("full-agent context benchmark rejects incomplete provenance before agent execution", async () => {
  let calls = 0;
  const complete = dependencies(async (benchmarkConfig) => {
    calls += 1;
    return agentReport(benchmarkConfig, true);
  });

  await expect(runFullAgentContextBenchmark(config(), { ...complete, sourceRevision: undefined })).rejects.toThrow(
    "requires complete runtime and source provenance",
  );
  expect(calls).toBe(0);
});

test("full-agent context benchmark permits only a declared runner change between order blocks", async () => {
  let runnerPid = 100;
  const transitionSequences: number[] = [];
  const benchmarkDependencies = dependencies(async (benchmarkConfig) => agentReport(benchmarkConfig, true));
  benchmarkDependencies.runnerSnapshot = () => ({
    observedAt: "2026-08-28T00:00:00.000Z",
    processes: [{ pid: runnerPid, commandLine: "ollama runner --ctx-size 8192" }],
  });
  benchmarkDependencies.betweenOrderBlocks = async (completedSequence) => {
    transitionSequences.push(completedSequence);
    runnerPid = 200;
  };

  const report = await runFullAgentContextBenchmark(config(), benchmarkDependencies);

  expect(transitionSequences).toEqual([0]);
  expect(report.blockTransitions).toHaveLength(1);
  expect(report.blockTransitions[0]).toMatchObject({
    afterSequence: 0,
    runner: { before: { processes: [{ pid: 100 }] }, after: { processes: [{ pid: 200 }] } },
  });
  expect(report.summary).toMatchObject({ experimentValid: true, provenanceComplete: true });
});

test("full-agent context benchmark rejects a declared transition that retains the runner", async () => {
  const benchmarkDependencies = dependencies(async (benchmarkConfig) => agentReport(benchmarkConfig, true));
  benchmarkDependencies.betweenOrderBlocks = async () => {};

  const report = await runFullAgentContextBenchmark(config(), benchmarkDependencies);

  expect(report.blockTransitions).toHaveLength(1);
  expect(report.summary).toMatchObject({ experimentValid: false, provenanceComplete: false });
});

function config(): FullAgentContextBenchmarkConfig {
  return {
    model: "test-model",
    warmupPairsPerFixture: 0,
    measuredPairsPerFixture: 2,
    timeoutMs: 10_000,
    maxOutputTokens: 1_536,
    temperature: 0,
    seed: 42,
    contextWindow: 8_192,
    externalPowerContext: "controlled-test-power",
  };
}

function dependencies(
  runAgent: (config: AgentBenchmarkConfig, dependencies: AgentBenchmarkDependencies) => Promise<AgentBenchmarkReport>,
): FullAgentContextBenchmarkDependencies {
  return {
    processor: processor(),
    endpoint: "http://127.0.0.1:11435/v1",
    backendVersion: "test-backend",
    modelDigest: "test-digest",
    sourceRevision: "test-revision",
    memorySnapshot: () => null,
    powerSnapshot: () => ({
      observedAt: "2026-08-28T00:00:00.000Z",
      source: "ac" as const,
      batteryPercent: 80,
      batteryStatus: "AC attached",
      currentPowerMode: 2,
      batteryPowerMode: 1,
      acPowerMode: 2,
    }),
    runnerSnapshot: () => ({
      observedAt: "2026-08-28T00:00:00.000Z",
      processes: [{ pid: 100, commandLine: "ollama runner --ctx-size 8192" }],
    }),
    runAgent,
  };
}

function processor(): TurnProcessor {
  return {
    providerId: "test-provider",
    modelId: "test-model",
    contextCapacity: 8_192,
    maxOutputTokens: 1_536,
    temperature: 0,
    seed: 42,
    runtimeStatus: () => profileStatus(),
    async listModels() {
      return [{ id: "test-model", provider: "test-provider", contextWindow: 8_192 }];
    },
    async *stream() {
      throw new Error("Mock agent runner should replace the processor");
    },
  };
}

function agentReport(
  config: AgentBenchmarkConfig,
  success: boolean,
  options: { invalidDelayedPolicy?: boolean; omitCachedUsage?: boolean; noSoftBand?: boolean } = {},
): AgentBenchmarkReport {
  const condition = config.contextPolicy ?? "schema3";
  const schema3 = condition === "schema3";
  const delayedHard = condition === "delayed-hard";
  const hardBoundary = config.fixtureId === "schema3-long-session-calibration-v1" && !options.noSoftBand;
  const mustReduce = schema3 || (delayedHard && hardBoundary);
  const inputTokens = options.noSoftBand ? 5_000 : mustReduce ? 4_500 : 6_000;
  const durationMs = schema3 ? 70 : delayedHard ? 90 : 100;
  const providerDurationMs = schema3 ? 60 : delayedHard ? 90 : 100;
  const timeToFirstOutputMs = schema3 ? 60 : delayedHard ? 90 : 100;
  const cachedInputTokens = schema3 ? 500 : delayedHard ? 2_000 : 1_000;
  const observation: AgentBenchmarkObservation = {
    sequence: 0,
    phase: "measured",
    durationMs,
    status: "completed",
    success,
    expectedMarkerFound: success,
    requiredToolsObserved: success,
    maximumToolCallsObserved: true,
    workspaceValid: success,
    requiredCommandSucceeded: success,
    requiredCompactionObserved: true,
    exactToolCallsObserved: true,
    exactModelRoundsObserved: true,
    workspaceTransitionsValid: success,
    requiredContextReductionObserved: true,
    providerUsageCalibrationValid: true,
    modelRounds: 1,
    toolCalls: 1,
    toolNames: ["read_file"],
    inputTokens,
    outputTokens: 10,
    providerQueueDurationMs: 0,
    providerDurationMs,
    providerTimeToFirstOutputMs: [timeToFirstOutputMs],
    contextTrimEvents: 0,
    providerRounds: [{
      providerCallId: `${config.fixtureId}-${config.contextPolicy}`,
      turnId: "turn",
      turnIndex: 1,
      roundIndex: 0,
      shape: "tool_follow_up",
      contextPlan: {
        schemaVersion: 3,
        estimator: { method: "openai-json-utf8-bytes-divisor-3", version: 2, safetyFactor: 1.2 },
        capacityTokens: 8_192,
        reserves: { outputTokens: 1_536, toolResultTokens: 768, safetyTokens: 512, totalTokens: 2_816 },
        maximumPlannedInputTokens: 5_376,
        hardInputLimitTokens: options.invalidDelayedPolicy ? null : 6_656,
        originalEstimatedInputTokens: options.noSoftBand ? 5_000 : hardBoundary ? 7_000 : 6_000,
        estimatedInputTokens: inputTokens,
        estimatedMessageTokens: inputTokens,
        estimatedToolDefinitionTokens: 0,
        budgetStatus: mustReduce || options.noSoftBand ? "within_soft_limit" : "over_soft_limit",
        actions: mustReduce && !options.noSoftBand ? [{
          kind: "truncate_historical_tool_output",
          messageIndex: 1,
          originalCharacters: 3_000,
          compactedCharacters: 1_000,
          removedLines: 20,
          estimatedTokensSaved: 500,
        }] : [],
      },
      usage: {
        inputTokens,
        outputTokens: 10,
        totalTokens: inputTokens + 10,
        ...(!options.omitCachedUsage ? { cachedInputTokens } : {}),
      },
      outcome: "completed",
      queueDurationMs: 0,
      durationMs: providerDurationMs,
      timeToFirstOutputMs,
      inputTokens,
      outputTokens: 10,
      totalTokens: inputTokens + 10,
      calibration: {
        eligible: true,
        exclusionReason: null,
        estimateErrorTokens: 0,
        estimateToActualRatio: 1,
        requiredCalibrationFactor: 1,
      },
    }],
    turnResponses: [success ? "PASS" : "FAIL"],
    responseText: success ? "PASS" : "FAIL",
  };
  return {
    observations: [observation],
    runtime: { profileStatus: profileStatus() },
    memory: { before: null, after: null, delta: null },
  } as unknown as AgentBenchmarkReport;
}

function profileStatus(): RuntimeProfileStatus {
  return {
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
}
