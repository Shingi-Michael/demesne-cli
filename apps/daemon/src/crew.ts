import { isRecord } from "@demesne/protocol";
import type { ProviderToolDefinition } from "@demesne/providers";

/// Sub-agents that stay (pass 190 A), the way Codex's do. A sub-agent started
/// with `background: true` returns at once and the chat keeps working while
/// it does. `agents` waits for one, asks one a follow-up, or stops one.
/// They live as long as the turn: when the answer is written, any still
/// working are stopped, so nothing keeps running behind your back.

export const AGENTS_TOOL = "agents";
/// At most this many in the background per turn.
export const CREW_LIMIT = 6;
const WAIT_DEFAULT_S = 300, WAIT_MAX_S = 600;

export const agentsDefinition: ProviderToolDefinition = {
  name: AGENTS_TOOL,
  description: "Work with sub-agents you started with background: true. "
    + "wait: block until one of them reports (all working ones unless ids are given) and get every report not yet delivered. "
    + "message: ask one a follow-up; it answers with what it already found, and its answer arrives like a report. "
    + "stop: stop one whose answer you no longer need. "
    + "Reports that come in while you work are also added to your next tool result, so wait only when you need an answer to go on.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["wait", "message", "stop"] },
      ids: { type: "array", items: { type: "string" }, maxItems: CREW_LIMIT, description: "wait: the agents to wait for (a1, a2…). Omit for all that are working." },
      id: { type: "string", description: "message, stop: the agent, e.g. a1." },
      message: { type: "string", maxLength: 4000, description: "message: the follow-up, complete on its own." },
      seconds: { type: "number", minimum: 1, maximum: WAIT_MAX_S, description: `wait: give up after this long (default ${WAIT_DEFAULT_S}).` },
    },
  },
};

export type CrewInput =
  | { action: "wait"; ids?: string[]; seconds: number }
  | { action: "message"; id: string; message: string }
  | { action: "stop"; id: string };

export function parseAgentsInput(input: unknown): CrewInput {
  if (!isRecord(input)) throw new Error("agents needs an action");
  if (input.action === "wait") {
    const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === "string").map((id) => id.trim()) : undefined;
    const seconds = typeof input.seconds === "number" && Number.isFinite(input.seconds) ? Math.min(WAIT_MAX_S, Math.max(1, input.seconds)) : WAIT_DEFAULT_S;
    return { action: "wait", ...(ids?.length ? { ids } : {}), seconds };
  }
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (input.action === "message") {
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!id || !message) throw new Error("message needs an id and a message");
    return { action: "message", id, message: message.slice(0, 4000) };
  }
  if (input.action === "stop") {
    if (!id) throw new Error("stop needs an id");
    return { action: "stop", id };
  }
  throw new Error("action must be wait, message or stop");
}

/// One job's run: the prompt it's given, and its report (or a thrown error).
export type CrewRun = (prompt: string, signal: AbortSignal, again: boolean) => Promise<string>;

/// How a member shows on its row.
export type CrewMark = { asked: string } | { crew: "working" | "reported" | "stopped" };

interface Member {
  id: string; toolCallId: string; description: string; prompt: string;
  state: "working" | "reported" | "stopped" | "failed";
  controller: AbortController; run: CrewRun;
  last?: string;
  /// Follow-ups sent while it was still working, asked next.
  queued: string[];
  /// Reports the chat hasn't been given yet.
  unread: string[];
  /// What the stored tool call ends with.
  log: string[];
}

/// One turn's background sub-agents.
export class Crew {
  private members: Member[] = [];
  private wake = new Set<() => void>();

  constructor(private readonly hooks: {
    mark: (toolCallId: string, mark: CrewMark) => void;
    settle: (toolCallId: string, outcome: "completed" | "failed", text: string) => void;
    signal: AbortSignal;
  }) {}

  get size(): number { return this.members.length; }
  get working(): number { return this.members.filter((member) => member.state === "working").length; }

  /// Starts one and returns its id at once.
  start(toolCallId: string, description: string, prompt: string, run: CrewRun): string {
    if (this.members.length >= CREW_LIMIT) throw new Error(`at most ${CREW_LIMIT} background sub-agents in one turn`);
    const id = `a${this.members.length + 1}`;
    const member: Member = { id, toolCallId, description, prompt, state: "working", controller: this.controller(), run, queued: [], unread: [], log: [] };
    this.members.push(member);
    this.go(member, prompt, false);
    return id;
  }

  private controller(): AbortController {
    const controller = new AbortController();
    if (this.hooks.signal.aborted) controller.abort(this.hooks.signal.reason);
    else this.hooks.signal.addEventListener("abort", () => controller.abort(this.hooks.signal.reason), { once: true });
    return controller;
  }

  private go(member: Member, prompt: string, again: boolean): void {
    member.state = "working";
    void member.run(prompt, member.controller.signal, again).then((report) => {
      if (member.state !== "working") return;
      member.last = report;
      member.state = "reported";
      member.unread.push(report);
      member.log.push(report);
      this.hooks.mark(member.toolCallId, { crew: "reported" });
    }, (error: unknown) => {
      if (member.state !== "working") return;
      const message = error instanceof Error ? error.message : String(error);
      member.state = member.controller.signal.aborted ? "stopped" : "failed";
      if (member.state === "failed") { member.unread.push(`Error: ${message}`); member.log.push(`Error: ${message}`); }
    }).finally(() => {
      // A follow-up sent while it worked is asked as soon as it's done.
      const next = member.state === "reported" ? member.queued.shift() : undefined;
      if (next) this.ask(member, next);
      this.ping();
    });
  }

  private ask(member: Member, message: string): void {
    this.hooks.mark(member.toolCallId, { asked: message });
    this.hooks.mark(member.toolCallId, { crew: "working" });
    member.log.push(`Follow-up: ${message}`);
    member.controller = this.controller();
    const prompt = `${member.prompt}\n\nYou already reported this:\n${member.last ?? "(nothing yet)"}\n\nFollow-up from the main agent: ${message}\nAnswer the follow-up. Reuse what you already found and look further only where you need to.`;
    this.go(member, prompt, true);
  }

  private ping(): void { for (const wake of [...this.wake]) wake(); }

  private find(id: string): Member {
    const member = this.members.find((one) => one.id === id.toLowerCase());
    if (!member) throw new Error(`no agent ${id} in this turn${this.members.length ? ` (there are ${this.members.map((one) => one.id).join(", ")})` : ""}`);
    return member;
  }

  /// Reports not yet given to the chat, as text, marked read.
  take(ids?: readonly string[]): string {
    const parts: string[] = [];
    for (const member of this.members) {
      if (ids && !ids.includes(member.id)) continue;
      for (const report of member.unread.splice(0)) parts.push(`[Agent ${member.id} · ${member.description} reported]\n${report}`);
    }
    return parts.join("\n\n");
  }

  hasUnread(): boolean { return this.members.some((member) => member.unread.length > 0); }

  async run(input: CrewInput, signal: AbortSignal): Promise<string> {
    if (input.action === "stop") {
      const member = this.find(input.id);
      if (member.state === "working") {
        member.state = "stopped";
        member.queued.length = 0;
        member.controller.abort(new Error("stopped by the chat"));
        member.log.push("Stopped by the chat.");
        this.hooks.mark(member.toolCallId, { crew: "stopped" });
        this.ping();
      }
      return `Stopped ${member.id}.${member.unread.length ? `\n\n${this.take([member.id])}` : ""}`;
    }
    if (input.action === "message") {
      const member = this.find(input.id);
      if (member.state === "stopped" || member.state === "failed") throw new Error(`${member.id} has ${member.state}; start a new sub-agent instead`);
      if (member.state === "working") {
        member.queued.push(input.message);
        return `${member.id} is still working; it gets your follow-up as soon as it reports.`;
      }
      this.ask(member, input.message);
      return `Asked ${member.id}. Its answer arrives like a report; call agents wait when you need it.`;
    }
    const ids = input.ids?.map((id) => this.find(id).id);
    const watched = () => this.members.filter((member) => !ids || ids.includes(member.id));
    if (!watched().some((member) => member.unread.length || member.state === "working")) return "No agents are working, and every report has been delivered.";
    if (!watched().some((member) => member.unread.length)) {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => { clearTimeout(timer); this.wake.delete(check); signal.removeEventListener("abort", done); resolve(); };
        const check = () => { if (watched().some((member) => member.unread.length) || !watched().some((member) => member.state === "working")) done(); };
        timer = setTimeout(done, input.seconds * 1000);
        this.wake.add(check);
        signal.addEventListener("abort", done, { once: true });
        check();
      });
      signal.throwIfAborted();
    }
    const text = this.take(ids);
    const still = watched().filter((member) => member.state === "working").map((member) => member.id);
    return (text || `Nothing yet after ${input.seconds}s.`) + (still.length ? `\n\nStill working: ${still.join(", ")}.` : "");
  }

  /// Stop, pressed on its line by the person.
  stopByPerson(toolCallId: string): boolean {
    const member = this.members.find((one) => one.toolCallId === toolCallId);
    if (!member || member.state !== "working") return false;
    member.state = "stopped";
    member.queued.length = 0;
    member.controller.abort(new Error("stopped by the person"));
    member.unread.push("The person stopped this agent before it reported. Go on without it.");
    member.log.push("Stopped by the person.");
    this.hooks.mark(member.toolCallId, { crew: "stopped" });
    this.ping();
    return true;
  }

  /// The turn is over: stop any still working and close every row.
  close(): void {
    for (const member of this.members) {
      if (member.state === "working") {
        member.state = "stopped";
        member.controller.abort(new Error("the turn ended"));
        this.hooks.mark(member.toolCallId, { crew: "stopped" });
      }
      const text = member.log.length ? member.log.join("\n\n") : "Stopped before it reported.";
      try { this.hooks.settle(member.toolCallId, member.state === "failed" ? "failed" : "completed", text.slice(0, 64 * 1024)); } catch { /* a cancelled turn already closed it */ }
    }
    this.members = [];
    this.ping();
  }
}
