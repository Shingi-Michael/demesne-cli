#!/usr/bin/env bun

import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ConfigError, loadConfig, updateUserConfig, userConfigPath } from "@demesne/config";
import { MultiProviderProcessor } from "./multi-provider-processor.ts";
import { buildProviders, createProcessor, isLocalProvider, signedInAccounts } from "./providers-from-config.ts";
import { createDaemonApp } from "./app.ts";
import { ntfy } from "./notify-phone.ts";
import { serveDaemon } from "./http-server.ts";
import {
  runtimeProfileMinimumFirstEventTimeoutMs,
  runtimeProfileRequiresSingleInferenceSlot,
} from "./ollama-runtime.ts";
import { ProviderTurnProcessor } from "./provider-processor.ts";
import { acquireDataDirectoryLock } from "./data-directory-lock.ts";
import { BUILD, VERSION } from "./version.ts";


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
  const id = settings.auth === "chatgpt" ? "ChatGPT" : settings.auth === "codex" ? "Codex" : settings.id ?? "openai-compatible";
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
// The daemon binary's stat at startup; reload() compares it to detect when an
// updater has replaced the binary with a new version.
let initialBinaryStat: { mtimeMs: number; size: number } | undefined;
try {
  const binaryStat = statSync(process.execPath);
  initialBinaryStat = { mtimeMs: binaryStat.mtimeMs, size: binaryStat.size };
} catch { /* the running source/binary cannot be stat'd; skip update detection */ }

let app: ReturnType<typeof createDaemonApp>;
const processor = createProcessor(config, dataDirectory, await signedInAccounts(dataDirectory));
let server: ReturnType<typeof Bun.serve>;
try {
  app = createDaemonApp({
    databasePath: join(dataDirectory, "demesne.sqlite"),
    processor,
    nameChats: true,
    localProviders: [config.provider, ...Object.values(config.additionalProviders ?? {})].filter(isLocalProvider)
      .map((item) => item.id ?? "openai-compatible"),
    reloadProviders: () => reloadProviders(processor),
    systemPrompt: config.provider.systemPrompt,
    theme: config.theme,
    authToken: loadDaemonToken(dataDirectory),
    version: VERSION,
    ...(BUILD ? { build: BUILD } : {}),
    inferenceSlots,
    providerInferenceSlots,
    allowlistPath: process.env.DEMESNE_CONFIG_FILE || configFiles.user || userConfigPath(),
    configFile: configFiles.user ?? null,
    initialBinaryStat,
    mcpServers: config.mcp.servers,
    heartbeat: config.heartbeat,
    assistantFolders: config.assistant?.folders,
    // install.ps1 makes ~/Assistant; `[assistant] home` names another folder.
    assistantHome: config.assistant?.home ?? (existsSync(join(homedir(), "Assistant")) ? join(homedir(), "Assistant") : undefined),
    phone: config.assistant?.ntfy ? ntfy(config.assistant.ntfy, config.assistant.ntfyToken) : undefined,
    // The assistant's chat never follows the picker to another provider.
    assistantModel: config.assistant?.model ?? config.provider.model,
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

// Watch the user config file and hot-reload providers/theme when it changes
// (for example after an update rewrites it). Debounced so a rapid save does
// not reload more than once.
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let configWatcher: ReturnType<typeof watch> | null = null;
function scheduleConfigReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void app.reload().then((report) => {
      console.log(`daemon config reloaded: providers=${report.providers ? "switched" : "unchanged"}, theme=${report.theme.changed ? "changed" : "unchanged"}, binaryUpdated=${report.binaryUpdated}`);
    }).catch((error) => console.warn(`daemon config auto-reload failed: ${error instanceof Error ? error.message : String(error)}`));
  }, 1000);
  reloadTimer.unref?.();
}
if (configFiles.user) {
  try { configWatcher = watch(configFiles.user, () => scheduleConfigReload()); }
  catch { /* watching the config is optional; reload on request still works */ }
}

async function shutdown(): Promise<void> {
  try {
    configWatcher?.close();
    if (reloadTimer) clearTimeout(reloadTimer);
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

/// Re-reads the user config and auth after signing in or out, and swaps the
/// providers in place: no daemon restart.
async function reloadProviders(processor: ProviderTurnProcessor | MultiProviderProcessor | undefined) {
  if (!(processor instanceof MultiProviderProcessor)) throw new Error("Configure a provider in Demesne's setup first.");
  const { config: fresh } = loadConfig({ includeProject: false });
  const { configs, processors } = buildProviders(fresh, dataDirectory, await signedInAccounts(dataDirectory));
  if (processors.some((item) => !item)) throw new Error("Each configured provider requires a default model");
  return processor.replaceFromCatalog(processors as ProviderTurnProcessor[], configs.map((item) => item.allowedModels ?? []), configs.map(isLocalProvider));
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
