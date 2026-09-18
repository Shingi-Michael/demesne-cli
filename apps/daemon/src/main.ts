#!/usr/bin/env bun

import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ConfigError, loadConfig } from "@demesne/config";
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
import { VERSION } from "./version.ts";

// Configuration comes from environment variables and the user config file
// (`~/.demesne/config.toml`). Project files are intentionally ignored: daemon
// provider settings are machine-wide, and a workspace cannot reconfigure the
// shared runtime. Environment variables still win over the file.
const { config } = loadDaemonConfig();

const host = parseHost(config.daemon.host ?? "127.0.0.1");
const port = config.daemon.port ?? 7337;
const inferenceSlots = config.inferenceSlots ?? 1;
const configuredRuntimeProfile = config.provider.runtimeProfile;
// A strict profile knows the context capacity it verifies, so it also knows the
// cold prefill budget that capacity implies. Without this floor the 180,000 ms
// default aborts a legitimate near-capacity request before the model emits its
// first event. An explicit value always wins so an operator can still tighten
// the deadline deliberately.
const profileFirstEventFloorMs = runtimeProfileMinimumFirstEventTimeoutMs(configuredRuntimeProfile);
const providerFirstEventTimeoutMs = config.provider.firstEventTimeoutMs
  ?? Math.max(180_000, profileFirstEventFloorMs ?? 0);
const providerRequestTimeoutMs = config.provider.requestTimeoutMs
  ?? Math.max(900_000, providerFirstEventTimeoutMs);
if (providerFirstEventTimeoutMs > providerRequestTimeoutMs) {
  throw new Error("provider.first_event_timeout_ms must not exceed provider.request_timeout_ms");
}
if (
  profileFirstEventFloorMs !== undefined
  && providerFirstEventTimeoutMs < profileFirstEventFloorMs
) {
  console.warn(
    `Warning: the configured first-event timeout (${providerFirstEventTimeoutMs} ms) is below the `
      + `${profileFirstEventFloorMs} ms cold-prefill budget measured for ${configuredRuntimeProfile}. `
      + "Near-capacity requests may be aborted before the model emits its first event.",
  );
}
if (runtimeProfileRequiresSingleInferenceSlot(configuredRuntimeProfile) && inferenceSlots !== 1) {
  throw new Error(`provider.runtime_profile=${configuredRuntimeProfile} requires inference_slots=1`);
}
const dataDirectory = prepareDataDirectory(config.dataDir);
const dataDirectoryLock = acquireDataDirectoryLock(dataDirectory);
let app: ReturnType<typeof createDaemonApp>;
let server: ReturnType<typeof Bun.serve>;
try {
  app = createDaemonApp({
    databasePath: join(dataDirectory, "demesne.sqlite"),
    processor: createProcessor(),
    systemPrompt: config.provider.systemPrompt,
    authToken: loadDaemonToken(dataDirectory),
    version: VERSION,
    inferenceSlots,
    providerFirstEventTimeoutMs,
    providerRequestTimeoutMs,
  });
  server = Bun.serve({ hostname: host, port, fetch: app.fetch });
} catch (error) {
  dataDirectoryLock.release();
  throw error;
}

console.log(`demesned ${VERSION} listening on ${server.url}`);

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

function loadDaemonConfig(): ReturnType<typeof loadConfig> {
  try {
    return loadConfig({ includeProject: false });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

function parseHost(value: string): string {
  if (!["127.0.0.1", "::1", "localhost"].includes(value)) {
    throw new Error("daemon.host must be a loopback address until daemon authentication is implemented");
  }
  return value;
}

function createProcessor(): ProviderTurnProcessor | undefined {
  const model = config.provider.model;
  const runtimeProfile = config.provider.runtimeProfile;
  if (!model && runtimeProfile) {
    throw new Error("provider.runtime_profile is set but provider.model is not: DEMESNE_RUNTIME_PROFILE requires DEMESNE_MODEL");
  }
  if (!model) return undefined;
  const baseUrl = config.provider.url ?? "http://127.0.0.1:1234/v1";
  const providerId = config.provider.id ?? "openai-compatible";
  const configuredContextCapacity = config.provider.contextWindow;
  const allowedModelIds = config.provider.allowedModels;
  const maxOutputTokens = config.provider.maxOutputTokens
    ?? runtimeProfileDefaultMaxOutputTokens(runtimeProfile);
  if (!configuredContextCapacity && !runtimeProfile) {
    throw new Error("provider.context_window is not set: DEMESNE_CONTEXT_WINDOW is required when provider.model is configured without a runtime profile");
  }
  if (!maxOutputTokens) {
    throw new Error("provider.max_output_tokens is not set: DEMESNE_MAX_OUTPUT_TOKENS is required when provider.model is configured without a profile default");
  }
  if (configuredContextCapacity && maxOutputTokens && maxOutputTokens >= configuredContextCapacity) {
    throw new Error("provider.max_output_tokens must be smaller than provider.context_window");
  }
  const provider = new OpenAICompatibleProvider({
    baseUrl,
    apiKey: config.provider.apiKey,
    providerId,
    includeUsage: config.provider.includeUsage ?? true,
    reasoningEffort: config.provider.reasoningEffort,
    contextWindow: configuredContextCapacity,
  });
  const verifier = createRuntimeProfileVerifier({
    profile: runtimeProfile,
    providerId,
    baseUrl,
    apiKey: config.provider.apiKey,
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

function prepareDataDirectory(configuredPath: string | undefined): string {
  const path = configuredPath ?? join(homedir(), ".demesne");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (configuredPath) {
    if ((statSync(path).mode & 0o077) !== 0) {
      throw new Error("data_dir must not be accessible by group or other users");
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
