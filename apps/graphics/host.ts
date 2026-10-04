import { ChatGPTAuth, type ChatGPTAccount } from "@demesne/chatgpt-auth";
import { configuredChatGPTAccount } from "../cli/src/chatgpt-auth.ts";
import { codeDiff } from "../cli/src/workbench/change-diff.ts";
import type {
  CommandsResponse,
  CommandRecord,
  ReviewScope,
  WorkspaceFingerprint,
} from "@demesne/protocol";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { DemesneClient, isStalePermissionResolution } from "@demesne/client";
import { updateUserConfig } from "@demesne/config";
import {
  themeByName,
  themeNames,
  resolveTheme,
  SLASH_COMMANDS,
} from "@demesne/brand";
import {
  isRecord,
  parseAnswerQuestionsRequest,
  type ImageArtifact,
  type Session,
  type EventEnvelope,
  type PermissionDecision,
  type ModelDescriptor,
  type WorkspaceFileInfo,
} from "@demesne/protocol";
import { loadCliSettings, type CliSettings } from "../cli/src/cli-config.ts";
import {
  createDaemonControlDependencies,
  startDaemon,
} from "../cli/src/daemon-control.ts";
import { replaySession } from "../cli/src/workbench/history.ts";
import { expandMentions } from "../cli/src/prompt-editor.ts";
import {
  isPlaceholderTitle,
  titleFromRequest,
} from "../cli/src/session-title.ts";
import { GraphicsDrive, type GraphicsUICommand } from "./drive-controller.ts";
import { GraphicsSetup } from "./setup-controller.ts";
import { GraphicsSession } from "./session-model.ts";

export interface GraphicsHostOptions {
  workspace?: string;
  server?: string;
  sessionId?: string;
  settings?: CliSettings;
  client?: DemesneClient;
  command?: (command: GraphicsUICommand) => void;
  /// Desktop hosts use trusted native IPC instead of command-line OS utilities.
  copy?: (text: string) => Promise<void>;
  open?: (path: string) => Promise<void>;
  changed: (snapshot: ReturnType<GraphicsHost["snapshot"]>) => void;
  /// Applied once, the first time the daemon is online: `demesne --model <id>`
  /// and `demesne "<message>"`.
  startup?: { model?: string; prompt?: string };
}
const string = (value: unknown, label: string, max = 128000) => {
  if (typeof value !== "string" || value.length > max)
    throw new Error(`Invalid ${label}`);
  return value;
};
const argsRecord = (value: unknown) => {
  if (!isRecord(value)) throw new Error("Invalid action arguments");
  return value;
};
export function daemonAddress(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid daemon URL");
  if (
    url.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
  )
    throw new Error("Remote daemon connections require HTTPS");
  return url.href;
}
export function daemonCredential(
  server: string,
  directory: string,
  env = process.env,
) {
  if (env.DEMESNE_DAEMON_TOKEN?.trim()) return env.DEMESNE_DAEMON_TOKEN.trim();
  if (
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      new URL(server).hostname,
    )
  )
    return;
  const path = join(directory, "daemon.token");
  return existsSync(path)
    ? readFileSync(path, "utf8").trim() || undefined
    : undefined;
}

/** All privileged operations stay here. The web renderer gets snapshots and a
 * fixed set of actions, never a daemon token, shell, arbitrary URL, or filesystem API. */
export class GraphicsHost {
  settings: CliSettings;
  setup: GraphicsSetup | null = null;
  drive: GraphicsDrive | undefined;
  driveState: import("@demesne/protocol").DriveState | null = null;
  /// Drive's Next queue for this workspace.
  nextQueue: {
    proposals: import("@demesne/protocol").DriveProposal[];
    signals: import("@demesne/protocol").DriveSignal[];
    generatedAt: string | null;
    model: string | null;
    loading: boolean;
    error: string | null;
  } = { proposals: [], signals: [], generatedAt: null, model: null, loading: false, error: null };
  /// Drive experiments in this workspace, newest first, and one being designed.
  experiments: {
    items: import("@demesne/protocol").Experiment[];
    draft: { proposalId: string; spec: import("@demesne/protocol").ExperimentSpec; model: string } | null;
    designing: string | null;
    error: string | null;
  } = { items: [], draft: null, designing: null, error: null };
  private experimentPoll: ReturnType<typeof setTimeout> | undefined;
  /// Proposals you hid: until a time (Not now, or while running) or for good.
  private nextHidden: Record<string, number | "never"> = {};
  private nextRequested = 0;
  private autoStarted = false;
  readonly workspace: string;
  private client: DemesneClient;
  chatgptAccount: ChatGPTAccount | null = null;
  model: ModelDescriptor = { id: "", provider: "" };
  /// The model's chosen thinking level (none: the model's default).
  reasoning: string | undefined;
  current: GraphicsSession | null = null;
  sessions: Session[] = [];
  files: WorkspaceFileInfo[] = [];
  artifacts: ImageArtifact[] = [];
  processes: CommandRecord[] = [];
  queuePosition: number | null = null;
  verificationFingerprint: WorkspaceFingerprint | null = null;
  processesError: string | null = null;
  checkQueue: string[] = [];
  panelWidth: number | null = null;
  reviewRevision = 0;
  private reviewCache = new Map<
    string,
    import("@demesne/protocol").ReviewResponse
  >();
  private panelWatchTimer: ReturnType<typeof setInterval> | null = null;
  private watching: string | null = null;
  private watchedCommand = "none";
  private polling: Promise<void> | null = null;
  private batchGeneration = 0;
  private checkBatchActive = false;
  connection: "connecting" | "online" | "offline" = "connecting";
  error: string | null = null;
  planOnly = false;
  queue = "";
  draft = "";
  draftVersion = 0;
  restored = false;
  busy = false;
  theme: string;
  private stream: AbortController | null = null;
  private generation = 0;
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private selectedSession?: string;
  private drafts = new Map<string, string>();
  private images = new Map<string, string>();
  onAction?: (
    method: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  onEvent?: (event: EventEnvelope) => void;
  onManual?: () => void;
  constructor(private options: GraphicsHostOptions) {
    this.workspace = resolve(options.workspace ?? process.cwd());
    this.settings =
      options.settings ??
      loadCliSettings({
        workspaceRoot: this.workspace,
        serverOverride: options.server,
      });
    const server = daemonAddress(options.server ?? this.settings.server);
    this.client =
      options.client ??
      new DemesneClient({
        server,
        token: daemonCredential(server, this.settings.dataDirectory),
      });
    this.theme = resolveTheme(
      this.settings.theme === "auto" ? undefined : this.settings.theme,
      process.env.COLORFGBG,
    ).name;
    this.selectedSession = options.sessionId;
    try {
      const prefs = JSON.parse(
        readFileSync(
          join(this.settings.dataDirectory, "graphics-ui.json"),
          "utf8",
        ),
      );
      if (Number.isFinite(prefs.panelWidth))
        this.panelWidth = Math.max(300, Math.min(1000, prefs.panelWidth));
    } catch {}
    if (options.command) this.drive = new GraphicsDrive(this, options.command);
  }
  get api() {
    return this.client;
  }
  get active() {
    return this.current?.active ?? null;
  }
  snapshot() {
    return {
      revision: this.revision,
      connection: this.connection,
      error: this.error,
      server: this.client.server,
      session: this.current
        ? {
            id: this.current.session.id,
            title: this.current.session.title,
            workspace: this.current.session.workspace,
            createdAt: this.current.session.createdAt,
          }
        : null,
      sessions: this.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        turns: session.turns.length,
        status: session.turns.at(-1)?.status,
        workspace: session.workspace?.root,
      })),
      runs: this.current?.runs() ?? [],
      cursor: this.current?.cursor ?? 0,
      model: this.model,
      reasoning: this.reasoning,
      chatgptAccount: this.model.provider === "ChatGPT" ? this.chatgptAccount : null,
      provider: this.current?.provider ?? null,
      checkpoint: this.current?.state.checkpoint ?? null,
      approvals: [...(this.current?.approvals.values() ?? [])],
      questions: [...(this.current?.questions.values() ?? [])],
      activeTurnId: this.active?.id ?? null,
      busy: this.busy,
      files: this.files,
      artifacts: this.artifacts,
      planOnly: this.planOnly,
      queue: this.queue,
      draft: this.draft,
      draftVersion: this.draftVersion,
      restored: this.restored,
      theme: this.theme,
      palette: themeByName(this.theme).colors,
      themes: themeNames(),
      commands: SLASH_COMMANDS,
      workspace: this.current?.session.workspace?.root ?? this.workspace,
      drive: this.driveState,
      // Drive's project memory for this workspace (shown in Session).
      driveMemory: this.drive?.memoryEntries ?? [],
      experiments: this.experiments,
      driveNext: {
        ...this.nextQueue,
        proposals: this.nextQueue.proposals.filter((item) => {
          const hidden = this.nextHidden[item.id];
          return hidden === undefined || (hidden !== "never" && hidden < Date.now());
        }),
      },
      setup: this.setup?.snapshot() ?? null,
      processes: this.processes,
      queuePosition: this.queuePosition,
      verificationFingerprint: this.verificationFingerprint,
      processesError: this.processesError,
      checkQueue: this.checkQueue,
      panelWidth: this.panelWidth,
      reviewRevision: this.reviewRevision,
    };
  }
  publish() {
    if (this.disposed) return;
    this.revision++;
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.disposed) this.options.changed(this.snapshot());
      }, 25);
  }
  async connect() {
    this.connection = "connecting";
    this.error = null;
    this.publish();
    try {
      const health = await this.client.health();
      const contextWindow = health.contextCapacity ?? [this.settings.loaded.config.provider, ...Object.values(this.settings.loaded.config.additionalProviders ?? {})]
        .find(p => p.model === health.model)?.contextWindow;
      this.reasoning = health.reasoning;
      this.model = {
        id: health.model,
        provider: health.provider,
        ...(contextWindow
          ? { contextWindow }
          : {}),
      };
      try {
        const id = configuredChatGPTAccount(this.settings.configPath);
        this.chatgptAccount = id ? (await new ChatGPTAuth(this.settings.dataDirectory).accounts()).find(a => a.id === id) ?? null : null;
      } catch { this.chatgptAccount = null; }
      this.sessions = await this.client.listSessions();
      this.connection = "online";
      if (this.selectedSession) await this.select(this.selectedSession);
      else await this.newSession();
      // Discovery across providers takes seconds; do it before /model asks.
      void this.models().catch(() => {});
      this.loadNextHidden();
      void this.refreshNext();
      void this.refreshExperiments();
      await this.applyStartup();
    } catch (error) {
      if (!this.autoStarted && this.settings.autoStart === "always") {
        this.autoStarted = true;
        try {
          await this.startDaemon();
          return;
        } catch {}
      }
      this.connection = "offline";
      this.error = error instanceof Error ? error.message : String(error);
      this.publish();
    }
  }
  async startDaemon() {
    const host = new URL(this.client.server).hostname;
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host))
      throw new Error("Start the remote daemon on its host.");
    const env = { ...process.env };
    const bundled = join(dirname(process.execPath), "../demesned");
    if (!env.DEMESNE_DAEMON_BIN && existsSync(bundled))
      env.DEMESNE_DAEMON_BIN = bundled;
    const result = await startDaemon(
      createDaemonControlDependencies(
        this.client.server,
        this.settings.dataDirectory,
        env,
      ),
    );
    if (!result.health) throw new Error(result.message);
    this.client = new DemesneClient({
      server: this.client.server,
      token: daemonCredential(this.client.server, this.settings.dataDirectory),
    });
    await this.connect();
  }
  async newSession(title?: string) {
    const result = await this.client.createSession({
      workspacePath: this.workspace,
      title: title ?? `Session ${new Date().toLocaleTimeString()}`,
    });
    await this.select(result.session.id);
    return result.session.id;
  }
  async select(id: string) {
    if (this.busy)
      throw new Error("Wait for the current session action to finish.");
    if (this.current) this.drafts.set(this.current.session.id, this.draft);
    const generation = this.generation + 1;
    this.busy = true;
    this.publish();
    try {
      const state = await this.client.getSessionState(id);
      const events = await replaySession(
        state,
        (sessionId, after, signal) =>
          this.client.streamEvents(sessionId, after, signal),
        (sessionId, after, through, signal) =>
          this.client.replayPage(sessionId, after, through, signal),
      );
      if (this.disposed) return;
      this.generation = generation;
      this.stream?.abort();
      this.current = new GraphicsSession(state, events);
      this.reviewRevision++;
      this.reviewCache.clear();
      this.batchGeneration++;
      this.checkBatchActive = false;
      this.checkQueue = [];
      this.processes = [];
      this.verificationFingerprint = null;
      this.processesError = null;
      void this.refreshProcesses();
      this.selectedSession = id;
      this.queue = "";
      this.draft = this.drafts.get(id) ?? "";
      this.draftVersion++;
      this.restored = false;
      this.files = [];
      this.artifacts = [];
      this.images.clear();
      this.busy = false;
      this.error = null;
      this.publish();
      const controller = (this.stream = new AbortController());
      void this.watch(id, generation, controller);
      void this.refreshFiles().catch(() => {});
      void this.refreshArtifacts().catch(() => {});
      void this.refreshSessions();
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  private async watch(
    id: string,
    generation: number,
    controller: AbortController,
  ) {
    try {
      for await (const event of this.client.streamEvents(
        id,
        this.current!.cursor,
        controller.signal,
      )) {
        if (generation !== this.generation || controller.signal.aborted) break;
        if (!this.current!.apply(event)) continue;
        this.onEvent?.(event);
        this.drive?.agent.workerEvent(event);
        if (
          event.type === "turn.reverted" ||
          event.type === "command.changed" ||
          event.type === "tool.call_completed"
        ) {
          this.reviewRevision++;
          this.reviewCache.clear();
        }
        if (
          event.type === "command.changed" ||
          event.type === "turn.reverted" ||
          event.type === "tool.call_completed"
        )
          void this.refreshProcesses();
        if (event.type === "artifact.created")
          void this.refreshArtifacts().catch(() => {});
        if (/^tool\.call_(completed|failed)$/.test(event.type))
          void this.refreshFiles().catch(() => {});
        if (
          /^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)
        ) {
          if (Date.now() - this.nextRequested > 30 * 60_000) void this.refreshNext();
          const queued = this.queue;
          this.queue = "";
          if (queued.trim() && event.type === "turn.completed") {
            this.draft = "";
            this.draftVersion++;
            void this.submit(queued).catch((error) => {
              if (this.current?.session.id === id) {
                this.draft = queued;
                this.draftVersion++;
                this.restored = true;
              }
              this.fail(error);
            });
          } else if (queued) {
            this.draft = queued;
            this.draftVersion++;
            this.restored = true;
          }
          void this.refreshSessions();
        }
        this.publish();
      }
    } catch (error) {
      if (!controller.signal.aborted) this.fail(error);
    }
  }
  /// Every provider's models, cached: asking each provider (OpenRouter has
  /// hundreds) takes seconds. A stale list is returned at once and refreshed
  /// behind it.
  private modelCache: { at: number; models: Promise<ModelDescriptor[]> } | null = null;
  private models(): Promise<ModelDescriptor[]> {
    const cache = this.modelCache;
    if (cache && Date.now() - cache.at < 300_000) return cache.models;
    const fresh = this.client.listModels();
    this.modelCache = { at: Date.now(), models: fresh };
    fresh.catch(() => { if (this.modelCache?.models === fresh) this.modelCache = cache; });
    return cache ? cache.models.catch(() => fresh) : fresh;
  }
  private async applyStartup() {
    const startup = this.options.startup;
    if (!startup) return;
    this.options.startup = undefined;
    try {
      if (startup.model) await this.handle("model", { id: startup.model });
      if (startup.prompt?.trim()) await this.submit(startup.prompt);
    } catch (error) {
      this.fail(error);
    }
  }
  private fail(error: unknown) {
    this.error = error instanceof Error ? error.message : String(error);
    this.publish();
  }
  async refreshSessions() {
    try {
      this.sessions = await this.client.listSessions();
      this.publish();
    } catch {}
  }
  private loadingFiles: Promise<void> | null = null;
  async refreshFiles() {
    if (this.loadingFiles) return this.loadingFiles;
    const id = this.current?.session.id;
    if (!id) return;
    this.loadingFiles = this.client
      .listWorkspaceFileInfo(id)
      .then((files) => {
        if (this.current?.session.id === id) {
          this.files = files;
          this.publish();
        }
      })
      .finally(() => {
        this.loadingFiles = null;
      });
    return this.loadingFiles;
  }
  async refreshArtifacts() {
    const id = this.current?.session.id;
    if (!id) return;
    let cursor = 0;
    const artifacts: ImageArtifact[] = [];
    do {
      const page = await this.client.listArtifacts(id, cursor);
      artifacts.push(...page.artifacts);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    } while (true);
    if (this.current?.session.id === id) {
      this.artifacts = artifacts;
      this.publish();
    }
  }
  async submit(content: string, planOnly = this.planOnly) {
    if (!this.current || this.connection !== "online")
      throw new Error("Connect to the daemon first.");
    if (!content.trim()) return;
    if (this.active) {
      this.queue = content;
      this.draft = content;
      this.draftVersion++;
      this.publish();
      return { queued: true };
    }
    if (this.busy) throw new Error("A request is already being submitted.");
    const session = this.current,
      id = session.session.id;
    this.busy = true;
    this.error = null;
    this.publish();
    try {
      const expanded = expandMentions(
        content,
        this.files.map((file) => file.path),
      );
      const result = await this.client.submitTurn(id, {
        content: expanded,
        permissionMode: "ask",
        planOnly,
      });
      if (this.current?.session.id === id) {
        session.ensureTurn(result.turn);
        this.drive?.agent.workerStarted(id, content, result.turn.id);
        this.draft = "";
        this.draftVersion++;
        this.restored = false;
      }
      if (isPlaceholderTitle(session.session.title)) {
        const title = titleFromRequest(content);
        try {
          await this.client.updateSession(id, { title });
          session.session.title = title;
        } catch {}
      }
      return { turnId: result.turn.id };
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  get checking() {
    return this.processes.some(
      (command) =>
        command.check && ["running", "stopping"].includes(command.status),
    );
  }
  async interrupt() {
    const turn = this.active;
    if (!turn) {
      const commands = this.processes.filter(
        (command) =>
          command.check && ["running", "stopping"].includes(command.status),
      );
      if (!commands.length) return false;
      this.batchGeneration++;
      this.checkBatchActive = false;
      this.checkQueue = [];
      await Promise.all(
        commands.map((command) =>
          this.client.stopCommand(this.current!.session.id, command.id),
        ),
      );
      await this.refreshProcesses();
      return true;
    }
    await this.client.cancelTurn(turn.id);
    return true;
  }
  /// Asks the daemon for the Next queue: cached unless the workspace's
  /// signals changed; `force` regenerates it.
  async refreshNext(force = false) {
    if (this.nextQueue.loading) return;
    this.nextRequested = Date.now();
    this.nextQueue = { ...this.nextQueue, loading: true, error: null };
    this.publish();
    try {
      const result = await this.client.driveNext({
        workspace: this.workspace,
        memory: this.drive?.memory.forPlanner() ?? [],
        ...(force ? { force: true } : {}),
      });
      this.nextQueue = { proposals: result.proposals, signals: result.signals, generatedAt: result.generatedAt, model: result.model, loading: false, error: null };
    } catch (error) {
      this.nextQueue = { ...this.nextQueue, loading: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.publish();
  }
  /// Reads this workspace's experiments; polls while one runs. A settled
  /// experiment's verdict goes to project memory (once: memory keeps one copy
  /// of the same text), so the next queue never retries a settled idea blindly.
  async refreshExperiments() {
    clearTimeout(this.experimentPoll);
    try {
      const items = await this.client.listExperiments(this.workspace);
      this.experiments = { ...this.experiments, items: items.slice(0, 6), error: null };
      for (const item of items) {
        if (item.status === "running" || !item.verdict) continue;
        this.drive?.addMemory({ kind: "outcome", source: "drive", text: `Experiment ${item.id}: ${item.spec.question} ${item.verdict.summary}${item.pullRequest?.url ? ` Draft PR: ${item.pullRequest.url}` : ""}` });
      }
      if (items.some((item) => item.status === "running")) this.experimentPoll = setTimeout(() => void this.refreshExperiments(), 4000);
    } catch (error) {
      this.experiments = { ...this.experiments, error: error instanceof Error ? error.message : String(error) };
    }
    this.publish();
  }
  /// Has Drive design an experiment for a proposal. Run starts it at once;
  /// Plan first keeps it as a draft to read before starting.
  private async designExperiment(item: import("@demesne/protocol").DriveProposal, start: boolean) {
    this.experiments = { ...this.experiments, designing: item.id, error: null };
    this.publish();
    try {
      const { spec, model } = await this.client.designExperiment({ workspace: this.workspace, proposal: item, memory: this.drive?.memory.forPlanner() ?? [] });
      if (start) {
        await this.client.startExperiment(spec);
        this.experiments = { ...this.experiments, designing: null, draft: null };
        await this.refreshExperiments();
      } else this.experiments = { ...this.experiments, designing: null, draft: { proposalId: item.id, spec, model } };
    } catch (error) {
      this.experiments = { ...this.experiments, designing: null, error: error instanceof Error ? error.message : String(error) };
    }
    this.publish();
  }
  private nextHiddenPath() {
    return join(this.settings.dataDirectory, "drive", `${createHash("sha256").update(this.workspace).digest("hex").slice(0, 32)}.next-hidden.json`);
  }
  private loadNextHidden() {
    try {
      this.nextHidden = JSON.parse(readFileSync(this.nextHiddenPath(), "utf8"));
    } catch {
      this.nextHidden = {};
    }
  }
  private hideNext(id: string, until: number | "never") {
    this.nextHidden[id] = until;
    try {
      mkdirSync(dirname(this.nextHiddenPath()), { recursive: true, mode: 0o700 });
      writeFileSync(this.nextHiddenPath(), JSON.stringify(this.nextHidden), { mode: 0o600 });
    } catch { /* hiding still applies for this session */ }
    this.publish();
  }
  async refreshProcesses() {
    if (this.polling) return this.polling;
    const id = this.current?.session.id;
    if (!id) return;
    const output = this.watchedCommand;
    this.polling = this.client
      .commands(id, output)
      .then((result) => {
        if (this.current?.session.id !== id) return;
        const changed =
          JSON.stringify([
            this.processes,
            this.verificationFingerprint,
            this.processesError,
            this.queuePosition,
          ]) !==
          JSON.stringify([
            result.commands,
            result.fingerprint,
            null,
            result.queuePosition ?? null,
          ]);
        this.processes = result.commands;
        this.queuePosition = result.queuePosition ?? null;
        this.verificationFingerprint = result.fingerprint;
        this.processesError = null;
        if (changed) this.publish();
      })
      .catch((error) => {
        if (this.current?.session.id !== id) return;
        const message = error instanceof Error ? error.message : String(error);
        if (message !== this.processesError) {
          this.processesError = message;
          this.publish();
        }
      })
      .finally(() => {
        this.polling = null;
        if (this.current?.session.id === id && this.watchedCommand !== output)
          return this.refreshProcesses();
      });
    return this.polling;
  }
  private watchPanel(panel: string | null, command = "none") {
    this.watching = panel;
    this.watchedCommand = command;
    if (this.panelWatchTimer) clearInterval(this.panelWatchTimer);
    this.panelWatchTimer = null;
    if (panel === "log" || panel === "verification") {
      void this.refreshProcesses();
      this.panelWatchTimer = setInterval(
        () => void this.refreshProcesses(),
        500,
      );
      this.panelWatchTimer.unref();
    }
  }
  private async runChecks(ids: string[]) {
    if (this.checkBatchActive) throw new Error("Checks are already queued");
    const sessionId = this.current!.session.id;
    const selected = ids.map((id) =>
      this.processes.find((command) => command.id === id && command.check),
    );
    if (selected.some((command) => !command))
      throw new Error("A selected check is no longer available");
    const generation = ++this.batchGeneration;
    this.checkBatchActive = true;
    this.checkQueue = [...ids];
    this.publish();
    void (async () => {
      try {
        for (const id of ids) {
          if (
            generation !== this.batchGeneration ||
            this.current?.session.id !== sessionId
          )
            break;
          const started = await this.client.rerunCommand(sessionId, id);
          this.checkQueue = this.checkQueue.filter((value) => value !== id);
          await this.refreshProcesses();
          this.publish();
          while (generation === this.batchGeneration) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            const result = await this.client.commands(
              sessionId,
              this.watchedCommand,
            );
            const command = result.commands.find(
              (command) => command.id === started.id,
            );
            if (this.current?.session.id === sessionId) {
              this.processes = result.commands;
              this.queuePosition = result.queuePosition ?? null;
              this.verificationFingerprint = result.fingerprint;
              this.publish();
            }
            if (!command || !["running", "stopping"].includes(command.status))
              break;
          }
        }
      } catch (error) {
        this.fail(error);
      } finally {
        if (generation === this.batchGeneration) {
          this.checkBatchActive = false;
          this.checkQueue = [];
          this.publish();
        }
      }
    })();
  }

  async handle(method: string, raw: unknown): Promise<unknown> {
    const args = argsRecord(raw ?? {});
    const globals = new Set([
      "bootstrap",
      "connect",
      "start-daemon",
      "select-session",
      "new-session",
      "setup",
      "setup-action",
    ]);
    if (!globals.has(method) && args.sessionId !== this.current?.session.id)
      throw new Error("The session changed. Try the action again.");
    if (method === "panel-watch") {
      this.watchPanel(
        typeof args.panel === "string" ? args.panel : null,
        typeof args.command === "string" ? args.command : "none",
      );
      return;
    }
    // The Next queue: refresh, Run (a bounded Drive mission), Plan first
    // (a read-only plan turn), Not now (a day), Never (a veto in memory).
    if (method === "next-refresh") return this.refreshNext(true);
    if (["next-run", "next-plan", "next-snooze", "next-never"].includes(method)) {
      const item = this.nextQueue.proposals.find((proposal) => proposal.id === args.id);
      if (!item) throw new Error("That proposal is no longer in the queue.");
      if (method === "next-snooze") return this.hideNext(item.id, Date.now() + 24 * 3_600_000);
      if (method === "next-never") {
        this.drive?.addMemory({ kind: "veto", text: `${item.title}: ${item.why}`, source: "you" });
        return this.hideNext(item.id, "never");
      }
      this.hideNext(item.id, Date.now() + 6 * 3_600_000);
      // An experiment is designed (variants, metric, checks) rather than planned in chat.
      if (item.kind === "experiment") return this.designExperiment(item, method === "next-run");
      if (method === "next-plan") return this.submit(`${item.title}. ${item.why}`, true);
      if (!this.drive) throw new Error("Drive is unavailable here.");
      return this.drive.handle("drive", { text: `--bounded ${item.title}. ${item.why}` });
    }
    if (method === "experiment-start") {
      const draft = this.experiments.draft;
      if (!draft) throw new Error("There is no designed experiment to start.");
      await this.client.startExperiment(draft.spec);
      this.experiments = { ...this.experiments, draft: null };
      return this.refreshExperiments();
    }
    if (method === "experiment-discard") { this.experiments = { ...this.experiments, draft: null }; this.publish(); return; }
    if (method === "experiment-stop") {
      await this.client.stopExperiment(string(args.id, "experiment id", 100));
      return this.refreshExperiments();
    }
    if (method === "processes") {
      await this.refreshProcesses();
      return this.processes;
    }
    if (method === "panel-width") {
      const width = Number(args.width);
      if (!Number.isFinite(width)) throw new Error("Invalid panel width");
      this.panelWidth = Math.max(300, Math.min(1000, width));
      mkdirSync(this.settings.dataDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(this.settings.dataDirectory, "graphics-ui.json"),
        JSON.stringify({ panelWidth: this.panelWidth }),
        { mode: 0o600 },
      );
      this.publish();
      return;
    }
    const driven = this.drive?.authorize(method, args);
    // Only the person writing or sending a message takes over from Drive
    // ("manual" is the renderer's signal that the composer draft changed).
    // Clicking, navigating, opening panels and reading leave it running.
    if (!driven && ["manual", "submit", "plan-submit"].includes(method)) {
      this.onManual?.();
      this.drive?.agent.intervene();
    }
    if (method === "bootstrap") return this.snapshot();
    if (method === "connect") {
      await this.connect();
      return this.snapshot();
    }
    if (method === "start-daemon") {
      await this.startDaemon();
      return this.snapshot();
    }
    if (method === "new-session")
      return this.newSession(
        typeof args.title === "string" ? args.title : undefined,
      );
    if (method === "select-session") {
      await this.select(string(args.id, "session id", 200));
      return this.snapshot();
    }
    if (method === "draft") {
      this.draft = string(args.text, "draft");
      this.restored = false;
      if (this.active) this.queue = this.draft;
      this.publish();
      return;
    }
    if (method === "plan-submit")
      return this.submit(
        string(args.text, "prompt").replace(/^\/plan\s+/, ""),
        true,
      );
    if (method === "copy") {
      await this.copy(string(args.text, "clipboard text", 260000));
      return;
    }
    if (method === "setup") {
      this.setup?.dispose();
      this.setup = new GraphicsSetup({
        dataDirectory: this.settings.dataDirectory,
        configPath: this.settings.configPath,
        changed: () => this.publish(),
        copy: (text) => this.copy(text),
        open: (url) => this.open(url),
        finish: async (open) => {
          this.setup?.dispose();
          this.setup = null;
          this.publish();
          if (open) {
            this.settings = loadCliSettings({
              workspaceRoot: this.workspace,
              serverOverride: this.client.server,
            });
            if (this.connection !== "online") await this.startDaemon();
            else {
              this.error =
                "Configuration saved. Restart the daemon when all sessions are idle to apply provider changes.";
              this.publish();
            }
          }
        },
      });
      this.publish();
      void this.setup.start();
      return;
    }
    if (method === "setup-action") {
      if (!this.setup) throw new Error("Setup is closed");
      await this.setup.action(args);
      return;
    }
    if (method === "submit") return this.submit(string(args.text, "prompt"));
    if (method === "cancel") return this.interrupt();
    if (method === "clear-queue") {
      this.queue = "";
      this.restored = false;
      this.draft = "";
      this.draftVersion++;
      this.publish();
      return;
    }
    if (method === "mode") {
      this.planOnly = args.planOnly === true;
      this.publish();
      return;
    }
    if (method === "models") return this.models();
    if (method === "model") {
      const id = string(args.id, "model", 1000);
      const reasoning = args.reasoning === undefined ? undefined : string(args.reasoning, "reasoning", 16);
      if (reasoning !== undefined && !/^[a-z]{1,16}$/.test(reasoning)) throw new Error("Invalid reasoning");
      await this.client.setModel(id, reasoning);
      this.reasoning = reasoning;
      const models = await this.models();
      this.model = models.find((model) => model.id === id) ?? {
        id,
        provider: this.model.provider,
      };
      if (this.current)
        await this.client.updateSession(this.current.session.id, {
          preferredModel: id,
        });
      this.publish();
      return;
    }
    if (method === "theme") {
      const name = string(args.name, "theme", 100);
      if (!themeNames().includes(name)) throw new Error("Unknown theme");
      this.theme = name;
      this.publish();
      return;
    }
    if (method === "files") {
      await this.refreshFiles();
      return this.files;
    }
    if (method === "read-file")
      return this.client.readWorkspaceFile(
        this.current!.session.id,
        string(args.path, "file path", 4096),
      );
    if (method === "file-status")
      return this.client.workspaceFileStatus(
        this.current!.session.id,
        string(args.path, "file path", 4096),
      );
    if (method === "changes") {
      const scope = (args.scope ?? "turn") as ReviewScope;
      if (!["turn", "session", "workspace"].includes(scope))
        throw new Error("Unknown change scope");
      const turnId = typeof args.turnId === "string" ? args.turnId : undefined;
      const key = `${this.current!.session.id}:${scope}:${turnId ?? ""}`;
      let review = args.force !== true ? this.reviewCache.get(key) : undefined;
      if (!review) {
        review = await this.client.review(
          this.current!.session.id,
          scope,
          turnId,
        );
        this.reviewCache.set(key, review);
      }
      const files = review.files.map((file) => ({
        ...file,
        ...codeDiff(file.before ?? "", file.after ?? ""),
      }));
      if (scope === "turn" && turnId)
        for (const draft of this.current!.changes(turnId).filter(
          (file) =>
            file.state === "drafting" ||
            file.state === "pending" ||
            file.state === "approval",
        )) {
          const index = files.findIndex((file) => file.path === draft.path);
          const item = {
            ...draft,
            beforeExists: true,
            afterExists: true,
            before: draft.before ?? null,
            after: draft.after ?? null,
          };
          if (index >= 0) files[index] = item;
          else files.push(item);
        }
      return { ...review, files };
    }
    if (method === "stop-command") {
      this.batchGeneration++;
      this.checkBatchActive = false;
      this.checkQueue = [];
      const result = await this.client.stopCommand(
        this.current!.session.id,
        string(args.id, "command id", 200),
      );
      await this.refreshProcesses();
      return result;
    }
    if (method === "rerun-checks") {
      if (
        !Array.isArray(args.ids) ||
        args.ids.length < 1 ||
        args.ids.length > 50 ||
        args.ids.some((id) => typeof id !== "string")
      )
        throw new Error("Select recorded checks");
      return this.runChecks(args.ids as string[]);
    }
    if (method === "permission") {
      const id = string(args.id, "permission id", 200),
        approval = this.current!.approvals.get(id),
        decision = string(args.decision, "decision", 50) as PermissionDecision;
      if (!approval || !this.current!.isActive(approval.turnId))
        throw new Error("This permission is no longer pending.");
      if (
        !["allow_once", "allow_session", "allow_always", "deny"].includes(
          decision,
        )
      )
        throw new Error("Invalid permission decision");
      if (decision === "allow_session" && approval.name === "run_command")
        throw new Error("Host commands require individual approval.");
      if (decision === "allow_always") {
        if (!approval.rule)
          throw new Error("This operation cannot create a persistent rule.");
        const allow = this.settings.loaded.config.permissions.allow;
        if (!allow.includes(approval.rule)) {
          updateUserConfig(this.settings.configPath, {
            permissions: { allow: [...allow, approval.rule] },
          });
          allow.push(approval.rule);
        }
      }
      try {
        await this.client.resolvePermission(id, decision);
      } catch (error) {
        if (isStalePermissionResolution(error)) {
          this.current!.approvals.delete(id);
          this.publish();
        }
        throw error;
      }
      this.current!.approvals.delete(id);
      this.publish();
      return;
    }
    if (method === "answer") {
      const id = string(args.id, "question id", 200);
      if (!this.current!.questions.has(id))
        throw new Error("This question is no longer pending.");
      const body = parseAnswerQuestionsRequest({ answers: args.answers });
      await this.client.request(`/v1/questions/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      this.current!.questions.delete(id);
      this.publish();
      return;
    }
    if (method === "rename") {
      const title = string(args.title, "title", 200).trim();
      if (!title) throw new Error("Enter a title");
      await this.client.updateSession(this.current!.session.id, { title });
      this.current!.session.title = title;
      await this.refreshSessions();
      return;
    }
    if (method === "archive") {
      await this.client.archiveSession(this.current!.session.id);
      await this.newSession();
      return;
    }
    if (method === "compact") {
      if (this.active)
        throw new Error("Wait for the current turn before compacting.");
      const result = await this.client.compactSession(
        this.current!.session.id,
        {
          instructions:
            typeof args.instructions === "string"
              ? args.instructions
              : undefined,
        },
      );
      this.current!.ensureTurn(result.turn);
      this.publish();
      return;
    }
    if (method === "undo") {
      if (this.active)
        throw new Error("Wait for the current turn before undoing changes.");
      const result = await this.client.undo(this.current!.session.id, {
        ...(typeof args.turnId === "string" ? { turnId: args.turnId } : {}),
        ...(typeof args.path === "string" ? { paths: [args.path] } : {}),
      });
      await this.refreshFiles();
      await this.refreshProcesses();
      this.publish();
      return result;
    }
    if (method === "export") {
      const format = args.format === "json" ? "json" : "md",
        content = await this.client.exportSession(
          this.current!.session.id,
          format,
        );
      const directory = join(this.settings.dataDirectory, "exports");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${this.current!.session.id}.${format}`);
      writeFileSync(path, content, { mode: 0o600 });
      return { path };
    }
    if (method === "artifact") {
      const id = string(args.id, "artifact id", 200),
        artifact = this.artifacts.find((item) => item.id === id);
      if (!artifact) throw new Error("Image is not in the current session.");
      const key = `${id}:${args.original === true ? "original" : "preview"}`;
      if (this.images.has(key)) return this.images.get(key);
      const variant = args.original === true ? "original" : "preview";
      const bytes = await this.client.artifactContent(artifact, variant);
      const data = `data:${variant === "original" ? artifact.mimeType : "image/png"};base64,${Buffer.from(bytes).toString("base64")}`;
      if (this.images.size >= 3)
        this.images.delete(this.images.keys().next().value!);
      this.images.set(key, data);
      return data;
    }
    if (method === "import-reference") {
      const artifact = await this.client.importImage(
        this.current!.session.id,
        string(args.path, "image path", 4096),
        true,
        args.viewport as ImageArtifact["viewport"],
      );
      await this.refreshArtifacts();
      return artifact;
    }
    if (method === "open-artifact") {
      const artifact = this.artifacts.find((item) => item.id === args.id);
      if (!artifact) throw new Error("Image is not in this session");
      const bytes = await this.client.artifactContent(artifact, "original");
      const directory = join(this.settings.dataDirectory, "preview-cache");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const extension =
        artifact.mimeType === "image/jpeg"
          ? "jpg"
          : artifact.mimeType === "image/webp"
            ? "webp"
            : "png";
      const path = join(
        directory,
        `${createHash("sha256").update(bytes).digest("hex")}.${extension}`,
      );
      writeFileSync(path, bytes, { mode: 0o600 });
      await this.open(path);
      return;
    }
    if (method === "open-link") {
      const url = new URL(string(args.url, "link", 8000));
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("Unsupported link");
      await this.open(url.href);
      return;
    }
    if (
      this.drive &&
      ["drive", "drive-control", "observe", "ui-result", "manual"].includes(
        method,
      )
    )
      return this.drive.handle(method, args);
    if (this.onAction) return this.onAction(method, args);
    throw new Error(`Unsupported action: ${method}`);
  }
  private async copy(text: string) {
    if (this.options.copy) return this.options.copy(text);
    const command =
      process.platform === "darwin"
        ? ["pbcopy"]
        : process.env.WAYLAND_DISPLAY
          ? ["wl-copy"]
          : ["xclip", "-selection", "clipboard"];
    const child = Bun.spawn(command, {
      stdin: new Response(text),
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await child.exited) !== 0) throw new Error("Clipboard unavailable");
  }
  private async open(path: string) {
    if (this.options.open) return this.options.open(path);
    const child = Bun.spawn(
      [process.platform === "darwin" ? "open" : "xdg-open", path],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await child.exited) !== 0) throw new Error("Could not open the item");
  }
  /// A project switch must not discard any draft held by this UI.
  get hasUnsentDrafts() {
    return Boolean(this.draft.trim() || this.queue.trim()) ||
      [...this.drafts].some(([id, text]) => id !== this.current?.session.id && text.trim() && this.sessions.some(session => session.id === id));
  }
  dispose() {
    this.batchGeneration++;
    clearTimeout(this.experimentPoll);
    if (this.panelWatchTimer) clearInterval(this.panelWatchTimer);
    this.drive?.dispose();
    this.setup?.dispose();
    this.disposed = true;
    this.generation++;
    this.stream?.abort();
    if (this.timer) clearTimeout(this.timer);
  }
}
