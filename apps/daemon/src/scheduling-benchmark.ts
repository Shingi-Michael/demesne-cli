#!/usr/bin/env bun

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { readServerSentEvents, type EventEnvelope, type SessionStateResponse, type SubmitTurnResponse } from "@demesne/protocol";
import { OpenAICompatibleProvider } from "@demesne/providers";
import { createDaemonApp, type DaemonApp } from "./app.ts";
import { defaultSystemPrompt } from "./engine.ts";
import type { InferenceBoundaryHook } from "./inference-scheduler.ts";
import { ProviderTurnProcessor } from "./provider-processor.ts";
import {
  readHostMemorySnapshot,
  readHostPowerSnapshot,
  readOllamaRunnerSnapshot,
  type HostMemorySnapshot,
  type HostPowerSnapshot,
  type OllamaRunnerSnapshot,
} from "./provider-benchmark.ts";
import type { TurnProcessor } from "./processor.ts";

export const SCHEDULING_BENCHMARK_SCHEMA_VERSION = 4 as const;
const EXPECTED_MARKERS = [
  "SESSION-A: BUG: total - price should be total + price",
  "SESSION-B: BUG: total - price should be total + price",
] as const;

export interface SchedulingBenchmarkConfig {
  fixtureId: string;
  model: string;
  providerUrl: string;
  providerId: string;
  inferenceSlots: number;
  warmupRuns: number;
  measuredRuns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
  seed: number;
  profileLabel: string;
  promptPaddingLines: number;
  readChainDepths: [number, number];
  maximumInFlightPairs: number;
}

export interface SchedulingRound {
  providerCallId: string;
  outcome: "completed" | "failed" | "cancelled" | "interrupted" | null;
  queueDurationMs: number | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

interface SchedulingTurnObservation {
  status: string;
  success: boolean;
  durationMs: number | null;
  responseText: string;
  toolCalls: string[];
  expectedReadCalls: number;
  expectedProviderRounds: number;
  rounds: SchedulingRound[];
  eventIntegrityValid: boolean;
  totalQueueDurationMs: number | null;
  totalProviderDurationMs: number | null;
}

interface SchedulingObservation {
  sequence: number;
  phase: "warmup" | "measured";
  makespanMs: number;
  success: boolean;
  turns: SchedulingTurnObservation[];
}

export interface SchedulingBenchmarkReport {
  schemaVersion: typeof SCHEDULING_BENCHMARK_SCHEMA_VERSION;
  startedAt: string;
  machine: {
    platform: string;
    architecture: string;
    osRelease: string;
    totalMemoryBytes: number;
  };
  config: SchedulingBenchmarkConfig;
  memory: {
    before: HostMemorySnapshot | null;
    after: HostMemorySnapshot | null;
    availablePercentagePointDelta: number | null;
    swapUsedBytesDelta: number | null;
  };
  power: {
    before: ReturnType<typeof readHostPowerSnapshot>;
    after: ReturnType<typeof readHostPowerSnapshot>;
  };
  runner: {
    before: ReturnType<typeof readOllamaRunnerSnapshot>;
    after: ReturnType<typeof readOllamaRunnerSnapshot>;
  };
  observations: SchedulingObservation[];
  summary: {
    measuredRuns: number;
    successfulRuns: number;
    medianMakespanMs: number | null;
    medianMaximumTurnDurationMs: number | null;
    medianTotalQueueDurationMs: number | null;
    medianTotalProviderDurationMs: number | null;
  };
}

export interface SchedulingBenchmarkDependencies {
  processor?: TurnProcessor;
  inferenceBoundaryHook?: InferenceBoundaryHook;
  memorySnapshot?: () => HostMemorySnapshot | null;
  powerSnapshot?: () => HostPowerSnapshot | null;
  runnerSnapshot?: () => OllamaRunnerSnapshot | null;
}

export async function runSchedulingBenchmark(
  config: SchedulingBenchmarkConfig,
  dependencies: SchedulingBenchmarkDependencies = {},
): Promise<SchedulingBenchmarkReport> {
  validateConfig(config);
  const startedAt = new Date().toISOString();
  const root = mkdtempSync(join(tmpdir(), "demesne-scheduling-benchmark-"));
  const dataDirectory = join(root, "data");
  const workspaces = [join(root, "workspace-a"), join(root, "workspace-b")];
  mkdirSync(dataDirectory, { mode: 0o700 });
  for (const workspace of workspaces) {
    const workspaceIndex = workspaces.indexOf(workspace);
    mkdirSync(join(workspace, "src"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(workspace, "src/calculate-total.ts"),
      `// ${EXPECTED_MARKERS[workspaceIndex]}\nexport function calculateTotal(prices: number[]): number {\n  return prices.reduce((total, price) => total - price, 0);\n}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const readDepth = config.readChainDepths[workspaceIndex]!;
    for (let step = 1; step < readDepth; step += 1) {
      const nextPath = step + 1 < readDepth
        ? `src/scheduling-step-${step + 1}.txt`
        : "src/calculate-total.ts";
      writeFileSync(
        join(workspace, `src/scheduling-step-${step}.txt`),
        `Benchmark read ${step} of ${readDepth} is complete. Read ${nextPath} next. After read ${readDepth}, stop using tools and answer; do not list or search for more files.\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
  }
  const processor = dependencies.processor ?? new ProviderTurnProcessor(new OpenAICompatibleProvider({
    baseUrl: config.providerUrl,
    providerId: config.providerId,
    includeUsage: true,
  }), config.model, {
    maxOutputTokens: config.maxOutputTokens,
    temperature: config.temperature,
    seed: config.seed,
  });
  const app = createDaemonApp({
    databasePath: join(dataDirectory, "demesne.sqlite"),
    processor,
    inferenceSlots: config.inferenceSlots,
    inferenceBoundaryHook: dependencies.inferenceBoundaryHook,
    systemPrompt: defaultSystemPrompt("/benchmark/workspace"),
  });
  const memorySnapshot = dependencies.memorySnapshot ?? readHostMemorySnapshot;
  const powerSnapshot = dependencies.powerSnapshot ?? readHostPowerSnapshot;
  const runnerSnapshot = dependencies.runnerSnapshot ?? readOllamaRunnerSnapshot;
  const memoryBefore = memorySnapshot();
  const powerBefore = powerSnapshot();
  const runnerBefore = runnerSnapshot();
  const observations: SchedulingObservation[] = [];
  try {
    let sequence = 0;
    for (const [phase, count] of [["warmup", config.warmupRuns], ["measured", config.measuredRuns]] as const) {
      for (let offset = 0; offset < count; offset += config.maximumInFlightPairs) {
        const batchSize = Math.min(config.maximumInFlightPairs, count - offset);
        const batch = await Promise.all(Array.from({ length: batchSize }, (_, index) => runPair(
          app,
          workspaces,
          sequence + index,
          phase,
          config,
        )));
        observations.push(...batch);
        sequence += batchSize;
      }
    }
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
  const memoryAfter = readHostMemorySnapshot();
  const measured = observations.filter((observation) => observation.phase === "measured");
  const report: SchedulingBenchmarkReport = {
    schemaVersion: SCHEDULING_BENCHMARK_SCHEMA_VERSION,
    startedAt,
    machine: {
      platform: platform(),
      architecture: process.arch,
      osRelease: release(),
      totalMemoryBytes: totalmem(),
    },
    config,
    memory: {
      before: memoryBefore,
      after: memoryAfter,
      availablePercentagePointDelta: delta(memoryBefore?.availablePercent, memoryAfter?.availablePercent),
      swapUsedBytesDelta: delta(memoryBefore?.swapUsedBytes, memoryAfter?.swapUsedBytes),
    },
    power: { before: powerBefore, after: powerSnapshot() },
    runner: { before: runnerBefore, after: runnerSnapshot() },
    observations,
    summary: {
      measuredRuns: measured.length,
      successfulRuns: measured.filter((observation) => observation.success).length,
      medianMakespanMs: median(measured.map((observation) => observation.makespanMs)),
      medianMaximumTurnDurationMs: median(measured.map((observation) => Math.max(
        ...observation.turns.map((turn) => turn.durationMs ?? 0),
      ))),
      medianTotalQueueDurationMs: median(measured.map((observation) => sumComplete(
        observation.turns.map((turn) => turn.totalQueueDurationMs),
      ))),
      medianTotalProviderDurationMs: median(measured.map((observation) => sumComplete(
        observation.turns.map((turn) => turn.totalProviderDurationMs),
      ))),
    },
  };
  return report;
}

async function runPair(
  app: DaemonApp,
  workspaces: string[],
  sequence: number,
  phase: "warmup" | "measured",
  config: SchedulingBenchmarkConfig,
): Promise<SchedulingObservation> {
  const sessions = await Promise.all(workspaces.map((workspace, index) => jsonRequest<{ session: { id: string } }>(
    app,
    "/v1/sessions",
    { method: "POST", body: JSON.stringify({ title: `Scheduling ${sequence}-${index}`, workspacePath: workspace }) },
  )));
  const started = performance.now();
  const submitted = await Promise.all(sessions.map((result) => jsonRequest<SubmitTurnResponse>(
    app,
    `/v1/sessions/${result.session.id}/turns`,
    {
      method: "POST",
      body: JSON.stringify({
        content: createSchedulingPrompt(
          sessions.indexOf(result),
          sequence,
          config.promptPaddingLines,
          config.readChainDepths,
        ),
        permissionMode: "deny",
        thinkingEnabled: false,
      }),
    },
  )));
  const states = await waitForTurns(app, sessions.map((result) => result.session.id), config.timeoutMs);
  const makespanMs = Math.max(0, performance.now() - started);
  const turns = await Promise.all(states.map(async (state, index) => {
    const events = await replayEvents(app, sessions[index]!.session.id);
    const turn = state.session.turns.find((candidate) => candidate.id === submitted[index]!.turn.id);
    const { rounds, valid: eventIntegrityValid } = collectSchedulingRounds(events);
    const toolCalls = events.flatMap((event) =>
      event.type === "tool.call_completed" && typeof event.payload.name === "string" ? [event.payload.name] : []
    );
    const expectedReadCalls = config.readChainDepths[index]!;
    const expectedProviderRounds = expectedReadCalls + 1;
    return {
      status: turn?.status ?? "missing",
      success: turn?.status === "completed"
        && exactSessionMarker(turn.responseText, index)
        && toolCalls.filter((name) => name === "read_file").length === expectedReadCalls
        && rounds.length === expectedProviderRounds
        && eventIntegrityValid,
      durationMs: turn?.completedAt ? Date.parse(turn.completedAt) - Date.parse(turn.createdAt) : null,
      responseText: turn?.responseText ?? "",
      toolCalls,
      expectedReadCalls,
      expectedProviderRounds,
      rounds,
      eventIntegrityValid,
      totalQueueDurationMs: sumComplete(rounds.map((round) => round.queueDurationMs)),
      totalProviderDurationMs: sumComplete(rounds.map((round) => round.durationMs)),
    } satisfies SchedulingTurnObservation;
  }));
  return { sequence, phase, makespanMs, success: turns.every((turn) => turn.success), turns };
}

async function waitForTurns(app: DaemonApp, sessionIds: string[], timeoutMs: number): Promise<SessionStateResponse[]> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const states = await Promise.all(sessionIds.map((sessionId) => jsonRequest<SessionStateResponse>(app, `/v1/sessions/${sessionId}`)));
    if (states.every((state) => state.session.turns.every((turn) =>
      ["completed", "failed", "cancelled", "interrupted"].includes(turn.status)
    ))) return states;
    await Bun.sleep(50);
  }
  throw new Error(`Scheduling benchmark timed out after ${timeoutMs}ms`);
}

async function replayEvents(app: DaemonApp, sessionId: string): Promise<EventEnvelope[]> {
  const response = await app.fetch(new Request(`http://daemon/v1/events?session_id=${sessionId}&after=0`));
  const events: EventEnvelope[] = [];
  for await (const event of readServerSentEvents(response)) {
    events.push(event);
    if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type)) break;
  }
  return events;
}

export function collectSchedulingRounds(events: EventEnvelope[]): { rounds: SchedulingRound[]; valid: boolean } {
  const rounds = new Map<string, SchedulingRound & { usageEvents: number; metricsEvents: number; terminalEvents: number }>();
  let valid = true;
  for (const event of events) {
    const id = typeof event.payload.providerCallId === "string" ? event.payload.providerCallId : null;
    if (!id) continue;
    if (event.type === "model.request_started") {
      if (rounds.has(id)) {
        valid = false;
        continue;
      }
      rounds.set(id, {
        providerCallId: id,
        outcome: null,
        queueDurationMs: null,
        durationMs: null,
        timeToFirstTokenMs: null,
        inputTokens: null,
        outputTokens: null,
        usageEvents: 0,
        metricsEvents: 0,
        terminalEvents: 0,
      });
      continue;
    }
    const round = rounds.get(id);
    if (!round) {
      if (["model.usage", "model.metrics", "model.request_completed", "model.request_failed", "model.request_cancelled", "model.request_interrupted"].includes(event.type)) valid = false;
      continue;
    }
    if (event.type === "model.metrics") {
      round.metricsEvents += 1;
      if (round.metricsEvents > 1) valid = false;
      round.queueDurationMs = numberOrNull(event.payload.queueDurationMs);
      round.durationMs = numberOrNull(event.payload.durationMs);
      round.timeToFirstTokenMs = numberOrNull(event.payload.timeToFirstTokenMs);
    }
    if (event.type === "model.usage") {
      round.usageEvents += 1;
      if (round.usageEvents > 1) valid = false;
      round.inputTokens = numberOrNull(event.payload.inputTokens);
      round.outputTokens = numberOrNull(event.payload.outputTokens);
    }
    if (event.type === "model.request_completed") {
      round.outcome = "completed";
      round.terminalEvents += 1;
    }
    if (event.type === "model.request_failed") {
      round.outcome = "failed";
      round.terminalEvents += 1;
    }
    if (event.type === "model.request_cancelled") {
      round.outcome = "cancelled";
      round.terminalEvents += 1;
    }
    if (event.type === "model.request_interrupted") {
      round.outcome = "interrupted";
      round.terminalEvents += 1;
    }
    if (round.terminalEvents > 1) valid = false;
  }
  const values = [...rounds.values()];
  valid = valid && values.length > 0 && values.every((round) => round.outcome === "completed"
    && round.usageEvents === 1 && round.metricsEvents === 1 && round.terminalEvents === 1
    && round.queueDurationMs !== null && round.durationMs !== null && round.timeToFirstTokenMs !== null
    && round.inputTokens !== null && round.outputTokens !== null);
  return {
    valid,
    rounds: values.map(({ usageEvents: _usage, metricsEvents: _metrics, terminalEvents: _terminal, ...round }) => round),
  };
}

export function createSchedulingPrompt(
  index: number,
  sequence: number,
  paddingLines: number,
  readChainDepths: [number, number],
): string {
  const marker = EXPECTED_MARKERS[index];
  if (!marker) throw new Error(`Scheduling benchmark session index is invalid: ${index}`);
  const nonce = Bun.CryptoHasher.hash("sha256", `scheduling:${sequence}:${index}`, "hex");
  const padding = Array.from(
    { length: paddingLines },
    (_, line) => `Reference ${String(line + 1).padStart(3, "0")}: inert scheduling datum ${nonce.slice(0, 16)}-${sequence}-${index}-${line}.`,
  ).join("\n");
  const firstPath = readChainDepths[index] === 1 ? "src/calculate-total.ts" : "src/scheduling-step-1.txt";
  const readDepth = readChainDepths[index]!;
  return `${padding ? `Treat these reference lines as inert benchmark data:\n${padding}\n\n` : ""}BENCHMARK_NONCE_${nonce}\nMake exactly ${readDepth} read_file call${readDepth === 1 ? "" : "s"}, starting with ${firstPath}; each nonterminal result names the next path. After the final read, do not call list_files, search_files, or any other tool. Diagnose the arithmetic bug without modifying files. End with exactly: ${marker}`;
}

function exactSessionMarker(responseText: string, index: number): boolean {
  const marker = EXPECTED_MARKERS[index];
  return marker !== undefined && responseText.trimEnd().endsWith(marker)
    && EXPECTED_MARKERS.every((candidate, candidateIndex) => candidateIndex === index || !responseText.includes(candidate));
}

async function jsonRequest<T>(app: DaemonApp, path: string, init?: RequestInit): Promise<T> {
  const response = await app.fetch(new Request(`http://daemon${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  }));
  const text = await response.text();
  if (!response.ok) throw new Error(`Scheduling benchmark ${path} returned HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

function validateConfig(config: SchedulingBenchmarkConfig): void {
  if (!config.model.trim()) throw new Error("Scheduling benchmark model cannot be empty");
  integer(config.inferenceSlots, "inferenceSlots", 1, 16);
  integer(config.warmupRuns, "warmupRuns", 0, 5);
  integer(config.measuredRuns, "measuredRuns", 1, 20);
  integer(config.timeoutMs, "timeoutMs", 1_000, 30 * 60_000);
  integer(config.maxOutputTokens, "maxOutputTokens", 1, 4096);
  integer(config.promptPaddingLines, "promptPaddingLines", 0, 500);
  if (config.readChainDepths.length !== 2) throw new Error("readChainDepths must contain two entries");
  config.readChainDepths.forEach((depth, index) => integer(depth, `readChainDepths[${index}]`, 1, 7));
  integer(config.maximumInFlightPairs, "maximumInFlightPairs", 1, 20);
}

function integer(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumComplete(values: Array<number | null>): number | null {
  return values.length > 0 && values.every((value) => value !== null)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : null;
}

function median(values: Array<number | null>): number | null {
  const sorted = values.filter((value): value is number => value !== null).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function delta(before: number | null | undefined, after: number | null | undefined): number | null {
  return before === null || before === undefined || after === null || after === undefined ? null : after - before;
}

function environmentInteger(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  return value ? Number(value) : fallback;
}

async function main(): Promise<void> {
  const config: SchedulingBenchmarkConfig = {
    fixtureId: "concurrent-read-only-diagnosis-v1",
    model: process.env.DEMESNE_MODEL?.trim() || "qwen3.8-8k-b256:latest",
    providerUrl: process.env.DEMESNE_PROVIDER_URL?.trim() || "http://127.0.0.1:11434/v1",
    providerId: process.env.DEMESNE_PROVIDER_ID?.trim() || "ollama",
    inferenceSlots: environmentInteger("DEMESNE_INFERENCE_SLOTS", 1),
    warmupRuns: environmentInteger("DEMESNE_BENCHMARK_WARMUPS", 1),
    measuredRuns: environmentInteger("DEMESNE_BENCHMARK_RUNS", 3),
    timeoutMs: environmentInteger("DEMESNE_BENCHMARK_TIMEOUT_MS", 180_000),
    maxOutputTokens: environmentInteger("DEMESNE_BENCHMARK_OUTPUT_TOKENS", 512),
    temperature: Number(process.env.DEMESNE_BENCHMARK_TEMPERATURE ?? "0"),
    seed: environmentInteger("DEMESNE_BENCHMARK_SEED", 42),
    profileLabel: process.env.DEMESNE_BENCHMARK_PROFILE?.trim() || `slots-${process.env.DEMESNE_INFERENCE_SLOTS ?? "1"}`,
    promptPaddingLines: environmentInteger("DEMESNE_SCHEDULING_PADDING_LINES", 0),
    readChainDepths: [
      environmentInteger("DEMESNE_SCHEDULING_READ_DEPTH_A", 1),
      environmentInteger("DEMESNE_SCHEDULING_READ_DEPTH_B", 1),
    ],
    maximumInFlightPairs: environmentInteger("DEMESNE_SCHEDULING_MAXIMUM_IN_FLIGHT_PAIRS", 1),
  };
  const report = await runSchedulingBenchmark(config);
  const dataDirectory = process.env.DEMESNE_DATA_DIR ?? join(homedir(), ".demesne");
  const benchmarkDirectory = join(dataDirectory, "benchmarks");
  mkdirSync(benchmarkDirectory, { recursive: true, mode: 0o700 });
  chmodSync(benchmarkDirectory, 0o700);
  const timestamp = report.startedAt.replaceAll(":", "-");
  const outputPath = join(benchmarkDirectory, `scheduling-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Scheduling benchmark: ${config.profileLabel}`);
  console.log(`Successful measured pairs: ${report.summary.successfulRuns}/${report.summary.measuredRuns}`);
  console.log(`Median two-turn makespan: ${((report.summary.medianMakespanMs ?? 0) / 1000).toFixed(2)}s`);
  console.log(`Median total queue time: ${((report.summary.medianTotalQueueDurationMs ?? 0) / 1000).toFixed(2)}s`);
  console.log(`Raw report: ${outputPath}`);
}

if (import.meta.main) await main();
