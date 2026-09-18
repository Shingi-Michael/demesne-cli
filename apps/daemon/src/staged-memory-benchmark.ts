#!/usr/bin/env bun

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { isRecord, type RuntimeProfileStatus } from "@demesne/protocol";
import { OpenAICompatibleProvider } from "@demesne/providers";
import {
  runFullAgentContextBenchmark,
  type FullAgentContextBenchmarkReport,
} from "./full-agent-context-benchmark.ts";
import {
  createRuntimeProfileVerifier,
  readOllamaRunnerProcesses,
  type OllamaRunnerProcess,
  type RuntimeProfileVerifier,
} from "./ollama-runtime.ts";
import {
  calculateHostMemoryDelta,
  readHostMemorySnapshot,
  readHostPowerSnapshot,
  type HostMemoryDelta,
  type HostMemorySnapshot,
  type HostPowerSnapshot,
} from "./provider-benchmark.ts";
import { ProviderTurnProcessor } from "./provider-processor.ts";
import type { TurnProcessor } from "./processor.ts";

export const STAGED_MEMORY_BENCHMARK_SCHEMA_VERSION = 2 as const;

export interface StagedMemoryBenchmarkConfig {
  model: string;
  endpoint: string;
  backendVersion: string;
  modelDigest: string;
  sourceRevision: string;
  externalPowerContext: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  seed: number;
  idleDurationMs: number;
  transitionSettleMs: number;
  runnerTimeoutMs: number;
  pollIntervalMs: number;
  workloadTimeoutMs: number;
  workloadPairsPerFixture: number;
  runnerSampleIntervalMs: number;
  reloadModelBetweenWorkloadBlocks: boolean;
}

export interface RunnerResidentMemorySnapshot {
  observedAt: string;
  processes: Array<{ pid: number; residentBytes: number }>;
}

export interface StagedRunnerMemorySample extends RunnerResidentMemorySnapshot {
  phase: "modelLoad" | "idleResidency" | "workload" | "runnerRecycle" | "unloadRecovery";
}

export interface StagedRunnerMemoryEpoch {
  pid: number;
  firstObservedAt: string;
  lastObservedAt: string;
  sampleCount: number;
  firstResidentBytes: number;
  latestResidentBytes: number;
  observedPeakResidentBytes: number;
}

export interface StagedMemoryCheckpoint {
  phase: "unloaded" | "loaded" | "idle" | "workload" | "recovered";
  observedAt: string;
  memory: HostMemorySnapshot;
  power: HostPowerSnapshot;
  runners: OllamaRunnerProcess[];
  runnerMemory: RunnerResidentMemorySnapshot;
  profileStatus: RuntimeProfileStatus;
}

export interface StagedMemoryBenchmarkReport {
  schemaVersion: typeof STAGED_MEMORY_BENCHMARK_SCHEMA_VERSION;
  startedAt: string;
  completedAt: string;
  machine: {
    platform: string;
    architecture: string;
    osRelease: string;
    totalMemoryBytes: number;
    bunVersion: string;
  };
  runtime: {
    model: string;
    endpoint: string;
    backendVersion: string;
    modelDigest: string;
    sourceRevision: string;
    externalPowerContext: string;
    loadedProfileStatus: RuntimeProfileStatus;
  };
  config: StagedMemoryBenchmarkConfig;
  checkpoints: {
    unloaded: StagedMemoryCheckpoint;
    loaded: StagedMemoryCheckpoint;
    idle: StagedMemoryCheckpoint;
    workload: StagedMemoryCheckpoint;
    recovered: StagedMemoryCheckpoint;
  };
  intervals: {
    modelLoad: StagedMemoryInterval;
    idleResidency: StagedMemoryInterval;
    workload: StagedMemoryInterval;
    unloadRecovery: StagedMemoryInterval;
  };
  workload: FullAgentContextBenchmarkReport;
  runnerMemory: {
    sampleIntervalMs: number;
    unavailablePeriodicSamples: number;
    samples: StagedRunnerMemorySample[];
    epochs: StagedRunnerMemoryEpoch[];
  };
  summary: {
    experimentValid: boolean;
    provenanceComplete: boolean;
    runnerStable: boolean;
    workloadValid: boolean;
    noSustainedSwapGrowth: boolean;
    defaultMemoryEligible: boolean;
    controlledRunnerRecycles: number;
  };
}

export interface StagedMemoryInterval {
  from: StagedMemoryCheckpoint["phase"];
  to: StagedMemoryCheckpoint["phase"];
  durationMs: number;
  memoryDelta: HostMemoryDelta;
  pageOutBytesPerSecond: number | null;
  swapOutBytesPerSecond: number | null;
}

export interface StagedMemoryBenchmarkDependencies {
  processor: TurnProcessor;
  verifier: RuntimeProfileVerifier;
  fetch?: typeof fetch;
  memorySnapshot?: () => HostMemorySnapshot | null;
  powerSnapshot?: () => HostPowerSnapshot | null;
  runnerProcesses?: () => OllamaRunnerProcess[] | null;
  runnerMemorySnapshot?: (runners: OllamaRunnerProcess[]) => RunnerResidentMemorySnapshot | null;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  readBackendVersion?: () => Promise<string | null>;
  readModelDigest?: () => Promise<string | null>;
  runWorkload?: typeof runFullAgentContextBenchmark;
}

export interface IsolatedOllamaRecycleDependencies {
  verifier: RuntimeProfileVerifier;
  fetchImplementation: typeof fetch;
  runnerProcesses: () => OllamaRunnerProcess[] | null;
  powerSnapshot: () => HostPowerSnapshot | null;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
  readBackendVersion: () => Promise<string | null>;
  readModelDigest: () => Promise<string | null>;
  onUnloaded?: () => void;
  onReloaded?: () => void;
}

export async function runStagedMemoryBenchmark(
  config: StagedMemoryBenchmarkConfig,
  dependencies: StagedMemoryBenchmarkDependencies,
): Promise<StagedMemoryBenchmarkReport> {
  validateConfig(config, dependencies.processor);
  const fetchImplementation = dependencies.fetch ?? fetch;
  const memorySnapshot = dependencies.memorySnapshot ?? readHostMemorySnapshot;
  const powerSnapshot = dependencies.powerSnapshot ?? readHostPowerSnapshot;
  const runnerProcesses = dependencies.runnerProcesses ?? readOllamaRunnerProcesses;
  const runnerMemorySnapshot = dependencies.runnerMemorySnapshot ?? readRunnerResidentMemorySnapshot;
  const sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const now = dependencies.now ?? (() => new Date());
  const readBackend = dependencies.readBackendVersion
    ?? (() => readOllamaBackendVersion(config.endpoint, fetchImplementation));
  const readDigest = dependencies.readModelDigest
    ?? (() => readOllamaModelDigest(config.endpoint, config.model, fetchImplementation));
  const runWorkload = dependencies.runWorkload ?? runFullAgentContextBenchmark;
  const startedAt = now().toISOString();
  const runnerSampler = createRunnerMemorySampler(
    config.runnerSampleIntervalMs,
    dependencies.verifier,
    runnerMemorySnapshot,
  );

  await requireProvenance(config, readBackend, readDigest);
  requirePower(powerSnapshot(), "preflight");
  requireExclusiveServiceOwnership(dependencies.verifier.capture(), runnerProcesses(), "preflight");

  let benchmarkError: unknown;
  let cleanupError: unknown;
  try {
    await controlModel(config, fetchImplementation, 0);
    await waitForRunnerState(config, dependencies.verifier, runnerProcesses, sleep, now, 0);
    await sleep(config.transitionSettleMs);
    runnerSampler.setPhase("modelLoad");
    runnerSampler.start();
    const unloaded = checkpoint(
      "unloaded",
      dependencies.verifier,
      memorySnapshot,
      powerSnapshot,
      runnerProcesses,
      runnerMemorySnapshot,
      runnerSampler,
      now,
      0,
    );

    const loadStarted = now();
    await controlModel(config, fetchImplementation, -1);
    let expectedRunners = await waitForRunnerState(
      config,
      dependencies.verifier,
      runnerProcesses,
      sleep,
      now,
      1,
    );
    await dependencies.verifier.verify(config.model, []);
    await sleep(config.transitionSettleMs);
    await requireProvenance(config, readBackend, readDigest);
    const loaded = checkpoint(
      "loaded",
      dependencies.verifier,
      memorySnapshot,
      powerSnapshot,
      runnerProcesses,
      runnerMemorySnapshot,
      runnerSampler,
      now,
      1,
    );
    const loadedProfileStatus = dependencies.verifier.status();
    if (loadedProfileStatus.state !== "verified") throw new Error("Staged memory loaded profile is not verified");

    const idleStarted = now();
    runnerSampler.setPhase("idleResidency");
    await sleep(config.idleDurationMs);
    await dependencies.verifier.verify(config.model, expectedRunners);
    await requireProvenance(config, readBackend, readDigest);
    const idle = checkpoint(
      "idle",
      dependencies.verifier,
      memorySnapshot,
      powerSnapshot,
      runnerProcesses,
      runnerMemorySnapshot,
      runnerSampler,
      now,
      1,
    );

    const workloadStarted = now();
    runnerSampler.setPhase("workload");
    const workload = await runWorkload({
      model: config.model,
      warmupPairsPerFixture: 0,
      measuredPairsPerFixture: config.workloadPairsPerFixture,
      timeoutMs: config.workloadTimeoutMs,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      seed: config.seed,
      contextWindow: config.contextWindow,
      externalPowerContext: config.externalPowerContext,
    }, {
      processor: dependencies.processor,
      endpoint: config.endpoint,
      backendVersion: config.backendVersion,
      modelDigest: config.modelDigest,
      sourceRevision: config.sourceRevision,
      memorySnapshot,
      powerSnapshot,
      runnerSnapshot: () => {
        const processes = runnerProcesses();
        return processes ? { observedAt: now().toISOString(), processes } : null;
      },
      ...(config.reloadModelBetweenWorkloadBlocks ? {
        betweenOrderBlocks: async () => {
          runnerSampler.setPhase("runnerRecycle");
          expectedRunners = await recycleIsolatedOllamaRunner(config, expectedRunners, {
            verifier: dependencies.verifier,
            fetchImplementation,
            runnerProcesses,
            powerSnapshot,
            sleep,
            now,
            readBackendVersion: readBackend,
            readModelDigest: readDigest,
            onUnloaded: runnerSampler.sampleRequired,
            onReloaded: runnerSampler.sampleRequired,
          });
          runnerSampler.setPhase("workload");
        },
      } : {}),
    });
    await dependencies.verifier.verify(config.model, expectedRunners);
    await requireProvenance(config, readBackend, readDigest);
    const workloadCheckpoint = checkpoint(
      "workload",
      dependencies.verifier,
      memorySnapshot,
      powerSnapshot,
      runnerProcesses,
      runnerMemorySnapshot,
      runnerSampler,
      now,
      1,
    );
    const stable = runnerSignature(workloadCheckpoint.runners) === runnerSignature(expectedRunners);
    if (!stable) throw new Error("Staged memory runner changed outside a controlled boundary");

    const unloadStarted = now();
    runnerSampler.setPhase("unloadRecovery");
    await controlModel(config, fetchImplementation, 0);
    await waitForRunnerState(config, dependencies.verifier, runnerProcesses, sleep, now, 0);
    await sleep(config.transitionSettleMs);
    const recovered = checkpoint(
      "recovered",
      dependencies.verifier,
      memorySnapshot,
      powerSnapshot,
      runnerProcesses,
      runnerMemorySnapshot,
      runnerSampler,
      now,
      0,
    );
    runnerSampler.stop();
    const completedAt = now().toISOString();
    const checkpoints = { unloaded, loaded, idle, workload: workloadCheckpoint, recovered };
    const intervals = {
      modelLoad: interval(unloaded, loaded, Math.max(0, loadedTime(loaded) - loadStarted.getTime())),
      idleResidency: interval(loaded, idle, Math.max(0, loadedTime(idle) - idleStarted.getTime())),
      workload: interval(idle, workloadCheckpoint, Math.max(0, loadedTime(workloadCheckpoint) - workloadStarted.getTime())),
      unloadRecovery: interval(
        workloadCheckpoint,
        recovered,
        Math.max(0, loadedTime(recovered) - unloadStarted.getTime()),
      ),
    };
    const provenanceComplete = loadedProfileStatus.state === "verified"
      && config.backendVersion === await readBackend() && config.modelDigest === await readDigest()
      && validAcPower(unloaded.power) && validAcPower(loaded.power) && validAcPower(idle.power)
      && validAcPower(workloadCheckpoint.power) && validAcPower(recovered.power);
    const noSustainedSwapGrowth = intervals.idleResidency.memoryDelta.swapOutBytes === 0
      && intervals.workload.memoryDelta.swapOutBytes === 0;
    const workloadValid = workload.summary.experimentValid;
    return {
      schemaVersion: STAGED_MEMORY_BENCHMARK_SCHEMA_VERSION,
      startedAt,
      completedAt,
      machine: {
        platform: platform(),
        architecture: process.arch,
        osRelease: release(),
        totalMemoryBytes: totalmem(),
        bunVersion: Bun.version,
      },
      runtime: {
        model: config.model,
        endpoint: config.endpoint,
        backendVersion: config.backendVersion,
        modelDigest: config.modelDigest,
        sourceRevision: config.sourceRevision,
        externalPowerContext: config.externalPowerContext,
        loadedProfileStatus,
      },
      config,
      checkpoints,
      intervals,
      workload,
      runnerMemory: runnerSampler.report(),
      summary: {
        experimentValid: provenanceComplete && stable && workloadValid,
        provenanceComplete,
        runnerStable: stable,
        workloadValid,
        noSustainedSwapGrowth,
        defaultMemoryEligible: provenanceComplete && stable && workloadValid && noSustainedSwapGrowth,
        controlledRunnerRecycles: workload.blockTransitions.length,
      },
    };
  } catch (error) {
    benchmarkError = error;
  } finally {
    runnerSampler.stop();
    if (benchmarkError !== undefined) {
      try {
        await controlModel(config, fetchImplementation, 0);
        await waitForRunnerState(config, dependencies.verifier, runnerProcesses, sleep, now, 0);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (benchmarkError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([benchmarkError, cleanupError], "Staged memory benchmark and cleanup both failed");
  }
  throw benchmarkError;
}

export async function recycleIsolatedOllamaRunner(
  config: StagedMemoryBenchmarkConfig,
  expectedRunners: OllamaRunnerProcess[],
  dependencies: IsolatedOllamaRecycleDependencies,
  signal?: AbortSignal,
): Promise<OllamaRunnerProcess[]> {
  throwIfAborted(signal);
  requirePower(dependencies.powerSnapshot(), "runner recycle before unload");
  requireExclusiveServiceOwnership(
    dependencies.verifier.capture(),
    dependencies.runnerProcesses(),
    "runner recycle before unload",
  );
  await dependencies.verifier.verify(config.model, expectedRunners, signal);
  await requireProvenance(config, dependencies.readBackendVersion, dependencies.readModelDigest);
  await controlModel(config, dependencies.fetchImplementation, 0, signal);
  await waitForRunnerState(
    config,
    dependencies.verifier,
    dependencies.runnerProcesses,
    dependencies.sleep,
    dependencies.now,
    0,
    signal,
  );
  await dependencies.sleep(config.transitionSettleMs);
  throwIfAborted(signal);
  dependencies.onUnloaded?.();
  await controlModel(config, dependencies.fetchImplementation, -1, signal);
  const reloadedRunners = await waitForRunnerState(
    config,
    dependencies.verifier,
    dependencies.runnerProcesses,
    dependencies.sleep,
    dependencies.now,
    1,
    signal,
  );
  if (runnerSignature(reloadedRunners) === runnerSignature(expectedRunners)) {
    throw new Error("Staged memory controlled recycle did not replace the runner");
  }
  await dependencies.verifier.verify(config.model, [], signal);
  await dependencies.sleep(config.transitionSettleMs);
  throwIfAborted(signal);
  await requireProvenance(config, dependencies.readBackendVersion, dependencies.readModelDigest);
  requirePower(dependencies.powerSnapshot(), "runner recycle after load");
  requireExclusiveServiceOwnership(
    dependencies.verifier.capture(),
    dependencies.runnerProcesses(),
    "runner recycle after load",
  );
  dependencies.onReloaded?.();
  return reloadedRunners;
}

function checkpoint(
  phase: StagedMemoryCheckpoint["phase"],
  verifier: RuntimeProfileVerifier,
  memorySnapshot: () => HostMemorySnapshot | null,
  powerSnapshot: () => HostPowerSnapshot | null,
  runnerProcesses: () => OllamaRunnerProcess[] | null,
  runnerMemorySnapshot: (runners: OllamaRunnerProcess[]) => RunnerResidentMemorySnapshot | null,
  runnerSampler: ReturnType<typeof createRunnerMemorySampler>,
  now: () => Date,
  expectedRunners: number,
): StagedMemoryCheckpoint {
  const memory = memorySnapshot();
  if (!memory) throw new Error(`Staged memory ${phase} memory snapshot is unavailable`);
  const power = requirePower(powerSnapshot(), phase);
  const runners = runnerProcesses();
  if (!runners || runners.length !== expectedRunners) {
    throw new Error(`Staged memory ${phase} expected ${expectedRunners} global runners`);
  }
  const runnerMemory = runnerMemorySnapshot(runners);
  if (!runnerMemory) throw new Error(`Staged memory ${phase} runner memory snapshot is unavailable`);
  runnerSampler.record(runnerMemory);
  return { phase, observedAt: now().toISOString(), memory, power, runners, runnerMemory, profileStatus: verifier.status() };
}

function interval(
  from: StagedMemoryCheckpoint,
  to: StagedMemoryCheckpoint,
  durationMs: number,
): StagedMemoryInterval {
  const memoryDelta = calculateHostMemoryDelta(from.memory, to.memory);
  return {
    from: from.phase,
    to: to.phase,
    durationMs,
    memoryDelta,
    pageOutBytesPerSecond: rate(memoryDelta.pageOutBytes, durationMs),
    swapOutBytesPerSecond: rate(memoryDelta.swapOutBytes, durationMs),
  };
}

export async function controlModel(
  config: StagedMemoryBenchmarkConfig,
  fetchImplementation: typeof fetch,
  keepAlive: -1 | 0,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetchImplementation(new URL("/api/generate", config.endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    redirect: "manual",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(config.runnerTimeoutMs)])
      : AbortSignal.timeout(config.runnerTimeoutMs),
    body: JSON.stringify({
      model: config.model,
      prompt: "",
      stream: false,
      keep_alive: keepAlive,
      options: {
        num_ctx: config.contextWindow,
        num_predict: 1,
        temperature: config.temperature,
        seed: config.seed,
      },
    }),
  });
  if (!response.ok) throw new Error(`Ollama model ${keepAlive === 0 ? "unload" : "load"} returned HTTP ${response.status}`);
  await response.arrayBuffer();
}

export async function waitForRunnerState(
  config: StagedMemoryBenchmarkConfig,
  verifier: RuntimeProfileVerifier,
  runnerProcesses: () => OllamaRunnerProcess[] | null,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => Date,
  expectedCount: 0 | 1,
  signal?: AbortSignal,
): Promise<OllamaRunnerProcess[]> {
  const deadline = now().getTime() + config.runnerTimeoutMs;
  while (true) {
    throwIfAborted(signal);
    const owned = verifier.capture();
    const global = runnerProcesses();
    if (owned !== null && global !== null && owned.length === expectedCount && global.length === expectedCount
      && runnerSignature(owned) === runnerSignature(global)) return owned;
    if (now().getTime() >= deadline) {
      throw new Error(`Staged memory timed out waiting for ${expectedCount} isolated runner${expectedCount === 1 ? "" : "s"}`);
    }
    await sleep(config.pollIntervalMs);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function requireExclusiveServiceOwnership(
  owned: OllamaRunnerProcess[] | null,
  global: OllamaRunnerProcess[] | null,
  phase: string,
): void {
  if (owned === null || global === null || runnerSignature(owned) !== runnerSignature(global)) {
    throw new Error(`Staged memory ${phase} requires exclusive ownership of all Ollama runners`);
  }
}

async function requireProvenance(
  config: StagedMemoryBenchmarkConfig,
  readBackendVersion: () => Promise<string | null>,
  readModelDigest: () => Promise<string | null>,
): Promise<void> {
  const [backendVersion, modelDigest] = await Promise.all([readBackendVersion(), readModelDigest()]);
  if (backendVersion !== config.backendVersion || modelDigest !== config.modelDigest) {
    throw new Error("Staged memory runtime provenance changed");
  }
}

function requirePower(snapshot: HostPowerSnapshot | null, phase: string): HostPowerSnapshot {
  if (!validAcPower(snapshot)) throw new Error(`Staged memory ${phase} requires AC mode 2`);
  return snapshot;
}

function validAcPower(snapshot: HostPowerSnapshot | null): snapshot is HostPowerSnapshot {
  return snapshot?.source === "ac" && snapshot.currentPowerMode === 2;
}

function runnerSignature(processes: OllamaRunnerProcess[]): string {
  return [...processes]
    .sort((left, right) => left.pid - right.pid)
    .map((process) => `${process.pid}:${process.commandLine}`)
    .join("\n");
}

function rate(bytes: number | null, durationMs: number): number | null {
  return bytes === null || durationMs <= 0 ? null : bytes / (durationMs / 1_000);
}

function loadedTime(checkpoint: StagedMemoryCheckpoint): number {
  return new Date(checkpoint.observedAt).getTime();
}

function createRunnerMemorySampler(
  sampleIntervalMs: number,
  verifier: RuntimeProfileVerifier,
  snapshot: (runners: OllamaRunnerProcess[]) => RunnerResidentMemorySnapshot | null,
) {
  let phase: StagedRunnerMemorySample["phase"] = "modelLoad";
  let timer: ReturnType<typeof setInterval> | undefined;
  let unavailablePeriodicSamples = 0;
  const samples: StagedRunnerMemorySample[] = [];

  function record(value: RunnerResidentMemorySnapshot): void {
    samples.push({ ...value, processes: structuredClone(value.processes), phase });
  }

  function sample(required: boolean): void {
    const runners = verifier.capture();
    const value = runners === null ? null : snapshot(runners);
    if (value) {
      record(value);
      return;
    }
    if (required) throw new Error(`Staged memory ${phase} runner memory sample is unavailable`);
    unavailablePeriodicSamples += 1;
  }

  return {
    setPhase(value: StagedRunnerMemorySample["phase"]): void {
      phase = value;
    },
    start(): void {
      if (timer) return;
      timer = setInterval(() => sample(false), sampleIntervalMs);
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
    sampleRequired(): void {
      sample(true);
    },
    record,
    report(): StagedMemoryBenchmarkReport["runnerMemory"] {
      const epochSamples = new Map<number, Array<{ observedAt: string; residentBytes: number }>>();
      for (const sample of samples) {
        for (const process of sample.processes) {
          const values = epochSamples.get(process.pid) ?? [];
          values.push({ observedAt: sample.observedAt, residentBytes: process.residentBytes });
          epochSamples.set(process.pid, values);
        }
      }
      const epochs = [...epochSamples.entries()].map(([pid, values]): StagedRunnerMemoryEpoch => ({
        pid,
        firstObservedAt: values[0]!.observedAt,
        lastObservedAt: values.at(-1)!.observedAt,
        sampleCount: values.length,
        firstResidentBytes: values[0]!.residentBytes,
        latestResidentBytes: values.at(-1)!.residentBytes,
        observedPeakResidentBytes: Math.max(...values.map((value) => value.residentBytes)),
      }));
      return {
        sampleIntervalMs,
        unavailablePeriodicSamples,
        samples: structuredClone(samples),
        epochs,
      };
    },
  };
}

export function readRunnerResidentMemorySnapshot(
  runners: OllamaRunnerProcess[],
): RunnerResidentMemorySnapshot | null {
  if (platform() !== "darwin") return null;
  const processes: RunnerResidentMemorySnapshot["processes"] = [];
  for (const runner of runners) {
    try {
      const result = Bun.spawnSync({
        cmd: ["/bin/ps", "-o", "rss=", "-p", String(runner.pid)],
        env: { LC_ALL: "C" },
        stdout: "pipe",
        stderr: "ignore",
      });
      if (!result.success) return null;
      const residentKilobytes = Number(result.stdout.toString().trim());
      if (!Number.isSafeInteger(residentKilobytes) || residentKilobytes <= 0) return null;
      processes.push({ pid: runner.pid, residentBytes: residentKilobytes * 1024 });
    } catch {
      return null;
    }
  }
  return { observedAt: new Date().toISOString(), processes };
}

function validateConfig(config: StagedMemoryBenchmarkConfig, processor: TurnProcessor): void {
  if (!config.model.trim() || processor.modelId !== config.model) throw new Error("Staged memory model mismatch");
  if (!config.backendVersion.trim() || !config.modelDigest.trim() || !config.sourceRevision.trim()
    || !config.externalPowerContext.trim() || config.externalPowerContext === "unspecified-external-power") {
    throw new Error("Staged memory benchmark requires complete runtime, power, and source provenance");
  }
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname)
    || endpoint.port === "" || endpoint.port === "11434") {
    throw new Error("Staged memory benchmark requires an explicit isolated loopback Ollama endpoint");
  }
  for (const [name, value, minimum, maximum] of [
    ["contextWindow", config.contextWindow, 8_192, 8_192],
    ["maxOutputTokens", config.maxOutputTokens, 1_536, 1_536],
    ["idleDurationMs", config.idleDurationMs, 0, 10 * 60_000],
    ["transitionSettleMs", config.transitionSettleMs, 0, 60_000],
    ["runnerTimeoutMs", config.runnerTimeoutMs, 1_000, 10 * 60_000],
    ["pollIntervalMs", config.pollIntervalMs, 1, 10_000],
    ["workloadTimeoutMs", config.workloadTimeoutMs, 1_000, 30 * 60_000],
    ["workloadPairsPerFixture", config.workloadPairsPerFixture, 2, 10],
    ["runnerSampleIntervalMs", config.runnerSampleIntervalMs, 100, 10_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  }
  if (config.workloadPairsPerFixture % 2 !== 0) throw new Error("workloadPairsPerFixture must be even");
  if (typeof config.reloadModelBetweenWorkloadBlocks !== "boolean") {
    throw new Error("reloadModelBetweenWorkloadBlocks is invalid");
  }
  if (config.reloadModelBetweenWorkloadBlocks && config.workloadPairsPerFixture !== 2) {
    throw new Error("Controlled runner recycling requires exactly two workload pairs per fixture");
  }
  if (processor.contextCapacity !== config.contextWindow || processor.maxOutputTokens !== config.maxOutputTokens
    || processor.temperature !== config.temperature || processor.seed !== config.seed) {
    throw new Error("Staged memory processor defaults mismatch");
  }
}

export async function readOllamaBackendVersion(
  endpoint: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImplementation(new URL("/api/version", endpoint), {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    return isRecord(value) && typeof value.version === "string" ? value.version : null;
  } catch {
    return null;
  }
}

export async function readOllamaModelDigest(
  endpoint: string,
  model: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImplementation(new URL("/api/tags", endpoint), {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.models)) return null;
    for (const candidate of value.models) {
      if (!isRecord(candidate)) continue;
      const name = typeof candidate.name === "string" ? candidate.name : candidate.model;
      if (name === model && typeof candidate.digest === "string") return candidate.digest;
    }
    return null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const model = requiredEnvironment("DEMESNE_MODEL");
  const endpoint = requiredEnvironment("DEMESNE_PROVIDER_URL");
  const runtimeProfile = requiredEnvironment("DEMESNE_RUNTIME_PROFILE");
  const sourceRevision = requiredEnvironment("DEMESNE_SOURCE_REVISION");
  const externalPowerContext = requiredEnvironment("DEMESNE_EXTERNAL_POWER_CONTEXT");
  const providerId = process.env.DEMESNE_PROVIDER_ID ?? "ollama";
  const contextWindow = environmentInteger("DEMESNE_CONTEXT_WINDOW", 8_192);
  const maxOutputTokens = environmentInteger("DEMESNE_BENCHMARK_OUTPUT_TOKENS", 1_536);
  const backendVersion = await readOllamaBackendVersion(endpoint);
  const modelDigest = await readOllamaModelDigest(endpoint, model);
  if (!backendVersion || !modelDigest) throw new Error("Staged memory benchmark could not read Ollama provenance");
  const verifier = createRuntimeProfileVerifier({
    profile: runtimeProfile,
    providerId,
    baseUrl: endpoint,
    apiKey: process.env.DEMESNE_API_KEY,
  });
  if (!verifier) throw new Error("Staged memory benchmark requires runtime verification");
  const provider = new OpenAICompatibleProvider({
    baseUrl: endpoint,
    providerId,
    apiKey: process.env.DEMESNE_API_KEY,
    includeUsage: true,
    reasoningEffort: "none",
    contextWindow,
  });
  const processor = new ProviderTurnProcessor(provider, model, {
    maxOutputTokens,
    temperature: 0,
    seed: 42,
  }, verifier, contextWindow);
  const report = await runStagedMemoryBenchmark({
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
    idleDurationMs: environmentInteger("DEMESNE_MEMORY_IDLE_MS", 60_000),
    transitionSettleMs: environmentInteger("DEMESNE_MEMORY_SETTLE_MS", 5_000),
    runnerTimeoutMs: environmentInteger("DEMESNE_MEMORY_RUNNER_TIMEOUT_MS", 5 * 60_000),
    pollIntervalMs: environmentInteger("DEMESNE_MEMORY_POLL_MS", 500),
    workloadTimeoutMs: environmentInteger("DEMESNE_BENCHMARK_TIMEOUT_MS", 10 * 60_000),
    workloadPairsPerFixture: environmentInteger("DEMESNE_BENCHMARK_PAIRS", 2),
    runnerSampleIntervalMs: environmentInteger("DEMESNE_MEMORY_RUNNER_SAMPLE_MS", 1_000),
    reloadModelBetweenWorkloadBlocks: environmentBoolean("DEMESNE_MEMORY_RELOAD_BETWEEN_BLOCKS", false),
  }, { processor, verifier });
  const directory = join(process.env.DEMESNE_DATA_DIR ?? join(homedir(), ".demesne"), "benchmarks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `staged-memory-${report.startedAt.replaceAll(":", "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Staged memory benchmark: ${report.summary.experimentValid ? "valid" : "invalid"}`);
  console.log(`Default memory eligible: ${report.summary.defaultMemoryEligible ? "yes" : "no"}`);
  for (const [name, value] of Object.entries(report.intervals)) {
    console.log(`${name}: swap-out ${formatBytes(value.memoryDelta.swapOutBytes)}, page-out ${formatBytes(value.memoryDelta.pageOutBytes)}`);
  }
  console.log(`Raw report: ${path}`);
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

function environmentBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function formatBytes(value: number | null): string {
  return value === null ? "unknown" : `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
