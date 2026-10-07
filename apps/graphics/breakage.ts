import type { DemesneClient } from "@demesne/client";
import type { DriveAway, DriveAwayRequest, DriveFix, DriveFixAction, DriveFixProposal, DriveSignal } from "@demesne/protocol";

/// Breakage alerts: notices when something newly breaks (a check starts
/// failing, CI on the default branch turns red, an open PR's CI fails) and
/// offers to fix it in a git worktree. Only transitions alert: whatever was
/// already broken when demesne opened stays in Drive's Next queue. Nothing
/// costs tokens until you choose Fix. Next proposals you Run and /drive
/// missions use the same worktree and card.

export interface BreakageState {
  /// Newly broken, waiting for Fix / Not now / Never.
  signals: DriveSignal[];
  /// The fix being made, or ready for review.
  fix: DriveFix | null;
  /// Other finished work waiting for review (an away run leaves several).
  inbox: DriveFix[];
  /// The latest away run: proposals worked one after another while you're away.
  away: DriveAway | null;
  /// The action in flight (fix, apply, pr, discard).
  busy: string | null;
  /// The outcome of the last action, or why it failed.
  message: { text: string; tone: "ok" | "error"; url?: string } | null;
}

const LOCAL_EVERY = 2 * 60_000, GITHUB_EVERY = 5 * 60_000, FIX_EVERY = 3000;
const OPEN = new Set(["starting", "running", "ready", "failed"]);
export const neverAlert = (signal: Pick<DriveSignal, "title">) => `Never alert: ${signal.title}`;

export class BreakageWatch {
  state: BreakageState = { signals: [], fix: null, inbox: [], away: null, busy: null, message: null };
  /// Urgent signals at the last check; null until the first (the baseline).
  private seen: Map<string, DriveSignal> | null = null;
  private lastGitHub = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fixTimer: ReturnType<typeof setTimeout> | null = null;
  private awayTimer: ReturnType<typeof setTimeout> | null = null;
  private dismissedAway: string | null = null;
  private checking = false;
  private unsupported = false;

  constructor(private readonly options: {
    client: () => DemesneClient;
    workspace: () => string;
    publish: () => void;
    /// A turn is running here: alerts wait for a pause.
    busy: () => boolean;
    vetoes: () => string[];
    veto: (text: string) => void;
    open: (url: string) => Promise<void>;
    /// The checkout changed (a fix was applied).
    applied: () => void;
    /// A mission's worktree was applied, opened as a PR or discarded.
    closed?: (fix: DriveFix) => void;
    /// Copies text to the clipboard (a mission's receipt).
    copy?: (text: string) => Promise<void>;
  }) {}

  async start() {
    this.stop();
    this.seen = null; this.lastGitHub = 0; this.unsupported = false;
    try {
      await this.refreshOpen();
      if (this.state.fix && ["starting", "running"].includes(this.state.fix.status) && !this.state.fix.mission) this.watchFix();
    } catch { this.unsupported = true; return; }
    if (this.state.away?.status === "running") this.watchAway();
    this.options.publish();
    await this.check();
    this.timer = setInterval(() => void this.check(), LOCAL_EVERY);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.fixTimer) clearTimeout(this.fixTimer);
    if (this.awayTimer) clearTimeout(this.awayTimer);
    this.timer = this.fixTimer = this.awayTimer = null;
  }

  /// Reloads the open worktree work: the one on the card (running first, else
  /// the one already shown, else the newest), and the rest as an inbox.
  private async refreshOpen() {
    const client = this.options.client(), workspace = this.options.workspace();
    const { fixes } = await client.driveFixes(workspace);
    let away: DriveAway | null = null;
    try { away = (await client.driveAway(workspace)).away; } catch { /* an older daemon */ }
    const open = fixes.filter((fix) => OPEN.has(fix.status));
    // A finished run stays up while any of its work waits for review, until dismissed.
    this.state.away = away && away.id !== this.dismissedAway && (away.status === "running" || away.items.some((item) => open.some((fix) => fix.id === item.fixId))) ? away : null;
    const fix = open.find((item) => item.status === "starting" || item.status === "running")
      ?? open.find((item) => item.id === this.state.fix?.id) ?? open.at(-1) ?? null;
    this.state.fix = fix;
    this.state.inbox = open.filter((item) => item !== fix).reverse();
    this.options.publish();
  }

  /// While an away run works, keeps its progress and the inbox current.
  private watchAway() {
    if (this.awayTimer) clearTimeout(this.awayTimer);
    this.awayTimer = setTimeout(async () => {
      this.awayTimer = null;
      try { await this.refreshOpen(); } catch { /* try again */ }
      if (this.state.away?.status === "running") this.watchAway();
    }, FIX_EVERY);
  }

  /// Away mode: Drive runs these proposals one after another, each in its own
  /// worktree, and they wait here for review.
  async startAway(items: DriveAwayRequest["items"], minutes?: number) {
    const { away } = await this.options.client().startDriveAway({ workspace: this.options.workspace(), items, ...(minutes ? { minutes } : {}) });
    this.state.away = away; this.state.message = null;
    await this.refreshOpen().catch(() => {});
    this.watchAway();
  }

  async stopAway() {
    const { away } = await this.options.client().stopDriveAway(this.options.workspace());
    this.state.away = away;
    this.options.publish();
  }

  /// Looks for new breakages; GitHub at most every five minutes.
  async check() {
    if (this.unsupported || this.checking || this.options.busy()) return;
    this.checking = true;
    try {
      const gh = Date.now() - this.lastGitHub >= GITHUB_EVERY;
      const { signals } = await this.options.client().driveAlerts({ workspace: this.options.workspace(), ...(gh ? { gh: true } : {}) });
      if (gh) this.lastGitHub = Date.now();
      const current = new Map(signals.map((signal) => [signal.id, signal]));
      // A local-only check can't see GitHub: keep what it last showed.
      if (!gh) for (const [id, signal] of this.seen ?? []) if (signal.source === "github") current.set(id, signal);
      const previous = this.seen;
      this.seen = current;
      if (!previous) return;
      const vetoes = new Set(this.options.vetoes());
      const fixing = new Set(this.state.fix && OPEN.has(this.state.fix.status) ? this.state.fix.signals.map((signal) => signal.id) : []);
      const fresh = [...current.values()].filter((signal) => !previous.has(signal.id) && !vetoes.has(neverAlert(signal)) && !fixing.has(signal.id));
      // Anything that recovered on its own leaves the card.
      const still = this.state.signals.filter((signal) => current.has(signal.id));
      const next = [...still, ...fresh.filter((signal) => !still.some((item) => item.id === signal.id))].slice(0, 5);
      if (JSON.stringify(next) !== JSON.stringify(this.state.signals)) { this.state.signals = next; this.options.publish(); }
    } catch { /* offline, or an older daemon */ }
    finally { this.checking = false; }
  }

  private watchFix() {
    if (this.fixTimer) clearTimeout(this.fixTimer);
    this.fixTimer = setTimeout(async () => {
      this.fixTimer = null;
      const id = this.state.fix?.id;
      if (!id) return;
      try {
        const fix = (await this.options.client().driveFixes(this.options.workspace())).fixes.find((item) => item.id === id);
        if (fix && this.state.fix?.id === id) { this.state.fix = fix; this.options.publish(); }
        if (fix && !["starting", "running"].includes(fix.status)) return;
      } catch { /* try again */ }
      this.watchFix();
    }, FIX_EVERY);
  }

  /// The open work an action names (by id), else the one on the card.
  private byId(id: unknown) {
    return typeof id === "string" && id ? [this.state.fix, ...this.state.inbox].find((fix) => fix?.id === id) ?? null : this.state.fix;
  }

  /// Whether this daemon makes worktree fixes (older ones don't).
  get supported() { return !this.unsupported; }

  /// Opens a worktree and session for a /drive mission. Drive's planner works
  /// there; finishMission commits the result for the card. Throws when it
  /// can't (not a git repository, or worktree work already running).
  async openMission(mission: string): Promise<DriveFix> {
    if (this.state.busy) throw new Error("Wait for the current worktree action to finish.");
    const { fix } = await this.options.client().startDriveFix({ workspace: this.options.workspace(), signals: [], mission });
    if (fix.status === "failed" || !fix.sessionId) throw new Error(fix.error ?? "Couldn't open a worktree for the mission.");
    this.state.fix = fix; this.state.message = null;
    this.options.publish();
    return fix;
  }

  /// The open mission worktree whose session is this one, if any.
  missionFor(sessionId: string) {
    const fix = this.state.fix;
    return fix?.mission && fix.sessionId === sessionId && OPEN.has(fix.status) ? fix : null;
  }

  /// A mission settled: commit its changes and show them for review.
  async finishMission(id: string, summary: string, receipt?: { markdown: string; headline: string }) {
    try {
      const { fix } = await this.options.client().finishDriveMission(id, { summary: summary.slice(0, 4000), ...(receipt ? { receipt: receipt.markdown, headline: receipt.headline.slice(0, 300) } : {}) });
      if (this.state.fix?.id === id) this.state.fix = fix;
    } catch (error) {
      this.state.message = { text: error instanceof Error ? error.message : String(error), tone: "error" };
    }
    this.options.publish();
  }

  /// Runs a Next proposal in its own worktree, shown on the same card.
  /// Throws when it can't start (not a git repository, or one already running).
  async runProposal(proposal: DriveFixProposal, signals: DriveSignal[]) {
    if (this.state.busy) throw new Error("Wait for the current worktree action to finish.");
    this.state.busy = "fix"; this.state.message = null;
    this.options.publish();
    try {
      const { fix } = await this.options.client().startDriveFix({ workspace: this.options.workspace(), signals: signals.slice(0, 5), proposal });
      this.state.fix = fix;
      if (fix.status === "failed") this.state.message = { text: fix.error ?? "It couldn't start.", tone: "error" };
      else this.watchFix();
    } finally {
      this.state.busy = null;
      this.options.publish();
    }
  }

  async handle(method: string, args: Record<string, unknown>) {
    if (method === "breakage-dismiss") { this.state.signals = []; return this.options.publish(); }
    if (method === "breakage-never") {
      for (const signal of this.state.signals) this.options.veto(neverAlert(signal));
      this.state.signals = [];
      return this.options.publish();
    }
    if (method === "breakage-close") { this.state.message = null; return this.options.publish(); }
    if (method === "breakage-away-stop") return this.stopAway();
    if (method === "breakage-away-close") { this.dismissedAway = this.state.away?.id ?? null; this.state.away = null; return this.options.publish(); }
    if (method === "breakage-receipt") {
      const receipt = this.byId(args.id)?.receipt;
      if (!receipt || !this.options.copy) return;
      await this.options.copy(receipt);
      this.state.message = { text: "Copied the mission receipt (Markdown).", tone: "ok" };
      return this.options.publish();
    }
    if (method === "breakage-open") {
      const url = this.state.message?.url;
      if (url) await this.options.open(url);
      return;
    }
    if (this.state.busy) return;
    const action = method.replace(/^breakage-/, "");
    this.state.busy = action; this.state.message = null;
    this.options.publish();
    try {
      if (action === "fix") {
        if (!this.state.signals.length) throw new Error("Nothing to fix.");
        const { fix } = await this.options.client().startDriveFix({ workspace: this.options.workspace(), signals: this.state.signals });
        this.state.fix = fix; this.state.signals = [];
        if (fix.status === "failed") this.state.message = { text: fix.error ?? "The fix couldn't start.", tone: "error" };
        else this.watchFix();
      } else if (["apply", "pr", "discard"].includes(action)) {
        const id = this.byId(args.id)?.id ?? String(args.id ?? "");
        const { fix } = await this.options.client().driveFixAction(id, action as DriveFixAction);
        if (this.state.fix?.id === id) this.state.fix = null;
        this.state.inbox = this.state.inbox.filter((item) => item.id !== id);
        // The next one waiting for review takes the card.
        if (!this.state.fix && this.state.inbox.length) this.state.fix = this.state.inbox.shift()!;
        if (this.state.away && this.state.away.status !== "running" && !this.state.away.items.some((item) => [this.state.fix, ...this.state.inbox].some((open) => open?.id === item.fixId))) this.state.away = null;
        if (fix.mission) this.options.closed?.(fix);
        if (action === "apply") { this.state.message = { text: `Applied to your branch: ${fix.title}`, tone: "ok" }; this.options.applied(); }
        if (action === "pr") this.state.message = { text: `Opened a pull request from ${fix.branch}`, tone: "ok", ...(fix.prUrl ? { url: fix.prUrl } : {}) };
        if (action === "discard") this.state.message = { text: `${fix.proposal || fix.mission ? "Discarded" : "Fix discarded"}; the worktree and branch are gone.`, tone: "ok" };
      } else throw new Error(`Unknown action ${method}`);
    } catch (error) {
      this.state.message = { text: error instanceof Error ? error.message : String(error), tone: "error" };
    } finally {
      this.state.busy = null;
      this.options.publish();
    }
  }
}
