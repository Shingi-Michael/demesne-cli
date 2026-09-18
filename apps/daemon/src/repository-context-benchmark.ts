#!/usr/bin/env bun

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { isRecord, type RuntimeProfileStatus, type TokenUsage } from "@demesne/protocol";
import { OpenAICompatibleProvider, type ProviderMessage, type ProviderToolDefinition } from "@demesne/providers";
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
import { planContextRequest } from "./context-planner.ts";
import {
  calculateRepositoryFixtureSha256,
  createRepositoryContextFixtures,
  REPOSITORY_CONTEXT_CAPACITY,
  REPOSITORY_CONTEXT_HARD_INPUT_LIMIT,
  REPOSITORY_CONTEXT_OUTPUT_RESERVE,
  REPOSITORY_TOOL_DEFINITIONS_SHA256,
  stableJson,
  type RepositoryContextFixture,
  type RepositoryFixtureKind,
} from "./repository-context-fixtures.ts";

export const REPOSITORY_CONTEXT_BENCHMARK_SCHEMA_VERSION = 1 as const;
type Condition = "raw" | "reduced";

export interface RepositoryContextBenchmarkConfig {
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

interface QualityScore {
  valid: boolean;
  exact: boolean;
  error: string | null;
}

interface ConditionMeasurement {
  condition: Condition;
  predecessor: Condition | null;
  outcome: "completed" | "failed";
  error: string | null;
  durationMs: number;
  timeToFirstOutputMs: number | null;
  timeToFirstTextMs: number | null;
  responseText: string;
  reasoningCharacters: number;
  toolCallObserved: boolean;
  usage: TokenUsage | null;
  quality: QualityScore;
  messageCount: number;
  messageBytes: number;
  runtimeStatus: RuntimeProfileStatus;
}

export interface RepositoryContextObservation {
  fixtureId: string;
  fixtureKind: RepositoryFixtureKind;
  sequence: number;
  phase: "warmup" | "measured";
  order: [Condition, Condition];
  requestNonce: string;
  powerBefore: HostPowerSnapshot | null;
  powerAfter: HostPowerSnapshot | null;
  runnerBefore: OllamaRunnerSnapshot | null;
  runnerAfter: OllamaRunnerSnapshot | null;
  raw: ConditionMeasurement;
  reduced: ConditionMeasurement;
  operationallyValid: boolean;
  exclusionReason: string | null;
  reducedOnlyFailure: boolean;
  paired: {
    inputTokenSaving: number | null;
    inputTokenReductionRatio: number | null;
    timeToFirstOutputSavingMs: number | null;
    timeToFirstOutputLogRatio: number | null;
    durationSavingMs: number | null;
  };
}

interface FixtureSummary {
  fixtureId: string;
  kind: RepositoryFixtureKind;
  measuredPairs: number;
  operationallyValidPairs: number;
  rawExactRate: number;
  reducedExactRate: number;
  reducedOnlyFailures: number;
  medianRawInputTokens: number | null;
  medianReducedInputTokens: number | null;
  medianInputTokenSaving: number | null;
  medianRawTimeToFirstOutputMs: number | null;
  medianReducedTimeToFirstOutputMs: number | null;
  medianPairedTimeToFirstOutputSavingMs: number | null;
    geometricMeanRawToReducedTimeToFirstOutputRatio: number | null;
    geometricMeanRatioWhenRawFirst: number | null;
    geometricMeanRatioWhenReducedFirst: number | null;
    medianRawCachedInputTokens: number | null;
    medianReducedCachedInputTokens: number | null;
    medianPairedDurationSavingMs: number | null;
}

export interface RepositoryContextBenchmarkReport {
  schemaVersion: typeof REPOSITORY_CONTEXT_BENCHMARK_SCHEMA_VERSION;
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
  config: RepositoryContextBenchmarkConfig;
  toolDefinitionsSha256: string;
  fixtures: Array<{
    id: string;
    kind: RepositoryFixtureKind;
    version: number;
    repositoryManifestSha256: string;
    fixtureSha256: string;
    fileCount: number;
    repositoryBytes: number;
    rawMessageCount: number;
    reducedMessageCount: number;
    rawEstimatedInputTokens: number;
    reducedEstimatedInputTokens: number;
    actions: RepositoryContextFixture["plan"]["actions"];
  }>;
  memory: {
    before: HostMemorySnapshot | null;
    after: HostMemorySnapshot | null;
    delta: ReturnType<typeof calculateHostMemoryDelta>;
  };
  power: { before: HostPowerSnapshot | null; after: HostPowerSnapshot | null };
  runner: { before: OllamaRunnerSnapshot | null; after: OllamaRunnerSnapshot | null };
  observations: RepositoryContextObservation[];
  fixtureSummaries: FixtureSummary[];
  summary: {
    measuredPairs: number;
    operationallyValidPairs: number;
    experimentValid: boolean;
    provenanceComplete: boolean;
    repositoryQualityEligible: boolean;
    rawExactRate: number;
    reducedExactRate: number;
    reducedOnlyFailures: number;
    rawOnlyFailures: number;
    medianInputTokenSaving: number | null;
    medianPairedTimeToFirstOutputSavingMs: number | null;
    geometricMeanRawToReducedTimeToFirstOutputRatio: number | null;
    medianPairedDurationSavingMs: number | null;
  };
}

export async function runRepositoryContextBenchmark(
  config: RepositoryContextBenchmarkConfig,
  dependencies: {
    processor: TurnProcessor;
    fixtures?: RepositoryContextFixture[];
    endpoint?: string;
    backendVersion?: string;
    modelDigest?: string;
    sourceRevision?: string;
    now?: () => number;
    memorySnapshot?: () => HostMemorySnapshot | null;
    powerSnapshot?: () => HostPowerSnapshot | null;
    runnerSnapshot?: () => OllamaRunnerSnapshot | null;
  },
): Promise<RepositoryContextBenchmarkReport> {
  validateConfig(config, dependencies.processor);
  if (!nonempty(dependencies.endpoint) || !nonempty(dependencies.backendVersion)
    || !nonempty(dependencies.modelDigest) || !nonempty(dependencies.sourceRevision)
    || config.externalPowerContext === "unspecified-external-power") {
    throw new Error("Repository context benchmark requires complete runtime and source provenance");
  }
  if (dependencies.processor.runtimeStatus?.().state !== "verified") {
    throw new Error("Repository context runtime profile must be verified before the benchmark starts");
  }
  const fixtures = dependencies.fixtures ?? await createRepositoryContextFixtures();
  validateFixtures(fixtures);
  const now = dependencies.now ?? performance.now.bind(performance);
  const memorySnapshot = dependencies.memorySnapshot ?? readHostMemorySnapshot;
  const powerSnapshot = dependencies.powerSnapshot ?? readHostPowerSnapshot;
  const runnerSnapshot = dependencies.runnerSnapshot ?? readOllamaRunnerSnapshot;
  const startedAt = new Date().toISOString();
  const memoryBefore = memorySnapshot();
  const powerBefore = powerSnapshot();
  const runnerBefore = runnerSnapshot();
  if (!validAcPower(powerBefore) || runnerBefore === null || runnerBefore.processes.length !== 1) {
    throw new Error("Repository context preflight requires AC mode 2 and one preloaded runner");
  }
  const observations: RepositoryContextObservation[] = [];
  let predecessor: Condition | null = null;

  const pairCount = config.warmupPairsPerFixture + config.measuredPairsPerFixture;
  for (let sequence = 0; sequence < pairCount; sequence += 1) {
    const fixtureOrder = rotate(fixtures, sequence % fixtures.length);
    for (const fixture of fixtureOrder) {
      const order: [Condition, Condition] = sequence % 2 === 0 ? ["raw", "reduced"] : ["reduced", "raw"];
      const requestNonce = Bun.CryptoHasher.hash("sha256", `${fixture.fixtureSha256}:${startedAt}:${sequence}`, "hex");
      const pairPowerBefore = powerSnapshot();
      const pairRunnerBefore = runnerSnapshot();
      const byCondition = {} as Record<Condition, ConditionMeasurement>;
      for (const condition of order) {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(new Error("Repository context benchmark condition timed out")),
          config.timeoutMs,
        );
        try {
          byCondition[condition] = await measureCondition(
            dependencies.processor,
            condition,
            predecessor,
            messagesWithNonce(condition === "raw" ? fixture.rawMessages : fixture.reducedMessages, requestNonce),
            fixture.tools,
            fixture.gold,
            controller.signal,
            now,
          );
          predecessor = condition;
          if (byCondition[condition].outcome === "failed") {
            throw new Error(`Repository context benchmark failed fast: ${byCondition[condition].error ?? "provider failure"}`);
          }
        } finally {
          clearTimeout(timeout);
        }
      }
      const exclusionReason = operationalExclusion(byCondition.raw, byCondition.reduced);
      observations.push({
        fixtureId: fixture.id,
        fixtureKind: fixture.kind,
        sequence,
        phase: sequence < config.warmupPairsPerFixture ? "warmup" : "measured",
        order,
        requestNonce,
        powerBefore: pairPowerBefore,
        powerAfter: powerSnapshot(),
        runnerBefore: pairRunnerBefore,
        runnerAfter: runnerSnapshot(),
        raw: byCondition.raw,
        reduced: byCondition.reduced,
        operationallyValid: exclusionReason === null,
        exclusionReason,
        reducedOnlyFailure: byCondition.raw.outcome === "completed" && byCondition.raw.quality.exact
          && (byCondition.reduced.outcome !== "completed" || !byCondition.reduced.quality.exact),
        paired: pairedMetrics(byCondition.raw, byCondition.reduced),
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
    && stableRunners(runnerBefore, runnerAfter, measured);
  const rawExact = (observation: RepositoryContextObservation) => observation.raw.outcome === "completed"
    && observation.raw.quality.exact;
  const reducedExact = (observation: RepositoryContextObservation) => observation.reduced.outcome === "completed"
    && observation.reduced.quality.exact;
  const repositoryQualityEligible = measured.length > 0 && measured.every((observation) => rawExact(observation)
    && reducedExact(observation) && !observation.reducedOnlyFailure);
  const logRatios = operational.map((observation) => observation.paired.timeToFirstOutputLogRatio)
    .filter((value): value is number => value !== null);
  const fixtureSummaries = fixtures.map((fixture) => fixtureSummary(fixture, measured));
  const fixtureLogRatios = fixtureSummaries.map((summary) => summary.geometricMeanRawToReducedTimeToFirstOutputRatio)
    .filter((value): value is number => value !== null && value > 0)
    .map(Math.log);

  return {
    schemaVersion: REPOSITORY_CONTEXT_BENCHMARK_SCHEMA_VERSION,
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
    config,
    toolDefinitionsSha256: REPOSITORY_TOOL_DEFINITIONS_SHA256,
    fixtures: fixtures.map((fixture) => ({
      id: fixture.id,
      kind: fixture.kind,
      version: fixture.version,
      repositoryManifestSha256: fixture.repositoryManifestSha256,
      fixtureSha256: fixture.fixtureSha256,
      fileCount: fixture.repositoryManifest.length,
      repositoryBytes: fixture.repositoryManifest.reduce((total, file) => total + file.bytes, 0),
      rawMessageCount: fixture.rawMessages.length,
      reducedMessageCount: fixture.reducedMessages.length,
      rawEstimatedInputTokens: fixture.plan.originalEstimatedInputTokens,
      reducedEstimatedInputTokens: fixture.plan.estimatedInputTokens,
      actions: fixture.plan.actions,
    })),
    memory: { before: memoryBefore, after: memoryAfter, delta: calculateHostMemoryDelta(memoryBefore, memoryAfter) },
    power: { before: powerBefore, after: powerAfter },
    runner: { before: runnerBefore, after: runnerAfter },
    observations,
    fixtureSummaries,
    summary: {
      measuredPairs: measured.length,
      operationallyValidPairs: operational.length,
      experimentValid: operational.length === measured.length && provenanceComplete && repositoryQualityEligible,
      provenanceComplete,
      repositoryQualityEligible,
      rawExactRate: rate(measured, rawExact),
      reducedExactRate: rate(measured, reducedExact),
      reducedOnlyFailures: measured.filter((observation) => observation.reducedOnlyFailure).length,
      rawOnlyFailures: measured.filter((observation) => reducedExact(observation) && !rawExact(observation)).length,
      medianInputTokenSaving: medianKnown(operational.map((observation) => observation.paired.inputTokenSaving)),
      medianPairedTimeToFirstOutputSavingMs: medianKnown(
        operational.map((observation) => observation.paired.timeToFirstOutputSavingMs),
      ),
      geometricMeanRawToReducedTimeToFirstOutputRatio: fixtureLogRatios.length === fixtures.length
        ? Math.exp(mean(fixtureLogRatios))
        : null,
      medianPairedDurationSavingMs: medianKnown(operational.map((observation) => observation.paired.durationSavingMs)),
    },
  };
}

function fixtureSummary(fixture: RepositoryContextFixture, measured: RepositoryContextObservation[]): FixtureSummary {
  const fixtureObservations = measured.filter((observation) => observation.fixtureId === fixture.id);
  const operational = fixtureObservations.filter((observation) => observation.operationallyValid);
  const logs = operational.map((observation) => observation.paired.timeToFirstOutputLogRatio)
    .filter((value): value is number => value !== null);
  const rawFirstLogs = operational.filter((observation) => observation.order[0] === "raw")
    .map((observation) => observation.paired.timeToFirstOutputLogRatio)
    .filter((value): value is number => value !== null);
  const reducedFirstLogs = operational.filter((observation) => observation.order[0] === "reduced")
    .map((observation) => observation.paired.timeToFirstOutputLogRatio)
    .filter((value): value is number => value !== null);
  return {
    fixtureId: fixture.id,
    kind: fixture.kind,
    measuredPairs: fixtureObservations.length,
    operationallyValidPairs: operational.length,
    rawExactRate: rate(fixtureObservations, (observation) => observation.raw.outcome === "completed" && observation.raw.quality.exact),
    reducedExactRate: rate(fixtureObservations, (observation) => observation.reduced.outcome === "completed" && observation.reduced.quality.exact),
    reducedOnlyFailures: fixtureObservations.filter((observation) => observation.reducedOnlyFailure).length,
    medianRawInputTokens: medianKnown(operational.map((observation) => observation.raw.usage?.inputTokens ?? null)),
    medianReducedInputTokens: medianKnown(operational.map((observation) => observation.reduced.usage?.inputTokens ?? null)),
    medianInputTokenSaving: medianKnown(operational.map((observation) => observation.paired.inputTokenSaving)),
    medianRawTimeToFirstOutputMs: medianKnown(operational.map((observation) => observation.raw.timeToFirstOutputMs)),
    medianReducedTimeToFirstOutputMs: medianKnown(operational.map((observation) => observation.reduced.timeToFirstOutputMs)),
    medianPairedTimeToFirstOutputSavingMs: medianKnown(
      operational.map((observation) => observation.paired.timeToFirstOutputSavingMs),
    ),
    geometricMeanRawToReducedTimeToFirstOutputRatio: logs.length > 0 ? Math.exp(mean(logs)) : null,
    geometricMeanRatioWhenRawFirst: rawFirstLogs.length > 0 ? Math.exp(mean(rawFirstLogs)) : null,
    geometricMeanRatioWhenReducedFirst: reducedFirstLogs.length > 0 ? Math.exp(mean(reducedFirstLogs)) : null,
    medianRawCachedInputTokens: medianKnown(operational.map((observation) => observation.raw.usage?.cachedInputTokens ?? null)),
    medianReducedCachedInputTokens: medianKnown(
      operational.map((observation) => observation.reduced.usage?.cachedInputTokens ?? null),
    ),
    medianPairedDurationSavingMs: medianKnown(operational.map((observation) => observation.paired.durationSavingMs)),
  };
}

async function measureCondition(
  processor: TurnProcessor,
  condition: Condition,
  predecessor: Condition | null,
  messages: ProviderMessage[],
  tools: ProviderToolDefinition[],
  gold: Record<string, unknown>,
  signal: AbortSignal,
  now: () => number,
): Promise<ConditionMeasurement> {
  const started = now();
  let firstOutputAt: number | null = null;
  let firstTextAt: number | null = null;
  let responseText = "";
  let reasoningCharacters = 0;
  let toolCallObserved = false;
  let usage: TokenUsage | null = null;
  let outcome: ConditionMeasurement["outcome"] = "completed";
  let error: string | null = null;
  const iterator = processor.stream(
    structuredClone(messages),
    structuredClone(tools),
    signal,
    false,
    () => firstOutputAt ??= now(),
  )[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextWithAbort(iterator, signal);
      if (next.done) break;
      const event = next.value;
      if (event.type !== "usage") firstOutputAt ??= now();
      if (event.type === "text_delta") {
        firstTextAt ??= now();
        responseText += event.delta;
        if (responseText.length > 64 * 1024) throw new Error("Repository context response exceeded its limit");
      } else if (event.type === "reasoning_delta") {
        reasoningCharacters += event.delta.length;
      } else if (event.type === "tool_call_delta") {
        toolCallObserved = true;
      } else {
        if (usage) throw new Error("Repository context benchmark received duplicate usage");
        usage = event.usage;
      }
    }
  } catch (caught) {
    outcome = "failed";
    error = signal.aborted
      ? signal.reason instanceof Error ? signal.reason.message : "Repository context benchmark condition timed out"
      : caught instanceof Error ? caught.message : "Provider request failed";
  } finally {
    if (signal.aborted) await boundedIteratorReturn(iterator);
    else await iterator.return?.();
  }
  const completed = now();
  return {
    condition,
    predecessor,
    outcome,
    error,
    durationMs: Math.max(0, completed - started),
    timeToFirstOutputMs: firstOutputAt === null ? null : Math.max(0, firstOutputAt - started),
    timeToFirstTextMs: firstTextAt === null ? null : Math.max(0, firstTextAt - started),
    responseText,
    reasoningCharacters,
    toolCallObserved,
    usage,
    quality: scoreQuality(responseText, toolCallObserved, gold),
    messageCount: messages.length,
    messageBytes: Buffer.byteLength(JSON.stringify(messages)),
    runtimeStatus: processor.runtimeStatus?.() ?? unconfiguredProfileStatus(),
  };
}

function scoreQuality(responseText: string, toolCallObserved: boolean, gold: Record<string, unknown>): QualityScore {
  if (toolCallObserved) return { valid: false, exact: false, error: "Model attempted a tool call" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return { valid: false, exact: false, error: "Response is not one JSON object" };
  }
  if (!isRecord(parsed)) return { valid: false, exact: false, error: "Response is not a JSON object" };
  const exact = stableJson(normalizeQualityValue(parsed)) === stableJson(normalizeQualityValue(gold));
  return { valid: exact, exact, error: exact ? null : "Response facts or schema are incorrect" };
}

function normalizeQualityValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeQualityValue(entry));
    return key === "changedFiles" && normalized.every((entry) => typeof entry === "string")
      ? [...normalized].sort()
      : normalized;
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      normalizeQualityValue(entry, entryKey),
    ]));
  }
  return value;
}

function operationalExclusion(raw: ConditionMeasurement, reduced: ConditionMeasurement): string | null {
  if (raw.outcome !== "completed" || reduced.outcome !== "completed") return "provider request failed";
  if (!validUsage(raw.usage) || !validUsage(reduced.usage)) return "provider usage is incomplete";
  if ((raw.usage?.inputTokens ?? Number.POSITIVE_INFINITY) > REPOSITORY_CONTEXT_HARD_INPUT_LIMIT) {
    return "raw request exceeded the hard input gate";
  }
  if ((reduced.usage?.inputTokens ?? Number.POSITIVE_INFINITY) > REPOSITORY_CONTEXT_HARD_INPUT_LIMIT) {
    return "reduced request exceeded the hard input gate";
  }
  if (raw.runtimeStatus.state !== "verified" || reduced.runtimeStatus.state !== "verified") {
    return "runtime profile was not verified";
  }
  return null;
}

function pairedMetrics(raw: ConditionMeasurement, reduced: ConditionMeasurement): RepositoryContextObservation["paired"] {
  const rawInput = raw.usage?.inputTokens;
  const reducedInput = reduced.usage?.inputTokens;
  return {
    inputTokenSaving: typeof rawInput === "number" && typeof reducedInput === "number" ? rawInput - reducedInput : null,
    inputTokenReductionRatio: typeof rawInput === "number" && typeof reducedInput === "number" && rawInput > 0
      ? (rawInput - reducedInput) / rawInput
      : null,
    timeToFirstOutputSavingMs: raw.timeToFirstOutputMs !== null && reduced.timeToFirstOutputMs !== null
      ? raw.timeToFirstOutputMs - reduced.timeToFirstOutputMs
      : null,
    timeToFirstOutputLogRatio: raw.timeToFirstOutputMs !== null && reduced.timeToFirstOutputMs !== null
      && raw.timeToFirstOutputMs > 0 && reduced.timeToFirstOutputMs > 0
      ? Math.log(raw.timeToFirstOutputMs / reduced.timeToFirstOutputMs)
      : null,
    durationSavingMs: raw.usage?.outputTokens === reduced.usage?.outputTokens ? raw.durationMs - reduced.durationMs : null,
  };
}

function messagesWithNonce(messages: ProviderMessage[], nonce: string): ProviderMessage[] {
  const copy = structuredClone(messages);
  const system = copy[0];
  if (system?.role !== "system") throw new Error("Repository context fixture system message is missing");
  system.content = `BENCHMARK_NONCE_${nonce}\n${system.content}`;
  return copy;
}

function validateFixtures(fixtures: RepositoryContextFixture[]): void {
  if (stableJson(fixtures.map((fixture) => fixture.kind)) !== stableJson([
    "inspection",
    "single_file_repair",
    "multi_file_feature",
  ])) throw new Error("Repository context fixture set changed");
  for (const fixture of fixtures) {
    const replanned = planContextRequest({
      messages: structuredClone(fixture.rawMessages),
      tools: structuredClone(fixture.tools),
      historicalTurns: structuredClone(fixture.historicalTurns),
      capacityTokens: REPOSITORY_CONTEXT_CAPACITY,
      outputReserveTokens: REPOSITORY_CONTEXT_OUTPUT_RESERVE,
    });
    const manifestSha256 = Bun.CryptoHasher.hash("sha256", stableJson(fixture.repositoryManifest), "hex");
    if (Bun.CryptoHasher.hash("sha256", stableJson(fixture.tools), "hex") !== REPOSITORY_TOOL_DEFINITIONS_SHA256
      || calculateRepositoryFixtureSha256(fixture) !== fixture.fixtureSha256
      || manifestSha256 !== fixture.repositoryManifestSha256
      || fixture.plan.originalEstimatedInputTokens > REPOSITORY_CONTEXT_HARD_INPUT_LIMIT
      || fixture.plan.estimatedInputTokens > (fixture.plan.maximumPlannedInputTokens ?? Number.NEGATIVE_INFINITY)
      || fixture.plan.actions.length === 0 || stableJson(replanned.plan) !== stableJson(fixture.plan)
      || stableJson(replanned.messages) !== stableJson(fixture.reducedMessages)) {
      throw new Error(`Repository context fixture is invalid: ${fixture.id}`);
    }
  }
}

function validateConfig(config: RepositoryContextBenchmarkConfig, processor: TurnProcessor): void {
  if (!config.model.trim() || processor.modelId !== config.model) throw new Error("Repository context model mismatch");
  for (const [name, value, minimum, maximum] of [
    ["warmupPairsPerFixture", config.warmupPairsPerFixture, 2, 10],
    ["measuredPairsPerFixture", config.measuredPairsPerFixture, 2, 20],
    ["timeoutMs", config.timeoutMs, 1_000, 30 * 60_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  }
  if (config.warmupPairsPerFixture % 2 !== 0 || config.measuredPairsPerFixture % 2 !== 0) {
    throw new Error("Repository context pair counts must contain complete order blocks");
  }
  if (config.contextWindow !== REPOSITORY_CONTEXT_CAPACITY
    || config.maxOutputTokens !== REPOSITORY_CONTEXT_OUTPUT_RESERVE
    || processor.contextCapacity !== config.contextWindow || processor.maxOutputTokens !== config.maxOutputTokens
    || processor.temperature !== config.temperature || processor.seed !== config.seed) {
    throw new Error("Repository context processor defaults mismatch");
  }
  if (!config.externalPowerContext.trim()) throw new Error("External power context is required");
}

function validUsage(usage: TokenUsage | null): boolean {
  if (usage === null || typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number"
    || typeof usage.totalTokens !== "number" || !nonnegativeInteger(usage.inputTokens)
    || !nonnegativeInteger(usage.outputTokens) || !nonnegativeInteger(usage.totalTokens)) return false;
  return usage.totalTokens === usage.inputTokens + usage.outputTokens
    && (usage.cachedInputTokens === undefined || (nonnegativeInteger(usage.cachedInputTokens)
      && usage.cachedInputTokens <= usage.inputTokens));
}

function stableRunners(
  before: OllamaRunnerSnapshot | null,
  after: OllamaRunnerSnapshot | null,
  observations: RepositoryContextObservation[],
): boolean {
  if (!before || !after) return false;
  const signature = runnerSignature(before);
  return runnerSignature(after) === signature && observations.every((observation) => observation.runnerBefore !== null
    && observation.runnerAfter !== null && runnerSignature(observation.runnerBefore) === signature
    && runnerSignature(observation.runnerAfter) === signature);
}

function runnerSignature(snapshot: OllamaRunnerSnapshot): string {
  return stableJson([...snapshot.processes].sort((left, right) => left.pid - right.pid));
}

function validAcPower(snapshot: HostPowerSnapshot | null): snapshot is HostPowerSnapshot {
  return snapshot?.source === "ac" && snapshot.currentPowerMode === 2;
}

function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Operation aborted"));
    signal.addEventListener("abort", abort, { once: true });
    iterator.next().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
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

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonempty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function rotate<T>(values: T[], offset: number): T[] {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

async function boundedIteratorReturn<T>(iterator: AsyncIterator<T>): Promise<void> {
  const returned = iterator.return?.();
  if (!returned) return;
  await Promise.race([
    returned.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
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
  const contextWindow = environmentInteger("DEMESNE_CONTEXT_WINDOW", REPOSITORY_CONTEXT_CAPACITY);
  const maxOutputTokens = environmentInteger("DEMESNE_BENCHMARK_OUTPUT_TOKENS", REPOSITORY_CONTEXT_OUTPUT_RESERVE);
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
  if (!verifier) throw new Error("Repository context benchmark requires runtime verification");
  const observedBackendVersion = await backendVersion(baseUrl, process.env.DEMESNE_API_KEY);
  const observedModelDigest = await modelDigest(baseUrl, model, process.env.DEMESNE_API_KEY);
  if (!observedBackendVersion || !observedModelDigest) {
    throw new Error("Repository context benchmark requires backend version and model digest provenance");
  }
  await verifier.verify(model, verifier.capture());
  const processor = new ProviderTurnProcessor(provider, model, {
    maxOutputTokens,
    temperature: 0,
    seed: 42,
  }, verifier, contextWindow);
  const report = await runRepositoryContextBenchmark({
    model,
    warmupPairsPerFixture: environmentInteger("DEMESNE_BENCHMARK_WARMUP_PAIRS", 2),
    measuredPairsPerFixture: environmentInteger("DEMESNE_BENCHMARK_PAIRS", 4),
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
  const path = join(directory, `repository-context-${report.startedAt.replaceAll(":", "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Repository context benchmark: ${report.summary.experimentValid ? "valid" : "invalid"}`);
  console.log(`Repository quality eligible: ${report.summary.repositoryQualityEligible ? "yes" : "no"}`);
  console.log(`Valid measured pairs: ${report.summary.operationallyValidPairs}/${report.summary.measuredPairs}`);
  console.log(`Reduced-only failures: ${report.summary.reducedOnlyFailures}`);
  for (const fixture of report.fixtureSummaries) {
    console.log(`${fixture.kind}: raw ${(fixture.rawExactRate * 100).toFixed(0)}%, reduced ${(fixture.reducedExactRate * 100).toFixed(0)}%, median token saving ${fixture.medianInputTokenSaving ?? "unknown"}`);
  }
  console.log(`Raw report: ${path}`);
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
