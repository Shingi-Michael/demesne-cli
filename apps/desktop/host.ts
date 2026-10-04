import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadCliSettings } from "../cli/src/cli-config.ts";
import { daemonAddress, GraphicsHost } from "../graphics/host.ts";
import { StateEncoder, type GraphicsSnapshot } from "../graphics/state-wire.ts";
import { MAX_INPUT_BYTES, parseDesktopInput, type DesktopBootstrap, type DesktopInput, type DesktopOutput, type DesktopRequest } from "./host-protocol.ts";

/** Validate before persisting the selection, even when the daemon is offline. */
export function desktopWorkspace(path: unknown): string {
  if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0") || !isAbsolute(path))
    throw new Error("Choose an absolute project directory");
  const workspace = realpathSync(path), stat = statSync(workspace);
  if (!stat.isDirectory()) throw new Error("The project must be a directory");
  if (workspace === sep || workspace === homedir()) throw new Error("Choose a project directory rather than your home or filesystem root");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("The project directory must be owned by your user");
  if (stat.mode & 0o022) {
    const quoted = "'" + workspace.replaceAll("'", "'\\''") + "'";
    throw new Error(`The project directory is writable by group or other users: ${workspace} (mode ${(stat.mode & 0o777).toString(8)}). For a private project you own, run chmod go-w ${quoted}. Shared projects need an owner-private checkout.`);
  }
  return workspace;
}

interface DesktopPreferences { lastWorkspace: string | null; recentProjects: string[]; lastSessions: Record<string, string> }
const sessionKey = (server: string, workspace: string) => createHash("sha256").update(`${daemonAddress(server)}\n${workspace}`).digest("hex");
function readPreferences(path: string): DesktopPreferences {
  try {
    // A malicious or accidentally huge preferences file cannot exhaust startup memory.
    if (statSync(path).size > 64 * 1024) return { lastWorkspace: null, recentProjects: [], lastSessions: {} };
    const value = JSON.parse(readFileSync(path, "utf8"));
    const recentProjects: string[] = [];
    for (const candidate of Array.isArray(value.recentProjects) ? value.recentProjects.slice(0, 20) : []) {
      try { const workspace = desktopWorkspace(candidate); if (!recentProjects.includes(workspace)) recentProjects.push(workspace); } catch {}
    }
    let lastWorkspace: string | null = null;
    if (value.lastWorkspace) try { lastWorkspace = desktopWorkspace(value.lastWorkspace); } catch {}
    const lastSessions: Record<string, string> = {};
    if (value.lastSessions && typeof value.lastSessions === "object" && !Array.isArray(value.lastSessions)) {
      for (const [key, id] of Object.entries(value.lastSessions).slice(-40))
        if (/^[a-f0-9]{64}$/.test(key) && typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id)) lastSessions[key] = id;
    }
    return { lastWorkspace, recentProjects, lastSessions };
  } catch { return { lastWorkspace: null, recentProjects: [], lastSessions: {} }; }
}
function writePreferences(path: string, prefs: DesktopPreferences) {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(prefs) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export interface DesktopHostOptions {
  workspace?: string;
  server?: string;
  sessionId?: string;
  send: (message: DesktopOutput) => void;
  close: () => void;
  nativeTimeoutMs?: number;
}
/** One privileged Bun host per desktop process. EOF disposes the UI controller;
 * daemon-owned turns and commands stay alive and can be recovered next launch. */
export class DesktopHost {
  host: GraphicsHost | null = null;
  private encoder = new StateEncoder();
  private prefs: DesktopPreferences;
  private preferencePath: string;
  private generation = 0;
  private closed = false;
  private switching = false;
  private nativeSequence = 0;
  private pendingNative = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private pendingRequests = new Set<number>();
  private ready: Promise<void>;
  private darkAppearance = true;
  private explicitTheme = false;
  constructor(private options: DesktopHostOptions) {
    const settings = loadCliSettings({ serverOverride: options.server });
    this.preferencePath = join(settings.dataDirectory, "desktop-ui.json");
    this.prefs = readPreferences(this.preferencePath);
    const workspace = options.workspace === undefined ? this.prefs.lastWorkspace : desktopWorkspace(options.workspace);
    this.ready = workspace ? this.select(workspace).then(() => {}).catch(error => {
      this.send({ kind: "protocol-error", error: `Could not restore project: ${error instanceof Error ? error.message : String(error)}` });
    }) : Promise.resolve();
  }
  private send(message: DesktopOutput) { if (!this.closed) this.options.send(message); }
  bootstrap(): DesktopBootstrap {
    return { workspace: this.host?.workspace ?? null, recentProjects: [...this.prefs.recentProjects], snapshot: this.host?.snapshot() ?? null };
  }
  private async select(path: unknown): Promise<DesktopBootstrap> {
    const workspace = desktopWorkspace(path);
    if (this.host?.workspace === workspace) return this.bootstrap();
    if (this.switching) throw new Error("A project is already opening");
    if (this.host?.hasUnsentDrafts) throw new Error("Send or clear your unsent drafts before changing projects");
    if (this.host?.busy) throw new Error("Wait for the current session action to finish before changing projects");
    if (this.host?.drive?.agent.active) throw new Error("Pause Drive before changing projects");
    this.switching = true;
    const generation = this.generation + 1, encoder = new StateEncoder();
    let candidate: GraphicsHost | null = null;
    try {
      const settings = loadCliSettings({ workspaceRoot: workspace, serverOverride: this.options.server });
      const savedSession = this.prefs.lastSessions[sessionKey(settings.server, workspace)];
      const selectedSession = this.options.sessionId ?? savedSession;
      candidate = new GraphicsHost({
        workspace, server: this.options.server, sessionId: selectedSession, settings,
        changed: state => { if (this.generation === generation && !this.closed) {
          this.rememberSession(state);
          this.send({ kind: "update", update: encoder.encode(state) });
        } },
        command: command => { if (this.generation === generation && !this.closed) this.send({ kind: "command", command }); },
        copy: text => this.native("copy", { text }),
        open: path => this.native("open", { path }),
      });
      // Keep the previous host until the replacement is ready. An offline
      // daemon still yields a valid project with the existing Start daemon UI.
      await candidate.connect();
      if (savedSession && !this.options.sessionId && (!candidate.current || !candidate.sessions.some(session => session.id === savedSession) || candidate.current.session.workspace?.root !== workspace)) {
        // Deleted/archived sessions or a fresh daemon must not strand the
        // desktop in a false offline state. A real offline daemon stays offline.
        try {
          await candidate.newSession();
          candidate.connection = "online";
          candidate.error = null;
        } catch {}
      }
      if (candidate.settings.theme === "auto") candidate.theme = this.darkAppearance ? "demesne" : "demesne-light";
      if (this.closed) { candidate.dispose(); return this.bootstrap(); }
      const prefs = { ...this.prefs, lastWorkspace: workspace, recentProjects: [workspace, ...this.prefs.recentProjects.filter(item => item !== workspace)].slice(0, 10) };
      writePreferences(this.preferencePath, prefs);
      this.host?.dispose();
      this.host = candidate;
      this.explicitTheme = false;
      this.generation = generation;
      this.encoder = encoder;
      this.prefs = prefs;
      const snapshot = candidate.snapshot();
      this.rememberSession(snapshot);
      this.send({ kind: "update", update: this.encoder.encode(snapshot) });
      return this.bootstrap();
    } catch (error) { candidate?.dispose(); throw error; }
    finally { this.switching = false; }
  }
  private rememberSession(state: GraphicsSnapshot) {
    if (!this.host || state.session?.workspace?.root !== this.host.workspace) return;
    const key = sessionKey(this.host.api.server, this.host.workspace), id = state.session.id;
    if (this.prefs.lastSessions[key] === id) return;
    const lastSessions = Object.fromEntries([...Object.entries(this.prefs.lastSessions).filter(([existing]) => existing !== key), [key, id]].slice(-40));
    this.prefs = { ...this.prefs, lastSessions };
    try { writePreferences(this.preferencePath, this.prefs); }
    catch (error) { this.send({ kind: "protocol-error", error: `Could not save session recovery: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  private native(method: "copy" | "open", args: { text?: string; path?: string }): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Desktop closed"));
    if (this.pendingNative.size >= 32) return Promise.reject(new Error("Too many pending native actions"));
    const id = ++this.nativeSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNative.delete(id);
        reject(new Error("The native desktop action timed out"));
      }, this.options.nativeTimeoutMs ?? 30_000);
      this.pendingNative.set(id, { resolve: () => resolve(), reject, timer });
      this.send({ kind: "native", id, method, args });
    });
  }
  async receive(input: DesktopInput) {
    if (this.closed) return;
    if (input.kind === "native-response") {
      const pending = this.pendingNative.get(input.id);
      if (!pending) return; // A late response cannot complete another request.
      this.pendingNative.delete(input.id);
      clearTimeout(pending.timer);
      if (input.ok) pending.resolve(input.value);
      else pending.reject(new Error(input.error ?? "Native action failed"));
      return;
    }
    if (this.pendingRequests.has(input.id)) {
      this.send({ kind: "protocol-error", error: "Duplicate active request id" });
      return;
    }
    if (this.pendingRequests.size >= 64) {
      this.send({ kind: "response", id: input.id, ok: false, error: "Too many pending requests" });
      return;
    }
    this.pendingRequests.add(input.id);
    try {
      const value = await this.handle(input);
      this.send({ kind: "response", id: input.id, ok: true, ...(value === undefined ? {} : { value }) });
      if (["quit", "shutdown", "desktop-quit"].includes(input.method)) this.dispose();
    } catch (error) {
      this.send({ kind: "response", id: input.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally { this.pendingRequests.delete(input.id); }
  }
  private async handle(request: DesktopRequest) {
    await this.ready;
    if (this.closed) throw new Error("Desktop closed");
    if (["quit", "shutdown", "desktop-quit"].includes(request.method)) return;
    if (request.method === "desktop-appearance") {
      if (typeof request.args.dark !== "boolean") throw new Error("Invalid desktop appearance");
      this.darkAppearance = request.args.dark;
      if (this.host && this.host.settings.theme === "auto" && !this.explicitTheme) {
        this.host.theme = this.darkAppearance ? "demesne" : "demesne-light";
        this.host.publish();
      }
      return;
    }
    if (request.method === "desktop-bootstrap") return this.bootstrap();
    if (request.method === "desktop-open-project") return this.select(request.args.path);
    if (this.switching) throw new Error("Wait for the project to open");
    if (!this.host) throw new Error("Choose a project first");
    const result = await this.host.handle(request.method, request.args);
    if (request.method === "theme") this.explicitTheme = true;
    return result;
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    try { this.host?.dispose(); }
    finally {
      for (const pending of this.pendingNative.values()) { clearTimeout(pending.timer); pending.reject(new Error("Desktop closed")); }
      this.pendingNative.clear();
      this.options.close();
    }
  }
}

function option(args: string[], key: string) {
  const index = args.indexOf(`--${key}`);
  if (index < 0) return;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing --${key} value`);
  return value;
}
export function runDesktopHost(args = process.argv.slice(2)) {
  let closing = false, pendingWrites = 0, input = Buffer.alloc(0);
  const close = () => {
    if (closing) return;
    closing = true;
    process.stdin.pause();
    process.stdin.removeAllListeners("data");
    // Drain the quit acknowledgement before exiting. This does not stop the daemon.
    if (!pendingWrites) process.exit(0);
  };
  const send = (message: DesktopOutput) => {
    if (closing) return;
    pendingWrites++;
    process.stdout.write(JSON.stringify(message) + "\n", () => {
      pendingWrites--;
      if (closing && !pendingWrites) process.exit(0);
    });
  };
  const host = new DesktopHost({ workspace: option(args, "workspace"), server: option(args, "server"), sessionId: option(args, "session"), send, close });
  process.stdout.on("error", () => host.dispose());
  process.stdout.on("close", () => host.dispose());
  process.stdin.on("error", () => host.dispose());
  process.stdin.on("end", () => host.dispose());
  process.on("SIGTERM", () => host.dispose());
  process.on("SIGINT", () => host.dispose());
  process.stdin.on("data", (chunk: Buffer) => {
    input = Buffer.concat([input, chunk]);
    while (!closing) {
      const newline = input.indexOf(10);
      if (newline < 0) break;
      const frame = input.subarray(0, newline);
      input = input.subarray(newline + 1);
      if (frame.length > MAX_INPUT_BYTES) { send({ kind: "protocol-error", error: "Request exceeds 1 MiB" }); host.dispose(); return; }
      if (!frame.length) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(frame.toString("utf8"));
        void host.receive(parseDesktopInput(raw));
      } catch (error) {
        const id = raw && typeof raw === "object" && "id" in raw ? raw.id : undefined;
        const message = error instanceof Error ? error.message : String(error);
        send(typeof id === "number" && Number.isSafeInteger(id) && id > 0
          ? { kind: "response", id, ok: false, error: message }
          : { kind: "protocol-error", error: message });
      }
    }
    if (input.length > MAX_INPUT_BYTES) { send({ kind: "protocol-error", error: "Request exceeds 1 MiB" }); host.dispose(); }
  });
  return host;
}
if (import.meta.main) {
  try { runDesktopHost(); }
  catch (error) { process.stderr.write(`Demesne desktop: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); }
}
