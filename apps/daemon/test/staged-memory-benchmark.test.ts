import { expect, test } from "bun:test";
import type { RuntimeProfileStatus } from "@demesne/protocol";
import type { FullAgentContextBenchmarkReport } from "../src/full-agent-context-benchmark.ts";
import type { OllamaRunnerProcess, RuntimeProfileVerifier } from "../src/ollama-runtime.ts";
import {
  runStagedMemoryBenchmark,
  type StagedMemoryBenchmarkConfig,
  type StagedMemoryBenchmarkDependencies,
} from "../src/staged-memory-benchmark.ts";
import type { TurnProcessor } from "../src/processor.ts";

const RUNNER: OllamaRunnerProcess = {
  pid: 123,
  commandLine: "llama-server --model /models/model -c 8192 -np 1 --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn on -b 512 -ub 512",
};
const RELOADED_RUNNER: OllamaRunnerProcess = { ...RUNNER, pid: 456 };

test("staged memory benchmark attributes load, idle, workload, and recovery intervals", async () => {
  const harness = createHarness();
  const report = await runStagedMemoryBenchmark(config(), harness.dependencies);

  expect(harness.keepAliveRequests).toEqual([0, -1, 0]);
  expect(harness.calls).toEqual([
    "provenance", "power", "unload", "sleep:10", "memory", "power",
    "load", "verify", "sleep:10", "provenance", "memory", "power",
    "sleep:100", "verify", "provenance", "memory", "power",
    "workload", "verify", "provenance", "memory", "power",
    "unload", "sleep:10", "memory", "power", "provenance",
  ]);
  expect(report.intervals.modelLoad.memoryDelta).toMatchObject({
    availablePercentagePoints: -20,
    swapUsedBytes: 100,
    pageOutBytes: 40_960,
    swapOutBytes: 40_960,
  });
  expect(report.intervals.idleResidency.memoryDelta).toMatchObject({
    availablePercentagePoints: -1,
    swapUsedBytes: 0,
    pageOutBytes: 8_192,
    swapOutBytes: 0,
  });
  expect(report.intervals.workload.memoryDelta).toMatchObject({
    availablePercentagePoints: -9,
    swapUsedBytes: 300,
    pageOutBytes: 32_768,
    swapOutBytes: 81_920,
  });
  expect(report.intervals.unloadRecovery.memoryDelta).toMatchObject({
    availablePercentagePoints: 25,
    swapUsedBytes: -100,
    pageOutBytes: 20_480,
    swapOutBytes: 20_480,
  });
  expect(report.summary).toEqual({
    experimentValid: true,
    provenanceComplete: true,
    runnerStable: true,
    workloadValid: true,
    noSustainedSwapGrowth: false,
    defaultMemoryEligible: false,
    controlledRunnerRecycles: 0,
  });
  expect(report.runnerMemory.epochs).toEqual([{
    pid: RUNNER.pid,
    firstObservedAt: "2026-08-28T00:00:00.000Z",
    lastObservedAt: "2026-08-28T00:00:00.000Z",
    sampleCount: 3,
    firstResidentBytes: 1_000,
    latestResidentBytes: 1_000,
    observedPeakResidentBytes: 1_000,
  }]);
});

test("staged memory benchmark rejects provenance before changing model residency", async () => {
  const harness = createHarness();
  await expect(runStagedMemoryBenchmark({ ...config(), sourceRevision: "" }, harness.dependencies)).rejects.toThrow(
    "requires complete runtime, power, and source provenance",
  );
  expect(harness.keepAliveRequests).toEqual([]);
});

test("staged memory benchmark requires exclusive ownership before unloading", async () => {
  const harness = createHarness();
  harness.globalRunners.push({ ...RUNNER, pid: 999 });

  await expect(runStagedMemoryBenchmark(config(), harness.dependencies)).rejects.toThrow(
    "requires exclusive ownership of all Ollama runners",
  );
  expect(harness.keepAliveRequests).toEqual([]);
});

test("staged memory benchmark unloads its isolated model after workload failure", async () => {
  const harness = createHarness();
  harness.dependencies.runWorkload = async () => {
    harness.calls.push("workload");
    throw new Error("workload failed");
  };

  await expect(runStagedMemoryBenchmark(config(), harness.dependencies)).rejects.toThrow("workload failed");
  expect(harness.keepAliveRequests).toEqual([0, -1, 0]);
  expect(harness.globalRunners).toEqual([]);
});

test("staged memory benchmark rejects power drift and still unloads", async () => {
  const harness = createHarness();
  let powerReads = 0;
  harness.dependencies.powerSnapshot = () => {
    powerReads += 1;
    return powerReads < 4 ? power() : { ...power(), source: "battery", currentPowerMode: 1 };
  };

  await expect(runStagedMemoryBenchmark(config(), harness.dependencies)).rejects.toThrow("idle requires AC mode 2");
  expect(harness.keepAliveRequests).toEqual([0, -1, 0]);
  expect(harness.globalRunners).toEqual([]);
});

test("staged memory benchmark recycles and reverifies the runner between order blocks", async () => {
  const harness = createHarness({ replaceRunnerOnReload: true });
  const report = await runStagedMemoryBenchmark({
    ...config(),
    reloadModelBetweenWorkloadBlocks: true,
  }, harness.dependencies);

  expect(harness.keepAliveRequests).toEqual([0, -1, 0, -1, 0]);
  expect(report.summary).toMatchObject({
    experimentValid: true,
    runnerStable: true,
    workloadValid: true,
    controlledRunnerRecycles: 1,
  });
  expect(report.runnerMemory.epochs.map((epoch) => epoch.pid)).toEqual([RUNNER.pid, RELOADED_RUNNER.pid]);
});

test("staged memory benchmark fails when a controlled recycle retains the runner", async () => {
  const harness = createHarness();

  await expect(runStagedMemoryBenchmark({
    ...config(),
    reloadModelBetweenWorkloadBlocks: true,
  }, harness.dependencies)).rejects.toThrow("controlled recycle did not replace the runner");
  expect(harness.keepAliveRequests).toEqual([0, -1, 0, -1, 0]);
  expect(harness.globalRunners).toEqual([]);
});

function config(): StagedMemoryBenchmarkConfig {
  return {
    model: "test-model",
    endpoint: "http://127.0.0.1:11435/v1",
    backendVersion: "test-backend",
    modelDigest: "test-digest",
    sourceRevision: "test-source",
    externalPowerContext: "controlled-test-power",
    contextWindow: 8_192,
    maxOutputTokens: 1_536,
    temperature: 0,
    seed: 42,
    idleDurationMs: 100,
    transitionSettleMs: 10,
    runnerTimeoutMs: 1_000,
    pollIntervalMs: 1,
    workloadTimeoutMs: 10_000,
    workloadPairsPerFixture: 2,
    runnerSampleIntervalMs: 1_000,
    reloadModelBetweenWorkloadBlocks: false,
  };
}

function createHarness(options: { replaceRunnerOnReload?: boolean } = {}): {
  dependencies: StagedMemoryBenchmarkDependencies;
  calls: string[];
  keepAliveRequests: number[];
  globalRunners: OllamaRunnerProcess[];
} {
  const calls: string[] = [];
  const keepAliveRequests: number[] = [];
  const globalRunners: OllamaRunnerProcess[] = [];
  const serviceRunners: OllamaRunnerProcess[] = [];
  let loadCount = 0;
  const memories = [
    memory(100, 100, 10, 20),
    memory(80, 200, 20, 30),
    memory(79, 200, 22, 30),
    memory(70, 500, 30, 50),
    memory(95, 400, 35, 55),
  ];
  let clock = new Date("2026-08-28T00:00:00.000Z").getTime();
  const verifier: RuntimeProfileVerifier = {
    status: profileStatus,
    reset() {},
    capture: () => structuredClone(serviceRunners),
    async verify(_model, baseline) {
      calls.push("verify");
      expect(baseline).not.toBeNull();
      expect(serviceRunners).toHaveLength(1);
      if (baseline && baseline.length > 0) expect(serviceRunners).toEqual(baseline);
    },
  };
  const dependencies: StagedMemoryBenchmarkDependencies = {
    processor: processor(),
    verifier,
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { keep_alive: number };
      keepAliveRequests.push(body.keep_alive);
      calls.push(body.keep_alive === 0 ? "unload" : "load");
      if (body.keep_alive === -1) loadCount += 1;
      const loadedRunner = options.replaceRunnerOnReload && loadCount > 1 ? RELOADED_RUNNER : RUNNER;
      const nextRunners = body.keep_alive === -1 ? [loadedRunner] : [];
      serviceRunners.splice(0, serviceRunners.length, ...nextRunners);
      globalRunners.splice(0, globalRunners.length, ...nextRunners);
      clock += 20;
      return Response.json({ done: true });
    }) as unknown as typeof fetch,
    memorySnapshot: () => {
      calls.push("memory");
      return memories.shift() ?? null;
    },
    powerSnapshot: () => {
      calls.push("power");
      return power();
    },
    runnerProcesses: () => structuredClone(globalRunners),
    runnerMemorySnapshot: (runners) => ({
      observedAt: "2026-08-28T00:00:00.000Z",
      processes: runners.map((runner) => ({ pid: runner.pid, residentBytes: runner.pid === RUNNER.pid ? 1_000 : 900 })),
    }),
    sleep: async (milliseconds) => {
      calls.push(`sleep:${milliseconds}`);
      clock += milliseconds;
    },
    now: () => new Date(clock),
    readBackendVersion: async () => {
      if (calls.at(-1) !== "provenance") calls.push("provenance");
      return "test-backend";
    },
    readModelDigest: async () => "test-digest",
    runWorkload: async (_config, workloadDependencies) => {
      calls.push("workload");
      clock += 1_000;
      await workloadDependencies.betweenOrderBlocks?.(0);
      return workloadReport(Boolean(workloadDependencies.betweenOrderBlocks));
    },
  };
  return { dependencies, calls, keepAliveRequests, globalRunners };
}

function processor(): TurnProcessor {
  return {
    providerId: "test-provider",
    modelId: "test-model",
    contextCapacity: 8_192,
    maxOutputTokens: 1_536,
    temperature: 0,
    seed: 42,
    runtimeStatus: profileStatus,
    async listModels() {
      return [];
    },
    async *stream() {
      throw new Error("unused");
    },
  };
}

function memory(
  availablePercent: number,
  swapUsedBytes: number,
  pageOuts: number,
  swapOuts: number,
) {
  return {
    observedAt: "2026-08-28T00:00:00.000Z",
    availablePercent,
    swapUsedBytes,
    pageSizeBytes: 4_096,
    pageOuts,
    swapOuts,
  };
}

function power() {
  return {
    observedAt: "2026-08-28T00:00:00.000Z",
    source: "ac" as const,
    batteryPercent: 80,
    batteryStatus: "AC attached",
    currentPowerMode: 2,
    batteryPowerMode: 1,
    acPowerMode: 2,
  };
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

function workloadReport(recycled = false): FullAgentContextBenchmarkReport {
  return {
    blockTransitions: recycled ? [{}] : [],
    summary: { experimentValid: true },
  } as unknown as FullAgentContextBenchmarkReport;
}
