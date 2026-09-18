#!/usr/bin/env bun

/**
 * Long-context decode and prefill benchmark for a directly launched llama.cpp
 * `llama-server`.
 *
 * This harness exists because `bench:provider` measures a roughly forty-token
 * prompt. At that length the K/V cache holds a few hundred of its allocated
 * slots, so K/V precision is almost invisible: a q8_0 K/V configuration measured
 * only 5.3% slower than f16 there while measuring 47% slower at 14,734 tokens.
 * Any conclusion about K/V precision, batch size, or context capacity therefore
 * requires measurement at the context lengths the agent actually reaches.
 *
 * Rates are taken from llama.cpp's own `timings` block rather than estimated from
 * client-observed stream timing, so prefill and decode are separated by the
 * server that performed the work. Prompt caching is disabled so prefill is
 * genuinely recomputed for every observation.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import {
  calculateHostMemoryDelta,
  type HostMemoryDelta,
  type HostMemorySnapshot,
  type HostPowerSnapshot,
  readHostMemorySnapshot,
  readHostPowerSnapshot,
} from "./provider-benchmark.ts";
import {
  parseLlamaServerCommand,
  parseLlamaServerSpeculationType,
  readLlamaServerProcesses,
} from "./ollama-runtime.ts";

export const LLAMA_LONGCTX_BENCHMARK_SCHEMA_VERSION = 1 as const;

const RESPONSE_LIMIT = 4 * 1024 * 1024;

export interface LongContextFixture {
  id: string;
  nominalPromptTokens: number;
}

export interface LongContextObservation {
  fixtureId: string;
  phase: "warmup" | "measured";
  sequence: number;
  promptTokens: number;
  predictedTokens: number;
  prefillTokensPerSecond: number | null;
  decodeTokensPerSecond: number | null;
}

export interface LongContextFixtureSummary {
  fixtureId: string;
  nominalPromptTokens: number;
  measuredPromptTokens: number | null;
  measuredRuns: number;
  medianPrefillTokensPerSecond: number | null;
  medianDecodeTokensPerSecond: number | null;
}

export interface LongContextRunnerSnapshot {
  observedAt: string;
  processes: Array<{ pid: number; commandLine: string }>;
}

export interface LongContextGate {
  id: string;
  passed: boolean;
  detail: string;
}

export interface LongContextReport {
  schemaVersion: typeof LLAMA_LONGCTX_BENCHMARK_SCHEMA_VERSION;
  startedAt: string;
  completedAt: string;
  valid: boolean;
  machine: {
    platform: string;
    architecture: string;
    osRelease: string;
    totalMemoryBytes: number;
  };
  runtime: {
    endpoint: string;
    buildInfo: string | null;
    servedContextWindow: number | null;
    servedSlots: number | null;
    modelAlias: string | null;
    observedFlags: ReturnType<typeof parseLlamaServerCommand> | null;
    speculationType: string | null;
    sourceRevision?: string;
  };
  fixtures: LongContextFixture[];
  promptDigest: string;
  predictTokens: number;
  warmupRuns: number;
  memory: {
    before: HostMemorySnapshot | null;
    after: HostMemorySnapshot | null;
    delta: HostMemoryDelta;
  };
  power: {
    before: HostPowerSnapshot | null;
    after: HostPowerSnapshot | null;
  };
  runner: {
    before: LongContextRunnerSnapshot | null;
    after: LongContextRunnerSnapshot | null;
  };
  observations: LongContextObservation[];
  summary: LongContextFixtureSummary[];
  gates: LongContextGate[];
}

/**
 * Builds a deterministic filler prompt. The nominal token target is approximate
 * because tokenization is model specific; the report always records the server
 * measured `prompt_n` alongside the nominal value rather than assuming the target
 * was met.
 */
export function buildLongContextPrompt(nominalPromptTokens: number): string {
  const lines: string[] = [];
  const approximateTokensPerLine = 14.7;
  const lineCount = Math.max(1, Math.round(nominalPromptTokens / approximateTokensPerLine));
  for (let index = 0; index < lineCount; index += 1) {
    lines.push(`item${index} value${(index * 7919) % 104729} node${(index * 31) % 977}`);
  }
  return [
    "Below is a machine inventory listing. Do not summarize it.",
    ...lines,
    "",
    "Reply with a single detailed technical paragraph about measurement discipline.",
  ].join("\n");
}

export function longContextPromptDigest(fixtures: readonly LongContextFixture[]): string {
  const hash = createHash("sha256");
  for (const fixture of fixtures) {
    hash.update(`${fixture.id}:${fixture.nominalPromptTokens}\n`);
    hash.update(buildLongContextPrompt(fixture.nominalPromptTokens));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function summarizeLongContext(
  fixtures: readonly LongContextFixture[],
  observations: readonly LongContextObservation[],
): LongContextFixtureSummary[] {
  return fixtures.map((fixture) => {
    const measured = observations.filter(
      (observation) => observation.fixtureId === fixture.id && observation.phase === "measured",
    );
    const promptTokens = new Set(measured.map((observation) => observation.promptTokens));
    return {
      fixtureId: fixture.id,
      nominalPromptTokens: fixture.nominalPromptTokens,
      measuredPromptTokens: promptTokens.size === 1 ? [...promptTokens][0]! : null,
      measuredRuns: measured.length,
      medianPrefillTokensPerSecond: median(
        measured.flatMap((observation) => (observation.prefillTokensPerSecond === null ? [] : [observation.prefillTokensPerSecond])),
      ),
      medianDecodeTokensPerSecond: median(
        measured.flatMap((observation) => (observation.decodeTokensPerSecond === null ? [] : [observation.decodeTokensPerSecond])),
      ),
    };
  });
}

export function runnerSignature(snapshot: LongContextRunnerSnapshot | null): string | null {
  if (!snapshot) return null;
  return snapshot.processes
    .map((process) => `${process.pid}:${process.commandLine}`)
    .sort()
    .join("\n");
}

/**
 * Fail-closed gates. A report that fails any gate is written for the record but
 * marked invalid, so a configuration cannot be promoted on an unattributable or
 * memory-contaminated run.
 */
export function evaluateLongContextGates(input: {
  power: { before: HostPowerSnapshot | null; after: HostPowerSnapshot | null };
  runner: { before: LongContextRunnerSnapshot | null; after: LongContextRunnerSnapshot | null };
  memoryDelta: HostMemoryDelta;
  buildInfo: string | null;
  observedFlags: ReturnType<typeof parseLlamaServerCommand> | null;
  speculationType: string | null;
  summary: readonly LongContextFixtureSummary[];
}): LongContextGate[] {
  const gates: LongContextGate[] = [];

  const onAcPower = input.power.before?.source === "ac" && input.power.after?.source === "ac";
  gates.push({
    id: "ac-power",
    passed: onAcPower,
    detail: onAcPower
      ? "host remained on AC power"
      : `power source before ${input.power.before?.source ?? "unknown"}, after ${input.power.after?.source ?? "unknown"}`,
  });

  const beforeSignature = runnerSignature(input.runner.before);
  const afterSignature = runnerSignature(input.runner.after);
  const exclusive = input.runner.before?.processes.length === 1 && input.runner.after?.processes.length === 1;
  const unchanged = beforeSignature !== null && beforeSignature === afterSignature;
  gates.push({
    id: "exclusive-runner",
    passed: exclusive && unchanged,
    detail: exclusive
      ? unchanged
        ? "exactly one llama-server owned the run and did not change"
        : "llama-server changed during the run"
      : `observed ${input.runner.before?.processes.length ?? "unknown"} llama-server processes before and ${input.runner.after?.processes.length ?? "unknown"} after`,
  });

  const swapOutBytes = input.memoryDelta.swapOutBytes;
  const noSwapGrowth = swapOutBytes !== null && swapOutBytes <= 0;
  gates.push({
    id: "swap-out-growth",
    passed: noSwapGrowth,
    detail: swapOutBytes === null
      ? "swap-out growth could not be observed"
      : `swap-out growth ${(swapOutBytes / (1024 * 1024)).toFixed(2)} MiB`,
  });

  const provenance = input.buildInfo !== null && input.observedFlags !== null && input.speculationType !== null;
  gates.push({
    id: "runtime-provenance",
    passed: provenance,
    detail: provenance
      ? `build ${input.buildInfo}, K/V ${input.observedFlags?.keyCacheType}/${input.observedFlags?.valueCacheType}, batch ${input.observedFlags?.batchSize}/${input.observedFlags?.microBatchSize}, speculation ${input.speculationType}`
      : "llama-server build information or command line flags were unavailable",
  });

  const consistent = input.summary.every(
    (entry) => entry.measuredRuns > 0 && entry.measuredPromptTokens !== null && entry.medianDecodeTokensPerSecond !== null,
  );
  gates.push({
    id: "fixture-fidelity",
    passed: consistent,
    detail: consistent
      ? "every fixture produced a stable prompt length and a decode rate"
      : "a fixture produced no measurement or an unstable prompt length",
  });

  return gates;
}

export function readLlamaRunnerSnapshot(now: () => Date = () => new Date()): LongContextRunnerSnapshot | null {
  const processes = readLlamaServerProcesses();
  if (processes === null) return null;
  return { observedAt: now().toISOString(), processes };
}

interface LlamaCompletionTimings {
  prompt_n?: number;
  predicted_n?: number;
  prompt_per_second?: number;
  predicted_per_second?: number;
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > RESPONSE_LIMIT) throw new Error("llama-server response was too large");
  return JSON.parse(new TextDecoder().decode(buffer));
}

async function runCompletion(
  endpoint: string,
  prompt: string,
  predictTokens: number,
  signal: AbortSignal,
): Promise<LlamaCompletionTimings> {
  const response = await fetch(new URL("/completion", endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    redirect: "manual",
    signal,
    body: JSON.stringify({
      prompt,
      n_predict: predictTokens,
      temperature: 0,
      seed: 42,
      cache_prompt: false,
      stream: true,
    }),
  });
  if (!response.ok) throw new Error(`llama-server /completion returned HTTP ${response.status}`);
  if (!response.body) throw new Error("llama-server /completion returned no stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let timings: LlamaCompletionTimings | undefined;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > 4 * 1024 * 1024) throw new Error("llama-server /completion stream was too large");
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (!data) continue;
      const event: unknown = JSON.parse(data);
      if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
      const candidate = (event as Record<string, unknown>).timings;
      if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
        timings = candidate as LlamaCompletionTimings;
      }
    }
  }
  if (!timings) throw new Error("llama-server /completion stream omitted final timings");
  return timings;
}

async function readServerProperties(endpoint: string, signal: AbortSignal): Promise<{
  buildInfo: string | null;
  servedContextWindow: number | null;
  servedSlots: number | null;
  modelAlias: string | null;
}> {
  try {
    const response = await fetch(new URL("/props", endpoint), { redirect: "manual", signal });
    if (!response.ok) return { buildInfo: null, servedContextWindow: null, servedSlots: null, modelAlias: null };
    const body = await readLimitedJson(response);
    if (typeof body !== "object" || body === null) {
      return { buildInfo: null, servedContextWindow: null, servedSlots: null, modelAlias: null };
    }
    const record = body as Record<string, unknown>;
    const generation = record.default_generation_settings;
    const contextWindow = typeof generation === "object" && generation !== null
      ? (generation as Record<string, unknown>).n_ctx
      : null;
    return {
      buildInfo: typeof record.build_info === "string" ? record.build_info : null,
      servedContextWindow: typeof contextWindow === "number" ? contextWindow : null,
      servedSlots: typeof record.total_slots === "number" ? record.total_slots : null,
      modelAlias: typeof record.model_alias === "string" ? record.model_alias : null,
    };
  } catch {
    return { buildInfo: null, servedContextWindow: null, servedSlots: null, modelAlias: null };
  }
}

export async function runLongContextBenchmark(options: {
  endpoint: string;
  fixtures: readonly LongContextFixture[];
  predictTokens: number;
  warmupRuns: number;
  measuredRuns: number;
  signal: AbortSignal;
  sourceRevision?: string;
}): Promise<LongContextReport> {
  const startedAt = new Date().toISOString();
  const memoryBefore = readHostMemorySnapshot();
  const powerBefore = readHostPowerSnapshot();
  const runnerBefore = readLlamaRunnerSnapshot();
  const properties = await readServerProperties(options.endpoint, options.signal);
  const observations: LongContextObservation[] = [];

  for (const fixture of options.fixtures) {
    const prompt = buildLongContextPrompt(fixture.nominalPromptTokens);
    const totalRuns = options.warmupRuns + options.measuredRuns;
    for (let sequence = 0; sequence < totalRuns; sequence += 1) {
      const timings = await runCompletion(options.endpoint, prompt, options.predictTokens, options.signal);
      observations.push({
        fixtureId: fixture.id,
        phase: sequence < options.warmupRuns ? "warmup" : "measured",
        sequence,
        promptTokens: timings.prompt_n ?? 0,
        predictedTokens: timings.predicted_n ?? 0,
        prefillTokensPerSecond: timings.prompt_per_second ?? null,
        decodeTokensPerSecond: timings.predicted_per_second ?? null,
      });
    }
  }

  const memoryAfter = readHostMemorySnapshot();
  const powerAfter = readHostPowerSnapshot();
  const runnerAfter = readLlamaRunnerSnapshot();
  const memoryDelta = calculateHostMemoryDelta(memoryBefore, memoryAfter);
  const observedFlags = runnerBefore?.processes.length === 1
    ? parseLlamaServerCommand(runnerBefore.processes[0]!.commandLine)
    : null;
  const speculationType = runnerBefore?.processes.length === 1
    ? parseLlamaServerSpeculationType(runnerBefore.processes[0]!.commandLine)
    : null;
  const summary = summarizeLongContext(options.fixtures, observations);
  const gates = evaluateLongContextGates({
    power: { before: powerBefore, after: powerAfter },
    runner: { before: runnerBefore, after: runnerAfter },
    memoryDelta,
    buildInfo: properties.buildInfo,
    observedFlags,
    speculationType,
    summary,
  });

  return {
    schemaVersion: LLAMA_LONGCTX_BENCHMARK_SCHEMA_VERSION,
    startedAt,
    completedAt: new Date().toISOString(),
    valid: gates.every((gate) => gate.passed),
    machine: {
      platform: platform(),
      architecture: arch(),
      osRelease: release(),
      totalMemoryBytes: totalmem(),
    },
    runtime: {
      endpoint: options.endpoint,
      ...properties,
      observedFlags,
      speculationType,
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    },
    fixtures: [...options.fixtures],
    promptDigest: longContextPromptDigest(options.fixtures),
    predictTokens: options.predictTokens,
    warmupRuns: options.warmupRuns,
    memory: { before: memoryBefore, after: memoryAfter, delta: memoryDelta },
    power: { before: powerBefore, after: powerAfter },
    runner: { before: runnerBefore, after: runnerAfter },
    observations,
    summary,
    gates,
  };
}

export const DEFAULT_LONG_CONTEXT_FIXTURES: readonly LongContextFixture[] = [
  { id: "short-512", nominalPromptTokens: 512 },
  { id: "agent-4k", nominalPromptTokens: 4_096 },
  { id: "agent-8k", nominalPromptTokens: 8_192 },
  { id: "long-16k", nominalPromptTokens: 16_384 },
];

/**
 * `capacity-31k` approaches the usable input ceiling of the 32K profile, which is
 * the 32,768-token context less the 1,536-token output reserve. It is excluded
 * from the default sweep because a single cold observation costs over five
 * minutes of prefill; select it explicitly with `DEMESNE_LONGCTX_FIXTURES`.
 */
export const LONG_CONTEXT_FIXTURE_CATALOG: readonly LongContextFixture[] = [
  ...DEFAULT_LONG_CONTEXT_FIXTURES,
  { id: "capacity-31k", nominalPromptTokens: 30_720 },
  { id: "capacity-61k", nominalPromptTokens: 61_440 },
  { id: "capacity-93k", nominalPromptTokens: 93_000 },
  { id: "capacity-96k", nominalPromptTokens: 96_000 },
];

async function main(): Promise<void> {
  const endpoint = process.env.DEMESNE_PROVIDER_URL ?? "http://127.0.0.1:11436/v1";
  const providerId = process.env.DEMESNE_PROVIDER_ID ?? "llama.cpp";
  if (providerId !== "llama.cpp") {
    throw new Error("bench:llama:longctx requires DEMESNE_PROVIDER_ID=llama.cpp");
  }
  const selected = process.env.DEMESNE_LONGCTX_FIXTURES?.trim();
  const fixtures = selected
    ? LONG_CONTEXT_FIXTURE_CATALOG.filter((fixture) => selected.split(",").map((entry) => entry.trim()).includes(fixture.id))
    : DEFAULT_LONG_CONTEXT_FIXTURES;
  if (fixtures.length === 0) throw new Error("DEMESNE_LONGCTX_FIXTURES selected no known fixture");

  const report = await runLongContextBenchmark({
    endpoint,
    fixtures,
    predictTokens: environmentInteger("DEMESNE_LONGCTX_PREDICT_TOKENS", 200),
    warmupRuns: environmentNonnegativeInteger("DEMESNE_LONGCTX_WARMUPS", 1),
    measuredRuns: environmentInteger("DEMESNE_LONGCTX_RUNS", 3),
    signal: AbortSignal.timeout(environmentInteger("DEMESNE_LONGCTX_TIMEOUT_MS", 3_600_000)),
    ...(process.env.DEMESNE_SOURCE_REVISION ? { sourceRevision: process.env.DEMESNE_SOURCE_REVISION } : {}),
  });

  const dataDirectory = process.env.DEMESNE_DATA_DIR ?? join(homedir(), ".demesne");
  const benchmarkDirectory = join(dataDirectory, "benchmarks");
  mkdirSync(benchmarkDirectory, { recursive: true, mode: 0o700 });
  chmodSync(benchmarkDirectory, 0o700);
  const outputPath = join(benchmarkDirectory, `llama-longctx-${report.startedAt.replaceAll(":", "-")}.json`);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const flags = report.runtime.observedFlags;
  console.log(`llama.cpp long-context benchmark (schema ${report.schemaVersion})`);
  console.log(`Build: ${report.runtime.buildInfo ?? "unknown"}`);
  console.log(
    `Runtime: ctx ${report.runtime.servedContextWindow ?? "unknown"}, K/V ${flags?.keyCacheType ?? "?"}/${flags?.valueCacheType ?? "?"}, ` +
      `batch ${flags?.batchSize ?? "?"}/${flags?.microBatchSize ?? "?"}, FA ${flags?.flashAttention ?? "?"}, `
      + `speculation ${report.runtime.speculationType ?? "?"}`,
  );
  console.log("");
  for (const entry of report.summary) {
    console.log(
      `${entry.fixtureId.padEnd(10)} prompt_n=${String(entry.measuredPromptTokens ?? "?").padStart(6)}  ` +
        `prefill=${formatRate(entry.medianPrefillTokensPerSecond)}  decode=${formatRate(entry.medianDecodeTokensPerSecond)}`,
    );
  }
  console.log("");
  for (const gate of report.gates) {
    console.log(`${gate.passed ? "pass" : "FAIL"}  ${gate.id}: ${gate.detail}`);
  }
  console.log("");
  console.log(`Report valid: ${report.valid}`);
  console.log(`Raw report: ${outputPath}`);
  if (!report.valid) process.exitCode = 1;
}

function formatRate(value: number | null): string {
  return value === null ? "unknown" : `${value.toFixed(2)} tok/s`;
}

function environmentInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function environmentNonnegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return value;
}

if (import.meta.main) {
  await main();
}
