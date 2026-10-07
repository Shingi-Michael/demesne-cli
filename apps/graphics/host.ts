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
import { DemesneClient, isStalePermissionResolution, isWorkspaceUntrusted } from "@demesne/client";
import { updateUserConfig } from "@demesne/config";
import {
  themeByName,
  themeNames,
  type ThemeLibrary,
  resolveTheme,
  SLASH_COMMANDS,
  type SlashCommand,
} from "@demesne/brand";
import {
  isRecord,
  parseAnswerQuestionsRequest,
  parseQuestionActionRequest,
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
import { ProviderAccounts, type ProviderEntry } from "./providers.ts";
import { BreakageWatch } from "./breakage.ts";
import { missionReceipt } from "../cli/src/drive-receipt.ts";
import { expandCustomCommand, loadCustomCommands, mergeSlashCommands, type CustomCommand } from "../cli/src/custom-commands.ts";
import { loadWorkflows, workflowCommand } from "../cli/src/workflows.ts";
import { GraphicsSetup } from "./setup-controller.ts";
import { GraphicsSession } from "./session-model.ts";

/// How many of the top Next proposals away mode works through.
export const AWAY_RUNS = 3;

export interface GraphicsHostOptions {
  workspace?: string;
  server?: string;
  sessionId?: string;
  settings?: CliSettings;
  client?: DemesneClient;
  providerAccounts?: Pick<ProviderAccounts, "signingIn" | "list" | "signIn" | "signOut" | "cancel">;
  command?: (command: GraphicsUICommand) => void;
  /// Desktop hosts use trusted native IPC instead of command-line OS utilities.
  copy?: (text: string) => Promise<void>;
  open?: (path: string) => Promise<void>;
  changed: (snapshot: ReturnType<GraphicsHost["snapshot"]>) => void;
  /// Applied once, the first time the daemon is online: `demesne --model <id>`
  /// and `demesne "<message>"`.
  startup?: { model?: string; prompt?: string };
  /// A host with no window, carrying on a Drive mission after the window
  /// closed: it skips the work that only feeds the screen (model discovery,
  /// Drive's Next queue).
  headless?: boolean;
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
    /// How Drive's past proposals here turned out, once any have.
    calibration?: import("@demesne/protocol").DriveCalibration | null;
  } = { proposals: [], signals: [], generatedAt: null, model: null, loading: false, error: null };
  /// Settings › Providers: each provider's sign-in state, and the one being
  /// signed in while its browser flow is open.
  providers: { items: ProviderEntry[]; signingIn: string | null; message: string | null; loading: boolean } = { items: [], signingIn: null, message: null, loading: false };
  private providerAccounts: NonNullable<GraphicsHostOptions["providerAccounts"]> | null = null;
  private providerSignInGeneration = 0;
  /// Settings › Clean up sessions: what's worth deleting, what you ticked,
  /// and whether Delete was pressed once (it asks twice).
  cleanup: { candidates: import("@demesne/protocol").SessionCleanupCandidate[]; selected: string[]; loading: boolean; armed: boolean; message: string | null; staleDays: number } = { candidates: [], selected: [], loading: false, armed: false, message: null, staleDays: 30 };
  /// New breakages, and the worktree fix for them.
  readonly breakage = new BreakageWatch({
    client: () => this.client,
    workspace: () => this.workspace,
    publish: () => this.publish(),
    busy: () => this.busy,
    vetoes: () => (this.drive?.memoryEntries ?? []).filter((entry) => entry.kind === "veto").map((entry) => entry.text),
    veto: (text) => this.drive?.addMemory({ kind: "veto", text, source: "you" }),
    open: (url) => this.open(url),
    applied: () => { void this.refreshFiles().catch(() => {}); void this.refreshProcesses(); },
    closed: (fix) => void this.leaveMission(fix),
    copy: (text) => this.copy(text),
  });
  /// The session you were in when a mission opened its worktree session.
  private missionReturn: string | null = null;
  private missionFinishing = new Set<string>();
  /// The commit of a settled worktree mission, while it is being made.
  missionFinish: Promise<void> | null = null;
  /// Breakage alerts and the open worktree (a mission's) have loaded.
  breakageStarted: Promise<void> = Promise.resolve();
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
  /// The workspace waiting for the user's "Do you trust this folder?" answer.
  untrustedWorkspace: string | null = null;
  private trustWorkspace = false;
  planOnly = false;
  queue = "";
  /** Send now: the queued follow-up goes out as soon as the stopped turn settles. */
  sendQueuedOnStop = false;
  draft = "";
  draftVersion = 0;
  restored = false;
  busy = false;
  theme: string;
  private themeLibrary: ThemeLibrary | null = null;
  get hasSavedTheme() { return this.themeLibrary?.persisted === true; }
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
  private commandCache: { at: number; root: string; commands: SlashCommand[]; customs: CustomCommand[] } | null = null;
  /// Built-ins, then your workflow and custom command files (project ones
  /// win), re-read every few seconds so a new file shows up without a restart.
  slashCommands() {
    const root = this.current?.session.workspace?.root ?? this.workspace;
    if (this.commandCache && this.commandCache.root === root && Date.now() - this.commandCache.at < 3000) return this.commandCache.commands;
    let customs: CustomCommand[] = [], workflows: SlashCommand[] = [];
    try { customs = loadCustomCommands(root); } catch { /* unreadable folders add nothing */ }
    try { workflows = loadWorkflows(root).map(workflowCommand); } catch { /* as above */ }
    const commands = mergeSlashCommands(SLASH_COMMANDS, [...workflows.map((command) => ({ command, body: "", source: "" })), ...customs.filter((custom) => !workflows.some((command) => command.name === custom.command.name))]);
    this.commandCache = { at: Date.now(), root, commands, customs };
    return commands;
  }
  snapshot() {
    return {
      revision: this.revision,
      connection: this.connection,
      error: this.error,
      untrustedWorkspace: this.untrustedWorkspace,
      server: this.client.server,
      session: this.current
        ? {
            id: this.current.session.id,
            title: this.current.session.title,
            workspace: this.current.session.workspace,
            createdAt: this.current.session.createdAt,
            autoApprove: this.current.session.autoApprove === true,
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
      palette: this.themeLibrary?.themes.find(t=>t.name === this.theme)?.colors ?? themeByName(this.theme).colors,
      themes: this.themeLibrary?.themes.map(t=>t.name) ?? themeNames(),
      themeOptions: this.themeLibrary?.themes ?? [],
      themeCanUndo: this.themeLibrary?.canUndo ?? false,
      commands: this.slashCommands(),
      workspace: this.current?.session.workspace?.root ?? this.workspace,
      drive: this.driveState,
      // Drive's project memory for this workspace (shown in Session).
      driveMemory: this.drive?.memoryEntries ?? [],
      providers: this.providers,
      cleanup: this.cleanup,
      breakage: this.breakage.state,
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
  private setThemes(library:ThemeLibrary) {
    // Preserve an initial --theme / terminal appearance override until the
    // user actually saves a selection in the daemon's shared library.
    this.themeLibrary=library.persisted?library:{...library,selected:themeByName(this.theme)};
    this.theme=this.themeLibrary.selected.name;this.publish();
  }
  private async refreshThemes() {this.setThemes(await this.client.themes());}
  async connect() {
    this.connection = "connecting";
    this.error = null;
    this.publish();
    try {
      const health = await this.client.health();
      // Older daemons may not yet have theme persistence. Built-ins still work.
      try { await this.refreshThemes(); } catch {}
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
        this.chatgptAccount = id ? (await new ChatGPTAuth(this.settings.accountDataDirectory ?? this.settings.dataDirectory).accounts()).find(a => a.id === id) ?? null : null;
      } catch { this.chatgptAccount = null; }
      this.sessions = await this.client.listSessions();
      this.connection = "online";
      if (this.selectedSession) await this.select(this.selectedSession);
      else {
        try {
          await this.newSession();
        } catch (error) {
          if (isWorkspaceUntrusted(error)) return;
          throw error;
        }
      }
      // Discovery across providers takes seconds; do it before /model asks.
      if (!this.options.headless) {
        void this.models().catch(() => {});
        this.loadNextHidden();
        void this.refreshNext();
      }
      this.breakageStarted = this.breakage.start().catch(() => {});
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
    let result;
    try {
      result = await this.client.createSession({
        workspacePath: this.workspace,
        title: title ?? `Session ${new Date().toLocaleTimeString()}`,
        ...(this.trustWorkspace ? { trustWorkspace: true } : {}),
      });
    } catch (error) {
      // Every caller (startup, New session, the desktop's project switch)
      // shows the same Trust folder question.
      if (isWorkspaceUntrusted(error)) {
        this.untrustedWorkspace = this.workspace;
        this.publish();
      }
      throw error;
    }
    this.untrustedWorkspace = null;
    await this.select(result.session.id);
    return result.session.id;
  }
  /// Opens a worktree and session for a /drive mission and moves you into
  /// it, so Drive's turns run there and your checkout stays as it is.
  async openMissionWorktree(mission: string) {
    const previous = this.current?.session.id ?? null;
    const fix = await this.breakage.openMission(mission);
    this.missionReturn = previous;
    await this.select(fix.sessionId!);
    void this.refreshSessions();
  }

  /// Drive's state changed: when a worktree mission settles (completed, idle
  /// or stopped), commit what it changed and show it for review.
  missionChanged(state: import("@demesne/protocol").DriveState | null) {
    if (!state || !["completed", "idle", "stopped"].includes(state.status)) return;
    const fix = this.breakage.missionFor(state.homeSessionId);
    const key = `${state.id}:${state.status}:${state.step}`;
    if (!fix || this.missionFinishing.has(key)) return;
    this.missionFinishing.add(key);
    const summary = state.answer || state.completed.join("\n") || state.activity;
    this.missionFinish = this.breakage.finishMission(fix.id, summary, missionReceipt(state, fix));
  }

  /// A mission's worktree is gone: go back to the session you started from.
  private async leaveMission(fix: import("@demesne/protocol").DriveFix) {
    if (this.current?.session.id !== fix.sessionId) return;
    const back = this.missionReturn && this.sessions.some((session) => session.id === this.missionReturn) ? this.missionReturn
      : this.sessions.find((session) => session.id !== fix.sessionId && session.workspace?.root === this.workspace)?.id;
    this.missionReturn = null;
    try { if (back) await this.select(back); else await this.newSession(); }
    catch { /* stay; the session list still has yours */ }
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
        if(event.type === "tool.call_completed" && event.payload.name === "apply_theme")void this.refreshThemes().catch(error=>this.fail(error));
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
          if (!this.options.headless && Date.now() - this.nextRequested > 30 * 60_000) void this.refreshNext();
          // After the turn settles, look for anything it (or anyone) broke.
          setTimeout(() => void this.breakage.check(), 1500);
          const queued = this.queue, now = this.sendQueuedOnStop;
          this.queue = "";
          this.sendQueuedOnStop = false;
          if (queued.trim() && (event.type === "turn.completed" || now)) {
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
            this.draft = this.draft.trim() ? `${queued}\n\n${this.draft}` : queued;
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
  /// Finds sessions worth deleting. The open session (and Drive's) never are.
  async scanCleanup(message: string | null = null) {
    this.cleanup = { ...this.cleanup, loading: true, armed: false, message };
    this.publish();
    try {
      const keep = [this.current?.session.id, this.driveState && ["running", "waiting", "blocked"].includes(this.driveState.status) ? this.driveState.homeSessionId : undefined].filter((id): id is string => Boolean(id));
      const { candidates, staleDays } = await this.client.sessionCleanup(keep);
      this.cleanup = { candidates, selected: candidates.filter((item) => item.suggested).map((item) => item.id), loading: false, armed: false, message, staleDays };
    } catch (error) {
      this.cleanup = { ...this.cleanup, loading: false, message: error instanceof Error ? error.message : String(error) };
    }
    this.publish();
  }
  /// Delete asks twice: the first press arms it, the second deletes.
  async deleteCleanup() {
    const ids = this.cleanup.selected.filter((id) => this.cleanup.candidates.some((item) => item.id === id));
    if (!ids.length) return;
    if (!this.cleanup.armed) { this.cleanup = { ...this.cleanup, armed: true }; return this.publish(); }
    this.cleanup = { ...this.cleanup, loading: true, armed: false };
    this.publish();
    try {
      const { deleted, skipped } = await this.client.deleteSessions(ids);
      await this.refreshSessions();
      await this.scanCleanup(`Deleted ${deleted.length} session${deleted.length === 1 ? "" : "s"}${skipped.length ? `; kept ${skipped.length} (${skipped[0]!.reason})` : ""}.`);
    } catch (error) {
      this.cleanup = { ...this.cleanup, loading: false, message: error instanceof Error ? error.message : String(error) };
      this.publish();
    }
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
  async submit(content: string, planOnly = this.planOnly, permissionMode: "ask" | "allow" = "ask") {
    if (!this.current || this.connection !== "online")
      throw new Error("Connect to the daemon first.");
    if (!content.trim()) return;
    if (this.active) {
      // Enter while a turn runs queues the text as the next message.
      this.queue = this.queue.trim() ? `${this.queue}\n\n${content}` : content;
      this.draft = "";
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
        permissionMode,
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
      this.nextQueue = { proposals: result.proposals, signals: result.signals, generatedAt: result.generatedAt, model: result.model, loading: false, error: null, calibration: result.calibration ?? null };
    } catch (error) {
      this.nextQueue = { ...this.nextQueue, loading: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.publish();
  }
  private accounts() {
    return this.providerAccounts ??= this.options.providerAccounts ?? new ProviderAccounts({ configPath: this.settings.configPath, dataDirectory: this.settings.dataDirectory, accountDataDirectory: this.settings.accountDataDirectory, open: (url) => this.open(url) });
  }
  async refreshProviders(message: string | null = this.providers.message) {
    const generation = this.providerSignInGeneration;
    this.providers = { ...this.providers, loading: true };
    this.publish();
    try {
      const items = await this.accounts().list(this.model.provider);
      if (generation !== this.providerSignInGeneration || this.disposed) return;
      this.providers = { items, signingIn: this.accounts().signingIn, message, loading: false };
    }
    catch (error) {
      if (generation !== this.providerSignInGeneration || this.disposed) return;
      this.providers = { ...this.providers, loading: false, message: error instanceof Error ? error.message : String(error) };
    }
    this.publish();
  }
  /// After signing in or out: the daemon rebuilds its providers, and the
  /// model shown follows it (switching away from a provider you left).
  private async applyProviderChange(done: string, generation?: number) {
    const stale = () => this.disposed || (generation !== undefined && generation !== this.providerSignInGeneration);
    const result = await this.client.reloadProviders();
    if (stale()) return;
    this.modelCache = null;
    const health = await this.client.health();
    if (stale()) return;
    this.reasoning = health.reasoning;
    this.model = { id: health.model, provider: health.provider, ...(health.contextCapacity ? { contextWindow: health.contextCapacity } : {}) };
    let account: ChatGPTAccount | null = null;
    try {
      const id = configuredChatGPTAccount(this.settings.configPath);
      account = id ? (await new ChatGPTAuth(this.settings.accountDataDirectory ?? this.settings.dataDirectory).accounts()).find(a => a.id === id) ?? null : null;
    } catch {}
    if (stale()) return;
    this.chatgptAccount = account;
    await this.refreshProviders(result.restored ? `${done} Back on ${result.model} (${result.provider}).`
      : result.switched ? `${done} Switched to ${result.model} (${result.provider}); signing back in returns you to ${result.previous.model}.` : done);
  }
  private async signOutProvider(key: string) {
    const { label, revoked } = await this.accounts().signOut(key);
    await this.applyProviderChange(`Signed out of ${label}.${revoked === false ? " Remove Demesne in ChatGPT settings to confirm remote revocation." : ""}`);
  }
  private async signInProvider(key: string) {
    const generation = ++this.providerSignInGeneration;
    this.providers = { ...this.providers, signingIn: key, loading: false, message: "Finish signing in in your browser." };
    this.publish();
    try {
      const { label } = await this.accounts().signIn(key);
      if (generation !== this.providerSignInGeneration || this.disposed) return;
      this.providers = { ...this.providers, signingIn: null };
      await this.applyProviderChange(`Signed in to ${label}.`, generation);
    } catch (error) {
      if (generation !== this.providerSignInGeneration || this.disposed) return;
      this.providers = { ...this.providers, signingIn: null, message: error instanceof Error ? error.message : String(error) };
      this.publish();
    }
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
      "trust-workspace",
      "setup",
      "setup-action",
    ]);
    // A draft saved for a session that is no longer current (a workflow or
    // mission that just switched sessions, a keystroke racing a switch) has
    // nowhere to go; dropping it is not an error worth a notice.
    if (method === "draft" && args.sessionId !== this.current?.session.id) return;
    if (!globals.has(method) && args.sessionId !== this.current?.session.id)
      throw new Error("The session changed. Try the action again.");
    if (method === "auto-approve") {
      if (args.driveCommand !== undefined)
        throw new Error("Only you can change session approvals.");
      if (typeof args.autoApprove !== "boolean")
        throw new Error("Invalid auto-approve setting");
      if (!this.current) throw new Error("Choose a session first.");
      const selected = this.current;
      const result = await this.client.updateSession(selected.session.id, {
        autoApprove: args.autoApprove,
      });
      if (result.session.autoApprove !== args.autoApprove)
        throw new Error("The daemon did not apply this approval setting. Restart Demesne to update the daemon.");
      // A session switch during the request must not alter the new selection.
      if (this.current === selected) {
        selected.session.autoApprove = result.session.autoApprove === true;
        this.publish();
      }
      return;
    }
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
    // Away mode: the top proposals run one after another, each in its own
    // worktree, and wait as an inbox for review.
    if (method === "next-away") {
      if (!this.breakage.supported) throw new Error("Away mode needs a newer daemon.");
      const visible = this.snapshot().driveNext.proposals.slice(0, Math.min(AWAY_RUNS, Number(args.count) || AWAY_RUNS));
      if (!visible.length) throw new Error("Nothing in the queue to run.");
      await this.breakage.startAway(visible.map((item) => ({
        proposal: { id: item.id, kind: item.kind, title: item.title, why: item.why, minutes: item.minutes, confidence: item.confidence },
        signals: this.nextQueue.signals.filter((signal) => item.evidence.includes(signal.id)).slice(0, 5),
      })));
      for (const item of visible) this.hideNext(item.id, Date.now() + 6 * 3_600_000);
      return;
    }
    if (["next-run", "next-plan", "next-snooze", "next-never"].includes(method)) {
      const item = this.nextQueue.proposals.find((proposal) => proposal.id === args.id);
      if (!item) throw new Error("That proposal is no longer in the queue.");
      if (method === "next-snooze") return this.hideNext(item.id, Date.now() + 24 * 3_600_000);
      if (method === "next-never") {
        this.drive?.addMemory({ kind: "veto", text: `${item.title}: ${item.why}`, source: "you" });
        return this.hideNext(item.id, "never");
      }
      this.hideNext(item.id, Date.now() + 6 * 3_600_000);
      if (method === "next-plan") return this.submit(`${item.title}. ${item.why}`, true);
      // Run works in its own git worktree, so your checkout and this
      // conversation stay as they are until you apply the result. Outside a
      // git repository (or on an older daemon) it's a bounded mission here.
      if (this.breakage.supported) {
        const cited = this.nextQueue.signals.filter((signal) => item.evidence.includes(signal.id));
        try { return await this.breakage.runProposal({ id: item.id, kind: item.kind, title: item.title, why: item.why, minutes: item.minutes, confidence: item.confidence }, cited); }
        catch (error) {
          if (!/needs a git repository|no commits yet/.test(error instanceof Error ? error.message : "")) {
            this.hideNext(item.id, 0);
            throw error;
          }
        }
      }
      if (!this.drive) throw new Error("Drive is unavailable here.");
      return this.drive.handle("drive", { text: `--bounded ${item.title}. ${item.why}` });
    }
    if (method === "cleanup-scan") return this.scanCleanup();
    if (method === "cleanup-delete") return this.deleteCleanup();
    if (method === "cleanup-toggle") {
      const ids = args.id === "*" ? this.cleanup.candidates.map((item) => item.id) : [string(args.id, "id", 100)];
      const on = args.id === "*" ? this.cleanup.selected.length < this.cleanup.candidates.length : !this.cleanup.selected.includes(ids[0]!);
      const selected = new Set(this.cleanup.selected);
      for (const id of ids) on ? selected.add(id) : selected.delete(id);
      this.cleanup = { ...this.cleanup, selected: [...selected], armed: false, message: null };
      return this.publish();
    }
    if (method.startsWith("breakage-")) return this.breakage.handle(method, args);
    if (method === "providers-refresh") return this.refreshProviders();
    if (method === "provider-signin") return this.signInProvider(string(args.key, "provider", 200));
    if (method === "provider-signout") return this.signOutProvider(string(args.key, "provider", 200));
    if (method === "provider-cancel") { this.providerSignInGeneration++; this.providerAccounts?.cancel(); this.providers = { ...this.providers, signingIn: null, loading: false, message: "Sign-in cancelled." }; this.publish(); return; }
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
    // Only the person sending a message takes over from Drive ("manual" is
    // kept for callers that take over explicitly; typing no longer sends it).
    // Clicking, navigating, opening panels and reading leave it running.
    if (!driven && ["manual", "submit", "plan-submit", "themefy"].includes(method)) {
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
    if (method === "trust-workspace") {
      this.trustWorkspace = true;
      await this.connect();
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
        dataDirectory: this.settings.accountDataDirectory ?? this.settings.dataDirectory,
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
              // Apply the new provider now; an older daemon that can't reload
              // still asks for a restart.
              try { await this.applyProviderChange("Provider setup saved."); }
              catch {
                this.error =
                  "Configuration saved. Restart the daemon when all sessions are idle to apply provider changes.";
                this.publish();
              }
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
    if (method === "custom-command") {
      this.commandCache = null;
      this.slashCommands();
      const name = string(args.name, "command", 100).replace(/^\//, "").toLowerCase();
      const custom = this.commandCache!.customs.find((item) => item.command.name.slice(1).toLowerCase() === name);
      if (!custom) throw new Error(`Unknown command: /${name}`);
      return this.submit(expandCustomCommand(custom, typeof args.argument === "string" ? args.argument : ""));
    }
    if (method === "cancel") return this.interrupt();
    if (method === "queue-action") {
      const action = string(args.action, "queue action", 10);
      if (action === "edit") {
        // Back into the composer, ahead of anything typed since.
        this.draft = this.draft.trim() ? `${this.queue}\n\n${this.draft}` : this.queue;
        this.draftVersion++;
        this.queue = "";
      } else if (action === "drop") this.queue = "";
      else if (action === "now") {
        if (!this.active || !this.queue.trim()) return;
        this.sendQueuedOnStop = true;
        this.publish();
        await this.interrupt();
        return;
      } else throw new Error(`Unknown queue action: ${action}`);
      this.publish();
      return;
    }
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
    // The model scoreboard, across projects, for the model picker.
    if (method === "model-scores") return this.client.modelScoreboard({ days: 30 });
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
    if (method === "themefy") {
      if(args.driveCommand)throw new Error("Only the user can start a theme interview");
      if(!this.current)await this.newSession();
      if(this.current!.active)throw new Error("Wait for the current turn to finish before starting Themefy");
      if(this.themeLibrary && !this.themeLibrary.persisted)this.setThemes(await this.client.selectTheme(this.theme));
      const result=await this.client.themefy(this.current!.session.id,typeof args.preferences === "string"?args.preferences:"");
      this.current!.ensureTurn(result.turn);this.publish();return;
    }
    if (method === "theme-undo") {
      this.setThemes(await this.client.undoTheme());return;
    }
    if (method === "theme") {
      const name = string(args.name, "theme", 100);
      if(this.themeLibrary){this.setThemes(await this.client.selectTheme(name));return;}
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
      // Another session's changes (a worktree branch waiting for review)
      // are read without switching to it.
      const sessionId = typeof args.branchSession === "string" && args.branchSession ? string(args.branchSession, "session id", 200) : this.current!.session.id;
      const key = `${sessionId}:${scope}:${turnId ?? ""}`;
      let review = args.force !== true ? this.reviewCache.get(key) : undefined;
      if (!review) {
        review = await this.client.review(
          sessionId,
          scope,
          turnId,
        );
        this.reviewCache.set(key, review);
      }
      const files = review.files.map((file) => ({
        ...file,
        ...codeDiff(file.before ?? "", file.after ?? ""),
      }));
      if (scope === "turn" && turnId && sessionId === this.current!.session.id)
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
    if (method === "question-action") {
      if (args.driveCommand !== undefined) throw new Error("Only the user can answer or control an interview");
      if (!this.current) throw new Error("Choose a session first");
      const id=string(args.id,"question id",200), selected=this.current!;
      const pending=selected.questions.get(id);
      if (!pending) throw new Error("This question is no longer pending");
      if (pending.revision === undefined) throw new Error("Restart the updated daemon to answer questions in the composer");
      const result=await this.client.questionAction(id,parseQuestionActionRequest(args.action));
      if (this.current === selected) {
        const latest=selected.questions.get(id);
        if (latest && result.question.revision >= (latest.revision ?? 0)) {
          if (["answered","cancelled"].includes(result.question.status)) selected.questions.delete(id);
          else if (result.question.revision > (latest.revision ?? 0) || result.question.draftVersion >= (latest.draftVersion ?? 0)) selected.questions.set(id,result.question);
        }
        this.publish();
      }
      return result;
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
    this.providerSignInGeneration++;
    this.providerAccounts?.cancel();
    if (this.panelWatchTimer) clearInterval(this.panelWatchTimer);
    this.breakage.stop();
    this.drive?.dispose();
    this.setup?.dispose();
    this.disposed = true;
    this.generation++;
    this.stream?.abort();
    if (this.timer) clearTimeout(this.timer);
  }
}
