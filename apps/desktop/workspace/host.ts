import { ChatGPTAuth, type ChatGPTAccount } from "@demesne/chatgpt-auth";
import { configuredChatGPTAccount } from "@demesne/setup/chatgpt-auth.ts";
import { codeDiff } from "@demesne/workbench/change-diff.ts";
import type {
  CommandRecord,
  ReviewScope,
  TurnAttachment,
  WorkspaceFingerprint,
  NearbyAgent,
} from "@demesne/protocol";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { DemesneClient, isStalePermissionResolution, isWorkspaceUntrusted } from "@demesne/client";
import { DEFAULT_AGENT_LIMITS, loadConfig, parseConfigFile, updateUserConfig } from "@demesne/config";
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
  type Session,
  type EventEnvelope,
  type PermissionDecision,
  type ModelDescriptor,
  type WorkspaceFileInfo,
} from "@demesne/protocol";
import { loadCliSettings, type CliSettings } from "@demesne/setup/cli-config.ts";
import {
  createDaemonControlDependencies,
  startDaemon,
  stopDaemon,
} from "@demesne/setup/daemon-control.ts";
import { replaySession } from "@demesne/workbench/history.ts";
import { expandMentions } from "./prompt-editor.ts";
import {
  isPlaceholderTitle,
  titleFromRequest,
} from "./session-title.ts";
import { WorkspaceDrive } from "./drive-controller.ts";
import { ProviderAccounts, type ProviderEntry } from "./providers.ts";
import { BreakageWatch } from "./breakage.ts";
import { missionReceipt } from "@demesne/drive/drive-receipt.ts";
import { expandCustomCommand, loadCustomCommands, mergeSlashCommands, type CustomCommand } from "./custom-commands.ts";
import { loadWorkflows, workflowCommand } from "@demesne/drive/workflows.ts";
import { customizeView, newCustomizable, readCustomizable, writeCustomizable } from "./customize.ts";
import { WorkspaceSetup } from "./setup-controller.ts";
import { pointSourceIn } from "./point-source.ts";
import type { PointPick } from "./point.ts";
import { WorkspaceSession } from "./session-model.ts";
import { lastAsk, waitingAsk, type AwayAsk } from "./away.ts";
import { glanceOf } from "./glance.ts";
import { backState } from "./back-later.ts";
import { DEFAULT_DRIVE_LIMITS } from "@demesne/protocol";
import { SETTINGS_KEYS, type SettingsInfo } from "./settings-page.ts";

export interface WorkspaceHostOptions {
  workspace?: string;
  server?: string;
  sessionId?: string;
  settings?: CliSettings;
  client?: DemesneClient;
  providerAccounts?: Pick<ProviderAccounts, "signingIn" | "list" | "signIn" | "signOut" | "cancel">;
  /// Runs Drive in this host (the desktop window and headless missions).
  drive?: boolean;
  /// Opens on Home: an empty chat, with no project ("plain") or in this
  /// one, using again one left empty, rather than the last chat.
  home?: "plain" | "project";
  /// Desktop hosts use trusted native IPC instead of command-line OS utilities.
  copy?: (text: string) => Promise<void>;
  open?: (path: string) => Promise<void>;
  changed: (snapshot: ReturnType<WorkspaceHost["snapshot"]>) => void;
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

/// How often the sidebar looks in on chats still working in the background.
const BACKGROUND_POLL_MS = 4_000;
/// How often the sidebar looks for other agents (Heartbeat).
const AGENTS_POLL_MS = 15_000;

/** All privileged operations stay here. The web renderer gets snapshots and a
 * fixed set of actions, never a daemon token, shell, arbitrary URL, or filesystem API. */
/// Who is at the keyboard, for the sidebar's foot: the account's full name
/// on macOS, otherwise the login name.
const YOU = (() => {
  try {
    if (process.platform === "darwin") {
      const full = execFileSync("id", ["-F"], { encoding: "utf8", timeout: 1_000 }).trim();
      if (full) return full;
    }
  } catch { /* fall back to the login name */ }
  try { return userInfo().username; } catch { return ""; }
})();
export class WorkspaceHost {
  settings: CliSettings;
  setup: WorkspaceSetup | null = null;
  drive: WorkspaceDrive | undefined;
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
  private providerAccounts: NonNullable<WorkspaceHostOptions["providerAccounts"]> | null = null;
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
  /// Why a mission stopped itself, for its report.
  private missionBlockers = new Map<string, string>();
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
  current: WorkspaceSession | null = null;
  sessions: Session[] = [];
  files: WorkspaceFileInfo[] = [];
  processes: CommandRecord[] = [];
  queuePosition: number | null = null;
  verificationFingerprint: WorkspaceFingerprint | null = null;
  processesError: string | null = null;
  reviewRevision = 0;
  private reviewCache = new Map<
    string,
    import("@demesne/protocol").ReviewResponse
  >();
  private panelWatchTimer: ReturnType<typeof setInterval> | null = null;
  private watching: string | null = null;
  private watchedCommand = "none";
  private polling: Promise<void> | null = null;
  connection: "connecting" | "online" | "offline" = "connecting";
  error: string | null = null;
  /// The workspace waiting for the user's "Do you trust this folder?" answer.
  untrustedWorkspace: string | null = null;
  private trustWorkspace = false;
  planOnly = false;
  /** Images waiting to go with the next message, already uploaded. */
  attachments: TurnAttachment[] = [];
  /** Plan is per chat: each chat keeps the mode it was left in. */
  private plans = new Map<string, boolean>();
  queue = "";
  /** How often this project asked this week, against last week. */
  asks: { thisWeek: number; lastWeek: number } | null = null;
  /** Words sent to the running turn that it hasn't read yet. */
  steers: { id: string; text: string }[] = [];
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
  onAction?: (
    method: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  onEvent?: (event: EventEnvelope) => void;
  onManual?: () => void;
  constructor(private options: WorkspaceHostOptions) {
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
    if (options.drive) this.drive = new WorkspaceDrive(this);
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
    const taken = this.breakage.taken();
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
            acceptEdits: this.current.session.acceptEdits === true,
          }
        : null,
      sessions: this.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        turns: session.turns.length,
        status: session.turns.at(-1)?.status,
        workspace: session.workspace?.root,
        waiting: this.waitingSessions.has(session.id),
        // Home answers what a chat waits on, and picks up the last thing you asked.
        ask: this.waitingAsks.get(session.id) ?? null,
        lastAsk: lastAsk(session.turns),
        ...(session.pinnedAt ? { pinned: true } : {}),
        ...(session.backAt ? { backAt: session.backAt } : {}),
        ...(session.prUrl ? { prUrl: session.prUrl } : {}),
      })),
      runs: this.current?.runs() ?? [],
      cursor: this.current?.cursor ?? 0,
      model: this.model,
      reasoning: this.reasoning,
      chatgptAccount: this.model.provider === "ChatGPT" ? this.chatgptAccount : null,
      you: YOU,
      provider: this.current?.provider ?? null,
      checkpoint: this.current?.state.checkpoint ?? null,
      rewinds: this.current?.rewinds ?? [],
      approvals: [...(this.current?.approvals.values() ?? [])],
      questions: [...(this.current?.questions.values() ?? [])],
      activeTurnId: this.active?.id ?? null,
      busy: this.busy,
      files: this.files,
      planOnly: this.planOnly,
      attachments: this.attachments,
      queue: this.queue,
      steers: this.steers,
      asks: this.asks,
      allowRules: this.settings.loaded.config.permissions.allow.length,
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
          if (taken.has(item.id)) return false;
          const hidden = this.nextHidden[item.id];
          return hidden === undefined || (hidden !== "never" && hidden < Date.now());
        }),
      },
      setup: this.setup?.snapshot() ?? null,
      processes: this.processes,
      agents: this.agents,
      connectors: this.connectors,
      queuePosition: this.queuePosition,
      verificationFingerprint: this.verificationFingerprint,
      processesError: this.processesError,
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
      else if (this.options.home === "plain") await this.newSession(undefined, { plain: true, reuse: true });
      else {
        try {
          await this.newSession(undefined, { reuse: this.options.home === "project" });
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
  private daemonControl() {
    const host = new URL(this.client.server).hostname;
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host))
      throw new Error("Start the remote daemon on its host.");
    const env = { ...process.env };
    const bundled = join(dirname(process.execPath), "../demesned");
    if (!env.DEMESNE_DAEMON_BIN && existsSync(bundled))
      env.DEMESNE_DAEMON_BIN = bundled;
    return createDaemonControlDependencies(
      this.client.server,
      this.settings.dataDirectory,
      env,
    );
  }
  async startDaemon() {
    const result = await startDaemon(this.daemonControl());
    if (!result.health) throw new Error(result.message);
    this.client = new DemesneClient({
      server: this.client.server,
      token: daemonCredential(this.client.server, this.settings.dataDirectory),
    });
    await this.connect();
  }
  /// A plain chat has no project: no files, commands or Drive. With
  /// `reuse`, an empty chat already there is opened rather than piling up.
  async newSession(title?: string, options: { plain?: boolean; reuse?: boolean } = {}) {
    if (options.reuse && !title) {
      const empty = this.sessions.filter((session) => (options.plain ? !session.workspace : session.workspace?.root === this.workspace) && !session.turns.length)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (empty) {
        await this.select(empty.id);
        return empty.id;
      }
    }
    let result;
    try {
      result = await this.client.createSession({
        ...(options.plain ? {} : { workspacePath: this.workspace }),
        title: title ?? `Session ${new Date().toLocaleTimeString()}`,
        ...(this.trustWorkspace && !options.plain ? { trustWorkspace: true } : {}),
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
  /// Opens a worktree and session for a /drive mission. Drive works it in
  /// the background, so you stay in your chat and your checkout stays as it
  /// is; the mission's chat is in the sidebar if you want to watch.
  async openMissionWorktree(mission: string) {
    const previous = this.current?.session.id ?? null;
    const fix = await this.breakage.openMission(mission, previous ?? undefined);
    this.missionReturn = previous;
    // With no window there's nothing to stay in: the host moves into it.
    if (this.options.headless) await this.select(fix.sessionId!);
    else await this.followDriveSession(fix.sessionId!);
    void this.refreshSessions();
  }

  /// The mission's session when it isn't the one you're in: loaded and
  /// followed in the background so Drive can watch and work it.
  driveSession: WorkspaceSession | null = null;
  /// Its commands, for the checks Drive reads.
  driveProcesses: CommandRecord[] = [];
  private driveWatch: AbortController | null = null;
  async followDriveSession(id: string) {
    if (this.driveSession?.session.id === id) return;
    this.stopFollowingDrive();
    const controller = (this.driveWatch = new AbortController());
    const state = await this.client.getSessionState(id);
    const events = await replaySession(
      state,
      (sessionId, after, signal) => this.client.streamEvents(sessionId, after, signal),
      (sessionId, after, through, signal) => this.client.replayPage(sessionId, after, through, signal),
    );
    if (controller.signal.aborted || this.disposed) return;
    const session = (this.driveSession = new WorkspaceSession(state, events));
    const commands = () => void this.client.commands(id).then((result) => { if (this.driveSession === session) this.driveProcesses = result.commands; }).catch(() => {});
    commands();
    void (async () => {
      try {
        for await (const event of this.client.streamEvents(id, session.cursor, controller.signal)) {
          if (controller.signal.aborted) break;
          if (!session.apply(event)) continue;
          this.drive?.agent.workerEvent(event);
          if (event.type === "command.changed" || event.type === "tool.call_completed") commands();
          // Only what changes the sidebar or the Drive line repaints; the
          // mission's streaming text never touches the chat you're in.
          // Drive never waits on you: the one thing its coder still asks
          // for is publishing (a push or a PR), and that is yours to do
          // from the review card, so Drive declines it.
          if (event.type === "permission.requested") for (const approval of session.approvals.values())
            void this.client.resolvePermission(approval.id, "deny").then(() => { session.approvals.delete(approval.id); this.publish(); }).catch(() => {});
          if (/^turn\.|^permission\.|^question\./.test(event.type)) {
            if (event.type.startsWith("turn.")) void this.refreshSessions();
            this.publish();
          }
        }
      } catch {
        if (this.driveSession === session && !controller.signal.aborted) this.stopFollowingDrive();
      }
    })();
  }
  private stopFollowingDrive() {
    this.driveWatch?.abort();
    this.driveWatch = null;
    this.driveSession = null;
    this.driveProcesses = [];
  }
  /// Whether Drive's mission works in the chat you're in.
  get inDriveHome() {
    const home = this.driveState && ["running", "waiting", "blocked", "paused"].includes(this.driveState.status) ? this.driveState.homeSessionId : this.driveSession?.session.id;
    return Boolean(home && home === this.current?.session.id);
  }

  /// Drive's state changed: when a worktree mission settles (completed, idle
  /// or stopped), commit what it changed and show it for review.
  missionChanged(state: import("@demesne/protocol").DriveState | null) {
    if (!state) return;
    const fix = this.breakage.missionFor(state.homeSessionId);
    // Drive never waits on you: a mission that would block ends instead,
    // with why, and its report lands in your chat.
    if (state.status === "blocked" && fix) {
      this.missionBlockers.set(state.id, state.activity);
      queueMicrotask(() => { try { this.drive?.agent.control("stop"); } catch { /* already settled */ } });
      return;
    }
    if (!["completed", "idle", "stopped"].includes(state.status)) return;
    const key = `${state.id}:${state.status}:${state.step}`;
    if (!fix || this.missionFinishing.has(key)) return;
    this.missionFinishing.add(key);
    const blocker = this.missionBlockers.get(state.id);
    const summary = blocker ? `Couldn't finish: ${blocker}` : state.answer || state.completed.join("\n") || state.activity;
    this.missionFinish = this.breakage.finishMission(fix.id, summary, missionReceipt(state, fix));
  }

  /// A mission's worktree is gone: go back to the session you started from.
  private async leaveMission(fix: import("@demesne/protocol").DriveFix) {
    if (this.driveSession?.session.id === fix.sessionId) this.stopFollowingDrive();
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
      // A chat that came back is done coming back once you open it.
      if (backState(state.session.backAt, Date.now(), this.mergedPullRequests.has(id)) === "back") void this.client.updateSession(id, { backAt: null }).then(() => this.refreshSessions()).catch(() => {});
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
      this.current = new WorkspaceSession(state, events);
      this.planOnly = this.plans.get(id) ?? false;
      this.attachments = [];
      this.reviewRevision++;
      this.reviewCache.clear();
      this.processes = [];
      this.verificationFingerprint = null;
      this.processesError = null;
      void this.refreshProcesses();
      this.selectedSession = id;
      this.queue = "";
      this.steers = [];
      void this.refreshAsks();
      this.draft = this.drafts.get(id) ?? "";
      this.draftVersion++;
      this.restored = false;
      this.files = [];
      this.busy = false;
      this.error = null;
      this.publish();
      const controller = (this.stream = new AbortController());
      void this.watch(id, generation, controller);
      void this.refreshFiles().catch(() => {});
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
        if (event.type === "turn.steered") this.steers = this.steers.filter((steer) => steer.id !== event.payload.steerId);
        if(event.type === "tool.call_completed" && event.payload.name === "apply_theme")void this.refreshThemes().catch(error=>this.fail(error));
        this.onEvent?.(event);
        this.drive?.agent.workerEvent(event);
        if (
          event.type === "turn.reverted" ||
          event.type === "session.rewound" ||
          event.type === "session.rewind_redone" ||
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
        if (/^tool\.call_(completed|failed)$/.test(event.type))
          void this.refreshFiles().catch(() => {});
        if (
          /^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)
        ) {
          if (!this.options.headless && Date.now() - this.nextRequested > 30 * 60_000) void this.refreshNext();
          // After the turn settles, look for anything it (or anyone) broke.
          setTimeout(() => void this.breakage.check(), 1500);
          // Words the turn ended before reading go out as the next message.
          const late = this.steers.map((steer) => steer.text).join("\n\n");
          this.steers = [];
          const queued = [late, this.queue].filter((text) => text.trim()).join("\n\n"), now = this.sendQueuedOnStop;
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
          void this.refreshAsks();
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
      if (!this.agentsStarted) void this.refreshAgents();
      await this.checkBackground();
      this.publish();
    } catch {}
  }
  /// Other agents Heartbeat sees, placed on their projects' lines.
  agents: NearbyAgent[] = [];
  /// MCP servers and whether Heartbeat is on, for the Connectors card.
  connectors: { servers: { name: string; state: "starting" | "ready" | "failed"; tools: number }[]; heartbeat: boolean } = { servers: [], heartbeat: false };
  private agentsTimer: ReturnType<typeof setTimeout> | null = null;
  private agentsStarted = false;
  async refreshAgents() {
    this.agentsStarted = true;
    if (this.agentsTimer) clearTimeout(this.agentsTimer);
    this.agentsTimer = null;
    try {
      const { agents } = await this.client.heartbeatAgents();
      if (JSON.stringify(agents) !== JSON.stringify(this.agents)) {
        this.agents = agents;
        this.publish();
      }
    } catch { /* an older daemon, or Heartbeat is off */ }
    try {
      const connectors = await this.client.connectors();
      if (JSON.stringify(connectors) !== JSON.stringify(this.connectors)) {
        this.connectors = connectors;
        this.publish();
      }
    } catch { /* an older daemon */ }
    if (!this.disposed) {
      this.agentsTimer = setTimeout(() => void this.refreshAgents(), AGENTS_POLL_MS);
      this.agentsTimer.unref?.();
    }
  }
  /// Always: the rule goes into your config and is allowed from now on.
  private saveAllowRule(rule: string | null | undefined) {
    if (!rule) throw new Error("This operation cannot create a persistent rule.");
    const allow = this.settings.loaded.config.permissions.allow;
    if (!allow.includes(rule)) {
      updateUserConfig(this.settings.configPath, { permissions: { allow: [...allow, rule] } });
      allow.push(rule);
    }
  }
  /// Settings the daemon reads only when it starts, changed since it did.
  private restartFor = new Set<string>();
  /// Reads config.toml again after Settings wrote it; where the daemon and
  /// its data live stays as it was.
  private reloadSettings() {
    this.settings = { ...this.settings, loaded: loadConfig({ workspaceRoot: this.workspace }) };
  }
  /// The document in your own config.toml, not the project's.
  private userConfig(): Record<string, unknown> {
    try { return existsSync(this.settings.configPath) ? parseConfigFile(this.settings.configPath) : {}; }
    catch { return {}; }
  }
  private userAllowRules(): string[] {
    const permissions = this.userConfig().permissions;
    return isRecord(permissions) && Array.isArray(permissions.allow) ? permissions.allow.filter((rule): rule is string => typeof rule === "string") : [];
  }
  /// Everything Settings shows that lives in config.toml or the daemon.
  private async settingsInfo(): Promise<SettingsInfo> {
    const config = this.settings.loaded.config, mine = new Set(this.userAllowRules());
    const user = this.userConfig(), userMcp = isRecord(user.mcp) && isRecord(user.mcp.servers) ? user.mcp.servers : {};
    const [trusted, subagent] = await Promise.all([
      this.client.trusted().then((result) => result.trusted).catch(() => null),
      this.client.subagentModel().catch(() => null),
    ]);
    const limits = config.drive ?? {};
    return {
      home: homedir(),
      configPath: this.settings.configPath,
      dataDirectory: this.settings.dataDirectory,
      server: this.client.server,
      allow: config.permissions.allow.map((rule) => ({ rule, mine: mine.has(rule) })),
      trusted,
      subagent: subagent ? { model: subagent.model, models: subagent.models } : { model: config.agent?.subagentModel ?? null, models: [] },
      agent: { maxModelRounds: config.agent?.maxModelRounds ?? DEFAULT_AGENT_LIMITS.maxModelRounds, maxToolCalls: config.agent?.maxToolCalls ?? DEFAULT_AGENT_LIMITS.maxToolCalls, proofMarks: config.agent?.proofMarks !== false },
      drive: { maxActiveMinutes: limits.maxActiveMinutes ?? DEFAULT_DRIVE_LIMITS.maxActiveMinutes, maxTokens: limits.maxTokens ?? DEFAULT_DRIVE_LIMITS.maxTokens, maxTasks: limits.maxTasks ?? DEFAULT_DRIVE_LIMITS.maxTasks },
      images: config.images?.url ? { model: config.images.model ?? null } : null,
      heartbeat: config.heartbeat?.enabled !== false,
      mcp: Object.entries(config.mcp.servers).map(([name, server]) => ({ name, command: [server.command, ...(server.args ?? [])].join(" "), mine: name in userMcp })),
      restart: [...this.restartFor],
    };
  }
  /// Chats in the background that wait on an approval or an answer: the
  /// sidebar marks them amber, as it does the open one.
  waitingSessions = new Set<string>();
  /// Chats whose pull request has merged, for "when its PR merges".
  private readonly mergedPullRequests = new Set<string>();
  /// What each of them waits on, for Home.
  waitingAsks = new Map<string, AwayAsk>();
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  /// While another chat of this project is still working, look in on it now
  /// and then, so the sidebar shows when it asks for you or settles.
  private async checkBackground() {
    // This project's chats, and the ones Drive runs on their own branch.
    const branched = new Set([this.breakage.state.fix, ...this.breakage.state.inbox].map((job) => job?.sessionId).filter(Boolean));
    const busy = this.sessions.filter((session) => session.id !== this.current?.session.id && (session.workspace?.root === this.workspace || branched.has(session.id)) && ["running", "queued"].includes(session.turns.at(-1)?.status ?? ""));
    const waiting = new Set<string>(), asks = new Map<string, AwayAsk>();
    await Promise.all(busy.map(async (session) => {
      try {
        const state = await this.client.getSessionState(session.id);
        if (state.pendingPermissions.length || state.pendingQuestions?.length) waiting.add(session.id);
        const ask = waitingAsk(state.pendingPermissions, state.pendingQuestions);
        if (ask) asks.set(session.id, ask);
      } catch {}
    }));
    this.waitingSessions = waiting;
    this.waitingAsks = asks;
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = busy.length && !this.disposed ? setTimeout(() => { this.backgroundTimer = null; void this.refreshSessions(); }, BACKGROUND_POLL_MS) : null;
  }
  private loadingFiles: Promise<void> | null = null;
  async refreshFiles() {
    if (this.loadingFiles) return this.loadingFiles;
    const id = this.current?.session.id;
    // A chat with no project has no files or commands to list.
    if (!id || !this.current?.session.workspace) return;
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
  /// The start screen's "Asked you N times this week" line.
  private async refreshAsks() {
    const workspace = this.workspace;
    if (!workspace) { this.asks = null; return; }
    try {
      const asks = await this.client.permissionAsks(workspace);
      if (this.workspace !== workspace) return;
      if (JSON.stringify(asks) !== JSON.stringify(this.asks)) { this.asks = asks; this.publish(); }
    } catch { /* an older daemon; the line stays away */ }
  }
  async submit(content: string, planOnly = this.planOnly, permissionMode: "ask" | "allow" = "ask", fromDrive = false, wait = false) {
    if (!this.current || this.connection !== "online")
      throw new Error("Connect to the daemon first.");
    if (!content.trim() && this.attachments.length) content = "Take a look at the attached image.";
    if (!content.trim()) return;
    if (this.active && !wait && !fromDrive && !this.attachments.length && this.active.kind !== "compaction" && this.active.kind !== "themefy") {
      // Enter while a turn runs steers it: the model reads the words after
      // its current step. If the turn has already ended, they queue.
      const steer = { id: crypto.randomUUID(), text: content.trim() };
      this.steers = [...this.steers, steer];
      this.draft = "";
      this.draftVersion++;
      this.publish();
      try {
        await this.client.steer(this.current.session.id, steer);
        return { steered: true };
      } catch {
        if (!this.steers.some((item) => item.id === steer.id)) return { steered: true };
        // It ended first (or can't take words): queue them, or send them now.
        this.steers = this.steers.filter((item) => item.id !== steer.id);
      }
    }
    if (this.active) {
      // ⌥↵ while a turn runs queues the text as the next message.
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
      // Drive's request never carries the images you were about to send.
      const attached = fromDrive ? [] : this.attachments;
      const result = await this.client.submitTurn(id, {
        content: expanded,
        permissionMode,
        planOnly,
        ...(fromDrive ? { fromDrive } : {}),
        ...(attached.length ? { attachmentIds: attached.map((image) => image.id) } : {}),
      });
      if (this.current?.session.id === id) this.attachments = this.attachments.filter((image) => !attached.includes(image));
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
    if (!id || !this.current?.session.workspace) return;
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
        // A background command that just started may not have printed the
        // address it serves yet; look again briefly so its preview appears.
        if (!this.panelWatchTimer && result.commands.some((command) => command.background && command.status === "running" && !command.serves && Date.now() - Date.parse(command.startedAt) < 60_000))
          setTimeout(() => void this.refreshProcesses(), 1000).unref?.();
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
      "foundry-list",
      "foundry-get",
    ]);
    // A draft saved for a session that is no longer current (a workflow or
    // mission that just switched sessions, a keystroke racing a switch) has
    // nowhere to go; dropping it is not an error worth a notice.
    if (method === "draft" && args.sessionId !== this.current?.session.id) return;
    if (!globals.has(method) && args.sessionId !== this.current?.session.id)
      throw new Error("The session changed. Try the action again.");
    if (method === "auto-approve") {
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
    // Drive on by default: the one switch per project.
    if (method === "drive-auto") {
      if (!this.breakage.supported) throw new Error("Drive on its own needs a newer daemon.");
      return this.breakage.setAuto(args.on === true);
    }
    if (["next-run", "next-plan", "next-snooze", "next-never"].includes(method)) {
      // Drive may have just started this idea on its own: look before starting it twice.
      if (method === "next-run" || method === "next-plan") await this.breakage.refreshAuto().catch(() => {});
      const item = this.snapshot().driveNext.proposals.find((proposal) => proposal.id === args.id);
      if (!item) {
        this.publish();
        throw new Error(this.breakage.taken().has(String(args.id)) ? "Drive is already working on that one." : "That proposal is no longer in the queue.");
      }
      if (method === "next-snooze") return this.hideNext(item.id, Date.now() + 24 * 3_600_000);
      if (method === "next-never") {
        this.drive?.addMemory({ kind: "veto", text: `${item.title}: ${item.why}`, source: "you" });
        return this.hideNext(item.id, "never");
      }
      // Plan writes its read-only plan in a chat of its own: yours, your
      // draft and its context stay as they are, and Drive keeps going.
      if (method === "next-plan") {
        if (this.connection !== "online") throw new Error("Connect to the daemon first.");
        const { session } = await this.client.createSession({
          workspacePath: this.workspace,
          title: titleFromRequest(item.title),
          ...(this.trustWorkspace ? { trustWorkspace: true } : {}),
        });
        const { turn } = await this.client.submitTurn(session.id, { content: `${item.title}. ${item.why}`, permissionMode: "ask", planOnly: true });
        this.hideNext(item.id, Date.now() + 6 * 3_600_000);
        void this.refreshSessions();
        return { sessionId: session.id, turnId: turn.id };
      }
      // Run works in its own git worktree, so your checkout and this
      // conversation stay as they are until you apply the result. Outside a
      // git repository (or on an older daemon) it's a bounded mission here.
      if (this.breakage.supported) {
        const cited = this.nextQueue.signals.filter((signal) => item.evidence.includes(signal.id));
        try {
          const result = await this.breakage.runProposal({ id: item.id, kind: item.kind, title: item.title, why: item.why, minutes: item.minutes, confidence: item.confidence }, cited);
          this.hideNext(item.id, Date.now() + 6 * 3_600_000);
          return result;
        }
        catch (error) {
          if (!/needs a git repository|no commits yet/.test(error instanceof Error ? error.message : "")) {
            throw error;
          }
        }
      }
      if (!this.drive) throw new Error("Drive is unavailable here.");
      const result = await this.drive.handle("drive", { text: `--bounded ${item.title}. ${item.why}` });
      this.hideNext(item.id, Date.now() + 6 * 3_600_000);
      return result;
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
    // Only the person sending a message takes over from Drive ("manual" is
    // kept for callers that take over explicitly; typing no longer sends it).
    // Clicking, navigating, opening panels and reading leave it running.
    // A mission in the background keeps going while you talk in your own chat.
    if (method === "manual" || (["submit", "plan-submit", "themefy"].includes(method) && (!this.driveSession || this.inDriveHome))) {
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
      // Trust was asked for a chat in this project, not the plain one open.
      if (this.connection === "online" && !this.current?.session.workspace) await this.newSession();
      return this.snapshot();
    }
    if (method === "new-session") {
      // Picking where a chat lives on Home takes what you typed with it.
      const carried = typeof args.draft === "string" ? args.draft : undefined;
      if (carried !== undefined && this.current) { this.draft = ""; this.drafts.delete(this.current.session.id); }
      const id = await this.newSession(
        typeof args.title === "string" ? args.title : undefined,
        { plain: args.plain === true, reuse: args.reuse === true },
      );
      if (carried !== undefined) this.carryDraft(carried);
      return id;
    }
    if (method === "move-session") {
      // A plain chat gains a folder and keeps its messages.
      const path = string(args.path, "project path", 4096), current = this.current;
      if (!current || current.session.workspace) throw new Error("Only a chat that isn't in a project can move");
      try { await this.client.updateSession(current.session.id, { workspacePath: path }); }
      catch (error) {
        if (isWorkspaceUntrusted(error)) throw new Error(`Open ${path} as a project and trust it before moving a chat there.`);
        throw error;
      }
      this.sessions = await this.client.listSessions();
      const here = this.sessions.find((session) => session.id === current.session.id)?.workspace?.root === this.workspace;
      if (here) await this.select(current.session.id);
      return { here, sessionId: current.session.id };
    }
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
      this.setup = new WorkspaceSetup({
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
    if (method === "submit") return this.submit(string(args.text, "prompt"), this.planOnly, "ask", false, args.wait === true);
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
      if (this.current) this.plans.set(this.current.session.id, this.planOnly);
      this.publish();
      return;
    }
    // An image pasted, dropped or picked in the composer: uploaded now, sent
    // with the next message.
    if (method === "attach") {
      if (!this.current) throw new Error("Choose a session first.");
      if (typeof args.data !== "string" || typeof args.mimeType !== "string" || typeof args.name !== "string") throw new Error("Invalid image");
      if (this.attachments.length >= 6) throw new Error("A message can carry at most 6 images.");
      const selected = this.current;
      const artifact = await this.client.uploadAttachment(selected.session.id, Buffer.from(args.data, "base64"), args.mimeType, args.name);
      if (this.current !== selected) return;
      const image = { id: artifact.id, filename: artifact.filename, width: artifact.width, height: artifact.height };
      this.attachments = [...this.attachments, image];
      this.publish();
      return image;
    }
    if (method === "detach") {
      this.attachments = this.attachments.filter((image) => image.id !== args.id);
      this.publish();
      return;
    }
    // The composer's mode word: Ask, Accept edits, Plan or Auto, for this chat.
    if (method === "permission-mode") {
      const mode = args.mode;
      if (mode !== "ask" && mode !== "edits" && mode !== "plan" && mode !== "auto") throw new Error("Invalid mode");
      if (!this.current) throw new Error("Choose a session first.");
      const selected = this.current, id = selected.session.id;
      const patch: { autoApprove?: boolean; acceptEdits?: boolean } = {};
      if ((selected.session.autoApprove === true) !== (mode === "auto")) patch.autoApprove = mode === "auto";
      if ((selected.session.acceptEdits === true) !== (mode === "edits")) patch.acceptEdits = mode === "edits";
      if (patch.autoApprove !== undefined || patch.acceptEdits !== undefined) {
        const result = await this.client.updateSession(id, patch);
        if ((result.session.autoApprove === true) !== (mode === "auto") || (result.session.acceptEdits === true) !== (mode === "edits"))
          throw new Error("The daemon did not apply this mode. Restart Demesne to update the daemon.");
        selected.session.autoApprove = result.session.autoApprove === true;
        selected.session.acceptEdits = result.session.acceptEdits === true;
      }
      this.plans.set(id, mode === "plan");
      if (this.current === selected) this.planOnly = mode === "plan";
      this.publish();
      return;
    }
    if (method === "models") return this.models();
    // The model scoreboard, across projects, for the model picker.
    // Point at it: where an element picked in the live preview is written.
    if (method === "point-source") {
      const root = this.current?.session.workspace?.root ?? this.workspace;
      return root ? pointSourceIn(root, args.pick as PointPick) : null;
    }
    if (method === "model-scores") return this.client.modelScoreboard({ days: 30 });
    if (method === "plan-limits") return (await this.client.planLimits()).limits;
    // Rest on a chat: its card, read from that chat's own state.
    // Its pull request on the row: what gh last said about the chats' PRs.
    if (method === "session-prs") {
      const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string" && id.length <= 200).slice(0, 100) : [];
      if (!ids.length) return {};
      const { pullRequests } = await this.client.sessionPullRequests(ids, args.fresh === true);
      for (const [id, pr] of Object.entries(pullRequests)) pr.state === "merged" ? this.mergedPullRequests.add(id) : this.mergedPullRequests.delete(id);
      return pullRequests;
    }
    if (method === "session-glance") {
      const id = string(args.id, "id", 200);
      const [state, changes] = await Promise.all([this.client.getSessionState(id), this.client.changes(id).then((response) => response.changes).catch(() => null)]);
      return glanceOf(state, changes);
    }
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
      // The context size has to follow the switch: when the list doesn't
      // say, the daemon knows the active model's.
      if (!this.model.contextWindow) {
        const health = await this.client.health().catch(() => null);
        if (health?.contextCapacity && health.model.split("/").at(-1) === id.split("/").at(-1))
          this.model = { ...this.model, contextWindow: health.contextCapacity };
      }
      if (this.current)
        await this.client.updateSession(this.current.session.id, {
          preferredModel: id,
        });
      this.publish();
      return;
    }
    if (method === "themefy") {
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
      if (decision === "allow_always") this.saveAllowRule(approval.rule);
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
    // Home answers a chat in the background without opening it.
    if (method === "away-permission") {
      const sessionId = string(args.session, "session", 200), id = string(args.id, "permission id", 200),
        decision = string(args.decision, "decision", 50) as PermissionDecision,
        ask = this.waitingAsks.get(sessionId);
      if (ask?.kind !== "permission" || ask.id !== id) throw new Error("This permission is no longer pending.");
      if (!["allow_once", "allow_always", "deny"].includes(decision)) throw new Error("Invalid permission decision");
      if (decision === "allow_always") this.saveAllowRule(ask.rule);
      try {
        await this.client.resolvePermission(id, decision);
      } finally {
        this.waitingAsks.delete(sessionId);
        this.waitingSessions.delete(sessionId);
        this.publish();
        void this.refreshSessions();
      }
      return;
    }
    if (method === "question-action") {
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
      // The sidebar renames any chat in place; the menu renames this one.
      const id = args.id === undefined ? this.current!.session.id : string(args.id, "session", 200);
      await this.client.updateSession(id, { title });
      if (id === this.current?.session.id) this.current.session.title = title;
      await this.refreshSessions();
      return;
    }
    // Scheduled: routines, each one sentence; a new one belongs to this
    // window's project, or to no project in a plain chat.
    if (method === "routines") return (await this.client.routines()).routines;
    if (method === "routine-add") {
      const plain = Boolean(this.current && !this.current.session.workspace);
      return (await this.client.addRoutine(string(args.text, "routine", 2000), plain ? null : this.current?.session.workspace?.root ?? this.workspace)).routines;
    }
    if (method === "routine-set") return (await this.client.setRoutine(string(args.id, "routine", 200), args.on === true)).routines;
    if (method === "routine-remove") return (await this.client.removeRoutine(string(args.id, "routine", 200))).routines;
    // Foundry: what the agent made. The list and a source are read by the
    // window and by the viewer frame (which has no session).
    if (method === "foundry-list") return (await this.client.foundryList()).artifacts;
    if (method === "foundry-get") return this.client.foundryGet(string(args.id, "artifact", 200), typeof args.version === "number" && Number.isSafeInteger(args.version) && args.version > 0 ? args.version : undefined);
    if (method === "foundry-rename") return this.client.foundryRename(string(args.id, "artifact", 200), string(args.title, "title", 200));
    if (method === "foundry-delete") return this.client.foundryDelete(string(args.id, "artifact", 200));
    if (method === "foundry-save") return this.client.foundrySave({ id: string(args.id, "artifact", 200), source: string(args.source, "source", 520_000), note: "Edited by you" });
    // Make something: a new chat in this window's place, asked to use Foundry.
    if (method === "foundry-make") {
      const text = string(args.text, "request", 4000).trim();
      if (!text) throw new Error("Describe what to make");
      const plain = Boolean(this.current && !this.current.session.workspace);
      await this.newSession(undefined, { plain, reuse: true });
      await this.submit(`Create in Foundry: ${text}`, false, "ask");
      return this.snapshot();
    }
    // Revise: the composer of the open chat gets a line naming the artifact.
    if (method === "foundry-revise") {
      this.carryDraft(`Revise the Foundry artifact "${string(args.title, "title", 200)}" (id ${string(args.id, "artifact", 200)}): `);
      return;
    }
    // Customize: this project's instructions, commands and workflows, read
    // and written in place; a plain chat has only yours.
    if (method === "customize" || method === "customize-read" || method === "customize-save" || method === "customize-new") {
      const root = this.current && !this.current.session.workspace ? null : this.current?.session.workspace?.root ?? this.workspace;
      if (method === "customize") return customizeView(root);
      if (method === "customize-read") return { text: readCustomizable(string(args.path, "path", 4096), root) };
      if (method === "customize-new") return { path: newCustomizable(args.kind === "workflow" ? "workflow" : "command", string(args.name, "name", 80), root) };
      if (typeof args.text !== "string") throw new Error("Expected the file's text");
      writeCustomizable(string(args.path, "path", 4096), args.text, root);
      this.commandCache = null;
      this.publish();
      return customizeView(root);
    }
    // Bring it back later: off the list until then; null brings it back now.
    if (method === "bring-back") {
      const at = args.at === null ? null : string(args.at, "at", 40);
      await this.client.updateSession(string(args.id, "session", 200), { backAt: at });
      await this.refreshSessions();
      return;
    }
    if (method === "pin") {
      await this.client.updateSession(string(args.id, "session", 200), { pinned: args.pinned === true });
      await this.refreshSessions();
      return;
    }
    // All chats: the archived ones, newest first, and Restore.
    if (method === "archived-list") {
      return { sessions: (await this.client.listArchivedSessions()).map((session) => ({ id: session.id, title: session.title, archivedAt: session.archivedAt ?? session.updatedAt, updatedAt: session.updatedAt, turns: session.turns.length, workspace: session.workspace?.root })) };
    }
    if (method === "restore") {
      await this.client.restoreSession(string(args.id, "session", 200));
      await this.refreshSessions();
      return;
    }
    if (method === "archive") {
      // Another conversation (from the sidebar) is archived in place; the
      // open one is archived and replaced by a new chat.
      const id = typeof args.id === "string" ? args.id : this.current!.session.id;
      if (id !== this.current?.session.id) {
        await this.client.archiveSession(id);
        await this.refreshSessions();
        return;
      }
      await this.client.archiveSession(id);
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
    if (method === "rewind" || method === "rewind-redo") {
      if (this.active) throw new Error("Wait for the current turn before rewinding.");
      const id = this.current!.session.id;
      const result = method === "rewind"
        ? await this.client.rewind(id, { turnId: String(args.turnId), ...(typeof args.toolCallId === "string" ? { toolCallId: args.toolCallId } : {}) })
        : await this.client.redoRewind(id);
      await this.refreshFiles();
      await this.refreshProcesses();
      this.publish();
      return result;
    }
    // A proof mark: Prove it, Drop the sentence, Correct the sentence.
    if (method === "proof") {
      const action = args.action === "drop" ? "drop" : args.action === "correct" ? "correct" : "check";
      return this.client.proofAction(this.current!.session.id, string(args.turnId, "turn", 200), string(args.claimId, "claim", 64), { action });
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
    if (method === "settings-info") return this.settingsInfo();
    // One setting from Settings, written to your config.toml.
    if (method === "settings-config") {
      const key = string(args.key, "setting", 80), spec = SETTINGS_KEYS[key];
      if (!spec) throw new Error("Unknown setting");
      const value = args.value;
      if (value === null ? !spec.clear : spec.kind === "bool" ? typeof value !== "boolean"
        : spec.kind === "int" ? !(typeof value === "number" && Number.isInteger(value) && value > 0 && value <= spec.max!)
        : !(typeof value === "string" && value.trim() && value.length <= 200)) throw new Error(spec.kind === "int" ? `Type a whole number from 1 to ${spec.max!.toLocaleString("en-US")}.` : "Invalid value");
      const [section, field] = key.split(".") as [string, string];
      updateUserConfig(this.settings.configPath, { [section]: { [field]: typeof value === "string" ? value.trim() : value } });
      this.reloadSettings();
      if (spec.restart) this.restartFor.add(key);
      return this.settingsInfo();
    }
    if (method === "subagent-model") {
      const model = args.model === null ? null : string(args.model, "model", 200);
      await this.client.setSubagentModel(model);
      this.reloadSettings();
      return this.settingsInfo();
    }
    // Ask again: a rule it learned from your yeses goes back to asking.
    if (method === "allow-rule-remove") {
      const rule = string(args.rule, "rule", 2000);
      const mine = this.userAllowRules();
      if (!mine.includes(rule)) throw new Error("This rule is in the project's config; remove it there.");
      updateUserConfig(this.settings.configPath, { permissions: { allow: mine.filter((item) => item !== rule) } });
      this.reloadSettings();
      return this.settingsInfo();
    }
    if (method === "trusted-forget") {
      await this.client.forgetTrusted(string(args.root, "folder", 4096));
      return this.settingsInfo();
    }
    // A connector: an MCP server the daemon starts, written as a command line.
    if (method === "mcp-add" || method === "mcp-remove") {
      const name = string(args.name, "name", 64).trim();
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw new Error("A name is letters, digits and dashes, like github.");
      if (method === "mcp-add") {
        const words = string(args.command, "command", 2000).trim().split(/\s+/).filter(Boolean);
        if (!words.length) throw new Error("Type the command that starts the server.");
        updateUserConfig(this.settings.configPath, { mcp: { servers: { [name]: { command: words[0], ...(words.length > 1 ? { args: words.slice(1) } : {}) } } } });
      } else updateUserConfig(this.settings.configPath, { mcp: { servers: { [name]: null } } });
      this.reloadSettings();
      this.restartFor.add(`mcp.${name}`);
      return this.settingsInfo();
    }
    // Stops and starts the daemon so it reads config.toml again. Never while
    // a turn or Drive is working: restarting would cut it off.
    if (method === "restart-daemon") {
      const busy = this.sessions.some((session) => ["running", "queued"].includes(session.turns.at(-1)?.status ?? ""))
        || (this.driveState && ["running", "waiting", "blocked"].includes(this.driveState.status));
      if (busy) throw new Error("Something is working. Restart the daemon when it is done.");
      const control = this.daemonControl();
      const stopped = await stopDaemon(control);
      if (!stopped.stopped && stopped.message !== "Daemon is not running.") throw new Error(stopped.message);
      await this.startDaemon();
      this.restartFor.clear();
      return this.settingsInfo();
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
      ["drive", "drive-control", "drive-tell", "manual"].includes(
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
  /// Puts text into the open chat's composer, as if typed there.
  carryDraft(text: string) {
    if (!text.trim()) return;
    this.draft = text;
    this.draftVersion++;
    this.restored = false;
    this.publish();
  }
  get hasUnsentDrafts() {
    return Boolean(this.draft.trim() || this.queue.trim()) ||
      [...this.drafts].some(([id, text]) => id !== this.current?.session.id && text.trim() && this.sessions.some(session => session.id === id));
  }
  dispose() {
    this.providerSignInGeneration++;
    this.providerAccounts?.cancel();
    if (this.panelWatchTimer) clearInterval(this.panelWatchTimer);
    this.breakage.stop();
    this.drive?.dispose();
    this.stopFollowingDrive();
    this.setup?.dispose();
    this.disposed = true;
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    if (this.agentsTimer) clearTimeout(this.agentsTimer);
    this.generation++;
    this.stream?.abort();
    if (this.timer) clearTimeout(this.timer);
  }
}
