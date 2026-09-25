#!/usr/bin/env bun

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import type { ModelDescriptor, TokenUsage } from "@demesne/protocol";
import {
  OpenAICompatibleProvider,
  type ProviderAdapter,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderToolCall,
} from "@demesne/providers";
import { defaultSystemPrompt } from "./engine.ts";
import {
  calculateHostMemoryDelta,
  readHostMemorySnapshot,
  readOllamaRunnerSnapshot,
  readHostPowerSnapshot,
  type HostMemorySnapshot,
  type HostPowerSnapshot,
  type OllamaRunnerSnapshot,
} from "./provider-benchmark.ts";
import { ToolRegistry } from "./tools.ts";

export const CHAT_TOOL_BENCHMARK_SCHEMA_VERSION = 2 as const;

const FIXTURE_ID = "provider-read-tool-cycle-v1";
const USER_PROMPT = "Inspect src/calculate-total.ts and identify its arithmetic bug. Do not modify any files. Use the read_file tool before answering. End your answer with exactly this line:\nBUG: total - price should be total + price";
const EXPECTED_MARKER = "BUG: total - price should be total + price";
const SYSTEM_PROMPT_WORKSPACE = "/benchmark/workspace";
const CANONICAL_TOOL_CALL: ProviderToolCall = {
  id: "benchmark-read-1",
  name: "read_file",
  arguments: JSON.stringify({ path: "src/calculate-total.ts" }),
};
const CANONICAL_TOOL_RESULT = JSON.stringify({
  path: "src/calculate-total.ts",
  totalLines: 3,
  range: { from: 1, to: 3 },
  content: "1: export function calculateTotal(prices: number[]): number {\n2:   return prices.reduce((total, price) => total - price, 0);\n3: }",
  truncated: false,
  remainingLines: 0,
});

export interface ChatToolBenchmarkConfig {
  model: string;
  warmupRuns: number;
  measuredRuns: number;
  maxOutputTokens: number;
  temperature: number;
  seed: number;
  promptPaddingBlocks: number;
}

export interface ChatToolRoundObservation {
  durationMs: number;
  timeToFirstOutputMs: number | null;
  usage: TokenUsage | null;
  outputCharacters: number;
  responseText: string;
  toolCalls: ProviderToolCall[];
}

export interface ChatToolObservation {
  sequence: number;
  phase: "warmup" | "measured";
  durationMs: number;
  success: boolean;
  toolCallValid: boolean;
  expectedMarkerFound: boolean;
  firstRound: ChatToolRoundObservation;
  secondRound: ChatToolRoundObservation;
}

export interface ChatToolBenchmarkDependencies {
  now?: () => number;
  memorySnapshot?: () => HostMemorySnapshot | null;
  powerSnapshot?: () => HostPowerSnapshot | null;
  runnerSnapshot?: () => OllamaRunnerSnapshot | null;
  runtime?: {
    endpoint?: string;
    backendVersion?: string;
    sourceRevision?: string;
  };
}

export interface ChatToolBenchmarkReport {
  schemaVersion: typeof CHAT_TOOL_BENCHMARK_SCHEMA_VERSION;
  startedAt: string;
  machine: {
    platform: string;
    architecture: string;
    osRelease: string;
    totalMemoryBytes: number;
  };
  provider: string;
  runtime: ChatToolBenchmarkDependencies["runtime"];
  modelBeforeRun: ModelDescriptor;
  model: ModelDescriptor;
  fixture: {
    id: typeof FIXTURE_ID;
    systemPrompt: string;
    userPrompt: string;
    expectedMarker: string;
    canonicalToolCall: ProviderToolCall;
    canonicalToolResult: string;
  };
  config: ChatToolBenchmarkConfig;
  memory: {
    before: HostMemorySnapshot | null;
    after: HostMemorySnapshot | null;
    delta: ReturnType<typeof calculateHostMemoryDelta>;
  };
  power: {
    before: HostPowerSnapshot | null;
    after: HostPowerSnapshot | null;
  };
  runner: {
    before: OllamaRunnerSnapshot | null;
    after: OllamaRunnerSnapshot | null;
  };
  observations: ChatToolObservation[];
  summary: {
    measuredRuns: number;
    successfulRuns: number;
    successRate: number;
    medianDurationMs: number;
    medianFirstRoundDurationMs: number;
    medianSecondRoundDurationMs: number;
  };
}

export async function runChatToolBenchmark(
  provider: ProviderAdapter,
  config: ChatToolBenchmarkConfig,
  signal: AbortSignal,
  dependencies: ChatToolBenchmarkDependencies = {},
): Promise<ChatToolBenchmarkReport> {
  validateConfig(config);
  const now = dependencies.now ?? performance.now.bind(performance);
  const memorySnapshot = dependencies.memorySnapshot ?? readHostMemorySnapshot;
  const powerSnapshot = dependencies.powerSnapshot ?? readHostPowerSnapshot;
  const runnerSnapshot = dependencies.runnerSnapshot ?? readOllamaRunnerSnapshot;
  const startedAt = new Date().toISOString();
  const memoryBefore = memorySnapshot();
  const powerBefore = powerSnapshot();
  const runnerBefore = runnerSnapshot();
  const modelBeforeRun = (await provider.listModels(signal)).find((candidate) => candidate.id === config.model);
  if (!modelBeforeRun) throw new Error(`Benchmark model is not available: ${config.model}`);

  const systemPrompt = createSystemPrompt(config.promptPaddingBlocks);
  const baseMessages: ProviderMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: USER_PROMPT },
  ];
  const secondRoundMessages: ProviderMessage[] = [
    ...baseMessages,
    { role: "assistant", content: null, toolCalls: [CANONICAL_TOOL_CALL] },
    { role: "tool", toolCallId: CANONICAL_TOOL_CALL.id, content: CANONICAL_TOOL_RESULT },
  ];
  const tools = new ToolRegistry().definitions();
  const observations: ChatToolObservation[] = [];
  const totalRuns = config.warmupRuns + config.measuredRuns;

  for (let sequence = 0; sequence < totalRuns; sequence += 1) {
    if (signal.aborted) throw signal.reason;
    const started = now();
    const firstRound = await runRound(provider, {
      model: config.model,
      messages: baseMessages,
      tools,
      thinkingEnabled: false,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      seed: config.seed,
    }, signal, now);
    const secondRound = await runRound(provider, {
      model: config.model,
      messages: secondRoundMessages,
      tools,
      thinkingEnabled: false,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      seed: config.seed,
    }, signal, now);
    const completed = now();
    const toolCallValid = firstRound.toolCalls.length === 1
      && firstRound.toolCalls[0]?.name === "read_file"
      && readToolPath(firstRound.toolCalls[0].arguments) === "src/calculate-total.ts";
    const expectedMarkerFound = secondRound.responseText.includes(EXPECTED_MARKER);
    observations.push({
      sequence,
      phase: sequence < config.warmupRuns ? "warmup" : "measured",
      durationMs: Math.max(0, completed - started),
      success: toolCallValid && expectedMarkerFound,
      toolCallValid,
      expectedMarkerFound,
      firstRound,
      secondRound,
    });
  }

  const measured = observations.filter((observation) => observation.phase === "measured");
  const successfulRuns = measured.filter((observation) => observation.success).length;
  const model = (await provider.listModels(signal)).find((candidate) => candidate.id === config.model) ?? modelBeforeRun;
  const memoryAfter = memorySnapshot();
  const powerAfter = powerSnapshot();
  const runnerAfter = runnerSnapshot();
  return {
    schemaVersion: CHAT_TOOL_BENCHMARK_SCHEMA_VERSION,
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
    fixture: {
      id: FIXTURE_ID,
      systemPrompt,
      userPrompt: USER_PROMPT,
      expectedMarker: EXPECTED_MARKER,
      canonicalToolCall: CANONICAL_TOOL_CALL,
      canonicalToolResult: CANONICAL_TOOL_RESULT,
    },
    config,
    memory: {
      before: memoryBefore,
      after: memoryAfter,
      delta: calculateHostMemoryDelta(memoryBefore, memoryAfter),
    },
    power: { before: powerBefore, after: powerAfter },
    runner: { before: runnerBefore, after: runnerAfter },
    observations,
    summary: {
      measuredRuns: measured.length,
      successfulRuns,
      successRate: successfulRuns / measured.length,
      medianDurationMs: median(measured.map((observation) => observation.durationMs)),
      medianFirstRoundDurationMs: median(measured.map((observation) => observation.firstRound.durationMs)),
      medianSecondRoundDurationMs: median(measured.map((observation) => observation.secondRound.durationMs)),
    },
  };
}

async function runRound(
  provider: ProviderAdapter,
  request: ProviderRequest,
  signal: AbortSignal,
  now: () => number,
): Promise<ChatToolRoundObservation> {
  const started = now();
  let firstOutputAt: number | null = null;
  let usage: TokenUsage | null = null;
  let responseText = "";
  let outputCharacters = 0;
  const assembled = new Map<number, ProviderToolCall>();
  for await (const event of provider.stream(request, signal)) {
    if (event.type === "finish") continue;
    if (event.type === "usage") {
      usage = event.usage;
      continue;
    }
    firstOutputAt ??= now();
    if (event.type === "text_delta" || event.type === "reasoning_delta") {
      outputCharacters += event.delta.length;
      if (event.type === "text_delta") responseText += event.delta;
      continue;
    }
    const call = assembled.get(event.index) ?? { id: "", name: "", arguments: "" };
    call.id += event.idDelta;
    call.name += event.nameDelta;
    call.arguments += event.argumentsDelta;
    assembled.set(event.index, call);
  }
  const completed = now();
  return {
    durationMs: Math.max(0, completed - started),
    timeToFirstOutputMs: firstOutputAt === null ? null : Math.max(0, firstOutputAt - started),
    usage,
    outputCharacters,
    responseText,
    toolCalls: [...assembled.entries()].sort(([left], [right]) => left - right).map(([, call]) => call),
  };
}

function readToolPath(argumentsJson: string): string | null {
  try {
    const value: unknown = JSON.parse(argumentsJson);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && typeof (value as Record<string, unknown>).path === "string"
      ? (value as Record<string, unknown>).path as string
      : null;
  } catch {
    return null;
  }
}

function validateConfig(config: ChatToolBenchmarkConfig): void {
  if (!config.model.trim()) throw new Error("Benchmark model cannot be empty");
  boundedInteger(config.warmupRuns, "warmupRuns", 0, 10);
  boundedInteger(config.measuredRuns, "measuredRuns", 1, 50);
  boundedInteger(config.maxOutputTokens, "maxOutputTokens", 1, 4_096);
  boundedInteger(config.promptPaddingBlocks, "promptPaddingBlocks", 0, 512);
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
    throw new Error("temperature must be between 0 and 2");
  }
  if (!Number.isSafeInteger(config.seed)) throw new Error("seed must be a safe integer");
}

function createSystemPrompt(promptPaddingBlocks: number): string {
  const base = defaultSystemPrompt(SYSTEM_PROMPT_WORKSPACE);
  if (promptPaddingBlocks === 0) return base;
  const padding = Array.from(
    { length: promptPaddingBlocks },
    (_, index) => `Control record ${index + 1}: preserve this deterministic benchmark prefix without changing the task.`,
  );
  return `${base}\n${padding.join("\n")}`;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

async function backendVersion(baseUrl: string, providerId: string): Promise<string | undefined> {
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

async function main(): Promise<void> {
  const model = process.env.DEMESNE_MODEL?.trim();
  if (!model) throw new Error("DEMESNE_MODEL is required for a chat/tool benchmark");
  const baseUrl = process.env.DEMESNE_PROVIDER_URL ?? "http://127.0.0.1:11434/v1";
  const providerId = process.env.DEMESNE_PROVIDER_ID ?? "ollama";
  const provider = new OpenAICompatibleProvider({
    baseUrl,
    apiKey: process.env.DEMESNE_API_KEY,
    providerId,
    includeUsage: true,
    reasoningEffort: "none",
  });
  const discoveredBackendVersion = await backendVersion(baseUrl, providerId);
  const report = await runChatToolBenchmark(provider, {
    model,
    warmupRuns: environmentInteger("DEMESNE_BENCHMARK_WARMUPS", 1),
    measuredRuns: environmentInteger("DEMESNE_BENCHMARK_RUNS", 3),
    maxOutputTokens: environmentInteger("DEMESNE_BENCHMARK_OUTPUT_TOKENS", 512),
    temperature: 0,
    seed: 42,
    promptPaddingBlocks: environmentInteger("DEMESNE_BENCHMARK_PROMPT_PADDING_BLOCKS", 0),
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
  const outputPath = join(benchmarkDirectory, `chat-tool-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  console.log(`Chat/tool benchmark: ${report.config.model}`);
  console.log(`Successful runs: ${report.summary.successfulRuns}/${report.summary.measuredRuns}`);
  console.log(`Median cycle: ${formatMilliseconds(report.summary.medianDurationMs)}`);
  console.log(`Median first round: ${formatMilliseconds(report.summary.medianFirstRoundDurationMs)}`);
  console.log(`Median second round: ${formatMilliseconds(report.summary.medianSecondRoundDurationMs)}`);
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

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
