#!/usr/bin/env bun

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import type { ModelDescriptor, TokenUsage } from "@demesne/protocol";
import {
  OpenAICompatibleProvider,
  type ProviderAdapter,
  type ProviderRequest,
} from "@demesne/providers";

export const PROVIDER_BENCHMARK_SCHEMA_VERSION = 3 as const;

export interface ProviderBenchmarkConfig {
  fixtureId: string;
  prompt: string;
  model: string;
  warmupRuns: number;
  measuredRuns: number;
  maxOutputTokens: number;
  temperature: number;
  seed: number;
  thinkingEnabled: boolean;
}

export interface ProviderBenchmarkObservation {
  sequence: number;
  phase: "warmup" | "measured";
  durationMs: number;
  timeToFirstOutputMs: number | null;
  postFirstOutputDurationMs: number | null;
  endToEndOutputTokensPerSecond: number | null;
  postFirstOutputTokensPerSecondEstimate: number | null;
  outputCharacters: number;
  usage: TokenUsage | null;
}

export interface HostMemorySnapshot {
  observedAt: string;
  availablePercent: number | null;
  swapUsedBytes: number | null;
  pageSizeBytes: number | null;
  pageOuts: number | null;
  swapOuts: number | null;
}

export interface HostMemoryDelta {
  availablePercentagePoints: number | null;
  swapUsedBytes: number | null;
  pageOutBytes: number | null;
  swapOutBytes: number | null;
}

export interface HostPowerSnapshot {
  observedAt: string;
  source: "battery" | "ac" | "unknown";
  batteryPercent: number | null;
  batteryStatus: string | null;
  currentPowerMode: number | null;
  batteryPowerMode: number | null;
  acPowerMode: number | null;
}

export interface OllamaRunnerSnapshot {
  observedAt: string;
  processes: Array<{ pid: number; commandLine: string }>;
}

export interface ProviderBenchmarkDependencies {
  now?: () => number;
  memorySnapshot?: () => HostMemorySnapshot | null;
  powerSnapshot?: () => HostPowerSnapshot | null;
  runtime?: {
    endpoint?: string;
    backendVersion?: string;
    sourceRevision?: string;
  };
}

export interface ProviderBenchmarkReport {
  schemaVersion: typeof PROVIDER_BENCHMARK_SCHEMA_VERSION;
  startedAt: string;
  machine: {
    platform: string;
    architecture: string;
    osRelease: string;
    totalMemoryBytes: number;
  };
  provider: string;
  runtime: ProviderBenchmarkDependencies["runtime"];
  modelBeforeRun: ModelDescriptor;
  model: ModelDescriptor;
  memory: {
    before: HostMemorySnapshot | null;
    after: HostMemorySnapshot | null;
    delta: HostMemoryDelta;
  };
  power: {
    before: HostPowerSnapshot | null;
    after: HostPowerSnapshot | null;
  };
  config: ProviderBenchmarkConfig;
  observations: ProviderBenchmarkObservation[];
  summary: {
    measuredRuns: number;
    medianDurationMs: number;
    medianTimeToFirstOutputMs: number | null;
    medianEndToEndOutputTokensPerSecond: number | null;
    medianPostFirstOutputTokensPerSecondEstimate: number | null;
  };
}

export async function runProviderBenchmark(
  provider: ProviderAdapter,
  config: ProviderBenchmarkConfig,
  signal: AbortSignal,
  dependencies: ProviderBenchmarkDependencies = {},
): Promise<ProviderBenchmarkReport> {
  validateConfig(config);
  const now = dependencies.now ?? performance.now.bind(performance);
  const memorySnapshot = dependencies.memorySnapshot ?? readHostMemorySnapshot;
  const powerSnapshot = dependencies.powerSnapshot ?? readHostPowerSnapshot;
  const startedAt = new Date().toISOString();
  const memoryBefore = memorySnapshot();
  const powerBefore = powerSnapshot();
  const modelBeforeRun = (await provider.listModels(signal)).find((candidate) => candidate.id === config.model);
  if (!modelBeforeRun) throw new Error(`Benchmark model is not available: ${config.model}`);

  const observations: ProviderBenchmarkObservation[] = [];
  const totalRuns = config.warmupRuns + config.measuredRuns;
  for (let sequence = 0; sequence < totalRuns; sequence += 1) {
    if (signal.aborted) throw signal.reason;
    const request: ProviderRequest = {
      model: config.model,
      messages: [{ role: "user", content: config.prompt }],
      thinkingEnabled: config.thinkingEnabled,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      seed: config.seed,
    };
    const started = now();
    let firstOutputAt: number | null = null;
    let outputCharacters = 0;
    let usage: TokenUsage | null = null;
    for await (const event of provider.stream(request, signal)) {
      if (event.type === "finish") continue;
      if (event.type === "usage") {
        usage = event.usage;
        continue;
      }
      firstOutputAt ??= now();
      if (event.type === "text_delta" || event.type === "reasoning_delta") {
        outputCharacters += event.delta.length;
      }
    }
    const completed = now();
    const durationMs = Math.max(0, completed - started);
    const timeToFirstOutputMs = firstOutputAt === null ? null : Math.max(0, firstOutputAt - started);
    const postFirstOutputDurationMs = firstOutputAt === null ? null : Math.max(0, completed - firstOutputAt);
    const outputTokens = usage?.outputTokens ?? null;
    observations.push({
      sequence,
      phase: sequence < config.warmupRuns ? "warmup" : "measured",
      durationMs,
      timeToFirstOutputMs,
      postFirstOutputDurationMs,
      endToEndOutputTokensPerSecond: rate(outputTokens, durationMs),
      postFirstOutputTokensPerSecondEstimate: postFirstOutputDurationMs === null
        ? null
        : rate(outputTokens === null ? null : Math.max(0, outputTokens - 1), postFirstOutputDurationMs),
      outputCharacters,
      usage,
    });
  }

  const measured = observations.filter((observation) => observation.phase === "measured");
  const model = (await provider.listModels(signal)).find((candidate) => candidate.id === config.model) ?? modelBeforeRun;
  const memoryAfter = memorySnapshot();
  const powerAfter = powerSnapshot();
  return {
    schemaVersion: PROVIDER_BENCHMARK_SCHEMA_VERSION,
    startedAt,
    machine: {
      platform: platform(),
      architecture: process.arch,
      osRelease: release(),
      totalMemoryBytes: totalmem(),
    },
    provider: provider.id,
    runtime: dependencies.runtime,
    modelBeforeRun,
    model,
    memory: {
      before: memoryBefore,
      after: memoryAfter,
      delta: calculateHostMemoryDelta(memoryBefore, memoryAfter),
    },
    power: { before: powerBefore, after: powerAfter },
    config,
    observations,
    summary: {
      measuredRuns: measured.length,
      medianDurationMs: median(measured.map((observation) => observation.durationMs))!,
      medianTimeToFirstOutputMs: median(measured.map((observation) => observation.timeToFirstOutputMs)),
      medianEndToEndOutputTokensPerSecond: median(
        measured.map((observation) => observation.endToEndOutputTokensPerSecond),
      ),
      medianPostFirstOutputTokensPerSecondEstimate: median(
        measured.map((observation) => observation.postFirstOutputTokensPerSecondEstimate),
      ),
    },
  };
}

function validateConfig(config: ProviderBenchmarkConfig): void {
  if (!config.fixtureId.trim()) throw new Error("Benchmark fixture ID cannot be empty");
  if (!config.prompt.trim()) throw new Error("Benchmark prompt cannot be empty");
  if (!config.model.trim()) throw new Error("Benchmark model cannot be empty");
  boundedInteger(config.warmupRuns, "warmupRuns", 0, 10);
  boundedInteger(config.measuredRuns, "measuredRuns", 1, 50);
  boundedInteger(config.maxOutputTokens, "maxOutputTokens", 1, 4_096);
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
    throw new Error("temperature must be between 0 and 2");
  }
  if (!Number.isSafeInteger(config.seed)) throw new Error("seed must be a safe integer");
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function rate(tokens: number | null, durationMs: number): number | null {
  if (tokens === null || durationMs <= 0) return null;
  return tokens / (durationMs / 1_000);
}

function median(values: Array<number | null>): number | null {
  const sorted = values.filter((value): value is number => value !== null).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function readHostMemorySnapshot(): HostMemorySnapshot | null {
  if (platform() !== "darwin") return null;
  const pressure = commandOutput(["memory_pressure", "-Q"]);
  const swap = commandOutput(["sysctl", "vm.swapusage"]);
  const virtualMemory = commandOutput(["vm_stat"]);
  if (pressure === null && swap === null && virtualMemory === null) return null;
  return {
    observedAt: new Date().toISOString(),
    availablePercent: numberMatch(pressure, /System-wide memory free percentage:\s*(\d+)%/),
    swapUsedBytes: byteSizeMatch(swap, /used\s*=\s*([\d.]+)([KMG])/i),
    pageSizeBytes: numberMatch(virtualMemory, /page size of\s+(\d+) bytes/i),
    pageOuts: numberMatch(virtualMemory, /Pageouts:\s+(\d+)\./),
    swapOuts: numberMatch(virtualMemory, /Swapouts:\s+(\d+)\./),
  };
}

export function readHostPowerSnapshot(): HostPowerSnapshot | null {
  if (platform() !== "darwin") return null;
  const battery = commandOutput(["pmset", "-g", "batt"]);
  const custom = commandOutput(["pmset", "-g", "custom"]);
  if (battery === null && custom === null) return null;
  const source = battery?.includes("'Battery Power'") ? "battery" : battery?.includes("'AC Power'") ? "ac" : "unknown";
  const batterySection = custom?.match(/Battery Power:\s*([\s\S]*?)(?=\nAC Power:|$)/)?.[1] ?? null;
  const acSection = custom?.match(/AC Power:\s*([\s\S]*)$/)?.[1] ?? null;
  const batteryPowerMode = numberMatch(batterySection, /powermode\s+(\d+)/);
  const acPowerMode = numberMatch(acSection, /powermode\s+(\d+)/);
  return {
    observedAt: new Date().toISOString(),
    source,
    batteryPercent: numberMatch(battery, /\b(\d+)%/),
    batteryStatus: battery?.match(/\d+%;\s*([^;\n]+)/)?.[1]?.trim() ?? null,
    currentPowerMode: source === "battery" ? batteryPowerMode : source === "ac" ? acPowerMode : null,
    batteryPowerMode,
    acPowerMode,
  };
}

export function readOllamaRunnerSnapshot(): OllamaRunnerSnapshot | null {
  const output = commandOutput(["pgrep", "-fl", "llama-server"]);
  if (output === null) return null;
  const processes = output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), commandLine: match[2]! }];
  });
  return { observedAt: new Date().toISOString(), processes };
}

function commandOutput(command: string[]): string | null {
  try {
    const result = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "ignore" });
    return result.success ? result.stdout.toString() : null;
  } catch {
    return null;
  }
}

function numberMatch(value: string | null, pattern: RegExp): number | null {
  const match = value?.match(pattern);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function byteSizeMatch(value: string | null, pattern: RegExp): number | null {
  const match = value?.match(pattern);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2]!.toUpperCase();
  const multiplier = unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : 1024;
  return Math.round(amount * multiplier);
}

export function calculateHostMemoryDelta(
  before: HostMemorySnapshot | null,
  after: HostMemorySnapshot | null,
): HostMemoryDelta {
  const pageSize = before?.pageSizeBytes ?? after?.pageSizeBytes ?? null;
  return {
    availablePercentagePoints: difference(before?.availablePercent, after?.availablePercent),
    swapUsedBytes: difference(before?.swapUsedBytes, after?.swapUsedBytes),
    pageOutBytes: counterByteDifference(before?.pageOuts, after?.pageOuts, pageSize),
    swapOutBytes: counterByteDifference(before?.swapOuts, after?.swapOuts, pageSize),
  };
}

function difference(before: number | null | undefined, after: number | null | undefined): number | null {
  return before === null || before === undefined || after === null || after === undefined ? null : after - before;
}

function counterByteDifference(
  before: number | null | undefined,
  after: number | null | undefined,
  pageSize: number | null,
): number | null {
  const pages = difference(before, after);
  return pages === null || pageSize === null ? null : pages * pageSize;
}

async function main(): Promise<void> {
  const model = process.env.DEMESNE_MODEL?.trim();
  if (!model) throw new Error("DEMESNE_MODEL is required for a provider benchmark");
  const baseUrl = process.env.DEMESNE_PROVIDER_URL ?? "http://127.0.0.1:1234/v1";
  const providerId = process.env.DEMESNE_PROVIDER_ID ?? "openai-compatible";
  const provider = new OpenAICompatibleProvider({
    baseUrl,
    apiKey: process.env.DEMESNE_API_KEY,
    providerId,
    includeUsage: true,
    reasoningEffort: "none",
  });
  const discoveredBackendVersion = await backendVersion(baseUrl, providerId);
  const report = await runProviderBenchmark(provider, {
    fixtureId: "provider-throughput-v1",
    prompt: "Explain in a detailed technical paragraph why repeatable measurements are necessary when optimizing local language-model inference. Continue until the response limit.",
    model,
    warmupRuns: environmentInteger("DEMESNE_BENCHMARK_WARMUPS", 1),
    measuredRuns: environmentInteger("DEMESNE_BENCHMARK_RUNS", 5),
    maxOutputTokens: environmentInteger("DEMESNE_BENCHMARK_OUTPUT_TOKENS", 128),
    temperature: 0,
    seed: 42,
    thinkingEnabled: false,
  }, new AbortController().signal, {
    runtime: {
      endpoint: baseUrl,
      ...(discoveredBackendVersion ? { backendVersion: discoveredBackendVersion } : {}),
      ...(process.env.DEMESNE_SOURCE_REVISION ? { sourceRevision: process.env.DEMESNE_SOURCE_REVISION } : {}),
    },
  });

  const dataDirectory = process.env.DEMESNE_DATA_DIR ?? join(homedir(), ".demesne");
  const benchmarkDirectory = join(dataDirectory, "benchmarks");
  mkdirSync(benchmarkDirectory, { recursive: true, mode: 0o700 });
  chmodSync(benchmarkDirectory, 0o700);
  const timestamp = report.startedAt.replaceAll(":", "-");
  const outputPath = join(benchmarkDirectory, `provider-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  console.log(`Provider benchmark: ${report.model.id}`);
  console.log(`Measured runs: ${report.summary.measuredRuns}`);
  console.log(`Median request: ${formatMilliseconds(report.summary.medianDurationMs)}`);
  console.log(`Median first output: ${formatNullableMilliseconds(report.summary.medianTimeToFirstOutputMs)}`);
  console.log(`Median end-to-end output: ${formatRate(report.summary.medianEndToEndOutputTokensPerSecond)}`);
  console.log(`Median post-first-output estimate: ${formatRate(report.summary.medianPostFirstOutputTokensPerSecondEstimate)}`);
  console.log(`Memory availability delta: ${formatPercentageDelta(report.memory.delta.availablePercentagePoints)}`);
  console.log(`Swap-use delta: ${formatBytes(report.memory.delta.swapUsedBytes)}`);
  console.log(`Raw report: ${outputPath}`);
}

async function backendVersion(baseUrl: string, providerId: string): Promise<string | undefined> {
  if (providerId === "llama.cpp") return llamaServerBuild(baseUrl);
  if (providerId !== "ollama") return undefined;
  try {
    const response = await fetch(new URL("/api/version", baseUrl), { redirect: "manual" });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const version = (value as Record<string, unknown>).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * llama.cpp exposes its exact build identifier on `/props`. Recording it keeps a
 * report attributable to one binary, which matters because Metal kernel behaviour
 * for quantized K/V caches has changed materially between builds.
 */
async function llamaServerBuild(baseUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/props", baseUrl), { redirect: "manual" });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const build = (value as Record<string, unknown>).build_info;
    return typeof build === "string" && build ? build : undefined;
  } catch {
    return undefined;
  }
}

function environmentInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function formatMilliseconds(value: number): string {
  return `${(value / 1_000).toFixed(2)}s`;
}

function formatNullableMilliseconds(value: number | null): string {
  return value === null ? "unknown" : formatMilliseconds(value);
}

function formatRate(value: number | null): string {
  return value === null ? "unknown" : `${value.toFixed(2)} tok/s`;
}

function formatPercentageDelta(value: number | null): string {
  return value === null ? "unknown" : `${value > 0 ? "+" : ""}${value} points`;
}

function formatBytes(value: number | null): string {
  if (value === null) return "unknown";
  return `${(value / 1024 ** 2).toFixed(2)} MiB`;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
