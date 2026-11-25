import type { DemesneClient } from "@demesne/client";
import type { DriveFix, DriveFixChange, EventEnvelope, SessionStateResponse } from "@demesne/protocol";
import { replaySession } from "@demesne/workbench/history.ts";
import { WorkspaceSession } from "./session-model.ts";

/// Threads, seen from the window (pass 232): the orchestrator chat you're
/// in holds one ribbon of the threads it started, whatever each is on. A
/// line you open is followed live so it can show the thread's last steps,
/// or what it changed once it is back. A thread that asks you something is
/// followed too, so its question can come to the chat you are in.

export interface ThreadsState {
  /// The orchestrator chat these belong to.
  from: string | null;
  list: DriveFix[];
  /// The thread whose line is open in the ribbon, by its job id.
  open: string | null;
  /// "merge" while Merge all works through the list, or a thread's id.
  busy: string | null;
  message: { text: string; tone: "ok" | "error" } | null;
}

const ACTIVE = new Set(["starting", "running"]);
const OPEN = new Set(["starting", "running", "ready", "failed"]);
/// A ready thread is looked at often enough that a merge made somewhere
/// else takes its Merge away within a few seconds.
const FAST = 2500, READY = 6000, SLOW = 20_000;

/// One thread's chat, followed live.
class Follow {
  chat: WorkspaceSession | null = null;
  private readonly controller = new AbortController();
  constructor(readonly sessionId: string, private readonly client: DemesneClient, private readonly changed: () => void, private readonly settled: () => void) { void this.run(); }
  private async run() {
    const client = this.client, signal = this.controller.signal;
    let state: SessionStateResponse;
    try { state = await client.getSessionState(this.sessionId); } catch { return; }
    const events = await replaySession(state, (id, after, abort) => client.streamEvents(id, after, abort), (id, after, through, abort) => client.replayPage(id, after, through, abort)).catch(() => []);
    if (signal.aborted) return;
    const chat = (this.chat = new WorkspaceSession(state, events));
    this.changed();
    try {
      for await (const event of client.streamEvents(this.sessionId, chat.cursor, signal)) {
        if (signal.aborted) break;
        if (!chat.apply(event as EventEnvelope)) continue;
        this.changed();
        if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) this.settled();
      }
    } catch { /* the stream ended; opening the line again reconnects */ }
  }
  stop() { this.controller.abort(); }
}

export class ThreadWatch {
  state: ThreadsState = { from: null, list: [], open: null, busy: null, message: null };
  /// The followed threads' chats, by chat id: the open line's, and the first thread that waits on you.
  private readonly follows = new Map<string, Follow>();
  /// What the open line's thread changed, once it is back.
  private changes: { id: string; at: string | null; files: DriveFixChange[]; more: number } | null = null;
  private changesFor = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsupported = false;

  constructor(private readonly options: {
    client: () => DemesneClient;
    publish: () => void;
    /// The checkout changed (a thread was merged).
    merged: () => void;
  }) {}

  /// The chat you're in changed: show its threads, if it has any.
  async select(sessionId: string | null) {
    if (sessionId === this.state.from) return;
    // Stepping into one of these threads' own chats keeps its orchestrator's threads at hand.
    if (sessionId && this.state.list.some((fix) => fix.sessionId === sessionId)) return;
    this.stopFollowing();
    this.state = { from: sessionId, list: [], open: null, busy: null, message: null };
    this.options.publish();
    await this.refresh();
  }

  async refresh() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const from = this.state.from;
    if (!from || this.unsupported) return;
    try {
      const { fixes } = await this.options.client().threads(from);
      if (this.state.from !== from) return;
      const list = fixes.filter((fix) => OPEN.has(fix.status) || fix.status === "applied");
      if (JSON.stringify(list) !== JSON.stringify(this.state.list)) { this.state.list = list; this.options.publish(); }
    } catch (error) {
      // An older daemon has no threads.
      if (/404|not found/i.test(error instanceof Error ? error.message : String(error))) { this.unsupported = true; return; }
    }
    // A line stays open only while its thread is live: a merged thread leaves the ribbon.
    if (this.state.open && !this.state.list.some((fix) => fix.id === this.state.open && fix.status !== "applied")) { this.state.open = null; this.options.publish(); }
    this.retarget();
    if (this.state.list.length || this.state.from === from)
      this.timer = setTimeout(() => void this.refresh(), this.state.list.some((fix) => ACTIVE.has(fix.status)) ? FAST : this.state.list.some((fix) => fix.status === "ready") ? READY : SLOW);
  }

  /// A thread's job, by its job id.
  fix(id: unknown) { return this.state.list.find((fix) => fix.id === id) ?? null; }

  /// Opens a thread's line and follows its chat.
  async show(id: string) {
    const fix = this.fix(id);
    if (!fix) throw new Error("That thread is no longer open.");
    this.state.open = id;
    this.options.publish();
    this.retarget();
  }

  async close() {
    this.state.open = null;
    this.options.publish();
    this.retarget();
  }

  /// The first thread that waits on you: its question comes to the chat that started it.
  private asker() { return this.state.list.find((fix) => fix.waiting && fix.sessionId && ACTIVE.has(fix.status)) ?? null; }

  /// Follows the chats the ribbon needs, and no others.
  private retarget() {
    const wanted = new Set([this.state.open ? this.fix(this.state.open)?.sessionId : null, this.asker()?.sessionId].filter((id): id is string => Boolean(id)));
    let changed = false;
    for (const [id, follow] of this.follows) if (!wanted.has(id)) { follow.stop(); this.follows.delete(id); changed = true; }
    for (const id of wanted) if (!this.follows.has(id)) this.follows.set(id, new Follow(id, this.options.client(), () => { if (this.follows.has(id)) this.options.publish(); }, () => void this.refresh()));
    if (changed) this.options.publish();
    void this.loadChanges();
  }

  /// What the open line's thread changed, read once it is back and again if it comes back anew.
  private async loadChanges() {
    const fix = this.state.open ? this.fix(this.state.open) : null;
    if (!fix || fix.status !== "ready") { if (this.changes) { this.changes = null; this.changesFor = ""; } return; }
    const key = `${fix.id}:${fix.finishedAt}`;
    if (this.changesFor === key) return;
    this.changesFor = key;
    try {
      const { files, more } = await this.options.client().driveFixChanges(fix.id);
      if (this.changesFor !== key) return;
      this.changes = { id: fix.id, at: fix.finishedAt, files, more };
      this.options.publish();
    } catch { if (this.changesFor === key) this.changesFor = ""; }
  }

  private stopFollowing() {
    for (const follow of this.follows.values()) follow.stop();
    this.follows.clear();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopFollowing();
  }

  /// The followed chats, each with the thread it belongs to.
  chats() {
    return [...this.follows.values()].flatMap((follow) => {
      const fix = this.state.list.find((item) => item.sessionId === follow.sessionId);
      return follow.chat && fix ? [{ fix, chat: follow.chat }] : [];
    });
  }

  view() {
    const fix = this.state.open ? this.fix(this.state.open) : null, chat = fix?.sessionId ? this.follows.get(fix.sessionId)?.chat : null;
    return {
      ...this.state,
      changes: this.changes && this.changes.id === this.state.open ? { id: this.changes.id, files: this.changes.files, more: this.changes.more } : null,
      /// The open line's chat, for its last words and steps.
      chat: chat && fix ? {
        id: chat.session.id,
        /// The thread this chat belongs to, by its job id.
        of: fix.id,
        title: chat.session.title,
        runs: chat.runs(),
        approvals: [...chat.approvals.values()],
        questions: [...chat.questions.values()],
        activeTurnId: chat.active?.id ?? null,
        model: chat.session.preferredModel ?? null,
        provider: chat.provider ?? null,
      } : null,
    };
  }

  /// The open line's chat, followed live.
  private get chat() {
    const fix = this.state.open ? this.fix(this.state.open) : null;
    return fix?.sessionId ? this.follows.get(fix.sessionId)?.chat ?? null : null;
  }

  /// Words for the open thread, from its side beside the chat (pass 279):
  /// they steer it while it works, else start its next turn.
  async send(text: string) {
    const fix = this.state.open ? this.fix(this.state.open) : null, chat = this.chat;
    const content = text.trim();
    if (!fix?.sessionId || !chat || !content) throw new Error("Open a thread first.");
    const client = this.options.client();
    if (chat.active) {
      try { await client.steer(fix.sessionId, { id: crypto.randomUUID(), text: content }); return; }
      catch { /* it ended first: send it as the next message */ }
    }
    const { turn } = await client.submitTurn(fix.sessionId, { content, permissionMode: "allow" });
    chat.ensureTurn(turn);
    this.options.publish();
  }

  /// Stop: the open thread's running turn ends where it is, like Stop in a chat.
  async cancel() {
    const turn = this.chat?.active;
    if (turn) await this.options.client().cancelTurn(turn.id);
  }

  /// A permission the open thread waits on, answered from its side.
  async approve(id: string, decision: "allow_once" | "deny") {
    const chat = this.chat;
    if (!chat?.approvals.has(id)) throw new Error("This permission is no longer pending.");
    await this.options.client().resolvePermission(id, decision);
    chat.approvals.delete(id);
    this.options.publish();
  }

  /// Merges one ready thread onto your branch.
  async mergeOne(id: string) {
    const fix = this.fix(id);
    if (fix?.status !== "ready") throw new Error("That thread isn't ready to merge.");
    await this.act(id, async () => {
      await this.options.client().driveFixAction(fix.id, "apply");
      this.state.message = { text: `Merged ${fix.title} onto your branch.`, tone: "ok" };
      this.options.merged();
    });
  }

  /// Deletes a thread: a working one stops, its worktree and branch go; a
  /// merged one only leaves the list.
  async deleteThread(id: string) {
    const fix = this.fix(id);
    if (!fix) return;
    await this.act(id, async () => {
      await this.options.client().driveFixAction(fix.id, "discard");
      this.state.message = { text: fix.status === "applied" ? `Deleted ${fix.title}. Its merge stays on your branch.` : fix.thread?.proposed ? `Deleted ${fix.title}. It had not started.` : `Deleted ${fix.title}: its worktree and branch are gone.`, tone: "ok" };
      this.state.list = this.state.list.filter((item) => item.id !== id);
      if (this.state.open === id) this.state.open = null;
    });
  }

  /// Starts a proposed thread: its worktree, branch and chat are made now.
  async startThread(id: string) {
    const fix = this.fix(id);
    if (!fix?.thread?.proposed) throw new Error("That thread has already started.");
    await this.act(id, async () => { await this.options.client().driveFixAction(fix.id, "start"); });
  }

  /// Start all: every proposed thread in the order it was listed, so one
  /// built on another starts after it.
  async startAll() {
    const proposed = this.state.list.filter((fix) => fix.thread?.proposed && fix.status === "starting");
    if (!proposed.length) throw new Error("No thread waits for Start.");
    await this.act("start", async () => { for (const fix of proposed) await this.options.client().driveFixAction(fix.id, "start"); });
  }

  /// Try again: a stopped thread goes back to work, in its own chat and
  /// worktree where it got that far.
  async retryThread(id: string) {
    const fix = this.fix(id);
    if (fix?.status !== "failed") throw new Error("Only a thread that stopped can be tried again.");
    await this.act(id, async () => { await this.options.client().driveFixAction(fix.id, "retry"); });
  }

  /// Merge all: each ready thread onto your branch, oldest first, stopping
  /// at the first that doesn't apply cleanly. Only you start this.
  async mergeAll() {
    const ready = this.state.list.filter((fix) => fix.status === "ready");
    if (!ready.length) throw new Error("No thread is ready to merge.");
    await this.act("merge", async () => {
      const merged: string[] = [];
      try {
        for (const fix of ready) { await this.options.client().driveFixAction(fix.id, "apply"); merged.push(fix.title); }
        this.state.message = { text: `Merged ${merged.length === 1 ? merged[0] : `all ${merged.length}`} onto your branch.`, tone: "ok" };
      } finally { if (merged.length) this.options.merged(); }
    });
  }

  private async act(busy: string, work: () => Promise<void>) {
    if (this.state.busy) throw new Error("Wait for the current thread action to finish.");
    this.state.busy = busy; this.state.message = null;
    this.options.publish();
    try { await work(); }
    catch (error) { this.state.message = { text: error instanceof Error ? error.message : String(error), tone: "error" }; }
    finally {
      this.state.busy = null;
      await this.refresh();
      this.options.publish();
    }
  }

  async handle(method: string, args: Record<string, unknown>) {
    if (method === "thread-open") return this.show(String(args.id ?? ""));
    if (method === "thread-close") return this.close();
    if (method === "thread-send") return this.send(String(args.text ?? ""));
    if (method === "thread-cancel") return this.cancel();
    if (method === "thread-approve") return this.approve(String(args.id ?? ""), args.decision === "deny" ? "deny" : "allow_once");
    if (method === "thread-delete") return this.deleteThread(String(args.id ?? ""));
    if (method === "thread-merge") return this.mergeOne(String(args.id ?? ""));
    if (method === "thread-start") return this.startThread(String(args.id ?? ""));
    if (method === "threads-start") return this.startAll();
    if (method === "thread-retry") return this.retryThread(String(args.id ?? ""));
    if (method === "threads-merge") return this.mergeAll();
    if (method === "threads-message-close") { this.state.message = null; return this.options.publish(); }
    throw new Error(`Unknown action ${method}`);
  }
}
