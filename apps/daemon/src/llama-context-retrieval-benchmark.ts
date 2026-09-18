#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import type { TokenUsage } from "@demesne/protocol";
import { OpenAICompatibleProvider } from "@demesne/providers";
import {
  calculateHostMemoryDelta,
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

export const LLAMA_CONTEXT_RETRIEVAL_SCHEMA_VERSION = 1 as const;
const NEEDLE = "DEMESNE_NEEDLE_7F3A9C2E";

export interface RetrievalFixture {
  nominalPromptTokens: number;
  needlePosition: number;
  prompt: string;
  digest: string;
  expected: string;
}

export function buildRetrievalFixture(
  nominalPromptTokens: number,
  needlePosition = 0.5,
  payloadRepetitions = 0,
): RetrievalFixture {
  if (!Number.isSafeInteger(nominalPromptTokens) || nominalPromptTokens < 1_000) {
    throw new Error("nominalPromptTokens must be an integer of at least 1000");
  }
  if (!Number.isFinite(needlePosition) || needlePosition <= 0 || needlePosition >= 1) {
    throw new Error("needlePosition must be between zero and one");
  }
  // OpenAI chat framing plus the Qwen tokenizer measures these synthetic records
  // at approximately 19.6 tokens per line (materially denser than /completion).
  // Use 20 as a conservative calibration so nominal near-capacity fixtures stay
  // below the served context rather than being rejected before inference.
  if (!Number.isSafeInteger(payloadRepetitions) || payloadRepetitions < 0 || payloadRepetitions > 32) {
    throw new Error("payloadRepetitions must be an integer between zero and 32");
  }
  const payload = payloadRepetitions === 0
    ? NEEDLE
    : Array.from({ length: payloadRepetitions }, () => (
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa"
    )).join(" ");
  const lineCount = Math.max(1, Math.round(nominalPromptTokens / 20));
  const needleIndex = Math.min(lineCount - 1, Math.max(0, Math.round(lineCount * needlePosition)));
  const lines = Array.from({ length: lineCount }, (_, index) =>
    index === needleIndex
      ? `record ${index}: recovery_key=${payload}`
      : `record ${index}: node=${(index * 31) % 977} value=${(index * 7919) % 104729}`
  );
  const prompt = [
    "Read the complete inventory below.",
    "Return exactly the complete value after recovery_key= and nothing else.",
    "Do not explain, quote, or add punctuation.",
    "",
    ...lines,
  ].join("\n");
  return {
    nominalPromptTokens,
    needlePosition,
    prompt,
    digest: createHash("sha256").update(prompt).digest("hex"),
    expected: payload,
  };
}

export function retrievalMatches(response: string, expected: string): boolean {
  return response.trim() === expected;
}

export function ollamaModelNamesMatch(candidate: string, requested: string): boolean {
  const canonical = (name: string) => {
    const leaf = name.slice(name.lastIndexOf("/") + 1);
    return leaf.includes(":") ? name : `${name}:latest`;
  };
  return canonical(candidate) === canonical(requested);
}

interface RunnerSnapshot {
  observedAt: string;
  processes: Array<{ pid: number; commandLine: string }>;
}

interface OllamaNativeObservation {
  response: string;
  usage: TokenUsage;
  durationMs: number;
  firstOutputMs: number;
  postFirstOutputMs: number;
  decodeTokensPerSecond: number | null;
}

async function runOpenAINative(options: {
  endpoint: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
}): Promise<OllamaNativeObservation> {
  const body = JSON.stringify({
    model: options.model,
    messages: [{ role: "user", content: options.prompt }],
    stream: false,
    max_tokens: options.maxOutputTokens,
    temperature: 0,
    seed: 42,
  });
  const started = performance.now();
  const process = Bun.spawn([
    "curl", "--silent", "--show-error", "--max-time", String(Math.ceil(options.timeoutMs / 1_000)),
    "--request", "POST", "--header", "Content-Type: application/json", "--data-binary", "@-",
    new URL("chat/completions", options.endpoint.endsWith("/") ? options.endpoint : `${options.endpoint}/`).toString(),
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  process.stdin.write(body);
  process.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const durationMs = performance.now() - started;
  if (exitCode !== 0) throw new Error(`OpenAI-compatible native request failed: ${stderr.trim() || `curl exit ${exitCode}`}`);
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OpenAI-compatible native request returned invalid JSON");
  const record = value as Record<string, unknown>;
  if (record.error) throw new Error(`OpenAI-compatible native request failed: ${JSON.stringify(record.error)}`);
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  const message = first && typeof first === "object" && !Array.isArray(first)
    ? (first as Record<string, unknown>).message
    : null;
  const response = message && typeof message === "object" && !Array.isArray(message)
    && typeof (message as Record<string, unknown>).content === "string"
    ? (message as Record<string, unknown>).content as string
    : "";
  const usageRecord = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
    ? record.usage as Record<string, unknown>
    : {};
  const inputTokens = numericInteger(usageRecord.prompt_tokens);
  const outputTokens = numericInteger(usageRecord.completion_tokens);
  return {
    response,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    },
    durationMs,
    firstOutputMs: durationMs,
    postFirstOutputMs: 0,
    decodeTokensPerSecond: null,
  };
}

async function runOllamaNative(options: {
  endpoint: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
}): Promise<OllamaNativeObservation> {
  const body = JSON.stringify({
    model: options.model,
    messages: [{ role: "user", content: options.prompt }],
    stream: false,
    think: false,
    options: { temperature: 0, seed: 42, num_predict: options.maxOutputTokens },
  });
  const process = Bun.spawn([
    "curl",
    "--silent",
    "--show-error",
    "--max-time",
    String(Math.ceil(options.timeoutMs / 1_000)),
    "--request",
    "POST",
    "--header",
    "Content-Type: application/json",
    "--data-binary",
    "@-",
    new URL("/api/chat", options.endpoint).toString(),
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  process.stdin.write(body);
  process.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Ollama native request failed: ${stderr.trim() || `curl exit ${exitCode}`}`);
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ollama native request returned an invalid response");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") throw new Error(`Ollama native request failed: ${record.error}`);
  const message = record.message;
  const response = message && typeof message === "object" && !Array.isArray(message)
    && typeof (message as Record<string, unknown>).content === "string"
    ? (message as Record<string, unknown>).content as string
    : "";
  const inputTokens = numericInteger(record.prompt_eval_count);
  const outputTokens = numericInteger(record.eval_count);
  const totalDurationNs = numericNumber(record.total_duration);
  const loadDurationNs = numericNumber(record.load_duration) ?? 0;
  const promptDurationNs = numericNumber(record.prompt_eval_duration) ?? 0;
  const evalDurationNs = numericNumber(record.eval_duration);
  const firstOutputMs = (loadDurationNs + promptDurationNs) / 1_000_000;
  const durationMs = totalDurationNs === null ? firstOutputMs + ((evalDurationNs ?? 0) / 1_000_000) : totalDurationNs / 1_000_000;
  const postFirstOutputMs = evalDurationNs === null ? Math.max(0, durationMs - firstOutputMs) : evalDurationNs / 1_000_000;
  const decodeTokensPerSecond = outputTokens !== null && outputTokens > 0 && postFirstOutputMs > 0
    ? outputTokens / (postFirstOutputMs / 1_000)
    : null;
  return {
    response,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    },
    durationMs,
    firstOutputMs,
    postFirstOutputMs,
    decodeTokensPerSecond,
  };
}

function numericInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function numericNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function runnerSnapshot(providerId: string): RunnerSnapshot | null {
  const processes = providerId === "ollama"
    ? readOllamaMlxRunnerProcesses()
    : providerId === "vllm-metal" ? readVllmMetalProcesses() : readLlamaServerProcesses();
  return processes === null ? null : { observedAt: new Date().toISOString(), processes };
}

function readVllmMetalProcesses(): Array<{ pid: number; commandLine: string }> | null {
  try {
    const result = Bun.spawnSync({ cmd: ["pgrep", "-fl", "VLLM::EngineCore"], stdout: "pipe", stderr: "ignore" });
    if (!result.success) return [];
    return result.stdout.toString().split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), commandLine: match[2]! }] : [];
    });
  } catch {
    return null;
  }
}

function readOllamaMlxRunnerProcesses(): Array<{ pid: number; commandLine: string }> | null {
  try {
    const result = Bun.spawnSync({ cmd: ["pgrep", "-fl", "ollama runner"], stdout: "pipe", stderr: "ignore" });
    if (!result.success) return [];
    return result.stdout.toString().split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match && match[2]!.includes("--mlx-engine")
        ? [{ pid: Number(match[1]), commandLine: match[2]! }]
        : [];
    });
  } catch {
    return null;
  }
}

function runnerSignature(snapshot: RunnerSnapshot | null): string | null {
  if (!snapshot) return null;
  return snapshot.processes.map((process) => `${process.pid}:${process.commandLine}`).sort().join("\n");
}

async function serverProperties(endpoint: string, providerId: string, model: string): Promise<{
  buildInfo: string | null;
  contextWindow: number | null;
  modelAlias: string | null;
  engine: string | null;
}> {
  if (providerId === "ollama") {
    try {
      const [versionResponse, modelsResponse] = await Promise.all([
        fetch(new URL("/api/version", endpoint), { redirect: "manual" }),
        fetch(new URL("/api/ps", endpoint), { redirect: "manual" }),
      ]);
      if (!versionResponse.ok || !modelsResponse.ok) {
        return { buildInfo: null, contextWindow: null, modelAlias: null, engine: null };
      }
      const version: unknown = await versionResponse.json();
      const models: unknown = await modelsResponse.json();
      const versionValue = version && typeof version === "object" && !Array.isArray(version)
        ? (version as Record<string, unknown>).version
        : null;
      const entries = models && typeof models === "object" && !Array.isArray(models)
        ? (models as Record<string, unknown>).models
        : null;
      const selected = Array.isArray(entries)
        ? entries.find((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
            const record = entry as Record<string, unknown>;
            return (typeof record.name === "string" && ollamaModelNamesMatch(record.name, model))
              || (typeof record.model === "string" && ollamaModelNamesMatch(record.model, model));
          })
        : null;
      const record = selected && typeof selected === "object" && !Array.isArray(selected)
        ? selected as Record<string, unknown>
        : null;
      return {
        buildInfo: typeof versionValue === "string" ? versionValue : null,
        contextWindow: typeof record?.context_length === "number" ? record.context_length : null,
        modelAlias: typeof record?.name === "string" ? record.name : typeof record?.model === "string" ? record.model : null,
        engine: "mlx",
      };
    } catch {
      return { buildInfo: null, contextWindow: null, modelAlias: null, engine: null };
    }
  }
  if (providerId === "vllm-metal") {
    try {
      const [versionResponse, modelsResponse] = await Promise.all([
        fetch(new URL("/version", endpoint), { redirect: "manual" }),
        fetch(new URL("models", endpoint.endsWith("/") ? endpoint : `${endpoint}/`), { redirect: "manual" }),
      ]);
      if (!versionResponse.ok || !modelsResponse.ok) {
        return { buildInfo: null, contextWindow: null, modelAlias: null, engine: null };
      }
      const version: unknown = await versionResponse.json();
      const models: unknown = await modelsResponse.json();
      const versionValue = version && typeof version === "object" && !Array.isArray(version)
        ? (version as Record<string, unknown>).version
        : null;
      const entries = models && typeof models === "object" && !Array.isArray(models)
        ? (models as Record<string, unknown>).data
        : null;
      const selected = Array.isArray(entries)
        ? entries.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
          && (entry as Record<string, unknown>).id === model)
        : null;
      const record = selected && typeof selected === "object" && !Array.isArray(selected)
        ? selected as Record<string, unknown>
        : null;
      return {
        buildInfo: typeof versionValue === "string" ? versionValue : null,
        contextWindow: typeof record?.max_model_len === "number" ? record.max_model_len : null,
        modelAlias: typeof record?.id === "string" ? record.id : null,
        engine: "vllm-metal",
      };
    } catch {
      return { buildInfo: null, contextWindow: null, modelAlias: null, engine: null };
    }
  }
  try {
    const response = await fetch(new URL("/props", endpoint), { redirect: "manual" });
    if (!response.ok) return { buildInfo: null, contextWindow: null, modelAlias: null, engine: null };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { buildInfo: null, contextWindow: null, modelAlias: null, engine: null };
    }
    const record = body as Record<string, unknown>;
    const generation = record.default_generation_settings;
    const context = generation && typeof generation === "object" && !Array.isArray(generation)
      ? (generation as Record<string, unknown>).n_ctx
      : null;
    return {
      buildInfo: typeof record.build_info === "string" ? record.build_info : null,
      contextWindow: typeof context === "number" ? context : null,
      modelAlias: typeof record.model_alias === "string" ? record.model_alias : null,
      engine: "llama.cpp",
    };
  } catch {
    return { buildInfo: null, contextWindow: null, modelAlias: null, engine: null };
  }
}

function powerEligible(before: HostPowerSnapshot | null, after: HostPowerSnapshot | null): boolean {
  return before?.source === "ac" && after?.source === "ac";
}

async function main(): Promise<void> {
  const endpoint = process.env.DEMESNE_PROVIDER_URL ?? "http://127.0.0.1:11436/v1";
  const providerId = process.env.DEMESNE_PROVIDER_ID ?? "llama.cpp";
  const model = requiredEnvironment("DEMESNE_MODEL");
  const nominalPromptTokens = environmentInteger("DEMESNE_RETRIEVAL_TOKENS", 60_000);
  const needlePosition = environmentNumber("DEMESNE_RETRIEVAL_NEEDLE_POSITION", 0.5);
  const payloadRepetitions = environmentNonnegativeInteger("DEMESNE_RETRIEVAL_PAYLOAD_REPETITIONS", 0);
  const fixture = buildRetrievalFixture(nominalPromptTokens, needlePosition, payloadRepetitions);
  const provider = new OpenAICompatibleProvider({
    baseUrl: endpoint,
    providerId,
    includeUsage: true,
    reasoningEffort: "none",
  });
  const memoryBefore = readHostMemorySnapshot();
  const powerBefore = readHostPowerSnapshot();
  const runnerBefore = runnerSnapshot(providerId);
  const properties = await serverProperties(endpoint, providerId, model);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let firstOutputMs: number | null = null;
  let response = "";
  let usage: TokenUsage | null = null;
  const timeoutMs = environmentInteger("DEMESNE_RETRIEVAL_TIMEOUT_MS", 3_600_000);
  let nativeObservation: OllamaNativeObservation | null = null;
  if (providerId === "ollama") {
    nativeObservation = await runOllamaNative({
      endpoint,
      model,
      prompt: fixture.prompt,
      maxOutputTokens: payloadRepetitions > 0 ? 512 : 64,
      timeoutMs,
    });
    response = nativeObservation.response;
    usage = nativeObservation.usage;
    firstOutputMs = nativeObservation.firstOutputMs;
  } else if (providerId === "vllm-metal") {
    nativeObservation = await runOpenAINative({
      endpoint,
      model,
      prompt: fixture.prompt,
      maxOutputTokens: payloadRepetitions > 0 ? 512 : 64,
      timeoutMs,
    });
    response = nativeObservation.response;
    usage = nativeObservation.usage;
    firstOutputMs = nativeObservation.firstOutputMs;
  } else {
    const signal = AbortSignal.timeout(timeoutMs);
    for await (const event of provider.stream({
      model,
      messages: [{ role: "user", content: fixture.prompt }],
      maxOutputTokens: payloadRepetitions > 0 ? 512 : 64,
      temperature: 0,
      seed: 42,
      thinkingEnabled: false,
    }, signal)) {
      if (event.type === "text_delta") {
        if (firstOutputMs === null) firstOutputMs = performance.now() - started;
        response += event.delta;
      }
      if (event.type === "usage") usage = event.usage;
    }
  }

  const durationMs = nativeObservation?.durationMs ?? (performance.now() - started);
  const postFirstOutputMs = nativeObservation?.postFirstOutputMs
    ?? (firstOutputMs === null ? null : Math.max(0, durationMs - firstOutputMs));
  const decodeTokensPerSecond = nativeObservation?.decodeTokensPerSecond ?? (usage?.outputTokens !== null && usage?.outputTokens !== undefined
    && usage.outputTokens > 0 && postFirstOutputMs !== null && postFirstOutputMs > 0
    ? usage.outputTokens / (postFirstOutputMs / 1_000)
    : null);
  const memoryAfter = readHostMemorySnapshot();
  const powerAfter = readHostPowerSnapshot();
  const runnerAfter = runnerSnapshot(providerId);
  const memoryDelta = calculateHostMemoryDelta(memoryBefore, memoryAfter);
  const flags = providerId === "llama.cpp" && runnerBefore?.processes.length === 1
    ? parseLlamaServerCommand(runnerBefore.processes[0]!.commandLine)
    : null;
  const speculationType = providerId === "llama.cpp" && runnerBefore?.processes.length === 1
    ? parseLlamaServerSpeculationType(runnerBefore.processes[0]!.commandLine)
    : null;
  const gates = [
    { id: "retrieval", passed: retrievalMatches(response, fixture.expected), detail: `response ${JSON.stringify(response.trim())}` },
    { id: "reported-usage", passed: usage?.inputTokens !== null && usage?.inputTokens !== undefined, detail: `input tokens ${usage?.inputTokens ?? "unknown"}` },
    { id: "ac-power", passed: powerEligible(powerBefore, powerAfter), detail: `${powerBefore?.source ?? "unknown"} -> ${powerAfter?.source ?? "unknown"}` },
    {
      id: "exclusive-runner",
      passed: runnerBefore?.processes.length === 1 && runnerSignature(runnerBefore) === runnerSignature(runnerAfter),
      detail: `${runnerBefore?.processes.length ?? "unknown"} -> ${runnerAfter?.processes.length ?? "unknown"} processes`,
    },
    {
      id: "swap-out-growth",
      passed: memoryDelta.swapOutBytes !== null && memoryDelta.swapOutBytes <= 0,
      detail: `${((memoryDelta.swapOutBytes ?? 0) / (1024 * 1024)).toFixed(2)} MiB`,
    },
    {
      id: "runtime-provenance",
      passed: properties.buildInfo !== null && properties.contextWindow !== null && properties.engine !== null
        && (providerId === "ollama" || providerId === "vllm-metal" || (flags !== null && speculationType !== null)),
      detail: `build ${properties.buildInfo ?? "unknown"}, engine ${properties.engine ?? "unknown"}, ctx ${properties.contextWindow ?? "unknown"}, speculation ${speculationType ?? "n/a"}`,
    },
  ];
  const report = {
    schemaVersion: LLAMA_CONTEXT_RETRIEVAL_SCHEMA_VERSION,
    startedAt,
    completedAt: new Date().toISOString(),
    valid: gates.every((gate) => gate.passed),
    machine: { platform: platform(), architecture: arch(), osRelease: release(), totalMemoryBytes: totalmem() },
    runtime: { endpoint, providerId, model, ...properties, flags, speculationType },
    fixture: { ...fixture, prompt: undefined },
    observation: { durationMs, firstOutputMs, postFirstOutputMs, decodeTokensPerSecond, response, usage },
    memory: { before: memoryBefore, after: memoryAfter, delta: memoryDelta },
    power: { before: powerBefore, after: powerAfter },
    runner: { before: runnerBefore, after: runnerAfter },
    gates,
  };
  const benchmarkDirectory = join(process.env.DEMESNE_DATA_DIR ?? join(homedir(), ".demesne"), "benchmarks");
  mkdirSync(benchmarkDirectory, { recursive: true, mode: 0o700 });
  chmodSync(benchmarkDirectory, 0o700);
  const outputPath = join(benchmarkDirectory, `llama-retrieval-${startedAt.replaceAll(":", "-")}.json`);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  console.log(`llama.cpp retrieval benchmark (schema ${report.schemaVersion})`);
  console.log(`Prompt: nominal ${nominalPromptTokens}, reported ${usage?.inputTokens ?? "unknown"} tokens`);
  console.log(`Needle position: ${(needlePosition * 100).toFixed(1)}%`);
  console.log(`Payload repetitions: ${payloadRepetitions}`);
  console.log(`First output: ${firstOutputMs === null ? "unknown" : `${(firstOutputMs / 1_000).toFixed(2)}s`}`);
  console.log(`Post-first-output: ${decodeTokensPerSecond === null ? "unknown" : `${decodeTokensPerSecond.toFixed(2)} tok/s`}`);
  console.log(`Response: ${JSON.stringify(response.trim())}`);
  for (const gate of gates) console.log(`${gate.passed ? "pass" : "FAIL"}  ${gate.id}: ${gate.detail}`);
  console.log(`Report valid: ${report.valid}`);
  console.log(`Raw report: ${outputPath}`);
  if (!report.valid) process.exitCode = 1;
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
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function environmentNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function environmentNonnegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return value;
}

if (import.meta.main) await main();
