#!/usr/bin/env bun

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenAICompatibleProvider } from "@demesne/providers";
import { createInferenceRecycleController } from "./inference-recycle-controller.ts";
import {
  runMixedAgentAdmissionBenchmark,
  type MixedAgentAdmissionBenchmarkConfig,
  type MixedAgentAdmissionBenchmarkReport,
} from "./mixed-agent-admission-benchmark.ts";
import {
  createRuntimeProfileVerifier,
  readOllamaRunnerProcesses,
  type OllamaRunnerProcess,
} from "./ollama-runtime.ts";
import {
  calculateHostMemoryDelta,
  readHostMemorySnapshot,
  readHostPowerSnapshot,
  readOllamaRunnerSnapshot,
  type HostMemorySnapshot,
  type HostPowerSnapshot,
} from "./provider-benchmark.ts";
import { ProviderTurnProcessor } from "./provider-processor.ts";
import {
  validateRunnerTransitionChain,
  type SchedulingRecycleTransition,
} from "./scheduling-recycle-benchmark.ts";
import {
  controlModel,
  readOllamaBackendVersion,
  readOllamaModelDigest,
  recycleIsolatedOllamaRunner,
  waitForRunnerState,
  type StagedMemoryBenchmarkConfig,
} from "./staged-memory-benchmark.ts";

export const MIXED_AGENT_RECYCLE_BENCHMARK_SCHEMA_VERSION = 1 as const;

export type MixedAgentRecycleMode = "disabled" | "threshold";

export interface MixedAgentRecycleTriggerConfig {
  workThreshold: number;
  subsequentWorkThreshold: number;
  availablePercentThreshold: number;
  maximumRecycles: number;
  maximumContinuationDrainMs: number;
}

export interface MixedAgentRecycleBenchmarkOptions {
  lifecycle: StagedMemoryBenchmarkConfig;
  admission: MixedAgentAdmissionBenchmarkConfig;
  runtimeProfile: string;
  recycleMode: MixedAgentRecycleMode;
  trigger: MixedAgentRecycleTriggerConfig;
}

type RecycleControllerReport = ReturnType<ReturnType<typeof createInferenceRecycleController>["report"]>;

export interface MixedAgentRecycleSummary {
  functionalValid: boolean;
  provenanceComplete: boolean;
  contiguousRunnerLifecycleValid: boolean;
  recycleCountValid: boolean;
  zeroDrainTimeouts: boolean;
  zeroSwapOutGrowth: boolean;
  memoryEligible: boolean;
  experimentValid: boolean;
}

export interface MixedAgentRecycleBenchmarkReport {
  schemaVersion: typeof MIXED_AGENT_RECYCLE_BENCHMARK_SCHEMA_VERSION;
  startedAt: string;
  completedAt: string;
  runtime: {
    model: string;
    endpoint: string;
    provider: "ollama";
    profile: string;
    contextWindow: number;
    maxOutputTokens: number;
    backendVersion: string;
    modelDigest: string;
    sourceRevision: string;
    externalPowerContext: string;
  };
  mode: MixedAgentRecycleMode;
  trigger: RecycleControllerReport;
  transitions: SchedulingRecycleTransition[];
  mixed: MixedAgentAdmissionBenchmarkReport;
  memory: {
    before: HostMemorySnapshot;
    after: HostMemorySnapshot;
    recovered: HostMemorySnapshot;
    delta: ReturnType<typeof calculateHostMemoryDelta>;
  };
  summary: MixedAgentRecycleSummary;
}

export interface MixedAgentRecycleSummaryInput {
  mode: MixedAgentRecycleMode;
  maximumRecycles: number;
  functionalValid: boolean;
  provenanceComplete: boolean;
  runnersBefore: OllamaRunnerProcess[];
  runnersAfter: OllamaRunnerProcess[];
  transitions: Pick<SchedulingRecycleTransition, "runnersBefore" | "runnersAfter">[];
  recycleCount: number;
  drainTimeoutCount: number;
  swapOutBytes: number | null;
}

export function evaluateMixedAgentRecycleSummary(
  input: MixedAgentRecycleSummaryInput,
): MixedAgentRecycleSummary {
  const { runnerLifecycleValid } = validateRunnerTransitionChain(
    input.runnersBefore,
    input.runnersAfter,
    input.transitions,
    input.recycleCount,
  );
  const recycleCountValid = input.mode === "disabled"
    ? input.recycleCount === 0 && input.transitions.length === 0
    : input.recycleCount === input.transitions.length && input.recycleCount <= input.maximumRecycles;
  const zeroDrainTimeouts = input.drainTimeoutCount === 0;
  const zeroSwapOutGrowth = input.swapOutBytes === 0;
  const memoryEligible = zeroSwapOutGrowth;
  const experimentValid = input.functionalValid && input.provenanceComplete && runnerLifecycleValid
    && recycleCountValid && zeroDrainTimeouts && memoryEligible;
  return {
    functionalValid: input.functionalValid,
    provenanceComplete: input.provenanceComplete,
    contiguousRunnerLifecycleValid: runnerLifecycleValid,
    recycleCountValid,
    zeroDrainTimeouts,
    zeroSwapOutGrowth,
    memoryEligible,
    experimentValid,
  };
}

export async function runMixedAgentRecycleBenchmark(
  options: MixedAgentRecycleBenchmarkOptions,
): Promise<MixedAgentRecycleBenchmarkReport> {
  validateOptions(options);
  const { lifecycle, admission, runtimeProfile, recycleMode } = options;
  const startedAt = new Date().toISOString();
  const verifier = createRuntimeProfileVerifier({
    profile: runtimeProfile,
    providerId: "ollama",
    baseUrl: lifecycle.endpoint,
    apiKey: process.env.DEMESNE_API_KEY,
  });
  if (!verifier) throw new Error("Mixed-agent recycle benchmark requires runtime verification");
  const runnerProcesses = readOllamaRunnerProcesses;
  const sleep = (milliseconds: number) => Bun.sleep(milliseconds);
  const now = () => new Date();
  const readBackendVersion = () => readOllamaBackendVersion(lifecycle.endpoint);
  const readModelDigest = () => readOllamaModelDigest(lifecycle.endpoint, lifecycle.model);
  await requireProvenance(lifecycle, readBackendVersion, readModelDigest);
  requirePower(readHostPowerSnapshot(), "preflight");
  requireExclusive(verifier.capture(), runnerProcesses(), "preflight");

  let expectedRunners: OllamaRunnerProcess[] = [];
  let mixed: MixedAgentAdmissionBenchmarkReport | undefined;
  let recovered: HostMemorySnapshot | undefined;
  let benchmarkError: unknown;
  let cleanupError: unknown;
  const transitions: SchedulingRecycleTransition[] = [];
  const controller = createInferenceRecycleController({
    workThreshold: options.trigger.workThreshold,
    subsequentWorkThreshold: options.trigger.subsequentWorkThreshold,
    availablePercentThreshold: options.trigger.availablePercentThreshold,
    maximumRecycles: options.trigger.maximumRecycles,
    maximumContinuationDrainMs: options.trigger.maximumContinuationDrainMs,
    memorySnapshot: readHostMemorySnapshot,
    recycle: async (signal) => {
      const transitionStartedAt = now().toISOString();
      const runnersBefore = structuredClone(expectedRunners);
      const memoryBefore = requireMemory(readHostMemorySnapshot(), "recycle before");
      const powerBefore = requirePower(readHostPowerSnapshot(), "recycle before");
      const runnersAfter = await recycleIsolatedOllamaRunner(lifecycle, expectedRunners, {
        verifier,
        fetchImplementation: fetch,
        runnerProcesses,
        powerSnapshot: readHostPowerSnapshot,
        sleep,
        now,
        readBackendVersion,
        readModelDigest,
      }, signal);
      const memoryAfter = requireMemory(readHostMemorySnapshot(), "recycle after");
      const powerAfter = requirePower(readHostPowerSnapshot(), "recycle after");
      expectedRunners = runnersAfter;
      transitions.push({
        startedAt: transitionStartedAt,
        completedAt: now().toISOString(),
        runnersBefore,
        runnersAfter: structuredClone(runnersAfter),
        memoryBefore,
        memoryAfter,
        memoryDelta: calculateHostMemoryDelta(memoryBefore, memoryAfter),
        powerBefore,
        powerAfter,
      });
    },
  });

  try {
    await controlModel(lifecycle, fetch, 0);
    await waitForRunnerState(lifecycle, verifier, runnerProcesses, sleep, now, 0);
    await sleep(lifecycle.transitionSettleMs);
    await controlModel(lifecycle, fetch, -1);
    expectedRunners = await waitForRunnerState(lifecycle, verifier, runnerProcesses, sleep, now, 1);
    await verifier.verify(lifecycle.model, []);
    await sleep(lifecycle.transitionSettleMs);
    await requireProvenance(lifecycle, readBackendVersion, readModelDigest);
    requirePower(readHostPowerSnapshot(), "loaded");
    requireExclusive(verifier.capture(), runnerProcesses(), "loaded");

    const provider = new OpenAICompatibleProvider({
      baseUrl: lifecycle.endpoint,
      providerId: "ollama",
      apiKey: process.env.DEMESNE_API_KEY,
      includeUsage: true,
      reasoningEffort: "none",
      contextWindow: lifecycle.contextWindow,
    });
    const processor = new ProviderTurnProcessor(provider, lifecycle.model, {
      maxOutputTokens: lifecycle.maxOutputTokens,
      temperature: 0,
      seed: 42,
    }, verifier, lifecycle.contextWindow);
    mixed = await runMixedAgentAdmissionBenchmark(admission, {
      processor,
      ...(recycleMode === "threshold" ? { inferenceBoundaryHook: controller.hook } : {}),
      memorySnapshot: readHostMemorySnapshot,
      powerSnapshot: readHostPowerSnapshot,
      runnerSnapshot: readOllamaRunnerSnapshot,
    });
    await verifier.verify(lifecycle.model, expectedRunners);
    await requireProvenance(lifecycle, readBackendVersion, readModelDigest);
    requirePower(readHostPowerSnapshot(), "after workload");
    requireExclusive(verifier.capture(), runnerProcesses(), "after workload");
  } catch (error) {
    benchmarkError = error;
  } finally {
    try {
      await controlModel(lifecycle, fetch, 0);
      await waitForRunnerState(lifecycle, verifier, runnerProcesses, sleep, now, 0);
      await sleep(lifecycle.transitionSettleMs);
      requirePower(readHostPowerSnapshot(), "recovered");
      await requireProvenance(lifecycle, readBackendVersion, readModelDigest);
      recovered = requireMemory(readHostMemorySnapshot(), "recovered");
    } catch (error) {
      cleanupError = error;
    }
  }
  if (benchmarkError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([benchmarkError, cleanupError], "Mixed-agent recycle benchmark and cleanup both failed");
  }
  if (benchmarkError !== undefined) throw benchmarkError;
  if (cleanupError !== undefined) throw cleanupError;
  if (!mixed || !recovered) throw new Error("Mixed-agent recycle benchmark did not complete all phases");

  const memoryBefore = requireMemory(mixed.memory.before, "workload before");
  const memoryAfter = requireMemory(mixed.memory.after, "workload after");
  const runnersBefore = requireRunners(mixed.runner.before?.processes, "workload before");
  const runnersAfter = requireRunners(mixed.runner.after?.processes, "workload after");
  const trigger = controller.report();
  const memoryDelta = calculateHostMemoryDelta(memoryBefore, memoryAfter);
  const provenanceComplete = verifier.status().state === "verified"
    && validPower(mixed.power.before) && validPower(mixed.power.after)
    && transitions.every((transition) => validPower(transition.powerBefore) && validPower(transition.powerAfter));
  const summary = evaluateMixedAgentRecycleSummary({
    mode: recycleMode,
    maximumRecycles: options.trigger.maximumRecycles,
    functionalValid: mixed.summary.functionalValid,
    provenanceComplete,
    runnersBefore,
    runnersAfter,
    transitions,
    recycleCount: trigger.recycleCount,
    drainTimeoutCount: trigger.drainTimeoutCount,
    swapOutBytes: memoryDelta.swapOutBytes,
  });
  return {
    schemaVersion: MIXED_AGENT_RECYCLE_BENCHMARK_SCHEMA_VERSION,
    startedAt,
    completedAt: now().toISOString(),
    runtime: {
      model: lifecycle.model,
      endpoint: lifecycle.endpoint,
      provider: "ollama",
      profile: runtimeProfile,
      contextWindow: lifecycle.contextWindow,
      maxOutputTokens: lifecycle.maxOutputTokens,
      backendVersion: lifecycle.backendVersion,
      modelDigest: lifecycle.modelDigest,
      sourceRevision: lifecycle.sourceRevision,
      externalPowerContext: lifecycle.externalPowerContext,
    },
    mode: recycleMode,
    trigger,
    transitions,
    mixed,
    memory: { before: memoryBefore, after: memoryAfter, recovered, delta: memoryDelta },
    summary,
  };
}

function validateOptions(options: MixedAgentRecycleBenchmarkOptions): void {
  const { lifecycle, runtimeProfile, recycleMode, trigger } = options;
  if (!lifecycle.model.trim() || !runtimeProfile.trim() || !lifecycle.backendVersion.trim()
    || !lifecycle.modelDigest.trim() || !lifecycle.sourceRevision.trim()
    || !lifecycle.externalPowerContext.trim() || lifecycle.externalPowerContext === "unspecified-external-power") {
    throw new Error("Mixed-agent recycle benchmark requires complete runtime, power, and source provenance");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(lifecycle.endpoint);
  } catch {
    throw new Error("Mixed-agent recycle benchmark requires an explicit isolated loopback Ollama endpoint");
  }
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname)
    || endpoint.port === "" || endpoint.port === "11434") {
    throw new Error("Mixed-agent recycle benchmark requires an explicit isolated loopback Ollama endpoint");
  }
  if (recycleMode !== "disabled" && recycleMode !== "threshold") {
    throw new Error("Mixed-agent recycle mode must be disabled or threshold");
  }
  integer(lifecycle.contextWindow, "contextWindow", 1, 1_000_000);
  integer(lifecycle.maxOutputTokens, "maxOutputTokens", 1, lifecycle.contextWindow - 1);
  integer(lifecycle.transitionSettleMs, "transitionSettleMs", 0, 60_000);
  integer(lifecycle.runnerTimeoutMs, "runnerTimeoutMs", 1_000, 10 * 60_000);
  integer(lifecycle.pollIntervalMs, "pollIntervalMs", 1, 10_000);
  integer(trigger.workThreshold, "workThreshold", 1, 10_000);
  integer(trigger.subsequentWorkThreshold, "subsequentWorkThreshold", 1, 10_000);
  integer(trigger.availablePercentThreshold, "availablePercentThreshold", 1, 100);
  integer(trigger.maximumRecycles, "maximumRecycles", 1, 100);
  integer(trigger.maximumContinuationDrainMs, "maximumContinuationDrainMs", 1, 10 * 60_000);
  integer(options.admission.repetitions, "repetitions", 1, 10);
  integer(
    options.admission.maximumInFlightTasks,
    "maximumInFlightTasks",
    2,
    5 * options.admission.repetitions,
  );
  integer(options.admission.timeoutMs, "timeoutMs", 100, 30 * 60_000);
  if (lifecycle.temperature !== 0 || lifecycle.seed !== 42) {
    throw new Error("Mixed-agent recycle benchmark requires temperature 0 and seed 42");
  }
}

async function requireProvenance(
  config: StagedMemoryBenchmarkConfig,
  readBackendVersion: () => Promise<string | null>,
  readModelDigest: () => Promise<string | null>,
): Promise<void> {
  const [backendVersion, modelDigest] = await Promise.all([readBackendVersion(), readModelDigest()]);
  if (backendVersion !== config.backendVersion || modelDigest !== config.modelDigest) {
    throw new Error("Mixed-agent recycle runtime provenance changed");
  }
}

function requireMemory(snapshot: HostMemorySnapshot | null | undefined, phase: string): HostMemorySnapshot {
  if (!snapshot) throw new Error(`Mixed-agent recycle ${phase} memory snapshot is unavailable`);
  return snapshot;
}

function requirePower(snapshot: HostPowerSnapshot | null, phase: string): HostPowerSnapshot {
  if (!validPower(snapshot)) throw new Error(`Mixed-agent recycle ${phase} requires AC mode 2`);
  return snapshot;
}

function validPower(snapshot: HostPowerSnapshot | null): snapshot is HostPowerSnapshot {
  return snapshot?.source === "ac" && snapshot.currentPowerMode === 2;
}

function requireExclusive(
  owned: OllamaRunnerProcess[] | null,
  global: OllamaRunnerProcess[] | null,
  phase: string,
): void {
  if (owned === null || global === null || runnerSignature(owned) !== runnerSignature(global)) {
    throw new Error(`Mixed-agent recycle ${phase} requires exclusive ownership of all Ollama runners`);
  }
}

function requireRunners(
  runners: Array<{ pid: number; commandLine: string }> | undefined,
  phase: string,
): OllamaRunnerProcess[] {
  if (!runners || runners.length === 0) {
    throw new Error(`Mixed-agent recycle ${phase} runner snapshot is unavailable`);
  }
  return runners;
}

function runnerSignature(runners: OllamaRunnerProcess[]): string {
  return [...runners].sort((left, right) => left.pid - right.pid)
    .map((runner) => `${runner.pid}:${runner.commandLine}`).join("\n");
}

function integer(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function environmentInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function environmentMode(name: string, fallback: MixedAgentRecycleMode): MixedAgentRecycleMode {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "disabled" || value === "threshold") return value;
  throw new Error(`${name} must be disabled or threshold`);
}

async function main(): Promise<void> {
  const model = requiredEnvironment("DEMESNE_MODEL");
  const endpoint = requiredEnvironment("DEMESNE_PROVIDER_URL");
  const runtimeProfile = requiredEnvironment("DEMESNE_RUNTIME_PROFILE");
  const backendVersion = requiredEnvironment("DEMESNE_BACKEND_VERSION");
  const modelDigest = requiredEnvironment("DEMESNE_MODEL_DIGEST");
  const sourceRevision = requiredEnvironment("DEMESNE_SOURCE_REVISION");
  const externalPowerContext = requiredEnvironment("DEMESNE_EXTERNAL_POWER_CONTEXT");
  const recycleMode = environmentMode("DEMESNE_MIXED_AGENT_RECYCLE_MODE", "disabled");
  const contextWindow = environmentInteger("DEMESNE_CONTEXT_WINDOW", 8_192);
  const maxOutputTokens = environmentInteger("DEMESNE_BENCHMARK_OUTPUT_TOKENS", 1_536);
  const timeoutMs = environmentInteger("DEMESNE_BENCHMARK_TIMEOUT_MS", 10 * 60_000);
  const workThreshold = environmentInteger("DEMESNE_MIXED_AGENT_RECYCLE_WORK_THRESHOLD", 20);
  const options: MixedAgentRecycleBenchmarkOptions = {
    lifecycle: {
      model,
      endpoint,
      backendVersion,
      modelDigest,
      sourceRevision,
      externalPowerContext,
      contextWindow,
      maxOutputTokens,
      temperature: 0,
      seed: 42,
      idleDurationMs: 0,
      transitionSettleMs: environmentInteger("DEMESNE_MEMORY_SETTLE_MS", 5_000),
      runnerTimeoutMs: environmentInteger("DEMESNE_MEMORY_RUNNER_TIMEOUT_MS", 5 * 60_000),
      pollIntervalMs: environmentInteger("DEMESNE_MEMORY_POLL_MS", 500),
      workloadTimeoutMs: timeoutMs,
      workloadPairsPerFixture: 2,
      runnerSampleIntervalMs: 1_000,
      reloadModelBetweenWorkloadBlocks: false,
    },
    admission: {
      repetitions: environmentInteger("DEMESNE_MIXED_AGENT_REPETITIONS", 2),
      maximumInFlightTasks: environmentInteger("DEMESNE_MIXED_AGENT_MAXIMUM_IN_FLIGHT_TASKS", 3),
      timeoutMs,
    },
    runtimeProfile,
    recycleMode,
    trigger: {
      workThreshold,
      subsequentWorkThreshold: environmentInteger(
        "DEMESNE_MIXED_AGENT_RECYCLE_SUBSEQUENT_WORK_THRESHOLD",
        workThreshold,
      ),
      availablePercentThreshold: environmentInteger("DEMESNE_MIXED_AGENT_RECYCLE_AVAILABLE_PERCENT", 20),
      maximumRecycles: environmentInteger("DEMESNE_MIXED_AGENT_RECYCLE_MAXIMUM", 1),
      maximumContinuationDrainMs: environmentInteger(
        "DEMESNE_MIXED_AGENT_RECYCLE_MAXIMUM_DRAIN_MS",
        120_000,
      ),
    },
  };
  const report = await runMixedAgentRecycleBenchmark(options);
  const directory = join(process.env.DEMESNE_DATA_DIR ?? join(homedir(), ".demesne"), "benchmarks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `mixed-agent-recycle-${report.startedAt.replaceAll(":", "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Mixed-agent recycle benchmark: ${report.summary.experimentValid ? "valid" : "invalid"}`);
  console.log(`Successful scenarios: ${report.mixed.summary.successfulScenarios}/${report.mixed.summary.totalScenarios}`);
  console.log(`Recycle count: ${report.trigger.recycleCount}`);
  console.log(`Raw report: ${path}`);
  if (!report.summary.experimentValid) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
