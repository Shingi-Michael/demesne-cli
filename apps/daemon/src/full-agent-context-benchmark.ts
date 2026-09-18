#!/usr/bin/env bun

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { isRecord, type RuntimeProfileStatus } from "@demesne/protocol";
import { OpenAICompatibleProvider } from "@demesne/providers";
import {
  CACHE_TIMING_FULL_AGENT_FIXTURE_IDS,
  PAIRED_FULL_AGENT_FIXTURE_IDS,
  runAgentBenchmark,
  type AgentBenchmarkConfig,
  type AgentBenchmarkDependencies,
  type AgentBenchmarkObservation,
  type AgentBenchmarkReport,
} from "./agent-benchmark.ts";
import { createRuntimeProfileVerifier } from "./ollama-runtime.ts";
import {
  calculateHostMemoryDelta,
  readHostMemorySnapshot,
  readHostPowerSnapshot,
  readOllamaRunnerSnapshot,
  type HostMemorySnapshot,
  type HostPowerSnapshot,
  type OllamaRunnerSnapshot,
} from "./provider-benchmark.ts";
import { ProviderTurnProcessor } from "./provider-processor.ts";
import type { TurnProcessor } from "./processor.ts";

export const FULL_AGENT_CONTEXT_BENCHMARK_SCHEMA_VERSION = 3 as const;
const FULL_AGENT_CONTEXT_CAPACITY = 8_192;
const FULL_AGENT_OUTPUT_RESERVE = 1_536;
const FULL_AGENT_HARD_INPUT_LIMIT = FULL_AGENT_CONTEXT_CAPACITY - FULL_AGENT_OUTPUT_RESERVE;
export type FullAgentContextCondition = "raw" | "schema3" | "delayed-hard";
export type FullAgentContextComparison = "raw-schema3" | "soft-delayed-hard";
type FullAgentContextFixtureId = (typeof CACHE_TIMING_FULL_AGENT_FIXTURE_IDS)[number];

export interface FullAgentContextBenchmarkConfig {
  comparison?: FullAgentContextComparison;
  model: string;
  warmupPairsPerFixture: number;
  measuredPairsPerFixture: number;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
  seed: number;
  contextWindow: number;
  externalPowerContext: string;
}

export interface FullAgentConditionMeasurement {
  condition: FullAgentContextCondition;
  observation: AgentBenchmarkObservation;
  profileStatus: RuntimeProfileStatus;
  memory: AgentBenchmarkReport["memory"];
  firstReductionProviderRoundOrdinal: number | null;
  softBandRoundCount: number;
  preservedSoftBandRoundCount: number;
  totalCachedInputTokens: number | null;
  totalUncachedInputTokens: number | null;
  reductionActionCount: number;
  inputWithinHardLimit: boolean;
  policyValid: boolean;
}

export interface FullAgentContextObservation {
  fixtureId: FullAgentContextFixtureId;
  sequence: number;
  phase: "warmup" | "measured";
  baselineCondition: FullAgentContextCondition;
  treatmentCondition: FullAgentContextCondition;
  order: [FullAgentContextCondition, FullAgentContextCondition];
  requestNonce: string;
  powerBefore: HostPowerSnapshot | null;
  powerAfter: HostPowerSnapshot | null;
  runnerBefore: OllamaRunnerSnapshot | null;
  runnerAfter: OllamaRunnerSnapshot | null;
  baseline: FullAgentConditionMeasurement;
  treatment: FullAgentConditionMeasurement;
  operationallyValid: boolean;
  exclusionReason: string | null;
  treatmentOnlyFailure: boolean;
  paired: {
    baselineMinusTreatmentInputTokens: number | null;
    baselineMinusTreatmentInputTokenRatio: number | null;
    baselineMinusTreatmentProviderDurationMs: number | null;
    baselineMinusTreatmentTaskDurationMs: number | null;
    baselineMinusTreatmentTimeToFirstOutputMs: number | null;
    baselineToTreatmentTimeToFirstOutputLogRatio: number | null;
  };
}

export interface FullAgentContextBlockTransition {
  afterSequence: number;
  startedAt: string;
  completedAt: string;
  memory: {
    before: HostMemorySnapshot | null;
    after: HostMemorySnapshot | null;
    delta: ReturnType<typeof calculateHostMemoryDelta>;
  };
  power: { before: HostPowerSnapshot | null; after: HostPowerSnapshot | null };
  runner: { before: OllamaRunnerSnapshot | null; after: OllamaRunnerSnapshot | null };
}

interface FullAgentFixtureSummary {
  fixtureId: FullAgentContextFixtureId;
  measuredPairs: number;
  operationallyValidPairs: number;
  baselineSuccessRate: number;
  treatmentSuccessRate: number;
  treatmentOnlyFailures: number;
  baselineOnlyFailures: number;
  medianBaselineInputTokens: number | null;
  medianTreatmentInputTokens: number | null;
  medianBaselineMinusTreatmentInputTokens: number | null;
  medianBaselineMinusTreatmentProviderDurationMs: number | null;
  medianBaselineMinusTreatmentTaskDurationMs: number | null;
  medianBaselineMinusTreatmentTimeToFirstOutputMs: number | null;
  geometricMeanBaselineToTreatmentTimeToFirstOutputRatio: number | null;
}

export interface FullAgentContextBenchmarkReport {
  schemaVersion: typeof FULL_AGENT_CONTEXT_BENCHMARK_SCHEMA_VERSION;
  startedAt: string;
  machine: {
    platform: string;
    architecture: string;
    osRelease: string;
    totalMemoryBytes: number;
    bunVersion: string;
  };
  runtime: {
    provider: string;
    model: string;
    endpoint: string | null;
    backendVersion: string | null;
    modelDigest: string | null;
    sourceRevision: string | null;
    externalPowerContext: string;
    profileStatus: RuntimeProfileStatus;
  };
  config: FullAgentContextBenchmarkConfig;
  fixtureIds: readonly FullAgentContextFixtureId[];
  memory: {
    before: HostMemorySnapshot | null;
    after: HostMemorySnapshot | null;
    delta: ReturnType<typeof calculateHostMemoryDelta>;
  };
  power: { before: HostPowerSnapshot | null; after: HostPowerSnapshot | null };
  runner: { before: OllamaRunnerSnapshot | null; after: OllamaRunnerSnapshot | null };
  observations: FullAgentContextObservation[];
  blockTransitions: FullAgentContextBlockTransition[];
  fixtureSummaries: FullAgentFixtureSummary[];
  summary: {
    measuredPairs: number;
    operationallyValidPairs: number;
    experimentValid: boolean;
    discriminatingPairs: number;
    timingDiscriminated: boolean;
    hardBoundaryReductionPairs: number;
    hardBoundaryExercised: boolean;
    provenanceComplete: boolean;
    workspaceQualityEligible: boolean;
    baselineSuccessRate: number;
    treatmentSuccessRate: number;
    treatmentOnlyFailures: number;
    baselineOnlyFailures: number;
    medianBaselineMinusTreatmentInputTokens: number | null;
    medianBaselineMinusTreatmentProviderDurationMs: number | null;
    medianBaselineMinusTreatmentTaskDurationMs: number | null;
    medianBaselineMinusTreatmentTimeToFirstOutputMs: number | null;
    geometricMeanBaselineToTreatmentTimeToFirstOutputRatio: number | null;
  };
}

export interface FullAgentContextBenchmarkDependencies {
  processor: TurnProcessor;
  endpoint?: string;
  backendVersion?: string;
  modelDigest?: string;
  sourceRevision?: string;
  memorySnapshot?: () => HostMemorySnapshot | null;
  powerSnapshot?: () => HostPowerSnapshot | null;
  runnerSnapshot?: () => OllamaRunnerSnapshot | null;
  runAgent?: (config: AgentBenchmarkConfig, dependencies: AgentBenchmarkDependencies) => Promise<AgentBenchmarkReport>;
  betweenOrderBlocks?: (completedSequence: number) => Promise<void>;
}

export async function runFullAgentContextBenchmark(
  config: FullAgentContextBenchmarkConfig,
  dependencies: FullAgentContextBenchmarkDependencies,
): Promise<FullAgentContextBenchmarkReport> {
  validateConfig(config, dependencies.processor);
  if (!nonempty(dependencies.endpoint) || !nonempty(dependencies.backendVersion)
    || !nonempty(dependencies.modelDigest) || !nonempty(dependencies.sourceRevision)
    || config.externalPowerContext === "unspecified-external-power") {
    throw new Error("Full-agent context benchmark requires complete runtime and source provenance");
  }
  if (dependencies.processor.runtimeStatus?.().state !== "verified") {
    throw new Error("Full-agent context runtime profile must be verified before the benchmark starts");
  }
  const memorySnapshot = dependencies.memorySnapshot ?? readHostMemorySnapshot;
  const powerSnapshot = dependencies.powerSnapshot ?? readHostPowerSnapshot;
  const runnerSnapshot = dependencies.runnerSnapshot ?? readOllamaRunnerSnapshot;
  const agentRun = dependencies.runAgent ?? runAgentBenchmark;
  const startedAt = new Date().toISOString();
  const memoryBefore = memorySnapshot();
  const powerBefore = powerSnapshot();
  const runnerBefore = runnerSnapshot();
  if (!validAcPower(powerBefore) || runnerBefore === null || runnerBefore.processes.length !== 1) {
    throw new Error("Full-agent context preflight requires AC mode 2 and one preloaded runner");
  }

  const observations: FullAgentContextObservation[] = [];
  const blockTransitions: FullAgentContextBlockTransition[] = [];
  const comparison = config.comparison ?? "raw-schema3";
  const [baselineCondition, treatmentCondition] = comparisonConditions(comparison);
  const fixtureIds: readonly FullAgentContextFixtureId[] = comparison === "raw-schema3"
    ? PAIRED_FULL_AGENT_FIXTURE_IDS
    : CACHE_TIMING_FULL_AGENT_FIXTURE_IDS;
  const pairCount = config.warmupPairsPerFixture + config.measuredPairsPerFixture;
  for (let sequence = 0; sequence < pairCount; sequence += 1) {
    const fixtureOrder = rotate([...fixtureIds], sequence % fixtureIds.length);
    for (const fixtureId of fixtureOrder) {
      const order: [FullAgentContextCondition, FullAgentContextCondition] = sequence % 2 === 0
        ? [baselineCondition, treatmentCondition]
        : [treatmentCondition, baselineCondition];
      const requestNonce = Bun.CryptoHasher.hash("sha256", `${fixtureId}:${startedAt}:${sequence}`, "hex");
      const pairPowerBefore = powerSnapshot();
      const pairRunnerBefore = runnerSnapshot();
      const byCondition = new Map<FullAgentContextCondition, FullAgentConditionMeasurement>();
      for (const condition of order) {
        const report = await agentRun({
          fixtureId,
          model: config.model,
          warmupRuns: 0,
          measuredRuns: 1,
          timeoutMs: config.timeoutMs,
          maxOutputTokens: config.maxOutputTokens,
          temperature: config.temperature,
          seed: config.seed,
          contextPolicy: condition,
        }, {
          processor: dependencies.processor,
          endpoint: dependencies.endpoint,
          backendVersion: dependencies.backendVersion,
          modelDigest: dependencies.modelDigest,
          sourceRevision: dependencies.sourceRevision,
          memorySnapshot,
          powerSnapshot,
          systemPromptNonce: requestNonce,
        });
        byCondition.set(condition, conditionMeasurement(condition, report));
      }
      const baseline = byCondition.get(baselineCondition)!;
      const treatment = byCondition.get(treatmentCondition)!;
      const pairPowerAfter = powerSnapshot();
      const pairRunnerAfter = runnerSnapshot();
      const exclusionReason = operationalExclusion(
        baseline,
        treatment,
        pairPowerBefore,
        pairPowerAfter,
        pairRunnerBefore,
        pairRunnerAfter,
      );
      observations.push({
        fixtureId,
        sequence,
        phase: sequence < config.warmupPairsPerFixture ? "warmup" : "measured",
        baselineCondition,
        treatmentCondition,
        order,
        requestNonce,
        powerBefore: pairPowerBefore,
        powerAfter: pairPowerAfter,
        runnerBefore: pairRunnerBefore,
        runnerAfter: pairRunnerAfter,
        baseline,
        treatment,
        operationallyValid: exclusionReason === null,
        exclusionReason,
        treatmentOnlyFailure: baseline.observation.success && !treatment.observation.success,
        paired: pairedMetrics(baseline.observation, treatment.observation),
      });
    }
    if (dependencies.betweenOrderBlocks && sequence + 1 < pairCount) {
      const transitionStartedAt = new Date().toISOString();
      const transitionMemoryBefore = memorySnapshot();
      const transitionPowerBefore = powerSnapshot();
      const transitionRunnerBefore = runnerSnapshot();
      await dependencies.betweenOrderBlocks(sequence);
      const transitionMemoryAfter = memorySnapshot();
      const transitionPowerAfter = powerSnapshot();
      const transitionRunnerAfter = runnerSnapshot();
      blockTransitions.push({
        afterSequence: sequence,
        startedAt: transitionStartedAt,
        completedAt: new Date().toISOString(),
        memory: {
          before: transitionMemoryBefore,
          after: transitionMemoryAfter,
          delta: calculateHostMemoryDelta(transitionMemoryBefore, transitionMemoryAfter),
        },
        power: { before: transitionPowerBefore, after: transitionPowerAfter },
        runner: { before: transitionRunnerBefore, after: transitionRunnerAfter },
      });
    }
  }

  const memoryAfter = memorySnapshot();
  const powerAfter = powerSnapshot();
  const runnerAfter = runnerSnapshot();
  const measured = observations.filter((observation) => observation.phase === "measured");
  const operational = measured.filter((observation) => observation.operationallyValid);
  const profileStatus = dependencies.processor.runtimeStatus?.() ?? unconfiguredProfileStatus();
  const provenanceComplete = profileStatus.state === "verified"
    && profileStatus.observed?.contextWindow === config.contextWindow
    && nonempty(dependencies.endpoint) && nonempty(dependencies.backendVersion)
    && nonempty(dependencies.modelDigest) && nonempty(dependencies.sourceRevision)
    && config.externalPowerContext !== "unspecified-external-power"
    && validAcPower(powerBefore) && validAcPower(powerAfter)
    && measured.every((observation) => validAcPower(observation.powerBefore) && validAcPower(observation.powerAfter))
    && stableRunnerEpochs(runnerBefore, runnerAfter, observations, blockTransitions);
  const workspaceQualityEligible = measured.length > 0 && measured.every((observation) =>
    observation.baseline.observation.success
      && observation.treatment.observation.success
      && !observation.treatmentOnlyFailure
  );
  const discriminatingPairs = measured.filter((observation) =>
    observation.baseline.softBandRoundCount > 0
      && observation.baseline.reductionActionCount > 0
      && observation.treatment.preservedSoftBandRoundCount > 0
  ).length;
  const timingDiscriminated = comparison === "raw-schema3" || discriminatingPairs > 0;
  const hardBoundaryReductionPairs = measured.filter((observation) =>
    observation.treatment.condition === "delayed-hard"
      && observation.treatment.observation.providerRounds.some((round) => {
        const plan = round.contextPlan;
        return plan !== null && plan.hardInputLimitTokens !== null
          && plan.originalEstimatedInputTokens > plan.hardInputLimitTokens
          && plan.actions.length > 0
          && plan.estimatedInputTokens <= plan.hardInputLimitTokens;
      })
  ).length;
  const hardBoundaryExercised = comparison === "raw-schema3" || hardBoundaryReductionPairs > 0;
  const fixtureSummaries = fixtureIds.map((fixtureId) => fixtureSummary(fixtureId, measured));
  const fixtureLogRatios = fixtureSummaries
    .map((summary) => summary.geometricMeanBaselineToTreatmentTimeToFirstOutputRatio)
    .filter((value): value is number => value !== null && value > 0)
    .map(Math.log);

  return {
    schemaVersion: FULL_AGENT_CONTEXT_BENCHMARK_SCHEMA_VERSION,
    startedAt,
    machine: {
      platform: platform(),
      architecture: process.arch,
      osRelease: release(),
      totalMemoryBytes: totalmem(),
      bunVersion: Bun.version,
    },
    runtime: {
      provider: dependencies.processor.providerId,
      model: config.model,
      endpoint: dependencies.endpoint ?? null,
      backendVersion: dependencies.backendVersion ?? null,
      modelDigest: dependencies.modelDigest ?? null,
      sourceRevision: dependencies.sourceRevision ?? null,
      externalPowerContext: config.externalPowerContext,
      profileStatus,
    },
    config: { ...config, comparison },
    fixtureIds,
    memory: { before: memoryBefore, after: memoryAfter, delta: calculateHostMemoryDelta(memoryBefore, memoryAfter) },
    power: { before: powerBefore, after: powerAfter },
    runner: { before: runnerBefore, after: runnerAfter },
    observations,
    blockTransitions,
    fixtureSummaries,
    summary: {
      measuredPairs: measured.length,
      operationallyValidPairs: operational.length,
      experimentValid: operational.length === measured.length && provenanceComplete
        && workspaceQualityEligible && timingDiscriminated && hardBoundaryExercised,
      discriminatingPairs,
      timingDiscriminated,
      hardBoundaryReductionPairs,
      hardBoundaryExercised,
      provenanceComplete,
      workspaceQualityEligible,
      baselineSuccessRate: rate(measured, (observation) => observation.baseline.observation.success),
      treatmentSuccessRate: rate(measured, (observation) => observation.treatment.observation.success),
      treatmentOnlyFailures: measured.filter((observation) => observation.treatmentOnlyFailure).length,
      baselineOnlyFailures: measured.filter((observation) =>
        !observation.baseline.observation.success && observation.treatment.observation.success
      ).length,
      medianBaselineMinusTreatmentInputTokens: medianKnown(
        operational.map((observation) => observation.paired.baselineMinusTreatmentInputTokens),
      ),
      medianBaselineMinusTreatmentProviderDurationMs: medianKnown(
        operational.map((observation) => observation.paired.baselineMinusTreatmentProviderDurationMs),
      ),
      medianBaselineMinusTreatmentTaskDurationMs: medianKnown(
        operational.map((observation) => observation.paired.baselineMinusTreatmentTaskDurationMs),
      ),
      medianBaselineMinusTreatmentTimeToFirstOutputMs: medianKnown(
        operational.map((observation) => observation.paired.baselineMinusTreatmentTimeToFirstOutputMs),
      ),
      geometricMeanBaselineToTreatmentTimeToFirstOutputRatio:
        fixtureLogRatios.length === fixtureIds.length
          ? Math.exp(mean(fixtureLogRatios))
          : null,
    },
  };
}

function conditionMeasurement(
  condition: FullAgentContextCondition,
  report: AgentBenchmarkReport,
): FullAgentConditionMeasurement {
  const observation = report.observations.find((candidate) => candidate.phase === "measured");
  if (!observation || report.observations.filter((candidate) => candidate.phase === "measured").length !== 1) {
    throw new Error("Full-agent condition must produce exactly one measured observation");
  }
  const reductionActionCount = observation.providerRounds.reduce(
    (total, round) => total + (round.contextPlan?.actions.length ?? 0),
    0,
  );
  const firstReductionIndex = observation.providerRounds.findIndex((round) => (round.contextPlan?.actions.length ?? 0) > 0);
  const softBandRounds = observation.providerRounds.filter((round) => {
    const plan = round.contextPlan;
    return plan !== null && plan.maximumPlannedInputTokens !== null && plan.hardInputLimitTokens !== null
      && plan.originalEstimatedInputTokens > plan.maximumPlannedInputTokens
      && plan.originalEstimatedInputTokens <= plan.hardInputLimitTokens;
  });
  const cacheUsage = observation.providerRounds.map((round) => {
    const cached = round.usage?.cachedInputTokens;
    return cached !== undefined && nonnegativeInteger(cached) && nonnegativeInteger(round.inputTokens)
      && cached <= round.inputTokens
      ? { cached, uncached: round.inputTokens - cached }
      : null;
  });
  const totalCachedInputTokens = sumKnown(cacheUsage.map((usage) => usage?.cached ?? null));
  const totalUncachedInputTokens = sumKnown(cacheUsage.map((usage) => usage?.uncached ?? null));
  return {
    condition,
    observation,
    profileStatus: report.runtime.profileStatus,
    memory: report.memory,
    firstReductionProviderRoundOrdinal: firstReductionIndex < 0 ? null : firstReductionIndex + 1,
    softBandRoundCount: softBandRounds.length,
    preservedSoftBandRoundCount: softBandRounds.filter((round) => round.contextPlan?.actions.length === 0).length,
    totalCachedInputTokens,
    totalUncachedInputTokens,
    reductionActionCount,
    inputWithinHardLimit: observation.providerRounds.every((round) =>
      round.inputTokens !== null && round.inputTokens <= FULL_AGENT_HARD_INPUT_LIMIT
    ),
    policyValid: conditionPolicyValid(condition, observation, reductionActionCount),
  };
}

function operationalExclusion(
  baseline: FullAgentConditionMeasurement,
  treatment: FullAgentConditionMeasurement,
  powerBefore: HostPowerSnapshot | null,
  powerAfter: HostPowerSnapshot | null,
  runnerBefore: OllamaRunnerSnapshot | null,
  runnerAfter: OllamaRunnerSnapshot | null,
): string | null {
  if (baseline.observation.status !== "completed" || treatment.observation.status !== "completed") {
    return "agent run did not complete";
  }
  if (!validObservationUsage(baseline.observation) || !validObservationUsage(treatment.observation)) {
    return "provider usage is incomplete";
  }
  if (!baseline.inputWithinHardLimit || !treatment.inputWithinHardLimit) {
    return "provider input exceeded the hard input gate";
  }
  if (!baseline.policyValid) return `${baseline.condition} condition violated its context policy`;
  if (!treatment.policyValid) return `${treatment.condition} condition violated its context policy`;
  if (baseline.profileStatus.state !== "verified" || treatment.profileStatus.state !== "verified") {
    return "runtime profile was not verified";
  }
  if (!validAcPower(powerBefore) || !validAcPower(powerAfter)) return "power source or mode changed";
  if (!sameRunner(runnerBefore, runnerAfter)) return "runner identity changed";
  return null;
}

function validObservationUsage(observation: AgentBenchmarkObservation): boolean {
  if (!nonnegativeInteger(observation.inputTokens) || !nonnegativeInteger(observation.outputTokens)
    || observation.providerRounds.length === 0) return false;
  return observation.providerRounds.every((round) => round.outcome === "completed" && round.usage !== null
    && nonnegativeInteger(round.usage.inputTokens) && nonnegativeInteger(round.usage.outputTokens)
    && nonnegativeInteger(round.usage.totalTokens)
    && round.usage.totalTokens === round.usage.inputTokens + round.usage.outputTokens
    && (round.usage.cachedInputTokens === undefined
      || (nonnegativeInteger(round.usage.cachedInputTokens)
        && round.usage.cachedInputTokens <= round.usage.inputTokens)));
}

function pairedMetrics(
  baseline: AgentBenchmarkObservation,
  treatment: AgentBenchmarkObservation,
): FullAgentContextObservation["paired"] {
  const baselineInput = baseline.inputTokens;
  const treatmentInput = treatment.inputTokens;
  const alignedRounds = baseline.modelRounds === treatment.modelRounds
    && baseline.providerTimeToFirstOutputMs.length === treatment.providerTimeToFirstOutputMs.length;
  const baselineFirstOutput = alignedRounds ? sum(baseline.providerTimeToFirstOutputMs) : null;
  const treatmentFirstOutput = alignedRounds ? sum(treatment.providerTimeToFirstOutputMs) : null;
  const comparablePath = alignedRounds && stableJson(baseline.toolNames) === stableJson(treatment.toolNames)
    && baseline.outputTokens === treatment.outputTokens;
  return {
    baselineMinusTreatmentInputTokens: baselineInput !== null && treatmentInput !== null
      ? baselineInput - treatmentInput
      : null,
    baselineMinusTreatmentInputTokenRatio: baselineInput !== null && treatmentInput !== null && baselineInput > 0
      ? (baselineInput - treatmentInput) / baselineInput
      : null,
    baselineMinusTreatmentProviderDurationMs: comparablePath
      && baseline.providerDurationMs !== null && treatment.providerDurationMs !== null
      ? baseline.providerDurationMs - treatment.providerDurationMs
      : null,
    baselineMinusTreatmentTaskDurationMs: comparablePath ? baseline.durationMs - treatment.durationMs : null,
    baselineMinusTreatmentTimeToFirstOutputMs: baselineFirstOutput !== null && treatmentFirstOutput !== null
      ? baselineFirstOutput - treatmentFirstOutput
      : null,
    baselineToTreatmentTimeToFirstOutputLogRatio: baselineFirstOutput !== null && treatmentFirstOutput !== null
      && baselineFirstOutput > 0 && treatmentFirstOutput > 0
      ? Math.log(baselineFirstOutput / treatmentFirstOutput)
      : null,
  };
}

function fixtureSummary(
  fixtureId: FullAgentContextFixtureId,
  measured: FullAgentContextObservation[],
): FullAgentFixtureSummary {
  const fixtureObservations = measured.filter((observation) => observation.fixtureId === fixtureId);
  const operational = fixtureObservations.filter((observation) => observation.operationallyValid);
  const logs = operational.map((observation) => observation.paired.baselineToTreatmentTimeToFirstOutputLogRatio)
    .filter((value): value is number => value !== null);
  return {
    fixtureId,
    measuredPairs: fixtureObservations.length,
    operationallyValidPairs: operational.length,
    baselineSuccessRate: rate(fixtureObservations, (observation) => observation.baseline.observation.success),
    treatmentSuccessRate: rate(fixtureObservations, (observation) => observation.treatment.observation.success),
    treatmentOnlyFailures: fixtureObservations.filter((observation) => observation.treatmentOnlyFailure).length,
    baselineOnlyFailures: fixtureObservations.filter((observation) =>
      !observation.baseline.observation.success && observation.treatment.observation.success
    ).length,
    medianBaselineInputTokens: medianKnown(
      operational.map((observation) => observation.baseline.observation.inputTokens),
    ),
    medianTreatmentInputTokens: medianKnown(
      operational.map((observation) => observation.treatment.observation.inputTokens),
    ),
    medianBaselineMinusTreatmentInputTokens: medianKnown(
      operational.map((observation) => observation.paired.baselineMinusTreatmentInputTokens),
    ),
    medianBaselineMinusTreatmentProviderDurationMs: medianKnown(
      operational.map((observation) => observation.paired.baselineMinusTreatmentProviderDurationMs),
    ),
    medianBaselineMinusTreatmentTaskDurationMs: medianKnown(
      operational.map((observation) => observation.paired.baselineMinusTreatmentTaskDurationMs),
    ),
    medianBaselineMinusTreatmentTimeToFirstOutputMs: medianKnown(
      operational.map((observation) => observation.paired.baselineMinusTreatmentTimeToFirstOutputMs),
    ),
    geometricMeanBaselineToTreatmentTimeToFirstOutputRatio: logs.length > 0 ? Math.exp(mean(logs)) : null,
  };
}

function validateConfig(config: FullAgentContextBenchmarkConfig, processor: TurnProcessor): void {
  if (config.comparison !== undefined && !["raw-schema3", "soft-delayed-hard"].includes(config.comparison)) {
    throw new Error("Full-agent context comparison is invalid");
  }
  if (!config.model.trim() || processor.modelId !== config.model) throw new Error("Full-agent context model mismatch");
  for (const [name, value, minimum, maximum] of [
    ["warmupPairsPerFixture", config.warmupPairsPerFixture, 0, 4],
    ["measuredPairsPerFixture", config.measuredPairsPerFixture, 2, 10],
    ["timeoutMs", config.timeoutMs, 1_000, 30 * 60_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  }
  if (config.warmupPairsPerFixture % 2 !== 0 || config.measuredPairsPerFixture % 2 !== 0) {
    throw new Error("Full-agent context pair counts must contain complete order blocks");
  }
  if (config.contextWindow !== FULL_AGENT_CONTEXT_CAPACITY
    || config.maxOutputTokens !== FULL_AGENT_OUTPUT_RESERVE
    || processor.contextCapacity !== config.contextWindow || processor.maxOutputTokens !== config.maxOutputTokens
    || processor.temperature !== config.temperature || processor.seed !== config.seed) {
    throw new Error("Full-agent context processor defaults mismatch");
  }
  if (!config.externalPowerContext.trim()) throw new Error("External power context is required");
}

function comparisonConditions(
  comparison: FullAgentContextComparison,
): [FullAgentContextCondition, FullAgentContextCondition] {
  return comparison === "raw-schema3" ? ["raw", "schema3"] : ["schema3", "delayed-hard"];
}

function conditionPolicyValid(
  condition: FullAgentContextCondition,
  observation: AgentBenchmarkObservation,
  reductionActionCount: number,
): boolean {
  if (condition === "raw") return reductionActionCount === 0 && observation.contextTrimEvents === 0;
  return observation.providerRounds.every((round) => {
    const plan = round.contextPlan;
    if (!plan) return false;
    if (condition === "schema3") {
      const softLimit = plan.maximumPlannedInputTokens;
      if (softLimit === null) return false;
      if (plan.originalEstimatedInputTokens <= softLimit) return plan.actions.length === 0;
      return round.turnIndex === 0 || plan.actions.length > 0;
    }
    const hardLimit = plan.hardInputLimitTokens;
    if (hardLimit === null || plan.estimatedInputTokens > hardLimit) return false;
    if (plan.originalEstimatedInputTokens <= hardLimit) return plan.actions.length === 0;
    return round.turnIndex === 0 || plan.actions.length > 0;
  });
}

function stableRunnerEpochs(
  before: OllamaRunnerSnapshot | null,
  after: OllamaRunnerSnapshot | null,
  observations: FullAgentContextObservation[],
  transitions: FullAgentContextBlockTransition[],
): boolean {
  if (!before || !after || before.processes.length !== 1 || after.processes.length !== 1) return false;
  const transitionBySequence = new Map(transitions.map((transition) => [transition.afterSequence, transition]));
  if (transitionBySequence.size !== transitions.length) return false;
  let signature = runnerSignature(before);
  const sequences = [...new Set(observations.map((observation) => observation.sequence))].sort((left, right) => left - right);
  for (const sequence of sequences) {
    const sequenceObservations = observations.filter((observation) => observation.sequence === sequence);
    if (!sequenceObservations.every((observation) => observation.runnerBefore !== null
      && observation.runnerAfter !== null
      && runnerSignature(observation.runnerBefore) === signature
      && runnerSignature(observation.runnerAfter) === signature)) return false;
    const transition = transitionBySequence.get(sequence);
    if (!transition) continue;
    const transitionBefore = transition.runner.before;
    const transitionAfter = transition.runner.after;
    if (!validAcPower(transition.power.before) || !validAcPower(transition.power.after)
      || !transitionBefore || !transitionAfter
      || transitionBefore.processes.length !== 1 || transitionAfter.processes.length !== 1
      || runnerSignature(transitionBefore) !== signature) return false;
    const nextSignature = runnerSignature(transitionAfter);
    if (nextSignature === signature) return false;
    signature = nextSignature;
    transitionBySequence.delete(sequence);
  }
  return transitionBySequence.size === 0 && runnerSignature(after) === signature;
}

function sameRunner(before: OllamaRunnerSnapshot | null, after: OllamaRunnerSnapshot | null): boolean {
  return before !== null && after !== null && before.processes.length === 1
    && runnerSignature(before) === runnerSignature(after);
}

function runnerSignature(snapshot: OllamaRunnerSnapshot): string {
  return stableJson([...snapshot.processes].sort((left, right) => left.pid - right.pid));
}

function validAcPower(snapshot: HostPowerSnapshot | null): snapshot is HostPowerSnapshot {
  return snapshot?.source === "ac" && snapshot.currentPowerMode === 2;
}

function medianKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === values.length && known.length > 0 ? median(known) : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function rate<T>(values: T[], predicate: (value: T) => boolean): number {
  return values.length > 0 ? values.filter(predicate).length / values.length : 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumKnown(values: Array<number | null>): number | null {
  return values.length > 0 && values.every((value): value is number => value !== null) ? sum(values) : null;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonempty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function rotate<T>(values: T[], offset: number): T[] {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function unconfiguredProfileStatus(): RuntimeProfileStatus {
  return { profile: null, state: "unconfigured", expected: null, observed: null, mismatches: [], observedAt: null };
}

async function backendVersion(baseUrl: string, apiKey?: string): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/api/version", baseUrl), {
      redirect: "manual",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    return isRecord(value) && typeof value.version === "string" ? value.version : undefined;
  } catch {
    return undefined;
  }
}

async function modelDigest(baseUrl: string, model: string, apiKey?: string): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/api/tags", baseUrl), {
      redirect: "manual",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.models)) return undefined;
    for (const candidate of value.models) {
      if (!isRecord(candidate)) continue;
      const name = typeof candidate.name === "string" ? candidate.name : candidate.model;
      if (name === model && typeof candidate.digest === "string") return candidate.digest;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const model = process.env.DEMESNE_MODEL?.trim();
  if (!model) throw new Error("DEMESNE_MODEL is required");
  const runtimeProfile = process.env.DEMESNE_RUNTIME_PROFILE?.trim();
  if (!runtimeProfile) throw new Error("DEMESNE_RUNTIME_PROFILE is required");
  const sourceRevision = process.env.DEMESNE_SOURCE_REVISION?.trim();
  if (!sourceRevision) throw new Error("DEMESNE_SOURCE_REVISION is required");
  const externalPowerContext = process.env.DEMESNE_EXTERNAL_POWER_CONTEXT?.trim();
  if (!externalPowerContext || externalPowerContext === "unspecified-external-power") {
    throw new Error("DEMESNE_EXTERNAL_POWER_CONTEXT is required");
  }
  const baseUrl = process.env.DEMESNE_PROVIDER_URL ?? "http://127.0.0.1:11434/v1";
  const providerId = process.env.DEMESNE_PROVIDER_ID ?? "ollama";
  const contextWindow = environmentInteger("DEMESNE_CONTEXT_WINDOW", FULL_AGENT_CONTEXT_CAPACITY);
  const maxOutputTokens = environmentInteger("DEMESNE_BENCHMARK_OUTPUT_TOKENS", FULL_AGENT_OUTPUT_RESERVE);
  const provider = new OpenAICompatibleProvider({
    baseUrl,
    providerId,
    apiKey: process.env.DEMESNE_API_KEY,
    includeUsage: true,
    reasoningEffort: "none",
    contextWindow,
  });
  const verifier = createRuntimeProfileVerifier({
    profile: runtimeProfile,
    providerId,
    baseUrl,
    apiKey: process.env.DEMESNE_API_KEY,
  });
  if (!verifier) throw new Error("Full-agent context benchmark requires runtime verification");
  const observedBackendVersion = await backendVersion(baseUrl, process.env.DEMESNE_API_KEY);
  const observedModelDigest = await modelDigest(baseUrl, model, process.env.DEMESNE_API_KEY);
  if (!observedBackendVersion || !observedModelDigest) {
    throw new Error("Full-agent context benchmark requires backend version and model digest provenance");
  }
  await verifier.verify(model, verifier.capture());
  const processor = new ProviderTurnProcessor(provider, model, {
    maxOutputTokens,
    temperature: 0,
    seed: 42,
  }, verifier, contextWindow);
  const report = await runFullAgentContextBenchmark({
    comparison: environmentComparison(),
    model,
    warmupPairsPerFixture: environmentInteger("DEMESNE_BENCHMARK_WARMUP_PAIRS", 0),
    measuredPairsPerFixture: environmentInteger("DEMESNE_BENCHMARK_PAIRS", 2),
    timeoutMs: environmentInteger("DEMESNE_BENCHMARK_TIMEOUT_MS", 10 * 60_000),
    maxOutputTokens,
    temperature: 0,
    seed: 42,
    contextWindow,
    externalPowerContext,
  }, {
    processor,
    endpoint: baseUrl,
    backendVersion: observedBackendVersion,
    modelDigest: observedModelDigest,
    sourceRevision,
  });
  const directory = join(process.env.DEMESNE_DATA_DIR ?? join(homedir(), ".demesne"), "benchmarks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `full-agent-context-${report.startedAt.replaceAll(":", "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Full-agent context benchmark: ${report.summary.experimentValid ? "valid" : "invalid"}`);
  console.log(`Comparison: ${report.config.comparison ?? "raw-schema3"}`);
  console.log(`Workspace quality eligible: ${report.summary.workspaceQualityEligible ? "yes" : "no"}`);
  console.log(`Valid measured pairs: ${report.summary.operationallyValidPairs}/${report.summary.measuredPairs}`);
  console.log(`Timing-discriminating pairs: ${report.summary.discriminatingPairs}`);
  console.log(`Hard-boundary reduction pairs: ${report.summary.hardBoundaryReductionPairs}`);
  console.log(`Treatment-only failures: ${report.summary.treatmentOnlyFailures}`);
  for (const fixture of report.fixtureSummaries) {
    console.log(`${fixture.fixtureId}: baseline ${(fixture.baselineSuccessRate * 100).toFixed(0)}%, treatment ${(fixture.treatmentSuccessRate * 100).toFixed(0)}%, median baseline-minus-treatment tokens ${fixture.medianBaselineMinusTreatmentInputTokens ?? "unknown"}`);
  }
  console.log(`Report: ${path}`);
  if (!report.summary.experimentValid) process.exitCode = 1;
}

function environmentComparison(): FullAgentContextComparison {
  const value = process.env.DEMESNE_BENCHMARK_COMPARISON?.trim() || "raw-schema3";
  if (value !== "raw-schema3" && value !== "soft-delayed-hard") {
    throw new Error("DEMESNE_BENCHMARK_COMPARISON is invalid");
  }
  return value;
}

function environmentInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
