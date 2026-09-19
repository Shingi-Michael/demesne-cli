import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/// Typed, dependency-free configuration for both the daemon and the CLI.
///
/// Precedence is explicit environment variables, then the project file
/// (`<workspace>/.demesne/config.toml`), then the user file
/// (`~/.demesne/config.toml`), then built-in defaults. Unknown keys are
/// rejected rather than ignored so a typo cannot silently disable a setting.

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "max";
/// A named theme, or `auto` to follow the terminal background. `dark` and
/// `light` are accepted for configurations written before named themes existed.
export type ThemePreference = string;
export type AutoStartPolicy = "prompt" | "always" | "never";
export type ConfigSource = "env" | "user" | "project";

export interface ProviderConfig {
  url?: string;
  id?: string;
  model?: string;
  allowedModels?: string[];
  apiKey?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  runtimeProfile?: string;
  reasoningEffort?: ReasoningEffort;
  includeUsage?: boolean;
  systemPrompt?: string;
  firstEventTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface DaemonConfig {
  autoStart: AutoStartPolicy;
  host?: string;
  port?: number;
}

export interface NotificationConfig {
  enabled: boolean;
  minimumDurationMs: number;
}

export interface UiConfig {
  intro: boolean;
  hyperlinks: boolean;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface DemesneConfig {
  server?: string;
  dataDir?: string;
  theme?: ThemePreference;
  inferenceSlots?: number;
  provider: ProviderConfig;
  daemon: DaemonConfig;
  permissions: { allow: string[] };
  notifications: NotificationConfig;
  ui: UiConfig;
  mcp: { servers: Record<string, McpServerConfig> };
}

export interface LoadedConfig {
  config: DemesneConfig;
  /// Absolute paths of config files that were read, or null when absent.
  files: { user: string | null; project: string | null };
  /// Dotted keys that were explicitly set, and by which layer.
  sources: Record<string, ConfigSource>;
}

export class ConfigError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "ConfigError";
  }
}

export interface LoadConfigOptions {
  workspaceRoot?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  /// Override the user config path. Pass null to skip the user file.
  userConfigPath?: string | null;
  /// Override the project config path. Pass null to skip the project file.
  projectConfigPath?: string | null;
  /// Set false to ignore project configuration entirely (the daemon does this:
  /// its provider settings are machine-wide, not workspace-specific).
  includeProject?: boolean;
}

export const USER_CONFIG_RELATIVE_PATH = join(".demesne", "config.toml");
export const PROJECT_CONFIG_RELATIVE_PATH = join(".demesne", "config.toml");

export function userConfigPath(home: string = homedir()): string {
  return join(home, USER_CONFIG_RELATIVE_PATH);
}

export function projectConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, PROJECT_CONFIG_RELATIVE_PATH);
}

export function defaultConfig(): DemesneConfig {
  return {
    provider: {},
    daemon: { autoStart: "prompt" },
    permissions: { allow: [] },
    notifications: { enabled: true, minimumDurationMs: 30_000 },
    ui: { intro: true, hyperlinks: true },
    mcp: { servers: {} },
  };
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const includeProject = options.includeProject ?? true;
  const config = defaultConfig();
  const sources: Record<string, ConfigSource> = {};
  const files: LoadedConfig["files"] = { user: null, project: null };

  const userPath = options.userConfigPath === undefined
    ? env.DEMESNE_CONFIG_FILE || userConfigPath(options.home)
    : options.userConfigPath;
  if (userPath && existsSync(userPath)) {
    applyFile(config, userPath, "user", sources);
    files.user = userPath;
  }

  if (includeProject) {
    const path = options.projectConfigPath === undefined
      ? options.workspaceRoot ? projectConfigPath(options.workspaceRoot) : null
      : options.projectConfigPath;
    if (path && existsSync(path)) {
      applyFile(config, path, "project", sources);
      files.project = path;
    }
  }

  applyEnvironment(config, env, sources);
  return { config, files, sources };
}

function applyFile(
  config: DemesneConfig,
  path: string,
  source: ConfigSource,
  sources: Record<string, ConfigSource>,
): void {
  try {
    applyDocument(config, parseConfigFile(path), source, sources);
  } catch (error) {
    if (error instanceof ConfigError && error.path) throw error;
    throw new ConfigError(messageOf(error), path);
  }
}

export function parseConfigFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read config: ${messageOf(error)}`, path);
  }
  return parseConfigDocument(text, path);
}

export function parseConfigDocument(text: string, path?: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new ConfigError(`invalid TOML: ${messageOf(error)}`, path);
  }
  if (!isRecord(parsed)) throw new ConfigError("config must be a TOML table", path);
  return parsed;
}

/// Validates a parsed document without touching the filesystem. Exported so
/// `demesne doctor` can explain a bad file precisely.
export function validateConfigDocument(document: Record<string, unknown>, path?: string): void {
  const target = defaultConfig();
  const sources: Record<string, ConfigSource> = {};
  applyDocument(target, document, "user", sources);
}

function applyDocument(
  config: DemesneConfig,
  document: Record<string, unknown>,
  source: ConfigSource,
  sources: Record<string, ConfigSource>,
): void {
  const path = source === "user" ? "user config" : "project config";
  assertKnownKeys(document, [
    "server", "data_dir", "theme", "inference_slots",
    "provider", "daemon", "permissions", "notifications", "ui", "mcp",
  ], path);

  assign(config, "server", document.server, source, sources, (value, key) => {
    const text = stringValue(value, key);
    assertServerUrl(text, key);
    return text;
  });
  assign(config, "dataDir", document.data_dir, source, sources, (value, key) => optionalString(value, key));
  assign(config, "theme", document.theme, source, sources, (value, key) => optionalString(value, key));
  assign(config, "inferenceSlots", document.inference_slots, source, sources, (value, key) => optionalPositiveInteger(value, key));

  if (document.provider !== undefined) {
    const provider = objectValue(document.provider, "provider");
    assertKnownKeys(provider, [
      "url", "id", "model", "allowed_models", "api_key", "context_window",
      "max_output_tokens", "runtime_profile", "reasoning_effort",
      "include_usage", "system_prompt", "first_event_timeout_ms", "request_timeout_ms",
    ], `${path}.provider`);
    assignInto(config.provider, "url", provider.url, source, sources, "provider.url", (value, key) => {
      const text = stringValue(value, key);
      assertProviderUrl(text, key);
      return text;
    });
    assignInto(config.provider, "id", provider.id, source, sources, "provider.id", optionalString);
    assignInto(config.provider, "model", provider.model, source, sources, "provider.model", optionalString);
    assignInto(config.provider, "allowedModels", provider.allowed_models, source, sources, "provider.allowedModels", stringArray);
    assignInto(config.provider, "apiKey", provider.api_key, source, sources, "provider.apiKey", optionalString);
    assignInto(config.provider, "contextWindow", provider.context_window, source, sources, "provider.contextWindow", optionalPositiveInteger);
    assignInto(config.provider, "maxOutputTokens", provider.max_output_tokens, source, sources, "provider.maxOutputTokens", optionalPositiveInteger);
    assignInto(config.provider, "runtimeProfile", provider.runtime_profile, source, sources, "provider.runtimeProfile", optionalString);
    assignInto(config.provider, "reasoningEffort", provider.reasoning_effort, source, sources, "provider.reasoningEffort",
      (value, key) => optionalEnum(value, ["none", "low", "medium", "high", "max"], key));
    assignInto(config.provider, "includeUsage", provider.include_usage, source, sources, "provider.includeUsage", optionalBoolean);
    assignInto(config.provider, "systemPrompt", provider.system_prompt, source, sources, "provider.systemPrompt", optionalString);
    assignInto(config.provider, "firstEventTimeoutMs", provider.first_event_timeout_ms, source, sources, "provider.firstEventTimeoutMs", optionalPositiveInteger);
    assignInto(config.provider, "requestTimeoutMs", provider.request_timeout_ms, source, sources, "provider.requestTimeoutMs", optionalPositiveInteger);
  }

  if (document.daemon !== undefined) {
    const daemon = objectValue(document.daemon, "daemon");
    assertKnownKeys(daemon, ["auto_start", "host", "port"], `${path}.daemon`);
    assignInto(config.daemon, "autoStart", daemon.auto_start, source, sources, "daemon.autoStart",
      (value, key) => optionalEnum(value, ["prompt", "always", "never"], key));
    assignInto(config.daemon, "host", daemon.host, source, sources, "daemon.host", optionalString);
    assignInto(config.daemon, "port", daemon.port, source, sources, "daemon.port", (value, key) => {
      const port = optionalPositiveInteger(value, key);
      if (port !== undefined && port > 65_535) throw new ConfigError(`${key} must be between 1 and 65535`);
      return port;
    });
  }

  if (document.permissions !== undefined) {
    const permissions = objectValue(document.permissions, "permissions");
    assertKnownKeys(permissions, ["allow"], `${path}.permissions`);
    assignInto(config.permissions, "allow", permissions.allow, source, sources, "permissions.allow", stringArray);
  }

  if (document.notifications !== undefined) {
    const notifications = objectValue(document.notifications, "notifications");
    assertKnownKeys(notifications, ["enabled", "minimum_duration_ms"], `${path}.notifications`);
    assignInto(config.notifications, "enabled", notifications.enabled, source, sources, "notifications.enabled", optionalBoolean);
    assignInto(config.notifications, "minimumDurationMs", notifications.minimum_duration_ms, source, sources, "notifications.minimumDurationMs", optionalPositiveInteger);
  }

  if (document.ui !== undefined) {
    const ui = objectValue(document.ui, "ui");
    assertKnownKeys(ui, ["intro", "hyperlinks"], `${path}.ui`);
    assignInto(config.ui, "intro", ui.intro, source, sources, "ui.intro", optionalBoolean);
    assignInto(config.ui, "hyperlinks", ui.hyperlinks, source, sources, "ui.hyperlinks", optionalBoolean);
  }

  if (document.mcp !== undefined) {
    const mcp = objectValue(document.mcp, "mcp");
    assertKnownKeys(mcp, ["servers"], `${path}.mcp`);
    if (mcp.servers !== undefined) {
      const servers = objectValue(mcp.servers, "mcp.servers");
      const parsed: Record<string, McpServerConfig> = {};
      for (const [name, value] of Object.entries(servers)) {
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
          throw new ConfigError(`mcp.servers.${name} must start with a letter or digit and contain only letters, digits, and dashes`);
        }
        const server = objectValue(value, `mcp.servers.${name}`);
        assertKnownKeys(server, ["command", "args", "env", "timeout_ms"], `mcp.servers.${name}`);
        const command = stringValue(server.command, `mcp.servers.${name}.command`);
        const args = server.args === undefined ? undefined : stringArray(server.args, `mcp.servers.${name}.args`);
        const env = server.env === undefined ? undefined : stringRecord(server.env, `mcp.servers.${name}.env`);
        const timeoutMs = server.timeout_ms === undefined
          ? undefined
          : optionalPositiveInteger(server.timeout_ms, `mcp.servers.${name}.timeout_ms`);
        parsed[name] = {
          command,
          ...(args ? { args } : {}),
          ...(env ? { env } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        };
      }
      config.mcp.servers = parsed;
      sources["mcp.servers"] = source;
    }
  }
}

/// Canonical environment variable for each configurable key. Exported so
/// `demesne doctor` and documentation can enumerate the supported overrides.
export const ENV_VARIABLE_NAMES: Record<string, string> = {
  server: "DEMESNE_SERVER",
  dataDir: "DEMESNE_DATA_DIR",
  theme: "DEMESNE_THEME",
  inferenceSlots: "DEMESNE_INFERENCE_SLOTS",
  "provider.url": "DEMESNE_PROVIDER_URL",
  "provider.id": "DEMESNE_PROVIDER_ID",
  "provider.model": "DEMESNE_MODEL",
  "provider.allowedModels": "DEMESNE_ALLOWED_MODELS",
  "provider.apiKey": "DEMESNE_API_KEY",
  "provider.contextWindow": "DEMESNE_CONTEXT_WINDOW",
  "provider.maxOutputTokens": "DEMESNE_MAX_OUTPUT_TOKENS",
  "provider.runtimeProfile": "DEMESNE_RUNTIME_PROFILE",
  "provider.reasoningEffort": "DEMESNE_REASONING_EFFORT",
  "provider.includeUsage": "DEMESNE_INCLUDE_USAGE",
  "provider.systemPrompt": "DEMESNE_SYSTEM_PROMPT",
  "provider.firstEventTimeoutMs": "DEMESNE_PROVIDER_FIRST_EVENT_TIMEOUT_MS",
  "provider.requestTimeoutMs": "DEMESNE_PROVIDER_REQUEST_TIMEOUT_MS",
  "daemon.host": "DEMESNE_HOST",
  "daemon.port": "DEMESNE_PORT",
};

function applyEnvironment(
  config: DemesneConfig,
  env: Record<string, string | undefined>,
  sources: Record<string, ConfigSource>,
): void {
  setFromEnv(config, "server", env.DEMESNE_SERVER, "server", sources, (value, key) => {
    assertServerUrl(value, key);
    return value;
  });
  setFromEnv(config, "dataDir", env.DEMESNE_DATA_DIR, "dataDir", sources, optionalString);
  setFromEnv(config, "theme", env.DEMESNE_THEME, "theme", sources, optionalString);
  setFromEnv(config, "inferenceSlots", env.DEMESNE_INFERENCE_SLOTS, "inferenceSlots", sources, optionalPositiveInteger);

  setFromEnv(config.provider, "url", env.DEMESNE_PROVIDER_URL, "provider.url", sources, (value, key) => {
    assertProviderUrl(value, key);
    return value;
  });
  setFromEnv(config.provider, "id", env.DEMESNE_PROVIDER_ID, "provider.id", sources, optionalString);
  setFromEnv(config.provider, "model", env.DEMESNE_MODEL, "provider.model", sources, optionalString);
  setFromEnv(config.provider, "allowedModels", env.DEMESNE_ALLOWED_MODELS, "provider.allowedModels", sources, stringArray);
  setFromEnv(config.provider, "apiKey", env.DEMESNE_API_KEY, "provider.apiKey", sources, optionalString);
  setFromEnv(config.provider, "contextWindow", env.DEMESNE_CONTEXT_WINDOW, "provider.contextWindow", sources, optionalPositiveInteger);
  setFromEnv(config.provider, "maxOutputTokens", env.DEMESNE_MAX_OUTPUT_TOKENS, "provider.maxOutputTokens", sources, optionalPositiveInteger);
  setFromEnv(config.provider, "runtimeProfile", env.DEMESNE_RUNTIME_PROFILE, "provider.runtimeProfile", sources, optionalString);
  setFromEnv(config.provider, "reasoningEffort", env.DEMESNE_REASONING_EFFORT, "provider.reasoningEffort", sources,
    (value, key) => optionalEnum(value, ["none", "low", "medium", "high", "max"], key));
  setFromEnv(config.provider, "includeUsage", env.DEMESNE_INCLUDE_USAGE, "provider.includeUsage", sources, optionalBoolean);
  setFromEnv(config.provider, "systemPrompt", env.DEMESNE_SYSTEM_PROMPT, "provider.systemPrompt", sources, optionalString);
  setFromEnv(config.provider, "firstEventTimeoutMs", env.DEMESNE_PROVIDER_FIRST_EVENT_TIMEOUT_MS, "provider.firstEventTimeoutMs", sources, optionalPositiveInteger);
  setFromEnv(config.provider, "requestTimeoutMs", env.DEMESNE_PROVIDER_REQUEST_TIMEOUT_MS, "provider.requestTimeoutMs", sources, optionalPositiveInteger);

  setFromEnv(config.daemon, "host", env.DEMESNE_HOST, "daemon.host", sources, optionalString);
  setFromEnv(config.daemon, "port", env.DEMESNE_PORT, "daemon.port", sources, (value, key) => {
    const port = optionalPositiveInteger(value, key);
    if (port !== undefined && port > 65_535) throw new ConfigError(`${key} must be between 1 and 65535`);
    return port;
  });

  if (env.DEMESNE_NO_INTRO === "1" || env.DEMESNE_NO_INTRO === "true") {
    config.ui.intro = false;
    sources["ui.intro"] = "env";
  }
  if (env.DEMESNE_NO_HYPERLINKS === "1" || env.DEMESNE_NO_HYPERLINKS === "true") {
    config.ui.hyperlinks = false;
    sources["ui.hyperlinks"] = "env";
  }
}

/// Renders a user config file. Only explicitly provided values are written so
/// `demesne setup` never freezes today's defaults into a file.
export function renderUserConfig(settings: {
  server?: string;
  dataDir?: string;
  theme?: ThemePreference;
  inferenceSlots?: number;
  provider?: ProviderConfig;
  daemon?: { autoStart?: AutoStartPolicy; host?: string; port?: number };
  permissions?: { allow?: string[] };
  notifications?: Partial<NotificationConfig>;
  ui?: Partial<UiConfig>;
}): string {
  const lines: string[] = [
    "# Demesne user configuration.",
    "# Generated by `demesne setup`; edit by hand or rerun setup.",
    "",
  ];
  if (settings.server) lines.push(`server = ${tomlString(settings.server)}`);
  if (settings.dataDir) lines.push(`data_dir = ${tomlString(settings.dataDir)}`);
  if (settings.theme) lines.push(`theme = ${tomlString(settings.theme)}`);
  if (settings.inferenceSlots !== undefined) lines.push(`inference_slots = ${settings.inferenceSlots}`);
  if (settings.server || settings.dataDir || settings.theme || settings.inferenceSlots !== undefined) lines.push("");

  const provider = settings.provider ?? {};
  const providerEntries: Array<[string, string]> = [];
  if (provider.url) providerEntries.push(["url", tomlString(provider.url)]);
  if (provider.id) providerEntries.push(["id", tomlString(provider.id)]);
  if (provider.model) providerEntries.push(["model", tomlString(provider.model)]);
  if (provider.allowedModels?.length) {
    providerEntries.push(["allowed_models", `[${provider.allowedModels.map(tomlString).join(", ")}]`]);
  }
  if (provider.apiKey) providerEntries.push(["api_key", tomlString(provider.apiKey)]);
  if (provider.contextWindow) providerEntries.push(["context_window", String(provider.contextWindow)]);
  if (provider.maxOutputTokens) providerEntries.push(["max_output_tokens", String(provider.maxOutputTokens)]);
  if (provider.runtimeProfile) providerEntries.push(["runtime_profile", tomlString(provider.runtimeProfile)]);
  if (provider.reasoningEffort) providerEntries.push(["reasoning_effort", tomlString(provider.reasoningEffort)]);
  if (provider.includeUsage !== undefined) providerEntries.push(["include_usage", String(provider.includeUsage)]);
  if (provider.systemPrompt) providerEntries.push(["system_prompt", tomlString(provider.systemPrompt)]);
  if (provider.firstEventTimeoutMs) providerEntries.push(["first_event_timeout_ms", String(provider.firstEventTimeoutMs)]);
  if (provider.requestTimeoutMs) providerEntries.push(["request_timeout_ms", String(provider.requestTimeoutMs)]);
  if (providerEntries.length > 0) {
    lines.push("[provider]");
    for (const [key, value] of providerEntries) lines.push(`${key} = ${value}`);
    lines.push("");
  }

  const daemonEntries: Array<[string, string]> = [];
  if (settings.daemon?.autoStart && settings.daemon.autoStart !== "prompt") {
    daemonEntries.push(["auto_start", tomlString(settings.daemon.autoStart)]);
  }
  if (settings.daemon?.host) daemonEntries.push(["host", tomlString(settings.daemon.host)]);
  if (settings.daemon?.port !== undefined) daemonEntries.push(["port", String(settings.daemon.port)]);
  if (daemonEntries.length > 0) {
    lines.push("[daemon]");
    for (const [key, value] of daemonEntries) lines.push(`${key} = ${value}`);
    lines.push("");
  }

  if (settings.permissions?.allow?.length) {
    lines.push("[permissions]", `allow = [${settings.permissions.allow.map(tomlString).join(", ")}]`, "");
  }

  if (settings.notifications?.enabled !== undefined || settings.notifications?.minimumDurationMs !== undefined) {
    lines.push("[notifications]");
    if (settings.notifications.enabled !== undefined) lines.push(`enabled = ${settings.notifications.enabled}`);
    if (settings.notifications.minimumDurationMs !== undefined) lines.push(`minimum_duration_ms = ${settings.notifications.minimumDurationMs}`);
    lines.push("");
  }

  if (settings.ui?.intro !== undefined || settings.ui?.hyperlinks !== undefined) {
    lines.push("[ui]");
    if (settings.ui.intro !== undefined) lines.push(`intro = ${settings.ui.intro}`);
    if (settings.ui.hyperlinks !== undefined) lines.push(`hyperlinks = ${settings.ui.hyperlinks}`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/// Serializes a validated config document back to TOML. Comments are not
/// preserved: this is for programmatic updates, not for rewriting files a
/// person maintains by hand.
export function renderConfigDocument(document: Record<string, unknown>): string {
  const lines: string[] = [];
  writeTomlTable(document, [], lines);
  return `${lines.join("\n").trimEnd()}\n`;
}

/// Applies a partial update to a user config file, preserving every unrelated
/// key, validating the merged result before writing, backing up the previous
/// file, and replacing it atomically with mode 0600.
export function updateUserConfig(
  path: string,
  updates: Record<string, unknown>,
): { backup: string | null; document: Record<string, unknown> } {
  const existing = existsSync(path) ? parseConfigFile(path) : {};
  const merged = deepMerge(existing, updates);
  validateConfigDocument(merged, path);
  const rendered = renderConfigDocument(merged);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.bak`;
    copyFileSync(path, backup);
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, rendered, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
  return { backup, document: merged };
}

function writeTomlTable(record: Record<string, unknown>, path: string[], lines: string[], depth = 0): void {
  const scalars = Object.entries(record).filter(([, value]) => !isRecord(value));
  const tables = Object.entries(record).filter(([, value]) => isRecord(value));
  for (const [key, value] of scalars) {
    lines.push(`${key} = ${tomlValue(value, [...path, key])}`);
  }
  for (const [key, value] of tables) {
    if (lines.length > 0) lines.push("");
    const tablePath = [...path, key];
    lines.push(`[${tablePath.join(".")}]`);
    writeTomlTable(value as Record<string, unknown>, tablePath, lines, depth + 1);
  }
}

function tomlValue(value: unknown, path: string[]): string {
  const key = path.join(".");
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    if (!value.every((entry) => ["string", "number", "boolean"].includes(typeof entry))) {
      throw new ConfigError(`${key} must be an array of scalars`);
    }
    return `[${value.map((entry) => tomlValue(entry, path)).join(", ")}]`;
  }
  throw new ConfigError(`${key} has an unsupported TOML value`);
}

function deepMerge(base: Record<string, unknown>, updates: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] = isRecord(value) && isRecord(current) ? deepMerge(current, value) : value;
  }
  return merged;
}

export function assertServerUrl(value: string, key = "server"): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${key} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${key} must use HTTP or HTTPS`);
  }
  if (url.username || url.password) throw new ConfigError(`${key} must not contain credentials`);
}

export function assertProviderUrl(value: string, key = "provider.url"): void {
  assertServerUrl(value, key);
  const url = new URL(value);
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new ConfigError(`${key} must use HTTPS unless it targets a loopback address`);
  }
}

function assign<K extends keyof DemesneConfig>(
  config: DemesneConfig,
  key: K,
  raw: unknown,
  source: ConfigSource,
  sources: Record<string, ConfigSource>,
  transform: (value: unknown, key: string) => DemesneConfig[K] | undefined,
): void {
  if (raw === undefined) return;
  const value = transform(raw, String(key));
  if (value === undefined) return;
  config[key] = value;
  sources[String(key)] = source;
}

function assignInto<T extends object, K extends keyof T>(
  target: T,
  key: K,
  raw: unknown,
  source: ConfigSource,
  sources: Record<string, ConfigSource>,
  dottedKey: string,
  transform: (value: unknown, key: string) => T[K] | undefined,
): void {
  if (raw === undefined) return;
  const value = transform(raw, dottedKey);
  if (value === undefined) return;
  target[key] = value;
  sources[dottedKey] = source;
}

function setFromEnv(
  target: object,
  key: string,
  raw: string | undefined,
  dottedKey: string,
  sources: Record<string, ConfigSource>,
  transform: (value: string, key: string) => unknown,
): void {
  if (raw === undefined || raw === "") return;
  const value = transform(raw, ENV_VARIABLE_NAMES[dottedKey] ?? `DEMESNE_${dottedKey}`);
  if (value === undefined) return;
  (target as Record<string, unknown>)[key] = value;
  sources[dottedKey] = "env";
}

function optionalString(value: unknown, key: string): string | undefined {
  if (typeof value !== "string") throw new ConfigError(`${key} must be a string`);
  if (!value.trim()) throw new ConfigError(`${key} must not be empty`);
  return value;
}

function stringValue(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ConfigError(`${key} must be a non-empty string`);
  return value;
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigError(`${key} must be a boolean`);
}

function optionalPositiveInteger(value: unknown, key: string): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ConfigError(`${key} must be a positive integer`);
  return parsed;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], key: string): T | undefined {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function stringArray(value: unknown, key: string): string[] | undefined {
  const entries = typeof value === "string" ? value.split(",").map((entry) => entry.trim()) : value;
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new ConfigError(`${key} must be a list of non-empty strings`);
  }
  if (new Set(entries).size !== entries.length) throw new ConfigError(`${key} must not contain duplicates`);
  return entries as string[];
}

function stringRecord(value: unknown, key: string): Record<string, string> | undefined {
  if (!isRecord(value)) throw new ConfigError(`${key} must be a table of strings`);
  const record: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") throw new ConfigError(`${key}.${entryKey} must be a string`);
    record[entryKey] = entryValue;
  }
  return record;
}

function objectValue(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ConfigError(`${key} must be a table`);
  return value;
}

function assertKnownKeys(record: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`unknown key "${key}" (expected one of ${allowed.join(", ")})`, path);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
