import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type CodexRequestId = string | number;
export type CodexNotification = { method: string; params: unknown };
export type CodexServerRequest = CodexNotification & { id: CodexRequestId };
export type CodexRequestOptions = { signal?: AbortSignal; timeoutMs?: number };
export type CodexClientOptions = {
  dataDir: string;
  binary?: string;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  /** Test transport override. Production always launches the installed Codex binary. */
  spawn?: (binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
};

export class CodexError extends Error {
  constructor(message: string, readonly code?: number) { super(safeMessage(message)); this.name = "CodexError"; }
}

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void; cleanup: () => void };

/** Managed stdio app-server connection. Protocol based on Codex 0.160.0 generated schemas. */
export class CodexClient {
  readonly home: string;
  private process?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private initialized = false;
  private disposed = false;
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<CodexRequestId, Pending>();
  private readonly incoming = new Set<CodexRequestId>();
  private readonly notifications = new Set<(notification: CodexNotification) => void>();
  private readonly serverRequests = new Set<(request: CodexServerRequest) => boolean>();
  private readonly failures = new Set<(error: Error) => void>();
  private readonly maxFrameBytes: number;

  constructor(private readonly options: CodexClientOptions) {
    this.home = join(resolve(options.dataDir), "codex");
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024;
  }

  async start(): Promise<void> {
    if (this.disposed) throw new CodexError("Codex connection is closed");
    if (this.initialized) return;
    if (!this.starting) {
      this.starting = this.launch().finally(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  async request<T = unknown>(method: string, params: unknown = {}, options: CodexRequestOptions = {}): Promise<T> {
    if (options.signal?.aborted) throw abortError();
    await waitFor(this.start(), options.signal);
    return this.sendRequest(method, params, options) as Promise<T>;
  }

  notify(method: string, params: unknown = {}): void { this.write({ method, params }); }
  respond(id: CodexRequestId, result: unknown): void { this.write({ id, result }); this.incoming.delete(id); }
  reject(id: CodexRequestId, code: number, message: string): void {
    this.write({ id, error: { code, message: safeMessage(message) } });
    this.incoming.delete(id);
  }
  onNotification(callback: (notification: CodexNotification) => void): () => void {
    this.notifications.add(callback);
    return () => { this.notifications.delete(callback); };
  }
  /** Return true when claimed, including when the response will arrive after a tool executes. */
  onServerRequest(callback: (request: CodexServerRequest) => boolean): () => void {
    this.serverRequests.add(callback);
    return () => { this.serverRequests.delete(callback); };
  }
  onError(callback: (error: Error) => void): () => void {
    this.failures.add(callback);
    return () => { this.failures.delete(callback); };
  }
  onClose(callback: (error: Error) => void): () => void { return this.onError(callback); }

  async close(): Promise<void> {
    this.disposed = true;
    const child = this.process;
    this.fail(new CodexError("Codex connection closed"));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done) => {
      const kill = setTimeout(() => { child.kill("SIGKILL"); }, 1_000);
      const finish = () => { clearTimeout(kill); done(); };
      child.once("close", finish);
      child.kill("SIGTERM");
    });
  }

  private async launch(): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    if ((await lstat(this.home)).isSymbolicLink()) throw new CodexError("Demesne's Codex home must not be a symbolic link");
    await chmod(this.home, 0o700);
    await this.preflightProfile();
    const workspace = join(this.home, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    if ((await lstat(workspace)).isSymbolicLink()) throw new CodexError("Demesne's Codex workspace must not be a symbolic link");
    if (this.disposed) throw new CodexError("Codex connection is closed");
    const binary = this.options.binary ?? findCodexBinary();
    if (!binary) throw new CodexError("Codex is not installed. Install @openai/codex or set DEMESNE_CODEX_BIN to its executable.");
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.home };
    // The separate browser login must never silently use another app's ambient credentials.
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_ACCESS_TOKEN", "ACCESS_TOKEN", "CHATGPT_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_SQLITE_HOME"]) delete env[key];
    const overrides = [
      'cli_auth_credentials_store="file"', 'model_provider="openai"', 'chatgpt_base_url="https://chatgpt.com/backend-api/"', "notify=[]", "analytics.enabled=false", 'web_search="disabled"',
      "features.skip_host_skill_discovery=true", "skills.bundled.enabled=false", "skills.include_instructions=false", "project_doc_max_bytes=0", "agents.enabled=false",
      "tools.update_plan.enabled=false", "tools.experimental_request_user_input.enabled=false",
      ...["stable_environment_tools", "shell_tool", "view_image", "multi_agent", "apps", "plugins", "remote_plugin", "image_generation", "js_repl", "hooks", "memories", "code_mode", "search_tool", "tool_suggest", "skill_search", "request_permissions", "request_permissions_tool", "current_time_reminder", "sleep_tool", "goals", "workspace_dependencies", "worktrees"].map((feature) => `features.${feature}=false`),
    ];
    const args = ["app-server", "--listen", "stdio://", ...overrides.flatMap((override) => ["-c", override])];
    let child: ChildProcessWithoutNullStreams;
    try { child = (this.options.spawn ?? ((bin, argv, opts) => spawn(bin, argv, { ...opts, stdio: "pipe" })))(binary, args, { cwd: workspace, env }); }
    catch { throw new CodexError("Unable to launch Codex app-server. Check the configured Codex executable."); }
    this.process = child;
    this.buffer = Buffer.alloc(0);
    child.on("error", () => { if (this.process === child) this.fail(new CodexError("Unable to launch Codex app-server. Check the configured Codex executable.")); });
    child.stdin.on("error", () => { if (this.process === child) this.fail(new CodexError("Codex app-server connection was lost")); });
    child.stdout.on("data", (chunk: Buffer) => { if (this.process === child) this.read(chunk); });
    // Drain stderr, but never forward process logs or authentication payloads to application logs.
    child.stderr.resume();
    child.on("close", () => { if (this.process === child) this.fail(new CodexError("Codex app-server stopped unexpectedly")); });
    try {
      await this.sendRequest("initialize", {
        clientInfo: { name: "demesne", title: "Demesne", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, { timeoutMs: 10_000 });
      this.notify("initialized");
      const effective = await this.sendRequest("config/read", { includeLayers: false }, { timeoutMs: 10_000 });
      if (!isRecord(effective) || !isRecord(effective.config)) throw new CodexError("Codex did not return its effective configuration");
      const config = effective.config;
      // This provider offers Codex's own ChatGPT route. A custom API endpoint or
      // provider could otherwise receive the OAuth credential or use an ambient key.
      checkRouting(config);
      if (config.notify != null && (!Array.isArray(config.notify) || config.notify.length > 0)) throw new CodexError("Codex managed configuration enables external notification commands outside Demesne's permission system");
      if (isRecord(config.mcp_servers) && Object.values(config.mcp_servers).some((server) => !isRecord(server) || server.enabled !== false)) {
        throw new CodexError("Codex has a managed MCP server outside Demesne's tool system. Disable it for the Demesne Codex profile before connecting.");
      }
      if (isRecord(config.features) && ["shell_tool", "stable_environment_tools", "view_image", "multi_agent", "apps", "plugins", "remote_plugin", "image_generation", "js_repl", "hooks", "code_mode", "request_permissions", "request_permissions_tool"].some((key) => config.features && (config.features as Record<string, unknown>)[key] === true)) {
        throw new CodexError("Codex managed configuration enables tools outside Demesne's permission system");
      }
      if (!isRecord(config.features) || config.features.skip_host_skill_discovery !== true) throw new CodexError("Codex cannot disable external skill discovery for the Demesne profile. Update the Codex executable.");
      if (config.project_doc_max_bytes !== 0) throw new CodexError("Codex cannot disable external project instructions for the Demesne profile. Update the Codex executable.");
      this.initialized = true;
    } catch (error) {
      this.fail(error instanceof Error ? error : new CodexError("Codex initialization failed"));
      throw error;
    }
  }

  private async preflightProfile(): Promise<void> {
    // Catalog refresh begins during process startup, before initialize. Check
    // the app-owned configuration first; never open any external auth store.
    const path = join(this.home, "config.toml");
    let info;
    try { info = await lstat(path); }
    catch (error) { if (isRecord(error) && error.code === "ENOENT") return; throw new CodexError("Unable to inspect Demesne's Codex configuration"); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new CodexError("Demesne's Codex configuration must be a regular file smaller than 1 MiB");
    let config: unknown;
    try { config = Bun.TOML.parse(await readFile(path, "utf8")); }
    catch { throw new CodexError("Demesne's Codex configuration contains invalid TOML"); }
    if (!isRecord(config)) throw new CodexError("Demesne's Codex configuration must be a TOML table");
    checkRouting(config);
    if (isRecord(config.profiles)) for (const profile of Object.values(config.profiles)) if (isRecord(profile)) checkRouting(profile);
  }

  private sendRequest(method: string, params: unknown, options: CodexRequestOptions): Promise<unknown> {
    if (this.pending.size >= 256) return Promise.reject(new CodexError("Too many pending Codex requests"));
    const id = ++this.nextId;
    return new Promise((done, reject) => {
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); };
      const stop = (error: Error) => { const pending = this.pending.get(id); if (!pending) return; this.pending.delete(id); pending.cleanup(); reject(error); };
      const aborted = () => stop(abortError());
      const timer = setTimeout(() => stop(new CodexError(`Codex ${method} timed out`)), options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve: done, reject, cleanup });
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) { aborted(); return; }
      try { this.write({ id, method, params }); }
      catch (error) { stop(error instanceof Error ? error : new CodexError("Codex request failed")); }
    });
  }

  private write(message: unknown): void {
    if (!this.process || this.process.stdin.destroyed) throw new CodexError("Codex app-server is not connected");
    const frame = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(frame) > this.maxFrameBytes) throw new CodexError("Codex request exceeds the maximum frame size");
    this.process.stdin.write(frame);
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) !== -1) {
      if (newline > this.maxFrameBytes) { this.fail(new CodexError("Codex response exceeds the maximum frame size")); return; }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { this.fail(new CodexError("Codex returned invalid JSON")); return; }
      if (!value || typeof value !== "object" || Array.isArray(value)) { this.fail(new CodexError("Codex returned an invalid protocol frame")); return; }
      const frame = value as Record<string, unknown>;
      const id = typeof frame.id === "string" || typeof frame.id === "number" ? frame.id : undefined;
      if (typeof frame.method === "string") {
        const notification = { method: frame.method, params: frame.params };
        if (id !== undefined) {
          if (this.incoming.has(id) || this.incoming.size >= 256) { this.fail(new CodexError("Codex exceeded the pending server request limit")); return; }
          this.incoming.add(id);
          let handled = false;
          for (const callback of this.serverRequests) {
            try { if (callback({ ...notification, id })) { handled = true; break; } } catch { /* A failed handler cannot authorize execution. */ }
          }
          if (!handled) this.reject(id, -32601, "Demesne does not support this Codex server request");
        } else {
          for (const callback of this.notifications) { try { callback(notification); } catch { /* Isolate subscribers. */ } }
        }
      } else if (id !== undefined) {
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id); pending.cleanup();
        if (frame.error && typeof frame.error === "object") {
          const error = frame.error as Record<string, unknown>;
          pending.reject(new CodexError(safeMessage(typeof error.message === "string" ? error.message : "Codex request failed"), typeof error.code === "number" ? error.code : undefined));
        } else if (Object.hasOwn(frame, "result")) pending.resolve(frame.result);
        else pending.reject(new CodexError("Codex returned an invalid response"));
      } else { this.fail(new CodexError("Codex returned an invalid protocol frame")); return; }
    }
    if (this.buffer.length > this.maxFrameBytes) this.fail(new CodexError("Codex response exceeds the maximum frame size"));
  }

  private fail(error: Error, notify = true): void {
    const child = this.process;
    this.process = undefined;
    this.initialized = false;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    this.incoming.clear();
    if (child && child.exitCode === null) {
      const kill = setTimeout(() => { child.kill("SIGKILL"); }, 1_000);
      kill.unref();
      child.once("close", () => clearTimeout(kill));
      child.kill("SIGTERM");
    }
    if (notify) for (const callback of this.failures) { try { callback(error); } catch { /* Isolate subscribers. */ } }
  }
}

export function findCodexBinary(): string | undefined {
  if (process.env.DEMESNE_CODEX_BIN) return process.env.DEMESNE_CODEX_BIN;
  const fromPath = Bun.which("codex");
  if (fromPath) return fromPath;
  const candidates = process.platform === "darwin" ? [
    "/opt/homebrew/bin/codex", "/usr/local/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ] : ["/usr/local/bin/codex", "/usr/bin/codex"];
  return candidates.find((candidate) => existsSync(candidate));
}

function abortError(): Error { return new DOMException("Codex request cancelled", "AbortError"); }
function checkRouting(config: Record<string, unknown>): void {
  if (config.openai_base_url != null || (isRecord(config.model_providers) && Object.hasOwn(config.model_providers, "openai"))) {
    throw new CodexError("Demesne's Codex profile must use the built-in OpenAI provider without custom API routing or credentials");
  }
  if (config.chatgpt_base_url != null && !officialChatGPTBase(config.chatgpt_base_url)) throw new CodexError("Demesne's Codex profile must use the official ChatGPT backend");
}
function officialChatGPTBase(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com" && !url.port && !url.username && !url.password
      && !url.search && !url.hash && url.pathname.replace(/\/$/, "") === "/backend-api";
  } catch { return false; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
async function waitFor(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  await new Promise<void>((done, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(abortError()); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(() => { signal.removeEventListener("abort", abort); done(); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
function safeMessage(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\bsk-[\w-]+/g, "[redacted]").replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]").slice(0, 2_048);
}
