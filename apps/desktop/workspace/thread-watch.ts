import type { DemesneClient } from "@demesne/client";
import type { DriveFix, EventEnvelope, SessionStateResponse } from "@demesne/protocol";
import { replaySession } from "@demesne/workbench/history.ts";
import { WorkspaceSession } from "./session-model.ts";

/// Threads, seen from the window: the orchestrator chat you're in lists the
/// threads it started, and the one you pick runs live in the right half
/// beside it, as a chat of its own you can talk to. Picking is the only
/// thing that moves the right half: a thread that needs you turns amber on
/// the list but never pulls the right half over to itself.

export interface ThreadsState {
  /// The orchestrator chat these belong to.
  from: string | null;
  list: DriveFix[];
  /// The thread shown in the right half, by its job id.
  open: string | null;
  /// You closed the right half; picking a thread opens it again.
  closed: boolean;
  /// "merge" while Merge all works through the list, or a thread's id.
  busy: string | null;
  message: { text: string; tone: "ok" | "error" } | null;
}

const ACTIVE = new Set(["starting", "running"]);
const OPEN = new Set(["starting", "running", "ready", "failed"]);
const FAST = 2500, SLOW = 20_000;

export class ThreadWatch {
  state: ThreadsState = { from: null, list: [], open: null, closed: false, busy: null, message: null };
  /// The open thread's chat, followed live.
  chat: WorkspaceSession | null = null;
  private follow: AbortController | null = null;
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
    this.stopFollowing();
    this.state = { from: sessionId, list: [], open: null, closed: false, busy: null, message: null };
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
    // The first time threads appear, the right half opens on the first one.
    if (!this.state.open && !this.state.closed && this.state.list.length) await this.show(this.state.list[0]!.id);
    else if (this.state.open && !this.state.list.some((fix) => fix.id === this.state.open)) { this.stopFollowing(); this.state.open = null; this.options.publish(); }
    if (this.state.list.length || this.state.from === from)
      this.timer = setTimeout(() => void this.refresh(), this.state.list.some((fix) => ACTIVE.has(fix.status)) ? FAST : SLOW);
  }

  /// A thread's job, by its job id.
  fix(id: unknown) { return this.state.list.find((fix) => fix.id === id) ?? null; }

  /// Puts a thread in the right half and follows its chat.
  async show(id: string) {
    const fix = this.fix(id);
    if (!fix) throw new Error("That thread is no longer open.");
    this.state.open = id; this.state.closed = false;
    this.options.publish();
    if (fix.sessionId && this.chat?.session.id !== fix.sessionId) await this.followChat(fix.sessionId);
  }

  close() {
    this.state.closed = true; this.state.open = null;
    this.stopFollowing();
    this.options.publish();
  }

  private async followChat(sessionId: string) {
    this.stopFollowing();
    const controller = (this.follow = new AbortController());
    const client = this.options.client();
    let state: SessionStateResponse;
    try { state = await client.getSessionState(sessionId); } catch { return; }
    const events = await replaySession(state, (id, after, signal) => client.streamEvents(id, after, signal), (id, after, through, signal) => client.replayPage(id, after, through, signal)).catch(() => []);
    if (controller.signal.aborted) return;
    const chat = (this.chat = new WorkspaceSession(state, events));
    this.options.publish();
    void (async () => {
      try {
        for await (const event of client.streamEvents(sessionId, chat.cursor, controller.signal)) {
          if (controller.signal.aborted) break;
          if (!chat.apply(event as EventEnvelope)) continue;
          this.options.publish();
          if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) void this.refresh();
        }
      } catch { /* the stream ended; picking the thread again reconnects */ }
    })();
  }

  private stopFollowing() {
    this.follow?.abort();
    this.follow = null;
    this.chat = null;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopFollowing();
  }

  view() {
    const chat = this.chat, fix = this.state.open ? this.fix(this.state.open) : null;
    return {
      ...this.state,
      chat: chat && fix?.sessionId === chat.session.id ? {
        id: chat.session.id,
        title: chat.session.title,
        runs: chat.runs(),
        approvals: [...chat.approvals.values()],
        questions: [...chat.questions.values()],
        activeTurnId: chat.active?.id ?? null,
        model: chat.session.preferredModel ?? null,
        reasoning: chat.session.preferredReasoning ?? null,
      } : null,
    };
  }

  /// Words for the open thread: they steer it while it works, else start its next turn.
  async send(text: string) {
    const fix = this.state.open ? this.fix(this.state.open) : null, chat = this.chat;
    const content = text.trim();
    if (!fix?.sessionId || !chat || !content) throw new Error("Pick a thread first.");
    const client = this.options.client();
    if (chat.active) {
      try { await client.steer(fix.sessionId, { id: crypto.randomUUID(), text: content }); return; }
      catch { /* it ended first: send it as the next message */ }
    }
    const { turn } = await client.submitTurn(fix.sessionId, { content, permissionMode: "allow" });
    chat.ensureTurn(turn);
    this.options.publish();
  }

  async approve(id: string, decision: "allow_once" | "deny") {
    const chat = this.chat;
    if (!chat?.approvals.has(id)) throw new Error("This permission is no longer pending.");
    await this.options.client().resolvePermission(id, decision);
    chat.approvals.delete(id);
    this.options.publish();
  }

  /// The open thread's model and effort, for its next turn; the chat on the
  /// left keeps its own.
  async setModel(model: string, reasoning: string | null) {
    const chat = this.chat;
    if (!chat || !model) throw new Error("Pick a thread first.");
    const { session } = await this.options.client().updateSession(chat.session.id, { preferredModel: model, preferredReasoning: reasoning });
    chat.session.preferredModel = session.preferredModel;
    chat.session.preferredReasoning = session.preferredReasoning;
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

  async stopThread(id: string) {
    const fix = this.fix(id);
    if (!fix) return;
    await this.act(id, () => this.options.client().driveFixAction(fix.id, "discard").then(() => { this.state.message = { text: `Discarded ${fix.title}: its worktree and branch are gone.`, tone: "ok" }; }));
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
    if (method === "thread-approve") return this.approve(String(args.id ?? ""), args.decision === "deny" ? "deny" : "allow_once");
    if (method === "thread-stop") return this.stopThread(String(args.id ?? ""));
    if (method === "thread-merge") return this.mergeOne(String(args.id ?? ""));
    if (method === "thread-model") return this.setModel(String(args.id ?? ""), typeof args.reasoning === "string" ? args.reasoning : null);
    if (method === "threads-merge") return this.mergeAll();
    if (method === "threads-message-close") { this.state.message = null; return this.options.publish(); }
    throw new Error(`Unknown action ${method}`);
  }
}
