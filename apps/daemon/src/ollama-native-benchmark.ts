#!/usr/bin/env bun

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { isRecord } from "@demesne/protocol";
import {
  calculateHostMemoryDelta,
  readHostMemorySnapshot,
  readHostPowerSnapshot,
  type HostMemorySnapshot,
  type HostPowerSnapshot,
} from "./provider-benchmark.ts";

export const OLLAMA_NATIVE_BENCHMARK_SCHEMA_VERSION = 2 as const;

export interface OllamaNativeBenchmarkConfig {
  fixtureId: string;
  prompt: string;
  model: string;
  contextWindow: number;
  warmupRuns: number;
  measuredRuns: number;
  maxOutputTokens: number;
  temperature: number;
  seed: number;
  thinkingEnabled: boolean;
}

export interface OllamaNativeObservation {
  sequence: number;
  phase: "warmup" | "measured";
  clientDurationMs: number;
  totalDurationMs: number;
  loadDurationMs: number;
  promptTokens: number;
  promptEvaluationDurationMs: number;
  promptTokensPerSecond: number | null;
  outputTokens: number;
  outputEvaluationDurationMs: number;
  outputTokensPerSecond: number | null;
  outputCharacters: number;
  doneReason: string | null;
}

export interface OllamaNativeBenchmarkDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  memorySnapshot?: () => HostMemorySnapshot | null;
  powerSnapshot?: () => HostPowerSnapshot | null;
  sourceRevision?: string;
}

export interface OllamaNativeBenchmarkReport {
  schemaVersion: typeof OLLAMA_NATIVE_BENCHMARK_SCHEMA_VERSION;
  startedAt: string;
  machine: {
    platform: string;
    architecture: string;
    osRelease: string;
    totalMemoryBytes: number;
  };
  runtime: {
    endpoint: string;
    backendVersion: string | null;
    contextBeforeRun: number | null;
    contextAfterRun: number | null;
    sourceRevision: string | null;
  };
  config: OllamaNativeBenchmarkConfig;
  memory: {
    before: HostMemorySnapshot | null;
    after: HostMemorySnapshot | null;
    delta: ReturnType<typeof calculateHostMemoryDelta>;
  };
  power: {
    before: HostPowerSnapshot | null;
    after: HostPowerSnapshot | null;
  };
  observations: OllamaNativeObservation[];
  summary: {
    measuredRuns: number;
    medianClientDurationMs: number;
    medianPromptTokensPerSecond: number | null;
    medianOutputTokensPerSecond: number | null;
  };
}

export function createOllamaNativeBenchmarkFixture(promptBlocks: number): { fixtureId: string; prompt: string } {
  boundedInteger(promptBlocks, "promptBlocks", 0, 512);
  if (promptBlocks === 0) {
    return {
      fixtureId: "ollama-native-throughput-v1",
      prompt: "Explain in a detailed technical paragraph why repeatable measurements are necessary when optimizing local language-model inference. Continue until the response limit.",
    };
  }

  const records = Array.from(
    { length: promptBlocks },
    (_, index) => `Record ${index + 1}: repeatable local inference experiments control model weights, context capacity, batch size, power state, input text, output limit, and sampling parameters.`,
  );
  return {
    fixtureId: `ollama-native-prefill-v1-${promptBlocks}-blocks`,
    prompt: [
      "Read every measurement record below. After the final record, respond with exactly: MEASURED",
      ...records,
      "Respond with exactly: MEASURED",
    ].join("\n"),
  };
}

export async function runOllamaNativeBenchmark(
  baseUrl: string,
  config: OllamaNativeBenchmarkConfig,
  signal: AbortSignal,
  dependencies: OllamaNativeBenchmarkDependencies = {},
): Promise<OllamaNativeBenchmarkReport> {
  validateConfig(config);
  const fetchImplementation = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? performance.now.bind(performance);
  const memorySnapshot = dependencies.memorySnapshot ?? readHostMemorySnapshot;
  const powerSnapshot = dependencies.powerSnapshot ?? readHostPowerSnapshot;
  const startedAt = new Date().toISOString();
  const memoryBefore = memorySnapshot();
  const powerBefore = powerSnapshot();
  const backendVersion = await readVersion(baseUrl, fetchImplementation, signal);
  const contextBeforeRun = await readRuntimeContext(baseUrl, config.model, fetchImplementation, signal);
  const observations: OllamaNativeObservation[] = [];
  const totalRuns = config.warmupRuns + config.measuredRuns;

  for (let sequence = 0; sequence < totalRuns; sequence += 1) {
    if (signal.aborted) throw signal.reason;
    const started = now();
    const response = await fetchImplementation(new URL("/api/generate", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        prompt: config.prompt,
        stream: false,
        think: config.thinkingEnabled,
        keep_alive: "5m",
        options: {
          num_ctx: config.contextWindow,
          num_predict: config.maxOutputTokens,
          temperature: config.temperature,
          seed: config.seed,
        },
      }),
      redirect: "manual",
      signal,
    });
    const completed = now();
    if (!response.ok) throw new Error(`Ollama native benchmark returned HTTP ${response.status}`);
    const value: unknown = await response.json();
    observations.push(parseObservation(value, sequence, config.warmupRuns, Math.max(0, completed - started)));
  }

  const contextAfterRun = await readRuntimeContext(baseUrl, config.model, fetchImplementation, signal);
  const memoryAfter = memorySnapshot();
  const powerAfter = powerSnapshot();
  const measured = observations.filter((observation) => observation.phase === "measured");
  return {
    schemaVersion: OLLAMA_NATIVE_BENCHMARK_SCHEMA_VERSION,
    startedAt,
    machine: {
      platform: platform(),
      architecture: process.arch,
      osRelease: release(),
      totalMemoryBytes: totalmem(),
    },
    runtime: {
      endpoint: new URL("/api/generate", baseUrl).href,
      backendVersion,
      contextBeforeRun,
      contextAfterRun,
      sourceRevision: dependencies.sourceRevision ?? null,
    },
    config,
    memory: {
      before: memoryBefore,
      after: memoryAfter,
      delta: calculateHostMemoryDelta(memoryBefore, memoryAfter),
    },
    power: { before: powerBefore, after: powerAfter },
    observations,
    summary: {
      measuredRuns: measured.length,
      medianClientDurationMs: median(measured.map((observation) => observation.clientDurationMs))!,
      medianPromptTokensPerSecond: median(measured.map((observation) => observation.promptTokensPerSecond)),
      medianOutputTokensPerSecond: median(measured.map((observation) => observation.outputTokensPerSecond)),
    },
  };
}

function parseObservation(
  value: unknown,
  sequence: number,
  warmupRuns: number,
  clientDurationMs: number,
): OllamaNativeObservation {
  if (!isRecord(value)) throw new Error("Ollama native benchmark returned invalid JSON");
  const totalDuration = nonnegativeNumber(value.total_duration, "total_duration");
  const loadDuration = nonnegativeNumber(value.load_duration, "load_duration");
  const promptTokens = nonnegativeInteger(value.prompt_eval_count, "prompt_eval_count");
  const promptDuration = nonnegativeNumber(value.prompt_eval_duration, "prompt_eval_duration");
  const outputTokens = nonnegativeInteger(value.eval_count, "eval_count");
  const outputDuration = nonnegativeNumber(value.eval_duration, "eval_duration");
  return {
    sequence,
    phase: sequence < warmupRuns ? "warmup" : "measured",
    clientDurationMs,
    totalDurationMs: totalDuration / 1_000_000,
    loadDurationMs: loadDuration / 1_000_000,
    promptTokens,
    promptEvaluationDurationMs: promptDuration / 1_000_000,
    promptTokensPerSecond: rate(promptTokens, promptDuration),
    outputTokens,
    outputEvaluationDurationMs: outputDuration / 1_000_000,
    outputTokensPerSecond: rate(outputTokens, outputDuration),
    outputCharacters: typeof value.response === "string" ? value.response.length : 0,
    doneReason: typeof value.done_reason === "string" ? value.done_reason : null,
  };
}

function rate(tokens: number, durationNanoseconds: number): number | null {
  return durationNanoseconds <= 0 ? null : tokens / (durationNanoseconds / 1_000_000_000);
}

async function readVersion(baseUrl: string, fetchImplementation: typeof fetch, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetchImplementation(new URL("/api/version", baseUrl), { redirect: "manual", signal });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    return isRecord(value) && typeof value.version === "string" ? value.version : null;
  } catch {
    return null;
  }
}

async function readRuntimeContext(
  baseUrl: string,
  model: string,
  fetchImplementation: typeof fetch,
  signal: AbortSignal,
): Promise<number | null> {
  try {
    const response = await fetchImplementation(new URL("/api/ps", baseUrl), { redirect: "manual", signal });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.models)) return null;
    for (const candidate of value.models) {
      if (!isRecord(candidate)) continue;
      const name = typeof candidate.name === "string" ? candidate.name : candidate.model;
      if (name === model && Number.isSafeInteger(candidate.context_length)) return candidate.context_length as number;
    }
    return null;
  } catch {
    return null;
  }
}

function validateConfig(config: OllamaNativeBenchmarkConfig): void {
  if (!config.fixtureId.trim()) throw new Error("Benchmark fixture ID cannot be empty");
  if (!config.prompt.trim()) throw new Error("Benchmark prompt cannot be empty");
  if (!config.model.trim()) throw new Error("Benchmark model cannot be empty");
  boundedInteger(config.contextWindow, "contextWindow", 1, 1_048_576);
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

function nonnegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Ollama native benchmark response has invalid ${name}`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Ollama native benchmark response has invalid ${name}`);
  }
  return value as number;
}

function median(values: Array<number | null>): number | null {
  const sorted = values.filter((value): value is number => value !== null).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

async function main(): Promise<void> {
  const model = process.env.DEMESNE_MODEL?.trim();
  if (!model) throw new Error("DEMESNE_MODEL is required for an Ollama native benchmark");
  const configuredUrl = process.env.DEMESNE_PROVIDER_URL ?? "http://127.0.0.1:11434/v1";
  const fixture = createOllamaNativeBenchmarkFixture(environmentInteger("DEMESNE_BENCHMARK_PROMPT_BLOCKS", 0));
  const report = await runOllamaNativeBenchmark(configuredUrl, {
    ...fixture,
    model,
    contextWindow: environmentInteger("DEMESNE_BENCHMARK_CONTEXT", 32_768),
    warmupRuns: environmentInteger("DEMESNE_BENCHMARK_WARMUPS", 1),
    measuredRuns: environmentInteger("DEMESNE_BENCHMARK_RUNS", 5),
    maxOutputTokens: environmentInteger("DEMESNE_BENCHMARK_OUTPUT_TOKENS", 128),
    temperature: 0,
    seed: 42,
    thinkingEnabled: false,
  }, new AbortController().signal, { sourceRevision: process.env.DEMESNE_SOURCE_REVISION });

  const dataDirectory = process.env.DEMESNE_DATA_DIR ?? join(homedir(), ".demesne");
  const benchmarkDirectory = join(dataDirectory, "benchmarks");
  mkdirSync(benchmarkDirectory, { recursive: true, mode: 0o700 });
  chmodSync(benchmarkDirectory, 0o700);
  const timestamp = report.startedAt.replaceAll(":", "-");
  const outputPath = join(benchmarkDirectory, `ollama-native-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  console.log(`Ollama native benchmark: ${report.config.model}`);
  console.log(`Runtime context: ${report.runtime.contextAfterRun ?? "unknown"}`);
  console.log(`Measured runs: ${report.summary.measuredRuns}`);
  console.log(`Median client request: ${formatMilliseconds(report.summary.medianClientDurationMs)}`);
  console.log(`Median native prefill: ${formatRate(report.summary.medianPromptTokensPerSecond)}`);
  console.log(`Median native decode: ${formatRate(report.summary.medianOutputTokensPerSecond)}`);
  console.log(`Raw report: ${outputPath}`);
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

function formatRate(value: number | null): string {
  return value === null ? "unknown" : `${value.toFixed(2)} tok/s`;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
