#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { isRecord, type ContextPlan, type RuntimeProfileStatus, type TokenUsage } from "@demesne/protocol";
import { OpenAICompatibleProvider, type ProviderMessage, type ProviderToolDefinition } from "@demesne/providers";
import { planContextRequest } from "./context-planner.ts";
import { defaultSystemPrompt } from "./engine.ts";
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
import { ToolRegistry } from "./tools.ts";

export const CONTEXT_REDUCTION_BENCHMARK_SCHEMA_VERSION = 1 as const;
const FIXTURE_ID = "schema3-paired-provider-latency-v1";
const CONTEXT_CAPACITY = 8_192;
const OUTPUT_RESERVE = 1_536;
const HARD_INPUT_LIMIT = CONTEXT_CAPACITY - OUTPUT_RESERVE;
const READ_A_ID = "call_schema_a";
const READ_B_ID = "call_schema_b";
const READ_ARGUMENTS = {
  files: [
    { path: "data/stable.txt", offset: 1, limit: 90 },
    { path: "data/changing.txt", offset: 1, limit: 90 },
  ],
};
const READ_ARGUMENTS_JSON = JSON.stringify(READ_ARGUMENTS);
const EXPECTED_TOOL_DEFINITIONS_SHA256 = "27ba5e66b9f1bd12c29bdf712792ca46b4ee5c48066fc7e7e2f1a5b4b5918f25";
const EXPECTED_REQUEST_FIXTURE_SHA256 = "766f36c9fe4088396a9204cc96c5e2d43e2cc1f2e91613c4847de70cc0d3c80a";
const STABLE_FILE = Array.from(
  { length: 90 },
  (_, index) => `S-${String(index + 1).padStart(3, "0")}: ${"s".repeat(8)}`,
).join("\n") + "\n";
const CHANGING_A = changingFile("A");
const CHANGING_B = changingFile("B");
const QUALITY_GOLD = {
  stableFirstRecord: "S-001: ssssssss",
  stableLastRecord: "S-090: ssssssss",
  latestChangingFirstRecord: "B-001: bbbbbbbbbb",
  latestChangingLastRecord: "B-020: bbbbbbbbbb",
  latestReadSet: "B",
};

type Condition = "raw" | "reduced";

export interface ContextReductionFixture {
  rawMessages: ProviderMessage[];
  reducedMessages: ProviderMessage[];
  tools: ProviderToolDefinition[];
  plan: ContextPlan;
  toolDefinitionsSha256: string;
  requestFixtureSha256: string;
}

export interface ContextReductionBenchmarkConfig {
  model: string;
  warmupPairs: number;
  measuredPairs: number;
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
  postFirstTextDurationMs: number | null;
  responseText: string;
  responseCharacters: number;
  reasoningCharacters: number;
  toolCallObserved: boolean;
  usage: TokenUsage | null;
  quality: QualityScore;
  requestMessageCount: number;
  messageBytes: number;
  runtimeStatus: RuntimeProfileStatus;
}

export interface ContextReductionPairObservation {
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
  valid: boolean;
  exclusionReason: string | null;
  paired: {
    timeToFirstOutputSavingMs: number | null;
    timeToFirstOutputLogRatio: number | null;
    durationSavingMs: number | null;
    inputTokenSaving: number | null;
    inputTokenRatio: number | null;
  };
}

export interface ContextReductionBenchmarkReport {
  schemaVersion: typeof CONTEXT_REDUCTION_BENCHMARK_SCHEMA_VERSION;
  startedAt: string;
  fixture: {
    id: typeof FIXTURE_ID;
    rawMessageCount: number;
    reducedMessageCount: number;
    rawEstimatedInputTokens: number;
    reducedEstimatedInputTokens: number;
    maximumPlannedInputTokens: number | null;
    hardInputLimitTokens: number | null;
    actions: ContextPlan["actions"];
    toolNames: string[];
    toolDefinitionsSha256: string;
    requestFixtureSha256: string;
  };
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
  config: ContextReductionBenchmarkConfig;
  memory: {
    before: HostMemorySnapshot | null;
    after: HostMemorySnapshot | null;
    delta: ReturnType<typeof calculateHostMemoryDelta>;
  };
  power: { before: HostPowerSnapshot | null; after: HostPowerSnapshot | null };
  runner: { before: OllamaRunnerSnapshot | null; after: OllamaRunnerSnapshot | null };
  observations: ContextReductionPairObservation[];
  summary: {
    measuredPairs: number;
    validPairs: number;
    experimentValid: boolean;
    provenanceComplete: boolean;
    rawQualityRate: number;
    reducedQualityRate: number;
    reducedOnlyFailures: number;
    medianRawInputTokens: number | null;
    medianReducedInputTokens: number | null;
    medianRawCachedInputTokens: number | null;
    medianReducedCachedInputTokens: number | null;
    medianInputTokenSaving: number | null;
    medianRawTimeToFirstOutputMs: number | null;
    medianReducedTimeToFirstOutputMs: number | null;
    meanPairedTimeToFirstOutputSavingMs: number | null;
    medianPairedTimeToFirstOutputSavingMs: number | null;
    geometricMeanRawToReducedTimeToFirstOutputRatio: number | null;
    geometricMeanRatio95PercentConfidenceInterval: [number, number] | null;
    geometricMeanRatioWhenRawRepeated: number | null;
    geometricMeanRatioWhenReducedRepeated: number | null;
    medianRawDurationMs: number | null;
    medianReducedDurationMs: number | null;
    medianPairedDurationSavingMs: number | null;
  };
}

export async function createContextReductionFixture(signal: AbortSignal = new AbortController().signal): Promise<ContextReductionFixture> {
  const root = mkdtempSync(join(tmpdir(), "demesne-context-reduction-"));
  try {
    const data = join(root, "data");
    mkdirSync(data, { recursive: true, mode: 0o700 });
    writeFileSync(join(data, "stable.txt"), STABLE_FILE, { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(data, "changing.txt"), CHANGING_A, { encoding: "utf8", mode: 0o600 });
    const registry = new ToolRegistry();
    const readFiles = registry.get("read_files");
    if (!readFiles) throw new Error("read_files tool is unavailable");
    const resultA = await readFiles.execute(READ_ARGUMENTS, { workspaceRoot: root, signal });
    writeFileSync(join(data, "changing.txt"), CHANGING_B, "utf8");
    const resultB = await readFiles.execute(READ_ARGUMENTS, { workspaceRoot: root, signal });
    const tools = registry.definitions();
    const rawMessages = buildRawMessages(resultA, resultB);
    const original = structuredClone(rawMessages);
    const planned = planContextRequest({
      messages: rawMessages,
      tools,
      historicalTurns: [
        { id: "turn-a", startMessageIndex: 1, endMessageIndex: 5 },
        { id: "turn-b", startMessageIndex: 5, endMessageIndex: 9 },
      ],
      capacityTokens: CONTEXT_CAPACITY,
      outputReserveTokens: OUTPUT_RESERVE,
    });
    if (stableJson(rawMessages) !== stableJson(original)) throw new Error("Context planner mutated the raw fixture");
    validateFixture(rawMessages, planned.messages, planned.plan, tools);
    const toolDefinitionsSha256 = sha256(stableJson(tools));
    const requestFixtureSha256 = sha256(stableJson({ rawMessages, reducedMessages: planned.messages }));
    if (toolDefinitionsSha256 !== EXPECTED_TOOL_DEFINITIONS_SHA256
      || requestFixtureSha256 !== EXPECTED_REQUEST_FIXTURE_SHA256) {
      throw new Error("Context reduction fixture hashes changed without a fixture version change");
    }
    return {
      rawMessages,
      reducedMessages: planned.messages,
      tools,
      plan: planned.plan,
      toolDefinitionsSha256,
      requestFixtureSha256,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runContextReductionBenchmark(
  config: ContextReductionBenchmarkConfig,
  dependencies: {
    processor: TurnProcessor;
    fixture?: ContextReductionFixture;
    endpoint?: string;
    backendVersion?: string;
    modelDigest?: string;
    sourceRevision?: string;
    now?: () => number;
    memorySnapshot?: () => HostMemorySnapshot | null;
    powerSnapshot?: () => HostPowerSnapshot | null;
    runnerSnapshot?: () => OllamaRunnerSnapshot | null;
  },
): Promise<ContextReductionBenchmarkReport> {
  validateConfig(config, dependencies.processor);
  const fixture = dependencies.fixture ?? await createContextReductionFixture();
  validateFixture(fixture.rawMessages, fixture.reducedMessages, fixture.plan, fixture.tools);
  if (fixture.toolDefinitionsSha256 !== sha256(stableJson(fixture.tools))
    || fixture.requestFixtureSha256 !== sha256(stableJson({
      rawMessages: fixture.rawMessages,
      reducedMessages: fixture.reducedMessages,
    }))) throw new Error("Context reduction fixture hashes are invalid");
  const now = dependencies.now ?? performance.now.bind(performance);
  const memorySnapshot = dependencies.memorySnapshot ?? readHostMemorySnapshot;
  const powerSnapshot = dependencies.powerSnapshot ?? readHostPowerSnapshot;
  const runnerSnapshot = dependencies.runnerSnapshot ?? readOllamaRunnerSnapshot;
  const startedAt = new Date().toISOString();
  const memoryBefore = memorySnapshot();
  const powerBefore = powerSnapshot();
  const runnerBefore = runnerSnapshot();
  const observations: ContextReductionPairObservation[] = [];
  const totalPairs = config.warmupPairs + config.measuredPairs;
  let predecessor: Condition | null = null;

  for (let sequence = 0; sequence < totalPairs; sequence += 1) {
    const order: [Condition, Condition] = sequence % 2 === 0 ? ["raw", "reduced"] : ["reduced", "raw"];
    const requestNonce = sha256(`${fixture.requestFixtureSha256}:${startedAt}:${sequence}`);
    const pairPowerBefore = powerSnapshot();
    const pairRunnerBefore = runnerSnapshot();
    const byCondition = {} as Record<Condition, ConditionMeasurement>;
    for (const condition of order) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Context reduction benchmark condition timed out")), config.timeoutMs);
      try {
        byCondition[condition] = await callCondition(
          dependencies.processor,
          condition,
          predecessor,
          messagesWithNonce(condition === "raw" ? fixture.rawMessages : fixture.reducedMessages, requestNonce),
          fixture.tools,
          controller.signal,
          now,
        );
        predecessor = condition;
      } finally {
        clearTimeout(timeout);
      }
    }
    const validity = pairValidity(byCondition.raw, byCondition.reduced);
    observations.push({
      sequence,
      phase: sequence < config.warmupPairs ? "warmup" : "measured",
      order,
      requestNonce,
      powerBefore: pairPowerBefore,
      powerAfter: powerSnapshot(),
      runnerBefore: pairRunnerBefore,
      runnerAfter: runnerSnapshot(),
      raw: byCondition.raw,
      reduced: byCondition.reduced,
      valid: validity.reason === null,
      exclusionReason: validity.reason,
      paired: pairedMetrics(byCondition.raw, byCondition.reduced),
    });
  }

  const memoryAfter = memorySnapshot();
  const powerAfter = powerSnapshot();
  const runnerAfter = runnerSnapshot();
  const profileStatus = dependencies.processor.runtimeStatus?.() ?? unconfiguredProfileStatus();
  const measured = observations.filter((observation) => observation.phase === "measured");
  const valid = measured.filter((observation) => observation.valid);
  const logRatios = valid.map((observation) => observation.paired.timeToFirstOutputLogRatio)
    .filter((value): value is number => value !== null);
  const ttftSavings = valid.map((observation) => observation.paired.timeToFirstOutputSavingMs)
    .filter((value): value is number => value !== null);
  const durationSavings = valid.map((observation) => observation.paired.durationSavingMs)
    .filter((value): value is number => value !== null);
  const inputSavings = valid.map((observation) => observation.paired.inputTokenSaving)
    .filter((value): value is number => value !== null);
  const confidenceInterval = meanConfidenceInterval(logRatios);
  const rawRepeatedRatios = valid.filter((observation) => observation.raw.predecessor === "raw")
    .map((observation) => observation.paired.timeToFirstOutputLogRatio)
    .filter((value): value is number => value !== null);
  const reducedRepeatedRatios = valid.filter((observation) => observation.reduced.predecessor === "reduced")
    .map((observation) => observation.paired.timeToFirstOutputLogRatio)
    .filter((value): value is number => value !== null);
  const measuredPowerStable = measured.every((observation) => validAcPower(observation.powerBefore)
    && validAcPower(observation.powerAfter));
  const measuredRunnersStable = runnerBefore !== null && runnerAfter !== null
    && measured.every((observation) => observation.runnerBefore !== null && observation.runnerAfter !== null
      && runnerSignature(observation.runnerBefore) === runnerSignature(runnerBefore)
      && runnerSignature(observation.runnerAfter) === runnerSignature(runnerBefore))
    && runnerSignature(runnerAfter) === runnerSignature(runnerBefore);
  const provenanceComplete = profileStatus.state === "verified"
    && profileStatus.observed?.contextWindow === config.contextWindow
    && nonempty(dependencies.endpoint)
    && nonempty(dependencies.backendVersion)
    && nonempty(dependencies.modelDigest)
    && nonempty(dependencies.sourceRevision)
    && config.externalPowerContext !== "unspecified-external-power"
    && validAcPower(powerBefore) && validAcPower(powerAfter)
    && measuredPowerStable && measuredRunnersStable;
  const fidelityEligible = measured.every((observation) => observation.raw.outcome === "completed"
    && observation.reduced.outcome === "completed" && observation.raw.quality.exact && observation.reduced.quality.exact);

  return {
    schemaVersion: CONTEXT_REDUCTION_BENCHMARK_SCHEMA_VERSION,
    startedAt,
    fixture: {
      id: FIXTURE_ID,
      rawMessageCount: fixture.rawMessages.length,
      reducedMessageCount: fixture.reducedMessages.length,
      rawEstimatedInputTokens: fixture.plan.originalEstimatedInputTokens,
      reducedEstimatedInputTokens: fixture.plan.estimatedInputTokens,
      maximumPlannedInputTokens: fixture.plan.maximumPlannedInputTokens,
      hardInputLimitTokens: fixture.plan.hardInputLimitTokens,
      actions: fixture.plan.actions,
      toolNames: fixture.tools.map((tool) => tool.name),
      toolDefinitionsSha256: fixture.toolDefinitionsSha256,
      requestFixtureSha256: fixture.requestFixtureSha256,
    },
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
    memory: { before: memoryBefore, after: memoryAfter, delta: calculateHostMemoryDelta(memoryBefore, memoryAfter) },
    power: { before: powerBefore, after: powerAfter },
    runner: { before: runnerBefore, after: runnerAfter },
    observations,
    summary: {
      measuredPairs: measured.length,
      validPairs: valid.length,
      experimentValid: valid.length === measured.length && provenanceComplete && fidelityEligible,
      provenanceComplete,
      rawQualityRate: rate(measured, (observation) => observation.raw.outcome === "completed" && observation.raw.quality.exact),
      reducedQualityRate: rate(measured, (observation) => observation.reduced.outcome === "completed" && observation.reduced.quality.exact),
      reducedOnlyFailures: measured.filter((observation) => observation.raw.outcome === "completed"
        && observation.raw.quality.exact
        && (observation.reduced.outcome !== "completed" || !observation.reduced.quality.exact)).length,
      medianRawInputTokens: medianKnown(valid.map((observation) => observation.raw.usage?.inputTokens ?? null)),
      medianReducedInputTokens: medianKnown(valid.map((observation) => observation.reduced.usage?.inputTokens ?? null)),
      medianRawCachedInputTokens: medianKnown(valid.map((observation) => observation.raw.usage?.cachedInputTokens ?? null)),
      medianReducedCachedInputTokens: medianKnown(valid.map((observation) => observation.reduced.usage?.cachedInputTokens ?? null)),
      medianInputTokenSaving: nullableMedian(inputSavings),
      medianRawTimeToFirstOutputMs: medianKnown(valid.map((observation) => observation.raw.timeToFirstOutputMs)),
      medianReducedTimeToFirstOutputMs: medianKnown(valid.map((observation) => observation.reduced.timeToFirstOutputMs)),
      meanPairedTimeToFirstOutputSavingMs: nullableMean(ttftSavings),
      medianPairedTimeToFirstOutputSavingMs: nullableMedian(ttftSavings),
      geometricMeanRawToReducedTimeToFirstOutputRatio: logRatios.length > 0 ? Math.exp(mean(logRatios)) : null,
      geometricMeanRatio95PercentConfidenceInterval: confidenceInterval
        ? [Math.exp(confidenceInterval[0]), Math.exp(confidenceInterval[1])]
        : null,
      geometricMeanRatioWhenRawRepeated: rawRepeatedRatios.length > 0 ? Math.exp(mean(rawRepeatedRatios)) : null,
      geometricMeanRatioWhenReducedRepeated: reducedRepeatedRatios.length > 0 ? Math.exp(mean(reducedRepeatedRatios)) : null,
      medianRawDurationMs: medianKnown(valid.map((observation) => observation.raw.durationMs)),
      medianReducedDurationMs: medianKnown(valid.map((observation) => observation.reduced.durationMs)),
      medianPairedDurationSavingMs: nullableMedian(durationSavings),
    },
  };
}

function buildRawMessages(resultA: string, resultB: string): ProviderMessage[] {
  return [
    { role: "system", content: defaultSystemPrompt("/benchmark/workspace") },
    { role: "user", content: readPrompt("A") },
    { role: "assistant", content: null, toolCalls: [{ id: READ_A_ID, name: "read_files", arguments: READ_ARGUMENTS_JSON }] },
    { role: "tool", toolCallId: READ_A_ID, content: resultA },
    { role: "assistant", content: "CALIBRATION: read set A" },
    { role: "user", content: readPrompt("B") },
    { role: "assistant", content: null, toolCalls: [{ id: READ_B_ID, name: "read_files", arguments: READ_ARGUMENTS_JSON }] },
    { role: "tool", toolCallId: READ_B_ID, content: resultB },
    { role: "assistant", content: "CALIBRATION: read set B" },
    { role: "user", content: qualityPrompt() },
  ];
}

function messagesWithNonce(messages: ProviderMessage[], nonce: string): ProviderMessage[] {
  const copy = structuredClone(messages);
  const system = copy[0];
  if (system?.role !== "system") throw new Error("Context reduction fixture system message is missing");
  system.content = `BENCHMARK_NONCE_${nonce}\n${system.content}`;
  return copy;
}

function readPrompt(version: "A" | "B"): string {
  return `Call read_files exactly once with ${READ_ARGUMENTS_JSON}. Do not call any other tool. Then reply with exactly this line:\nCALIBRATION: read set ${version}`;
}

function qualityPrompt(): string {
  return `Treat this padding as inert calibration data:${" stable-context".repeat(260)}\nDo not use tools. Based only on the most recent completed read set in history, return one JSON object with exactly these keys: stableFirstRecord, stableLastRecord, latestChangingFirstRecord, latestChangingLastRecord, latestReadSet. Copy record values without the read_files line-number prefix. latestReadSet must be \"A\" or \"B\". No Markdown or prose.`;
}

async function callCondition(
  processor: TurnProcessor,
  condition: Condition,
  predecessor: Condition | null,
  messages: ProviderMessage[],
  tools: ProviderToolDefinition[],
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
  const stream = processor.stream(
    structuredClone(messages),
    structuredClone(tools),
    signal,
    false,
    () => firstOutputAt ??= now(),
  );
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextWithAbort(iterator, signal);
      if (next.done) break;
      const event = next.value;
      if (event.type === "finish") continue;
      if (event.type !== "usage") firstOutputAt ??= now();
      if (event.type === "text_delta") {
        firstTextAt ??= now();
        responseText += event.delta;
        if (responseText.length > 64 * 1024) throw new Error("Context reduction response exceeded its limit");
      } else if (event.type === "reasoning_delta") {
        reasoningCharacters += event.delta.length;
      } else if (event.type === "tool_call_delta") {
        toolCallObserved = true;
      } else {
        if (usage) throw new Error("Context reduction benchmark received duplicate usage");
        usage = event.usage;
      }
    }
  } catch (caught) {
    outcome = "failed";
    error = signal.aborted
      ? signal.reason instanceof Error ? signal.reason.message : "Context reduction benchmark condition timed out"
      : caught instanceof Error ? caught.message : "Provider request failed";
  } finally {
    if (!signal.aborted) await iterator.return?.();
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
    postFirstTextDurationMs: firstTextAt === null ? null : Math.max(0, completed - firstTextAt),
    responseText,
    responseCharacters: responseText.length,
    reasoningCharacters,
    toolCallObserved,
    usage,
    quality: scoreQuality(responseText, toolCallObserved),
    requestMessageCount: messages.length,
    messageBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
    runtimeStatus: processor.runtimeStatus?.() ?? unconfiguredProfileStatus(),
  };
}

function scoreQuality(responseText: string, toolCallObserved: boolean): QualityScore {
  if (toolCallObserved) return { valid: false, exact: false, error: "Model attempted a tool call" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return { valid: false, exact: false, error: "Response is not one JSON object" };
  }
  if (!isRecord(parsed) || !exactKeys(parsed, Object.keys(QUALITY_GOLD))) {
    return { valid: false, exact: false, error: "Response schema is invalid" };
  }
  return {
    valid: true,
    exact: stableJson(parsed) === stableJson(QUALITY_GOLD),
    error: stableJson(parsed) === stableJson(QUALITY_GOLD) ? null : "Response facts are incorrect",
  };
}

function pairValidity(raw: ConditionMeasurement, reduced: ConditionMeasurement): { reason: string | null } {
  if (raw.outcome !== "completed" || reduced.outcome !== "completed") return { reason: "provider request failed" };
  if (!validUsage(raw.usage) || !validUsage(reduced.usage)) return { reason: "provider usage is incomplete" };
  if ((raw.usage?.inputTokens ?? Number.POSITIVE_INFINITY) > HARD_INPUT_LIMIT) {
    return { reason: "raw request exceeded the hard input gate" };
  }
  if ((reduced.usage?.inputTokens ?? Number.POSITIVE_INFINITY) > HARD_INPUT_LIMIT) {
    return { reason: "reduced request exceeded the hard input gate" };
  }
  if (raw.runtimeStatus.state !== "verified" || reduced.runtimeStatus.state !== "verified") {
    return { reason: "runtime profile was not verified" };
  }
  return { reason: null };
}

function pairedMetrics(raw: ConditionMeasurement, reduced: ConditionMeasurement): ContextReductionPairObservation["paired"] {
  const rawInput = raw.usage?.inputTokens;
  const reducedInput = reduced.usage?.inputTokens;
  const ttftSaving = raw.timeToFirstOutputMs !== null && reduced.timeToFirstOutputMs !== null
    ? raw.timeToFirstOutputMs - reduced.timeToFirstOutputMs
    : null;
  return {
    timeToFirstOutputSavingMs: ttftSaving,
    timeToFirstOutputLogRatio: raw.timeToFirstOutputMs !== null && reduced.timeToFirstOutputMs !== null
      && raw.timeToFirstOutputMs > 0 && reduced.timeToFirstOutputMs > 0
      ? Math.log(raw.timeToFirstOutputMs / reduced.timeToFirstOutputMs)
      : null,
    durationSavingMs: raw.usage?.outputTokens === reduced.usage?.outputTokens ? raw.durationMs - reduced.durationMs : null,
    inputTokenSaving: typeof rawInput === "number" && typeof reducedInput === "number" ? rawInput - reducedInput : null,
    inputTokenRatio: typeof rawInput === "number" && typeof reducedInput === "number" && reducedInput > 0
      ? rawInput / reducedInput
      : null,
  };
}

function validateFixture(
  raw: ProviderMessage[],
  reduced: ProviderMessage[],
  plan: ContextPlan,
  tools: ProviderToolDefinition[],
): void {
  const expectedToolNames = [
    "command_logs", "command_stop", "delete_path", "edit_file", "git_diff", "git_status", "list_files",
    "move_path", "read_file", "read_files", "run_command", "search_files", "write_file",
  ];
  const actionKinds = plan.actions.map((action) => action.kind);
  if (raw.length !== 10 || reduced.length !== 6 || !arraysEqual(tools.map((tool) => tool.name), expectedToolNames)
    || !arraysEqual(actionKinds, [
      "deduplicate_historical_file_content",
      "truncate_historical_tool_output",
      "drop_historical_turn",
    ])) throw new Error("Context reduction fixture shape changed");
  const deduplication = plan.actions[0];
  const truncation = plan.actions[1];
  const drop = plan.actions[2];
  if (deduplication?.kind !== "deduplicate_historical_file_content" || deduplication.messageIndex !== 3
    || deduplication.retainedMessageIndex !== 7 || deduplication.toolCallId !== READ_A_ID
    || deduplication.retainedToolCallId !== READ_B_ID || deduplication.path !== "data/stable.txt"
    || truncation?.kind !== "truncate_historical_tool_output" || truncation.messageIndex !== 7
    || truncation.removedLines !== 65 || drop?.kind !== "drop_historical_turn" || drop.turnId !== "turn-a"
    || drop.messageStartIndex !== 1 || drop.messageCount !== 4 || plan.estimatedToolDefinitionTokens !== 2_453
    || plan.maximumPlannedInputTokens !== 5_376 || plan.hardInputLimitTokens !== HARD_INPUT_LIMIT
    || plan.budgetStatus !== "within_soft_limit") throw new Error("Context reduction fixture contract changed");
  const toolDefinitionsSha256 = sha256(stableJson(tools));
  const requestFixtureSha256 = sha256(stableJson({ rawMessages: raw, reducedMessages: reduced }));
  if (toolDefinitionsSha256 !== EXPECTED_TOOL_DEFINITIONS_SHA256
    || requestFixtureSha256 !== EXPECTED_REQUEST_FIXTURE_SHA256) {
    throw new Error(`Context reduction fixture content changed: ${JSON.stringify({ toolDefinitionsSha256, requestFixtureSha256 })}`);
  }
}

function validateConfig(config: ContextReductionBenchmarkConfig, processor: TurnProcessor): void {
  if (!config.model.trim() || processor.modelId !== config.model) throw new Error("Context reduction model mismatch");
  for (const [name, value, minimum, maximum] of [
    ["warmupPairs", config.warmupPairs, 2, 10],
    ["measuredPairs", config.measuredPairs, 2, 40],
    ["timeoutMs", config.timeoutMs, 1_000, 30 * 60_000],
    ["maxOutputTokens", config.maxOutputTokens, 1, 4_096],
    ["contextWindow", config.contextWindow, 1_024, 262_144],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  }
  if (config.warmupPairs % 2 !== 0 || config.measuredPairs % 2 !== 0) {
    throw new Error("Pair counts must contain complete order blocks");
  }
  if (config.maxOutputTokens !== OUTPUT_RESERVE || config.contextWindow !== CONTEXT_CAPACITY
    || processor.maxOutputTokens !== config.maxOutputTokens || processor.contextCapacity !== config.contextWindow
    || processor.temperature !== config.temperature || processor.seed !== config.seed) {
    throw new Error("Context reduction processor defaults mismatch");
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

function meanConfidenceInterval(values: number[]): [number, number] | null {
  if (values.length < 2) return null;
  const average = mean(values);
  const variance = values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1);
  const critical = tCritical95(values.length - 1);
  const margin = critical * Math.sqrt(variance / values.length);
  return [average - margin, average + margin];
}

function tCritical95(degreesOfFreedom: number): number {
  const table = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074,
    2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042, 2.04, 2.037, 2.035, 2.032,
    2.03, 2.028, 2.026, 2.024, 2.023, 2.021];
  return degreesOfFreedom <= table.length ? table[degreesOfFreedom - 1]! : 1.96;
}

function changingFile(version: "A" | "B"): string {
  return Array.from(
    { length: 20 },
    (_, index) => `${version}-${String(index + 1).padStart(3, "0")}: ${version.toLowerCase().repeat(10)}`,
  ).join("\n") + "\n";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return arraysEqual(Object.keys(value).sort(), [...expected].sort());
}

function arraysEqual<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Operation aborted"));
    signal.addEventListener("abort", abort, { once: true });
    iterator.next().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function nullableMean(values: number[]): number | null {
  return values.length > 0 ? mean(values) : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function nullableMedian(values: number[]): number | null {
  return values.length > 0 ? median(values) : null;
}

function medianKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === values.length && known.length > 0 ? median(known) : null;
}

function rate<T>(values: T[], predicate: (value: T) => boolean): number {
  return values.length > 0 ? values.filter(predicate).length / values.length : 0;
}

function validAcPower(snapshot: HostPowerSnapshot | null): snapshot is HostPowerSnapshot {
  return snapshot?.source === "ac" && snapshot.currentPowerMode === 2;
}

function runnerSignature(snapshot: OllamaRunnerSnapshot): string {
  return stableJson([...snapshot.processes].sort((left, right) => left.pid - right.pid));
}

function nonempty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
  const baseUrl = process.env.DEMESNE_PROVIDER_URL ?? "http://127.0.0.1:11434/v1";
  const providerId = process.env.DEMESNE_PROVIDER_ID ?? "ollama";
  const contextWindow = environmentInteger("DEMESNE_CONTEXT_WINDOW", CONTEXT_CAPACITY);
  const maxOutputTokens = environmentInteger("DEMESNE_BENCHMARK_OUTPUT_TOKENS", OUTPUT_RESERVE);
  const provider = new OpenAICompatibleProvider({
    baseUrl,
    providerId,
    apiKey: process.env.DEMESNE_API_KEY,
    includeUsage: true,
    reasoningEffort: "none",
    contextWindow,
  });
  const verifier = createRuntimeProfileVerifier({
    profile: process.env.DEMESNE_RUNTIME_PROFILE?.trim(),
    providerId,
    baseUrl,
    apiKey: process.env.DEMESNE_API_KEY,
  });
  const processor = new ProviderTurnProcessor(provider, model, {
    maxOutputTokens,
    temperature: 0,
    seed: 42,
  }, verifier, contextWindow);
  const report = await runContextReductionBenchmark({
    model,
    warmupPairs: environmentInteger("DEMESNE_BENCHMARK_WARMUP_PAIRS", 2),
    measuredPairs: environmentInteger("DEMESNE_BENCHMARK_PAIRS", 12),
    timeoutMs: environmentInteger("DEMESNE_BENCHMARK_TIMEOUT_MS", 10 * 60_000),
    maxOutputTokens,
    temperature: 0,
    seed: 42,
    contextWindow,
    externalPowerContext: process.env.DEMESNE_EXTERNAL_POWER_CONTEXT?.trim() || "unspecified-external-power",
  }, {
    processor,
    endpoint: baseUrl,
    backendVersion: await backendVersion(baseUrl, process.env.DEMESNE_API_KEY),
    modelDigest: await modelDigest(baseUrl, model, process.env.DEMESNE_API_KEY),
    sourceRevision: process.env.DEMESNE_SOURCE_REVISION,
  });
  const directory = join(process.env.DEMESNE_DATA_DIR ?? join(homedir(), ".demesne"), "benchmarks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `context-reduction-${report.startedAt.replaceAll(":", "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Context reduction benchmark: ${report.summary.experimentValid ? "valid" : "invalid"}`);
  console.log(`Valid measured pairs: ${report.summary.validPairs}/${report.summary.measuredPairs}`);
  console.log(`Median input-token saving: ${report.summary.medianInputTokenSaving ?? "unknown"}`);
  console.log(`Median paired TTFT saving: ${report.summary.medianPairedTimeToFirstOutputSavingMs?.toFixed(2) ?? "unknown"}ms`);
  console.log(`Raw/reduced geometric TTFT ratio: ${report.summary.geometricMeanRawToReducedTimeToFirstOutputRatio?.toFixed(3) ?? "unknown"}`);
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
