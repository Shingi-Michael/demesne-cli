#!/usr/bin/env bun

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenAICompatibleProvider } from "@demesne/providers";
import { createInferenceRecycleController } from "./inference-recycle-controller.ts";
import {
  createRuntimeProfileVerifier,
  readOllamaRunnerProcesses,
  type OllamaRunnerProcess,
} from "./ollama-runtime.ts";
import {
  calculateHostMemoryDelta,
  readHostMemorySnapshot,
  readHostPowerSnapshot,
  type HostMemorySnapshot,
  type HostPowerSnapshot,
} from "./provider-benchmark.ts";
import { ProviderTurnProcessor } from "./provider-processor.ts";
import {
  runSchedulingBenchmark,
  type SchedulingBenchmarkConfig,
  type SchedulingBenchmarkReport,
} from "./scheduling-benchmark.ts";
import {
  controlModel,
  readOllamaBackendVersion,
  readOllamaModelDigest,
  recycleIsolatedOllamaRunner,
  waitForRunnerState,
  type StagedMemoryBenchmarkConfig,
} from "./staged-memory-benchmark.ts";

export const SCHEDULING_RECYCLE_BENCHMARK_SCHEMA_VERSION = 3 as const;

export interface SchedulingRecycleTransition {
  startedAt: string;
  completedAt: string;
  runnersBefore: OllamaRunnerProcess[];
  runnersAfter: OllamaRunnerProcess[];
  memoryBefore: HostMemorySnapshot;
  memoryAfter: HostMemorySnapshot;
  memoryDelta: ReturnType<typeof calculateHostMemoryDelta>;
  powerBefore: HostPowerSnapshot;
  powerAfter: HostPowerSnapshot;
}

interface SchedulingRecycleBenchmarkReport {
  schemaVersion: typeof SCHEDULING_RECYCLE_BENCHMARK_SCHEMA_VERSION;
  startedAt: string;
  completedAt: string;
  runtime: {
    model: string;
    endpoint: string;
    profile: string;
    backendVersion: string;
    modelDigest: string;
    sourceRevision: string;
    recycleMode: "disabled" | "forced" | "threshold";
  };
  trigger: ReturnType<ReturnType<typeof createInferenceRecycleController>["report"]>;
  transitions: SchedulingRecycleTransition[];
  scheduling: SchedulingBenchmarkReport;
  memory: {
    before: HostMemorySnapshot;
    after: HostMemorySnapshot;
    recovered: HostMemorySnapshot;
    delta: ReturnType<typeof calculateHostMemoryDelta>;
  };
  summary: {
    experimentValid: boolean;
    schedulingValid: boolean;
    eventIntegrityValid: boolean;
    provenanceComplete: boolean;
    runnerReplaced: boolean;
    runnerLifecycleValid: boolean;
    recycleCount: number;
    recycleDelayObservedInQueue: boolean;
    continuationDrainValid: boolean;
    noSwapOutGrowth: boolean;
    memoryEligible: boolean;
  };
}

async function runSchedulingRecycleBenchmark(options: {
  lifecycle: StagedMemoryBenchmarkConfig;
  scheduling: SchedulingBenchmarkConfig;
  runtimeProfile: string;
  recycleMode: "disabled" | "forced" | "threshold";
  trigger: {
    workThreshold: number;
    subsequentWorkThreshold: number;
    availablePercentThreshold: number;
    maximumRecycles: number;
    maximumContinuationDrainMs: number;
  };
}): Promise<SchedulingRecycleBenchmarkReport> {
  const { lifecycle, scheduling, runtimeProfile, recycleMode } = options;
  const startedAt = new Date().toISOString();
  const verifier = createRuntimeProfileVerifier({
    profile: runtimeProfile,
    providerId: scheduling.providerId,
    baseUrl: lifecycle.endpoint,
    apiKey: process.env.DEMESNE_API_KEY,
  });
  if (!verifier) throw new Error("Scheduling recycle benchmark requires runtime verification");
  const runnerProcesses = readOllamaRunnerProcesses;
  const sleep = (milliseconds: number) => Bun.sleep(milliseconds);
  const now = () => new Date();
  const readBackendVersion = () => readOllamaBackendVersion(lifecycle.endpoint);
  const readModelDigest = () => readOllamaModelDigest(lifecycle.endpoint, lifecycle.model);
  await requireProvenance(lifecycle, readBackendVersion, readModelDigest);
  requirePower(readHostPowerSnapshot(), "preflight");
  requireExclusive(verifier.capture(), runnerProcesses(), "preflight");

  let expectedRunners: OllamaRunnerProcess[] = [];
  let schedulingReport: SchedulingBenchmarkReport | undefined;
  let memoryBefore: HostMemorySnapshot | undefined;
  let memoryAfter: HostMemorySnapshot | undefined;
  let recovered: HostMemorySnapshot | undefined;
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
      const transitionMemoryBefore = requireMemory(readHostMemorySnapshot(), "recycle before");
      const powerBefore = requirePower(readHostPowerSnapshot(), "recycle before");
      const reloaded = await recycleIsolatedOllamaRunner(lifecycle, expectedRunners, {
        verifier,
        fetchImplementation: fetch,
        runnerProcesses,
        powerSnapshot: readHostPowerSnapshot,
        sleep,
        now,
        readBackendVersion,
        readModelDigest,
      }, signal);
      const transitionMemoryAfter = requireMemory(readHostMemorySnapshot(), "recycle after");
      const powerAfter = requirePower(readHostPowerSnapshot(), "recycle after");
      expectedRunners = reloaded;
      transitions.push({
        startedAt: transitionStartedAt,
        completedAt: now().toISOString(),
        runnersBefore,
        runnersAfter: structuredClone(reloaded),
        memoryBefore: transitionMemoryBefore,
        memoryAfter: transitionMemoryAfter,
        memoryDelta: calculateHostMemoryDelta(transitionMemoryBefore, transitionMemoryAfter),
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
    memoryBefore = requireMemory(readHostMemorySnapshot(), "before workload");

    const provider = new OpenAICompatibleProvider({
      baseUrl: lifecycle.endpoint,
      providerId: scheduling.providerId,
      apiKey: process.env.DEMESNE_API_KEY,
      includeUsage: true,
      reasoningEffort: "none",
      contextWindow: lifecycle.contextWindow,
    });
    const processor = new ProviderTurnProcessor(provider, lifecycle.model, {
      maxOutputTokens: scheduling.maxOutputTokens,
      temperature: scheduling.temperature,
      seed: scheduling.seed,
    }, verifier, lifecycle.contextWindow);
    schedulingReport = await runSchedulingBenchmark(scheduling, {
      processor,
      ...(recycleMode === "disabled" ? {} : { inferenceBoundaryHook: controller.hook }),
      memorySnapshot: readHostMemorySnapshot,
      powerSnapshot: readHostPowerSnapshot,
      runnerSnapshot: () => {
        const processes = runnerProcesses();
        return processes ? { observedAt: now().toISOString(), processes } : null;
      },
    });
    await verifier.verify(lifecycle.model, expectedRunners);
    await requireProvenance(lifecycle, readBackendVersion, readModelDigest);
    requirePower(readHostPowerSnapshot(), "after workload");
    requireExclusive(verifier.capture(), runnerProcesses(), "after workload");
    memoryAfter = requireMemory(readHostMemorySnapshot(), "after workload");
  } finally {
    await controlModel(lifecycle, fetch, 0);
    await waitForRunnerState(lifecycle, verifier, runnerProcesses, sleep, now, 0);
    await sleep(lifecycle.transitionSettleMs);
    recovered = requireMemory(readHostMemorySnapshot(), "recovered");
  }

  if (!schedulingReport || !memoryBefore || !memoryAfter || !recovered) {
    throw new Error("Scheduling recycle benchmark did not complete all phases");
  }
  const trigger = controller.report();
  const memoryDelta = calculateHostMemoryDelta(memoryBefore, memoryAfter);
  const measured = schedulingReport.observations.filter((observation) => observation.phase === "measured");
  const schedulingValid = measured.length === scheduling.measuredRuns
    && schedulingReport.summary.successfulRuns === schedulingReport.summary.measuredRuns;
  const eventIntegrityValid = measured.every((observation) =>
    observation.turns.every((turn) => turn.eventIntegrityValid)
  );
  const provenanceComplete = verifier.status().state === "verified"
    && lifecycle.backendVersion === await readBackendVersion()
    && lifecycle.modelDigest === await readModelDigest()
    && validPower(schedulingReport.power.before) && validPower(schedulingReport.power.after)
    && transitions.every((transition) => validPower(transition.powerBefore) && validPower(transition.powerAfter));
  const schedulingRunnerBefore = schedulingReport.runner.before?.processes ?? [];
  const schedulingRunnerAfter = schedulingReport.runner.after?.processes ?? [];
  const { runnerReplaced, runnerLifecycleValid } = validateRunnerTransitionChain(
    schedulingRunnerBefore,
    schedulingRunnerAfter,
    transitions,
    trigger.recycleCount,
  );
  const recycleDurations = trigger.decisions.flatMap((decision) =>
    decision.recycled && decision.recycleDurationMs !== null ? [decision.recycleDurationMs] : []
  );
  const maximumQueueDurationMs = Math.max(0, ...measured.flatMap((observation) =>
    observation.turns.flatMap((turn) => turn.rounds.map((round) => round.queueDurationMs ?? 0))
  ));
  const recycleDelayObservedInQueue = recycleDurations.every((duration) => maximumQueueDurationMs >= duration);
  const recycleCountValid = recycleMode === "forced"
    ? trigger.recycleCount === 1
    : recycleMode === "disabled"
      ? trigger.recycleCount === 0
      : trigger.recycleCount <= options.trigger.maximumRecycles;
  const continuationDrainValid = trigger.drainTimeoutCount === 0;
  const noSwapOutGrowth = memoryDelta.swapOutBytes === 0;
  return {
    schemaVersion: SCHEDULING_RECYCLE_BENCHMARK_SCHEMA_VERSION,
    startedAt,
    completedAt: now().toISOString(),
    runtime: {
      model: lifecycle.model,
      endpoint: lifecycle.endpoint,
      profile: runtimeProfile,
      backendVersion: lifecycle.backendVersion,
      modelDigest: lifecycle.modelDigest,
      sourceRevision: lifecycle.sourceRevision,
      recycleMode,
    },
    trigger,
    transitions,
    scheduling: schedulingReport,
    memory: { before: memoryBefore, after: memoryAfter, recovered, delta: memoryDelta },
    summary: {
      experimentValid: schedulingValid && eventIntegrityValid && provenanceComplete && runnerLifecycleValid
        && recycleCountValid && recycleDelayObservedInQueue && continuationDrainValid,
      schedulingValid,
      eventIntegrityValid,
      provenanceComplete,
      runnerReplaced,
      runnerLifecycleValid,
      recycleCount: trigger.recycleCount,
      recycleDelayObservedInQueue,
      continuationDrainValid,
      noSwapOutGrowth,
      memoryEligible: noSwapOutGrowth,
    },
  };
}

function requireMemory(snapshot: HostMemorySnapshot | null, phase: string): HostMemorySnapshot {
  if (!snapshot) throw new Error(`Scheduling recycle ${phase} memory snapshot is unavailable`);
  return snapshot;
}

function requirePower(snapshot: HostPowerSnapshot | null, phase: string): HostPowerSnapshot {
  if (!validPower(snapshot)) throw new Error(`Scheduling recycle ${phase} requires AC mode 2`);
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
    throw new Error(`Scheduling recycle ${phase} requires exclusive ownership of all Ollama runners`);
  }
}

function runnerSignature(runners: OllamaRunnerProcess[]): string {
  return [...runners].sort((left, right) => left.pid - right.pid)
    .map((runner) => `${runner.pid}:${runner.commandLine}`).join("\n");
}

export function validateRunnerTransitionChain(
  runnersBefore: OllamaRunnerProcess[],
  runnersAfter: OllamaRunnerProcess[],
  transitions: Pick<SchedulingRecycleTransition, "runnersBefore" | "runnersAfter">[],
  recycleCount: number,
): { runnerReplaced: boolean; runnerLifecycleValid: boolean } {
  const runnerReplaced = transitions.length > 0 && transitions.every((transition) =>
    runnerSignature(transition.runnersBefore) !== runnerSignature(transition.runnersAfter)
  );
  let expectedRunnerSignature = runnerSignature(runnersBefore);
  let transitionChainValid = expectedRunnerSignature.length > 0;
  for (const transition of transitions) {
    if (runnerSignature(transition.runnersBefore) !== expectedRunnerSignature) transitionChainValid = false;
    expectedRunnerSignature = runnerSignature(transition.runnersAfter);
  }
  return {
    runnerReplaced,
    runnerLifecycleValid: transitionChainValid
      && transitions.length === recycleCount
      && runnerSignature(runnersAfter) === expectedRunnerSignature,
  };
}

async function requireProvenance(
  config: StagedMemoryBenchmarkConfig,
  readBackendVersion: () => Promise<string | null>,
  readModelDigest: () => Promise<string | null>,
): Promise<void> {
  const [backendVersion, modelDigest] = await Promise.all([readBackendVersion(), readModelDigest()]);
  if (backendVersion !== config.backendVersion || modelDigest !== config.modelDigest) {
    throw new Error("Scheduling recycle runtime provenance changed");
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

async function main(): Promise<void> {
  const model = requiredEnvironment("DEMESNE_MODEL");
  const endpoint = requiredEnvironment("DEMESNE_PROVIDER_URL");
  const runtimeProfile = requiredEnvironment("DEMESNE_RUNTIME_PROFILE");
  const recycleMode = environmentRecycleMode("DEMESNE_SCHEDULING_RECYCLE_MODE", "forced");
  const trigger = recycleMode === "forced" ? {
    workThreshold: 1,
    subsequentWorkThreshold: 1,
    availablePercentThreshold: 100,
    maximumRecycles: 1,
    maximumContinuationDrainMs: environmentInteger("DEMESNE_SCHEDULING_RECYCLE_MAXIMUM_DRAIN_MS", 120_000),
  } : {
    workThreshold: environmentInteger("DEMESNE_SCHEDULING_RECYCLE_WORK_THRESHOLD", 20),
    subsequentWorkThreshold: environmentInteger(
      "DEMESNE_SCHEDULING_RECYCLE_SUBSEQUENT_WORK_THRESHOLD",
      environmentInteger("DEMESNE_SCHEDULING_RECYCLE_WORK_THRESHOLD", 20),
    ),
    availablePercentThreshold: environmentInteger("DEMESNE_SCHEDULING_RECYCLE_AVAILABLE_PERCENT", 20),
    maximumRecycles: environmentInteger("DEMESNE_SCHEDULING_RECYCLE_MAXIMUM", 1),
    maximumContinuationDrainMs: environmentInteger("DEMESNE_SCHEDULING_RECYCLE_MAXIMUM_DRAIN_MS", 120_000),
  };
  const sourceRevision = requiredEnvironment("DEMESNE_SOURCE_REVISION");
  const externalPowerContext = requiredEnvironment("DEMESNE_EXTERNAL_POWER_CONTEXT");
  const backendVersion = await readOllamaBackendVersion(endpoint);
  const modelDigest = await readOllamaModelDigest(endpoint, model);
  if (!backendVersion || !modelDigest) throw new Error("Scheduling recycle benchmark could not read Ollama provenance");
  const contextWindow = environmentInteger("DEMESNE_CONTEXT_WINDOW", 8_192);
  const lifecycle: StagedMemoryBenchmarkConfig = {
    model,
    endpoint,
    backendVersion,
    modelDigest,
    sourceRevision,
    externalPowerContext,
    contextWindow,
    maxOutputTokens: 1_536,
    temperature: 0,
    seed: 42,
    idleDurationMs: 0,
    transitionSettleMs: environmentInteger("DEMESNE_MEMORY_SETTLE_MS", 5_000),
    runnerTimeoutMs: environmentInteger("DEMESNE_MEMORY_RUNNER_TIMEOUT_MS", 5 * 60_000),
    pollIntervalMs: environmentInteger("DEMESNE_MEMORY_POLL_MS", 500),
    workloadTimeoutMs: environmentInteger("DEMESNE_BENCHMARK_TIMEOUT_MS", 10 * 60_000),
    workloadPairsPerFixture: 2,
    runnerSampleIntervalMs: 1_000,
    reloadModelBetweenWorkloadBlocks: false,
  };
  const scheduling: SchedulingBenchmarkConfig = {
    fixtureId: "concurrent-distinct-read-only-diagnosis-recycle-v1",
    model,
    providerUrl: endpoint,
    providerId: process.env.DEMESNE_PROVIDER_ID?.trim() || "ollama",
    inferenceSlots: 1,
    warmupRuns: 0,
    measuredRuns: environmentInteger("DEMESNE_BENCHMARK_RUNS", 1),
    timeoutMs: environmentInteger("DEMESNE_BENCHMARK_TIMEOUT_MS", 10 * 60_000),
    maxOutputTokens: environmentInteger("DEMESNE_BENCHMARK_OUTPUT_TOKENS", 512),
    temperature: 0,
    seed: 42,
    profileLabel: `${runtimeProfile}-${recycleMode}-recycle`,
    promptPaddingLines: environmentInteger("DEMESNE_SCHEDULING_PADDING_LINES", 0),
    readChainDepths: [
      environmentInteger("DEMESNE_SCHEDULING_READ_DEPTH_A", 1),
      environmentInteger("DEMESNE_SCHEDULING_READ_DEPTH_B", 1),
    ],
    maximumInFlightPairs: environmentInteger("DEMESNE_SCHEDULING_MAXIMUM_IN_FLIGHT_PAIRS", 1),
  };
  const report = await runSchedulingRecycleBenchmark({ lifecycle, scheduling, runtimeProfile, recycleMode, trigger });
  const directory = join(process.env.DEMESNE_DATA_DIR ?? join(homedir(), ".demesne"), "benchmarks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `scheduling-recycle-${report.startedAt.replaceAll(":", "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Scheduling recycle benchmark: ${report.summary.experimentValid ? "valid" : "invalid"}`);
  console.log(`Successful measured pairs: ${report.scheduling.summary.successfulRuns}/${report.scheduling.summary.measuredRuns}`);
  console.log(`Recycle count: ${report.summary.recycleCount}`);
  console.log(`Raw report: ${path}`);
}

function environmentRecycleMode(
  name: string,
  fallback: "disabled" | "forced" | "threshold",
): "disabled" | "forced" | "threshold" {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "disabled" || value === "forced" || value === "threshold") return value;
  throw new Error(`${name} must be disabled, forced, or threshold`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
