import type {
  ObservedRuntimeSettings,
  RuntimeProfileSettings,
  RuntimeProfileStatus,
} from "@demesne/protocol";

const RESPONSE_LIMIT = 1024 * 1024;

export interface RuntimeProfileVerifier {
  status(): RuntimeProfileStatus;
  reset(): void;
  capture(): OllamaRunnerProcess[] | null;
  verify(model: string, baseline: OllamaRunnerProcess[] | null, signal?: AbortSignal): Promise<void>;
}

export interface OllamaRunnerProcess {
  pid: number;
  commandLine: string;
}

interface RuntimeDependencies {
  fetch?: typeof fetch;
  runnerProcesses?: () => OllamaRunnerProcess[] | null;
  serviceProcessIds?: (port: number) => number[] | null;
  parentProcessId?: (pid: number) => number | null;
  now?: () => Date;
}

const BALANCED_32GB: RuntimeProfileSettings = {
  contextWindow: 8192,
  batchSize: 512,
  microBatchSize: 512,
  parallelSequences: 1,
  keyCacheType: "q8_0",
  valueCacheType: "q8_0",
  flashAttention: "on",
  loadedModels: 1,
};

const EXPERIMENTAL_Q4_KV_32GB: RuntimeProfileSettings = {
  ...BALANCED_32GB,
  keyCacheType: "q4_0",
  valueCacheType: "q4_0",
};

const EXPERIMENTAL_Q4_KV_B256_32GB: RuntimeProfileSettings = {
  ...EXPERIMENTAL_Q4_KV_32GB,
  batchSize: 256,
  microBatchSize: 256,
};

// Measured llama.cpp reference profile for the audited 32 GB M1 Max. f16 K/V is
// required, not incidental: on llama.cpp build b10621 Metal, q8_0 K/V decoded
// 7.58 tok/s against 14.25 tok/s for f16 at an identical 14,734-token context,
// a 47% regression. See "Measured llama.cpp 32K KV Precision and Batch Study".
const LLAMA_F16_KV_32K_B256_32GB: RuntimeProfileSettings = {
  contextWindow: 32_768,
  batchSize: 256,
  microBatchSize: 256,
  parallelSequences: 1,
  keyCacheType: "f16",
  valueCacheType: "f16",
  flashAttention: "on",
  loadedModels: 1,
};

// Batch 512 measured neutral on prefill (105.25 vs 105.71 tok/s) and decode
// (14.00 vs 14.25 tok/s) at 14,734 tokens. Retained only for controlled
// comparison; it is not a throughput improvement.
const LLAMA_F16_KV_32K_B512_32GB: RuntimeProfileSettings = {
  ...LLAMA_F16_KV_32K_B256_32GB,
  batchSize: 512,
  microBatchSize: 512,
};

const LLAMA_F16_KV_64K_B256_32GB: RuntimeProfileSettings = {
  ...LLAMA_F16_KV_32K_B256_32GB,
  contextWindow: 65_536,
  visionEnabled: false,
};

const LLAMA_F16_KV_100K_B256_32GB: RuntimeProfileSettings = {
  ...LLAMA_F16_KV_32K_B256_32GB,
  contextWindow: 100_096,
  visionEnabled: false,
  loadMode: "mmap",
};

interface RuntimeProfileDefinition {
  settings: RuntimeProfileSettings;
  providerId: string;
  providerLabel: string;
  runtime: "ollama" | "llama.cpp";
  speculationType?: string;
}

const RUNTIME_PROFILES: Record<string, RuntimeProfileDefinition> = {
  "balanced-32gb": ollamaProfile(BALANCED_32GB),
  "experimental-q4-kv-32gb": ollamaProfile(EXPERIMENTAL_Q4_KV_32GB),
  "experimental-q4-kv-b256-32gb": ollamaProfile(EXPERIMENTAL_Q4_KV_B256_32GB),
  "llama-f16-kv-32k-b256-32gb": llamaProfile(LLAMA_F16_KV_32K_B256_32GB),
  "llama-ngram-mod-f16-kv-32k-b256-32gb": llamaProfile(LLAMA_F16_KV_32K_B256_32GB, "ngram-mod"),
  "llama-ngram-mod-f16-kv-64k-b256-32gb": llamaProfile(LLAMA_F16_KV_64K_B256_32GB, "ngram-mod"),
  "experimental-llama-ngram-mod-f16-kv-64k-b256-32gb": llamaProfile(LLAMA_F16_KV_64K_B256_32GB, "ngram-mod"),
  "experimental-llama-ngram-mod-f16-kv-100k-b256-32gb": llamaProfile(LLAMA_F16_KV_100K_B256_32GB, "ngram-mod"),
  "llama-ngram-mod-f16-kv-100k-b256-32gb": llamaProfile(LLAMA_F16_KV_100K_B256_32GB, "ngram-mod"),
  "experimental-llama-vision-ngram-mod-f16-kv-100k-b256-32gb": llamaProfile({ ...LLAMA_F16_KV_100K_B256_32GB, visionEnabled: true }, "ngram-mod"),
  "experimental-llama-f16-kv-32k-b512-32gb": llamaProfile(LLAMA_F16_KV_32K_B512_32GB),
  "experimental-llama-ngram-simple-32gb": llamaProfile(LLAMA_F16_KV_32K_B256_32GB, "ngram-simple"),
  "experimental-llama-ngram-map-k-32gb": llamaProfile(LLAMA_F16_KV_32K_B256_32GB, "ngram-map-k"),
  "experimental-llama-ngram-map-k4v-32gb": llamaProfile(LLAMA_F16_KV_32K_B256_32GB, "ngram-map-k4v"),
  "experimental-llama-ngram-mod-32gb": llamaProfile(LLAMA_F16_KV_32K_B256_32GB, "ngram-mod"),
};

function ollamaProfile(settings: RuntimeProfileSettings): RuntimeProfileDefinition {
  return { settings, providerId: "ollama", providerLabel: "Ollama", runtime: "ollama" };
}

function llamaProfile(settings: RuntimeProfileSettings, speculationType = "none"): RuntimeProfileDefinition {
  return {
    settings: { ...settings, speculationType },
    providerId: "llama.cpp",
    providerLabel: "llama.cpp",
    runtime: "llama.cpp",
    speculationType,
  };
}

export function runtimeProfileRequiresSingleInferenceSlot(profile: string | null | undefined): boolean {
  return typeof profile === "string" && RUNTIME_PROFILES[profile] !== undefined;
}

export function runtimeProfileContextWindow(profile: string | null | undefined): number | undefined {
  if (typeof profile !== "string") return undefined;
  return RUNTIME_PROFILES[profile]?.settings.contextWindow;
}

export function runtimeProfileSupportsPromptCache(profile: string | null | undefined): boolean {
  if (typeof profile !== "string") return false;
  return RUNTIME_PROFILES[profile]?.runtime === "llama.cpp";
}

/**
 * Conservative measured floor for cold prefill throughput, in tokens per second,
 * on the audited 32 GB M1 Max. Measured prefill was 105.41 tok/s at 491 prompt
 * tokens, 110.81 at 4,051, 110.60 at 8,174, 105.72 at 16,556, and 97.11 at
 * 31,149. The floor is set below the slowest observation rather than at the
 * median so the derived deadline does not abort a legitimate near-capacity
 * request on a slightly slower run.
 */
const MEASURED_PREFILL_FLOOR_TOKENS_PER_SECOND = 85;

/**
 * Safety factor applied to the derived cold-prefill budget. The deadline still
 * bounds a silent or endless provider; it is sized to the capacity the profile
 * actually verifies instead of to a default chosen for 8K contexts.
 */
const FIRST_EVENT_TIMEOUT_MARGIN = 1.3;

/**
 * Minimum first-event deadline required for a profile to be able to complete a
 * cold prefill at its own verified context capacity.
 *
 * This exists because the 180,000 ms default silently made large contexts
 * unusable. A cold 31,149-token request on the 32K llama.cpp profile emitted its
 * first provider event at 320.8 seconds, so the daemon aborted it with "Provider
 * did not emit an event before the timeout" long before the model produced
 * anything. llama.cpp does send keep-alive bytes roughly every 30 seconds during
 * prefill, but those bytes do not decode into provider events and therefore do
 * not satisfy the deadline.
 */
export function runtimeProfileMinimumFirstEventTimeoutMs(profile: string | null | undefined): number | undefined {
  const contextWindow = runtimeProfileContextWindow(profile);
  if (contextWindow === undefined) return undefined;
  const coldPrefillSeconds = contextWindow / MEASURED_PREFILL_FLOOR_TOKENS_PER_SECOND;
  return Math.ceil((coldPrefillSeconds * FIRST_EVENT_TIMEOUT_MARGIN * 1_000) / 1_000) * 1_000;
}

export function runtimeProfileDefaultMaxOutputTokens(profile: string | null | undefined): number | undefined {
  return runtimeProfileRequiresSingleInferenceSlot(profile) ? 1_536 : undefined;
}

export function createRuntimeProfileVerifier(options: {
  profile: string | undefined;
  providerId: string;
  baseUrl: string;
  apiKey?: string;
  dependencies?: RuntimeDependencies;
}): RuntimeProfileVerifier | undefined {
  const profile = options.profile?.trim();
  if (!profile) return undefined;
  const definition = RUNTIME_PROFILES[profile];
  if (!definition) throw new Error(`Unknown DEMESNE_RUNTIME_PROFILE: ${profile}`);
  if (options.providerId !== definition.providerId) {
    throw new Error(`DEMESNE_RUNTIME_PROFILE=${profile} requires DEMESNE_PROVIDER_ID=${definition.providerId}`);
  }
  const baseUrl = new URL(options.baseUrl);
  if (!isLoopbackHost(baseUrl.hostname)) {
    throw new Error(`DEMESNE_RUNTIME_PROFILE=${profile} requires a local ${definition.providerLabel} endpoint`);
  }
  return definition.runtime === "llama.cpp"
    ? new LlamaServerRuntimeVerifier(
      profile,
      definition.settings,
      baseUrl,
      options.apiKey,
      options.dependencies,
    )
    : new OllamaRuntimeVerifier(profile, definition.settings, baseUrl, options.apiKey, options.dependencies);
}

export function parseOllamaRunnerCommand(commandLine: string): Omit<ObservedRuntimeSettings, "model" | "loadedModels" | "runnerProcesses"> {
  return {
    contextWindow: integerFlag(commandLine, "-c"),
    batchSize: integerFlag(commandLine, "-b"),
    microBatchSize: integerFlag(commandLine, "-ub"),
    parallelSequences: integerFlag(commandLine, "-np"),
    keyCacheType: settingFlag(commandLine, "--cache-type-k"),
    valueCacheType: settingFlag(commandLine, "--cache-type-v"),
    flashAttention: settingFlag(commandLine, "--flash-attn"),
  };
}

export function readOllamaRunnerProcesses(): OllamaRunnerProcess[] | null {
  try {
    const result = Bun.spawnSync({ cmd: ["pgrep", "-fl", "llama-server"], stdout: "pipe", stderr: "ignore" });
    if (!result.success) return [];
    return result.stdout.toString().split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match && isLlamaServerCommand(match[2]!)
        ? [{ pid: Number(match[1]), commandLine: match[2]! }]
        : [];
    });
  } catch {
    return null;
  }
}

/**
 * Parses a directly launched `llama-server` command line. llama.cpp accepts both
 * short and long forms, and the short forms (`-ctk`, `-fa`, `-c`) differ from the
 * long forms Ollama uses for its spawned runner (`--cache-type-k`, `--flash-attn`).
 * Both are accepted so a profile cannot be defeated by equivalent spelling.
 */
export function parseLlamaServerCommand(commandLine: string): Omit<ObservedRuntimeSettings, "model" | "loadedModels" | "runnerProcesses"> {
  return {
    contextWindow: integerFlagAny(commandLine, ["-c", "--ctx-size"]),
    batchSize: integerFlagAny(commandLine, ["-b", "--batch-size"]),
    microBatchSize: integerFlagAny(commandLine, ["-ub", "--ubatch-size"]),
    parallelSequences: integerFlagAny(commandLine, ["-np", "--parallel"]),
    keyCacheType: settingFlagAny(commandLine, ["-ctk", "--cache-type-k"]),
    valueCacheType: settingFlagAny(commandLine, ["-ctv", "--cache-type-v"]),
    flashAttention: settingFlagAny(commandLine, ["-fa", "--flash-attn"]),
  };
}

export function parseLlamaServerSpeculationType(commandLine: string): string {
  return settingFlag(commandLine, "--spec-type") ?? "none";
}

export function parseLlamaServerLoadMode(commandLine: string): string | null {
  return settingFlagAny(commandLine, ["-lm", "--load-mode"]);
}

export function llamaServerHasVisionProjector(commandLine: string): boolean {
  return stringFlag(commandLine, "-mm") !== null || stringFlag(commandLine, "--mmproj") !== null;
}

export function readLlamaServerProcesses(): OllamaRunnerProcess[] | null {
  try {
    const result = Bun.spawnSync({ cmd: ["pgrep", "-fl", "llama-server"], stdout: "pipe", stderr: "ignore" });
    if (!result.success) return [];
    return result.stdout.toString().split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match && isDirectLlamaServerCommand(match[2]!)
        ? [{ pid: Number(match[1]), commandLine: match[2]! }]
        : [];
    });
  } catch {
    return null;
  }
}

function readListeningProcessIds(port: number): number[] | null {
  try {
    const result = Bun.spawnSync({
      cmd: ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!result.success) return [];
    return [...new Set(result.stdout.toString().split("\n").flatMap((line) => {
      const pid = Number(line.trim());
      return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
    }))];
  } catch {
    return null;
  }
}

function readParentProcessId(pid: number): number | null {
  try {
    const result = Bun.spawnSync({ cmd: ["ps", "-o", "ppid=", "-p", String(pid)], stdout: "pipe", stderr: "ignore" });
    if (!result.success) return null;
    const parent = Number(result.stdout.toString().trim());
    return Number.isSafeInteger(parent) && parent > 0 ? parent : null;
  } catch {
    return null;
  }
}

class OllamaRuntimeVerifier implements RuntimeProfileVerifier {
  private currentStatus: RuntimeProfileStatus;
  private readonly fetchImplementation: typeof fetch;
  private readonly runnerProcesses: () => OllamaRunnerProcess[] | null;
  private readonly serviceProcessIds: (port: number) => number[] | null;
  private readonly parentProcessId: (pid: number) => number | null;
  private readonly now: () => Date;

  constructor(
    private readonly profile: string,
    private readonly expected: RuntimeProfileSettings,
    private readonly baseUrl: URL,
    private readonly apiKey: string | undefined,
    dependencies: RuntimeDependencies = {},
  ) {
    this.fetchImplementation = dependencies.fetch ?? fetch;
    this.runnerProcesses = dependencies.runnerProcesses ?? readOllamaRunnerProcesses;
    this.serviceProcessIds = dependencies.serviceProcessIds ?? readListeningProcessIds;
    this.parentProcessId = dependencies.parentProcessId ?? readParentProcessId;
    this.now = dependencies.now ?? (() => new Date());
    this.currentStatus = this.pendingStatus();
  }

  status(): RuntimeProfileStatus {
    return structuredClone(this.currentStatus);
  }

  reset(): void {
    this.currentStatus = this.pendingStatus();
  }

  capture(): OllamaRunnerProcess[] | null {
    const port = Number(this.baseUrl.port || (this.baseUrl.protocol === "https:" ? 443 : 80));
    const serviceProcessIds = this.serviceProcessIds(port);
    const processes = this.runnerProcesses();
    if (serviceProcessIds === null || serviceProcessIds.length !== 1 || processes === null) return null;
    const serviceProcessId = serviceProcessIds[0]!;
    return processes.filter((process) => this.parentProcessId(process.pid) === serviceProcessId);
  }

  async verify(model: string, baseline: OllamaRunnerProcess[] | null, signal?: AbortSignal): Promise<void> {
    const observedAt = this.now().toISOString();
    if (baseline === null) {
      this.failUnavailable("local llama-server processes could not be inspected", observedAt);
    }
    const processesAtFirstOutput = this.capture();
    if (processesAtFirstOutput === null) {
      this.failUnavailable("configured Ollama service and its runners could not be associated", observedAt);
    }
    let loadedModels: string[];
    try {
      loadedModels = await this.readLoadedModels(signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const reason = error instanceof Error ? error.message : "Ollama runtime metadata is unavailable";
      this.failUnavailable(reason, observedAt);
    }

    const processes = this.capture();
    if (processes === null) {
      this.failUnavailable("configured Ollama service and its runners could not be associated", observedAt);
    }

    const flags = processes.length === 1 ? parseOllamaRunnerCommand(processes[0]!.commandLine) : emptyObservedFlags();
    const selectedModel = loadedModels.find((loaded) => normalizeModelName(loaded) === normalizeModelName(model)) ?? null;
    const observed: ObservedRuntimeSettings = {
      model: selectedModel,
      ...flags,
      loadedModels: loadedModels.length,
      runnerProcesses: processes.length,
    };
    const mismatches = compareSettings(this.expected, observed, model);
    if (baseline.length > 0 && runnerSignature(baseline) !== runnerSignature(processes)) {
      mismatches.unshift("runner changed while the provider request was starting");
    }
    if (runnerSignature(processesAtFirstOutput) !== runnerSignature(processes)) {
      mismatches.unshift("runner changed while runtime metadata was inspected");
    }
    this.currentStatus = {
      profile: this.profile,
      state: mismatches.length === 0 ? "verified" : "mismatch",
      expected: this.expected,
      observed,
      mismatches,
      observedAt,
    };
    if (mismatches.length > 0) {
      throw new Error(`Runtime profile ${this.profile} mismatch: ${mismatches.join("; ")}`);
    }
  }

  private pendingStatus(): RuntimeProfileStatus {
    return {
      profile: this.profile,
      state: "pending",
      expected: this.expected,
      observed: null,
      mismatches: [],
      observedAt: null,
    };
  }

  private failUnavailable(reason: string, observedAt: string): never {
    this.currentStatus = {
      profile: this.profile,
      state: "unavailable",
      expected: this.expected,
      observed: null,
      mismatches: [reason],
      observedAt,
    };
    throw new Error(`Runtime profile ${this.profile} could not be verified: ${reason}`);
  }

  private async readLoadedModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.fetchImplementation(new URL("/api/ps", this.baseUrl), {
      headers: {
        Accept: "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      redirect: "manual",
      signal,
    });
    if (!response.ok) throw new Error(`Ollama /api/ps returned HTTP ${response.status}`);
    const text = await readLimitedText(response, RESPONSE_LIMIT);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("Ollama /api/ps returned invalid JSON");
    }
    if (!isRecord(body) || !Array.isArray(body.models)) {
      throw new Error("Ollama /api/ps returned an invalid response");
    }
    return body.models.map((entry) => {
      if (!isRecord(entry)) throw new Error("Ollama /api/ps returned an invalid model entry");
      const name = typeof entry.name === "string" ? entry.name : typeof entry.model === "string" ? entry.model : null;
      if (!name) throw new Error("Ollama /api/ps returned an invalid model entry");
      return name;
    });
  }
}

interface LlamaServerProperties {
  contextWindow: number | null;
  totalSlots: number | null;
  modelAlias: string | null;
  modelLoaded: boolean;
  sleeping: boolean;
  visionEnabled: boolean | null;
}

/**
 * Verifies a directly launched `llama-server`. Unlike the Ollama runtime there is
 * no supervising service, so the process listening on the configured port must
 * itself be the inference server. Context window and slot count are taken from
 * the server's own `/props` response rather than the command line, and the command
 * line is then required to agree; K/V precision, batch, and micro-batch are only
 * observable from the command line. A model alias is never accepted as proof of
 * configuration because identical aliases can serve different K/V precisions.
 */
class LlamaServerRuntimeVerifier implements RuntimeProfileVerifier {
  private currentStatus: RuntimeProfileStatus;
  private readonly fetchImplementation: typeof fetch;
  private readonly runnerProcesses: () => OllamaRunnerProcess[] | null;
  private readonly serviceProcessIds: (port: number) => number[] | null;
  private readonly now: () => Date;

  constructor(
    private readonly profile: string,
    private readonly expected: RuntimeProfileSettings,
    private readonly baseUrl: URL,
    private readonly apiKey: string | undefined,
    dependencies: RuntimeDependencies = {},
  ) {
    this.fetchImplementation = dependencies.fetch ?? fetch;
    this.runnerProcesses = dependencies.runnerProcesses ?? readLlamaServerProcesses;
    this.serviceProcessIds = dependencies.serviceProcessIds ?? readListeningProcessIds;
    this.now = dependencies.now ?? (() => new Date());
    this.currentStatus = this.pendingStatus();
  }

  status(): RuntimeProfileStatus {
    return structuredClone(this.currentStatus);
  }

  reset(): void {
    this.currentStatus = this.pendingStatus();
  }

  capture(): OllamaRunnerProcess[] | null {
    const port = Number(this.baseUrl.port || (this.baseUrl.protocol === "https:" ? 443 : 80));
    const serviceProcessIds = this.serviceProcessIds(port);
    const processes = this.runnerProcesses();
    if (serviceProcessIds === null || serviceProcessIds.length !== 1 || processes === null) return null;
    const serviceProcessId = serviceProcessIds[0]!;
    return processes.filter((process) => process.pid === serviceProcessId);
  }

  async verify(model: string, baseline: OllamaRunnerProcess[] | null, signal?: AbortSignal): Promise<void> {
    const observedAt = this.now().toISOString();
    if (baseline === null) {
      this.failUnavailable("local llama-server processes could not be inspected", observedAt);
    }
    const processesAtFirstOutput = this.capture();
    if (processesAtFirstOutput === null) {
      this.failUnavailable("configured llama-server endpoint and its process could not be associated", observedAt);
    }
    let properties: LlamaServerProperties;
    try {
      properties = await this.readProperties(signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const reason = error instanceof Error ? error.message : "llama-server runtime metadata is unavailable";
      this.failUnavailable(reason, observedAt);
    }

    const processes = this.capture();
    if (processes === null) {
      this.failUnavailable("configured llama-server endpoint and its process could not be associated", observedAt);
    }

    const flags = processes.length === 1 ? parseLlamaServerCommand(processes[0]!.commandLine) : emptyObservedFlags();
    const observed: ObservedRuntimeSettings = {
      model: properties.modelAlias === model ? properties.modelAlias : null,
      ...flags,
      speculationType: processes.length === 1
        ? parseLlamaServerSpeculationType(processes[0]!.commandLine)
        : "unknown",
      ...(properties.visionEnabled !== null ? { visionEnabled: properties.visionEnabled } : {}),
      loadMode: processes.length === 1 ? parseLlamaServerLoadMode(processes[0]!.commandLine) ?? undefined : undefined,
      contextWindow: properties.contextWindow,
      parallelSequences: properties.totalSlots,
      loadedModels: properties.modelLoaded ? 1 : 0,
      runnerProcesses: processes.length,
    };
    const mismatches = compareSettings(this.expected, observed, model);
    if (properties.sleeping) mismatches.push("llama-server reported a sleeping model");
    if (this.expected.visionEnabled === false && processes.length === 1
      && llamaServerHasVisionProjector(processes[0]!.commandLine)) {
      mismatches.push("vision projector expected absent, observed configured");
    }
    if (flags.contextWindow !== null && flags.contextWindow !== properties.contextWindow) {
      mismatches.push(`context window command line ${flags.contextWindow} disagrees with served ${properties.contextWindow}`);
    }
    if (flags.parallelSequences !== null && flags.parallelSequences !== properties.totalSlots) {
      mismatches.push(`parallel sequences command line ${flags.parallelSequences} disagrees with served ${properties.totalSlots}`);
    }
    if (baseline.length > 0 && runnerSignature(baseline) !== runnerSignature(processes)) {
      mismatches.unshift("llama-server changed while the provider request was starting");
    }
    if (runnerSignature(processesAtFirstOutput) !== runnerSignature(processes)) {
      mismatches.unshift("llama-server changed while runtime metadata was inspected");
    }
    this.currentStatus = {
      profile: this.profile,
      state: mismatches.length === 0 ? "verified" : "mismatch",
      expected: this.expected,
      observed,
      mismatches,
      observedAt,
    };
    if (mismatches.length > 0) {
      throw new Error(`Runtime profile ${this.profile} mismatch: ${mismatches.join("; ")}`);
    }
  }

  private pendingStatus(): RuntimeProfileStatus {
    return {
      profile: this.profile,
      state: "pending",
      expected: this.expected,
      observed: null,
      mismatches: [],
      observedAt: null,
    };
  }

  private failUnavailable(reason: string, observedAt: string): never {
    this.currentStatus = {
      profile: this.profile,
      state: "unavailable",
      expected: this.expected,
      observed: null,
      mismatches: [reason],
      observedAt,
    };
    throw new Error(`Runtime profile ${this.profile} could not be verified: ${reason}`);
  }

  private async readProperties(signal?: AbortSignal): Promise<LlamaServerProperties> {
    const response = await this.fetchImplementation(new URL("/props", this.baseUrl), {
      headers: {
        Accept: "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      redirect: "manual",
      signal,
    });
    if (!response.ok) throw new Error(`llama-server /props returned HTTP ${response.status}`);
    const text = await readLimitedText(response, RESPONSE_LIMIT);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("llama-server /props returned invalid JSON");
    }
    if (!isRecord(body)) throw new Error("llama-server /props returned an invalid response");
    const generation = isRecord(body.default_generation_settings) ? body.default_generation_settings : null;
    if (!generation) throw new Error("llama-server /props omitted default generation settings");
    return {
      contextWindow: positiveIntegerOrNull(generation.n_ctx),
      totalSlots: positiveIntegerOrNull(body.total_slots),
      modelAlias: typeof body.model_alias === "string" && body.model_alias ? body.model_alias : null,
      modelLoaded: typeof body.model_path === "string" && body.model_path.length > 0,
      sleeping: body.is_sleeping === true,
      visionEnabled: isRecord(body.modalities) && typeof body.modalities.vision === "boolean"
        ? body.modalities.vision
        : null,
    };
  }
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function compareSettings(expected: RuntimeProfileSettings, observed: ObservedRuntimeSettings, requestedModel: string): string[] {
  const mismatches: string[] = [];
  if (!observed.model) mismatches.push(`selected model ${requestedModel} is not loaded`);
  compare(mismatches, "loaded models", expected.loadedModels, observed.loadedModels);
  compare(mismatches, "runner processes", 1, observed.runnerProcesses);
  compare(mismatches, "context window", expected.contextWindow, observed.contextWindow);
  compare(mismatches, "batch size", expected.batchSize, observed.batchSize);
  compare(mismatches, "micro-batch size", expected.microBatchSize, observed.microBatchSize);
  compare(mismatches, "parallel sequences", expected.parallelSequences, observed.parallelSequences);
  compare(mismatches, "key cache type", expected.keyCacheType, observed.keyCacheType);
  compare(mismatches, "value cache type", expected.valueCacheType, observed.valueCacheType);
  compare(mismatches, "Flash Attention", expected.flashAttention, observed.flashAttention);
  if (expected.speculationType !== undefined) {
    compare(mismatches, "speculation type", expected.speculationType, observed.speculationType ?? null);
  }
  if (expected.visionEnabled !== undefined) {
    compare(mismatches, "vision modality", expected.visionEnabled ? "enabled" : "disabled", observed.visionEnabled === undefined
      ? null
      : observed.visionEnabled ? "enabled" : "disabled");
  }
  if (expected.loadMode !== undefined) {
    compare(mismatches, "load mode", expected.loadMode, observed.loadMode ?? null);
  }
  return mismatches;
}

function compare(mismatches: string[], label: string, expected: number | string, observed: number | string | null): void {
  if (observed !== expected) mismatches.push(`${label} expected ${expected}, observed ${observed ?? "unknown"}`);
}

function emptyObservedFlags(): ReturnType<typeof parseOllamaRunnerCommand> {
  return {
    contextWindow: null,
    batchSize: null,
    microBatchSize: null,
    parallelSequences: null,
    keyCacheType: null,
    valueCacheType: null,
    flashAttention: null,
  };
}

function integerFlag(commandLine: string, flag: string): number | null {
  const value = stringFlag(commandLine, flag);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function stringFlag(commandLine: string, flag: string): string | null {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...commandLine.matchAll(new RegExp(`(?:^|\\s)${escaped}\\s+(\\S+)`, "g"))];
  return matches.length === 1 ? matches[0]?.[1] ?? null : null;
}

function settingFlag(commandLine: string, flag: string): string | null {
  const value = stringFlag(commandLine, flag);
  return value && /^[a-z0-9_-]{1,32}$/.test(value) ? value : null;
}

function integerFlagAny(commandLine: string, flags: readonly string[]): number | null {
  const values = flags.flatMap((flag) => {
    const value = integerFlag(commandLine, flag);
    return value === null ? [] : [value];
  });
  return values.length === 1 ? values[0]! : null;
}

function settingFlagAny(commandLine: string, flags: readonly string[]): string | null {
  const values = flags.flatMap((flag) => {
    const value = settingFlag(commandLine, flag);
    return value === null ? [] : [value];
  });
  return values.length === 1 ? values[0]! : null;
}

function normalizeModelName(value: string): string {
  return value.includes(":") ? value : `${value}:latest`;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function isLlamaServerCommand(commandLine: string): boolean {
  const executable = commandLine.trim().split(/\s+/, 1)[0] ?? "";
  return (executable === "llama-server" || executable.endsWith("/llama-server")) && commandLine.includes(" --model ");
}

/**
 * A directly launched `llama-server` normally uses the short `-m` model flag,
 * which the Ollama-spawned runner predicate deliberately does not accept.
 */
function isDirectLlamaServerCommand(commandLine: string): boolean {
  const executable = commandLine.trim().split(/\s+/, 1)[0] ?? "";
  if (executable !== "llama-server" && !executable.endsWith("/llama-server")) return false;
  return /(?:^|\s)-m\s+\S/.test(commandLine) || commandLine.includes(" --model ");
}

function runnerSignature(processes: OllamaRunnerProcess[]): string {
  return processes
    .map((process) => `${process.pid}:${process.commandLine}`)
    .sort()
    .join("\n");
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel();
        throw new Error("Ollama /api/ps response was too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
