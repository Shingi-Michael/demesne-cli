#!/usr/bin/env bun

import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { OpenAICompatibleProvider } from "@demesne/providers";
import { createDaemonApp } from "./app.ts";
import {
  createRuntimeProfileVerifier,
  runtimeProfileDefaultMaxOutputTokens,
  runtimeProfileMinimumFirstEventTimeoutMs,
  runtimeProfileRequiresSingleInferenceSlot,
  runtimeProfileSupportsPromptCache,
} from "./ollama-runtime.ts";
import { ProviderTurnProcessor } from "./provider-processor.ts";
import { acquireDataDirectoryLock } from "./data-directory-lock.ts";

const host = parseHost(process.env.DEMESNE_HOST ?? "127.0.0.1");
const port = parsePort(process.env.DEMESNE_PORT ?? "7337");
const inferenceSlots = parseOptionalPositiveInteger(process.env.DEMESNE_INFERENCE_SLOTS, "DEMESNE_INFERENCE_SLOTS") ?? 1;
const configuredRuntimeProfile = process.env.DEMESNE_RUNTIME_PROFILE?.trim();
const explicitFirstEventTimeoutMs = parseOptionalPositiveInteger(
  process.env.DEMESNE_PROVIDER_FIRST_EVENT_TIMEOUT_MS,
  "DEMESNE_PROVIDER_FIRST_EVENT_TIMEOUT_MS",
);
const explicitRequestTimeoutMs = parseOptionalPositiveInteger(
  process.env.DEMESNE_PROVIDER_REQUEST_TIMEOUT_MS,
  "DEMESNE_PROVIDER_REQUEST_TIMEOUT_MS",
);
// A strict profile knows the context capacity it verifies, so it also knows the
// cold prefill budget that capacity implies. Without this floor the 180,000 ms
// default aborts a legitimate near-capacity request before the model emits its
// first event. An explicit environment value always wins so an operator can
// still tighten the deadline deliberately.
const profileFirstEventFloorMs = runtimeProfileMinimumFirstEventTimeoutMs(configuredRuntimeProfile);
const providerFirstEventTimeoutMs = explicitFirstEventTimeoutMs
  ?? Math.max(180_000, profileFirstEventFloorMs ?? 0);
const providerRequestTimeoutMs = explicitRequestTimeoutMs
  ?? Math.max(900_000, providerFirstEventTimeoutMs);
if (providerFirstEventTimeoutMs > providerRequestTimeoutMs) {
  throw new Error("DEMESNE_PROVIDER_FIRST_EVENT_TIMEOUT_MS must not exceed DEMESNE_PROVIDER_REQUEST_TIMEOUT_MS");
}
if (
  profileFirstEventFloorMs !== undefined
  && providerFirstEventTimeoutMs < profileFirstEventFloorMs
) {
  console.warn(
    `Warning: DEMESNE_PROVIDER_FIRST_EVENT_TIMEOUT_MS=${providerFirstEventTimeoutMs} is below the `
      + `${profileFirstEventFloorMs} ms cold-prefill budget measured for ${configuredRuntimeProfile}. `
      + "Near-capacity requests may be aborted before the model emits its first event.",
  );
}
if (runtimeProfileRequiresSingleInferenceSlot(configuredRuntimeProfile) && inferenceSlots !== 1) {
  throw new Error(`DEMESNE_RUNTIME_PROFILE=${configuredRuntimeProfile} requires DEMESNE_INFERENCE_SLOTS=1`);
}
const dataDirectory = prepareDataDirectory(process.env.DEMESNE_DATA_DIR);
const dataDirectoryLock = acquireDataDirectoryLock(dataDirectory);
let app: ReturnType<typeof createDaemonApp>;
let server: ReturnType<typeof Bun.serve>;
try {
  app = createDaemonApp({
    databasePath: join(dataDirectory, "demesne.sqlite"),
    processor: createProcessor(),
    systemPrompt: process.env.DEMESNE_SYSTEM_PROMPT,
    authToken: loadDaemonToken(dataDirectory),
    inferenceSlots,
    providerFirstEventTimeoutMs,
    providerRequestTimeoutMs,
  });
  server = Bun.serve({ hostname: host, port, fetch: app.fetch });
} catch (error) {
  dataDirectoryLock.release();
  throw error;
}

console.log(`demesned listening on ${server.url}`);

async function shutdown(): Promise<void> {
  try {
    await server.stop(true);
    await app.close();
  } finally {
    dataDirectoryLock.release();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("DEMESNE_PORT must be an integer between 1 and 65535");
  }
  return parsed;
}

function parseHost(value: string): string {
  if (!["127.0.0.1", "::1", "localhost"].includes(value)) {
    throw new Error("DEMESNE_HOST must be a loopback address until daemon authentication is implemented");
  }
  return value;
}

function createProcessor(): ProviderTurnProcessor | undefined {
  const model = process.env.DEMESNE_MODEL?.trim();
  const runtimeProfile = process.env.DEMESNE_RUNTIME_PROFILE?.trim();
  if (!model && runtimeProfile) throw new Error("DEMESNE_RUNTIME_PROFILE requires DEMESNE_MODEL");
  if (!model) return undefined;
  const reasoningEffort = parseReasoningEffort(process.env.DEMESNE_REASONING_EFFORT);
  const baseUrl = process.env.DEMESNE_PROVIDER_URL ?? "http://127.0.0.1:1234/v1";
  const providerId = process.env.DEMESNE_PROVIDER_ID ?? "openai-compatible";
  const configuredContextCapacity = parseOptionalPositiveInteger(process.env.DEMESNE_CONTEXT_WINDOW, "DEMESNE_CONTEXT_WINDOW");
  const allowedModelIds = parseOptionalList(process.env.DEMESNE_ALLOWED_MODELS, "DEMESNE_ALLOWED_MODELS");
  const maxOutputTokens = parseOptionalPositiveInteger(process.env.DEMESNE_MAX_OUTPUT_TOKENS, "DEMESNE_MAX_OUTPUT_TOKENS")
    ?? runtimeProfileDefaultMaxOutputTokens(runtimeProfile);
  if (!configuredContextCapacity && !runtimeProfile) {
    throw new Error("DEMESNE_CONTEXT_WINDOW is required when DEMESNE_MODEL is configured without a runtime profile");
  }
  if (!maxOutputTokens) {
    throw new Error("DEMESNE_MAX_OUTPUT_TOKENS is required when DEMESNE_MODEL is configured without a profile default");
  }
  if (configuredContextCapacity && maxOutputTokens && maxOutputTokens >= configuredContextCapacity) {
    throw new Error("DEMESNE_MAX_OUTPUT_TOKENS must be smaller than DEMESNE_CONTEXT_WINDOW");
  }
  const provider = new OpenAICompatibleProvider({
    baseUrl,
    apiKey: process.env.DEMESNE_API_KEY,
    providerId,
    includeUsage: process.env.DEMESNE_INCLUDE_USAGE !== "false",
    reasoningEffort,
    contextWindow: configuredContextCapacity,
  });
  const verifier = createRuntimeProfileVerifier({
    profile: runtimeProfile,
    providerId,
    baseUrl,
    apiKey: process.env.DEMESNE_API_KEY,
  });
  return new ProviderTurnProcessor(
    provider,
    model,
    { maxOutputTokens },
    verifier,
    configuredContextCapacity,
    allowedModelIds,
    runtimeProfileSupportsPromptCache(runtimeProfile),
  );
}

function parseOptionalList(value: string | undefined, name: string): string[] | undefined {
  if (!value?.trim()) return undefined;
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !entry) || new Set(entries).size !== entries.length) {
    throw new Error(`${name} must be a comma-separated list of unique non-empty values`);
  }
  return entries;
}

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseReasoningEffort(value: string | undefined): "none" | "low" | "medium" | "high" | "max" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["none", "low", "medium", "high", "max"].includes(normalized)) {
    return normalized as "none" | "low" | "medium" | "high" | "max";
  }
  throw new Error("DEMESNE_REASONING_EFFORT must be none, low, medium, high, or max");
}

function prepareDataDirectory(configuredPath: string | undefined): string {
  const path = configuredPath ?? join(homedir(), ".demesne");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (configuredPath) {
    if ((statSync(path).mode & 0o077) !== 0) {
      throw new Error("DEMESNE_DATA_DIR must not be accessible by group or other users");
    }
  } else {
    chmodSync(path, 0o700);
  }
  return path;
}

function loadDaemonToken(dataDirectory: string): string {
  const configured = process.env.DEMESNE_DAEMON_TOKEN?.trim();
  if (configured) return configured;
  const path = join(dataDirectory, "daemon.token");
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    const token = readFileSync(path, "utf8").trim();
    if (token) return token;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}
