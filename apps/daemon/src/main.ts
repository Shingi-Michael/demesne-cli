#!/usr/bin/env bun

import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ConfigError, loadConfig, updateUserConfig, userConfigPath, type ProviderConfig } from "@demesne/config";
import { MultiProviderProcessor } from "./multi-provider-processor.ts";
import { ChatGPTAuth } from "@demesne/chatgpt-auth";
import { ChatGPTProvider, OpenAICompatibleProvider } from "@demesne/providers";
import { createDaemonApp } from "./app.ts";
import { serveDaemon } from "./http-server.ts";
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

const OPENROUTER_API = "https://openrouter.ai/api/v1";

// Configuration comes from environment variables and the user config file
// (`~/.demesne/config.toml`). Project files are intentionally ignored: daemon
// provider settings are machine-wide, and a workspace cannot reconfigure the
// shared runtime. Environment variables still win over the file.
const { config, files: configFiles } = loadDaemonConfig();

const host = parseHost(config.daemon.host ?? "127.0.0.1");
const port = config.daemon.port ?? 7337;
const inferenceSlots = config.inferenceSlots ?? 1;
const providerInferenceSlots: Record<string, number> = {};
for (const settings of [config.provider, ...Object.values(config.additionalProviders ?? {})]) {
  const id = settings.auth === "chatgpt" ? "ChatGPT" : settings.id ?? "openai-compatible";
  const slots = settings.inferenceSlots ?? inferenceSlots;
  if (runtimeProfileRequiresSingleInferenceSlot(settings.runtimeProfile) && slots !== 1) throw new Error(`${id}'s runtime profile requires one inference slot`);
  if (providerInferenceSlots[id] !== undefined && providerInferenceSlots[id] !== slots) throw new Error(`Conflicting inference slots for provider ${id}`);
  providerInferenceSlots[id] = slots;
}
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
if (runtimeProfileRequiresSingleInferenceSlot(configuredRuntimeProfile) && (config.provider.inferenceSlots ?? inferenceSlots) !== 1) {
  throw new Error(`provider.runtime_profile=${configuredRuntimeProfile} requires inference_slots=1`);
}
const dataDirectory = prepareDataDirectory(config.dataDir);
const dataDirectoryLock = acquireDataDirectoryLock(dataDirectory);
let app: ReturnType<typeof createDaemonApp>;
const processor = createProcessor(await signedInAccounts());
let server: ReturnType<typeof Bun.serve>;
try {
  app = createDaemonApp({
    databasePath: join(dataDirectory, "demesne.sqlite"),
    processor,
    localProviders: [config.provider, ...Object.values(config.additionalProviders ?? {})].filter(isLocalProvider)
      .map((item) => item.id ?? "openai-compatible"),
    reloadProviders: () => reloadProviders(processor),
    systemPrompt: config.provider.systemPrompt,
    theme: config.theme,
    authToken: loadDaemonToken(dataDirectory),
    version: VERSION,
    inferenceSlots,
    providerInferenceSlots,
    allowlistPath: process.env.DEMESNE_CONFIG_FILE || configFiles.user || userConfigPath(),
    mcpServers: config.mcp.servers,
    images: config.images,
    providerVision: config.provider.vision,
    agent: config.agent,
    // /subagent saves its choice where the rest of the user's settings live.
    saveSubagentModel: (model) => { updateUserConfig(process.env.DEMESNE_CONFIG_FILE || configFiles.user || userConfigPath(), { agent: { subagent_model: model } }); },
    providerFirstEventTimeoutMs,
    // Let each turn's output budget determine the default streaming deadline.
    providerRequestTimeoutMs: config.provider.requestTimeoutMs,
  });
  server = serveDaemon(app, { hostname: host, port });
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

/// A provider you've signed out of (ChatGPT without tokens, OpenRouter
/// without a key) isn't offered; nor is one that would only fail.
function signedOut(settings: ProviderConfig, chatgptSignedIn: Set<string>): boolean {
  if (settings.auth === "chatgpt") return !settings.authProfile || !chatgptSignedIn.has(settings.authProfile);
  return (settings.url ?? "").replace(/\/$/, "") === OPENROUTER_API && !settings.apiKey;
}

/// Loopback, private and Tailscale addresses, and .local names: a model on
/// your own machines, preferred when the selected one goes away.
function isLocalProvider(settings: ProviderConfig): boolean {
  if (settings.auth === "chatgpt") return false;
  try {
    const host = new URL(settings.url ?? "http://127.0.0.1:1234/v1").hostname;
    return host === "localhost" || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || host === "[::1]";
  } catch { return false; }
}

async function signedInAccounts(): Promise<Set<string>> {
  const signedIn = new Set<string>();
  try { for (const account of await new ChatGPTAuth(dataDirectory).accounts()) if (account.signedIn) signedIn.add(account.id); }
  catch { /* A signed-out account must not hide other providers. */ }
  return signedIn;
}

/// The configured providers you're signed in to. When none are, all are
/// kept, so a request explains what to do instead of finding no provider.
function buildProviders(settings: typeof config, signedIn: Set<string>) {
  const all = [settings.provider, ...Object.values(settings.additionalProviders ?? {})];
  const available = all.filter((item) => !signedOut(item, signedIn));
  const configs = available.length ? available : all;
  const processors = configs.map(createSingleProcessor);
  return { configs, processors };
}

function createProcessor(signedIn: Set<string>): ProviderTurnProcessor | MultiProviderProcessor | undefined {
  const { configs, processors } = buildProviders(config, signedIn);
  if (processors.length === 1 && !processors[0]) return undefined;
  if (processors.some((processor) => !processor)) throw new Error("Each configured provider requires a default model");
  return new MultiProviderProcessor(processors as ProviderTurnProcessor[], configs.map((item) => item.allowedModels ?? []));
}

/// Re-reads the user config and auth after signing in or out, and swaps the
/// providers in place: no daemon restart.
async function reloadProviders(processor: ProviderTurnProcessor | MultiProviderProcessor | undefined) {
  if (!(processor instanceof MultiProviderProcessor)) throw new Error("Configure a provider with demesne setup first.");
  const { config: fresh } = loadConfig({ includeProject: false });
  const { configs, processors } = buildProviders(fresh, await signedInAccounts());
  if (processors.some((item) => !item)) throw new Error("Each configured provider requires a default model");
  return processor.replaceFromCatalog(processors as ProviderTurnProcessor[], configs.map((item) => item.allowedModels ?? []), configs.map(isLocalProvider));
}

function createSingleProcessor(settings: ProviderConfig): ProviderTurnProcessor | undefined {
  const model = settings.model;
  const runtimeProfile = settings.runtimeProfile;
  if (!model && runtimeProfile) {
    throw new Error("provider.runtime_profile is set but provider.model is not: DEMESNE_RUNTIME_PROFILE requires DEMESNE_MODEL");
  }
  if (!model) return undefined;
  const baseUrl = settings.url ?? "http://127.0.0.1:1234/v1";
  const providerId = settings.auth === "chatgpt" ? "ChatGPT" : settings.id ?? "openai-compatible";
  const configuredContextCapacity = settings.contextWindow;
  const allowedModelIds = settings.allowedModels;
  const maxOutputTokens = settings.maxOutputTokens
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
  if (settings.auth === "chatgpt" && !settings.authProfile) throw new Error("ChatGPT requires an auth_profile. Run demesne auth login chatgpt.");
  const auth = settings.auth === "chatgpt" ? new ChatGPTAuth(dataDirectory) : undefined;
  const provider = auth ? new ChatGPTProvider({ accountId: settings.authProfile!, accessToken: signal => auth.accessToken(settings.authProfile!, signal), contextWindow: configuredContextCapacity, configuredModel: model }) : new OpenAICompatibleProvider({
    baseUrl,
    allowHttpEndpoint: settings.allowHttpEndpoint,
    apiKey: settings.apiKey,
    providerId,
    includeUsage: settings.includeUsage ?? true,
    reasoningEffort: settings.reasoningEffort,
    openRouterIgnore: settings.openRouterIgnore,
    contextWindow: configuredContextCapacity,
  });
  const verifier = auth ? undefined : createRuntimeProfileVerifier({
    profile: runtimeProfile,
    providerId,
    baseUrl,
    apiKey: settings.apiKey,
  });
  return new ProviderTurnProcessor(
    provider,
    model,
    { maxOutputTokens },
    verifier,
    configuredContextCapacity,
    allowedModelIds,
    settings.auth === "chatgpt" || runtimeProfileSupportsPromptCache(runtimeProfile),
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
