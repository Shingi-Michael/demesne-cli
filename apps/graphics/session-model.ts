import {
  isRecord,
  parseUserQuestions,
  type EventEnvelope,
  type ReplayEvent,
  type SessionStateResponse,
  type Turn,
  type ProviderCallSnapshot,
  type UserQuestion,
  type QuestionState,
} from "@demesne/protocol";
import {
  restoreSessionEntries,
  toolArguments,
} from "../cli/src/workbench/history.ts";
import { derivePersistedRule } from "../cli/src/allow-rules.ts";
import { codeDiff } from "../cli/src/workbench/change-diff.ts";
import type {
  WorkbenchEntry,
  ToolEntry,
  ResponseReceipt,
} from "../cli/src/workbench/entries.ts";

export interface GraphicsApproval {
  id: string;
  turnId: string;
  toolCallId: string;
  name: string;
  summary: string;
  input: Record<string, unknown>;
  rule: string | null;
}
export interface GraphicsQuestion extends Partial<Omit<QuestionState,"id" | "turnId" | "toolCallId" | "questions">> {
  id: string;
  turnId: string;
  toolCallId: string;
  questions: UserQuestion[];
}
export interface GraphicsRun {
  id: string;
  number: number;
  content: string;
  status: Turn["status"];
  createdAt: string;
  completedAt: string | null;
  planOnly: boolean;
  kind?: string;
  entries: WorkbenchEntry[];
  receipt?: ResponseReceipt;
}
export interface GraphicsChange {
  path: string;
  state: string;
  added: number;
  removed: number;
  rows: ReturnType<typeof codeDiff>["rows"];
  unavailable?: string;
  edits: number;
  before?: string | null;
  after?: string | null;
  undo?: import("@demesne/protocol").ReviewFile["undo"];
}

/** The event journal is authoritative. Streaming deltas coalesce without losing
 * their first timestamp or replay cursor; settled run projections are cached. */
export class GraphicsSession {
  state: SessionStateResponse;
  cursor: number;
  provider: ProviderCallSnapshot | null;
  approvals = new Map<string, GraphicsApproval>();
  questions = new Map<string, GraphicsQuestion>();
  private journals = new Map<string, ReplayEvent[]>();
  private cache = new Map<string, GraphicsRun>();
  constructor(
    state: SessionStateResponse,
    events: readonly ReplayEvent[] = [],
  ) {
    this.state = structuredClone(state);
    this.cursor = state.lastEventId;
    this.provider = state.latestProviderCall;
    for (const event of events) {
      if (
        event.sessionId !== state.session.id ||
        (event.throughEventId ?? event.eventId) > this.cursor
      )
        continue;
      if (event.turnId) {
        const list = this.journals.get(event.turnId) ?? [];
        list.push(structuredClone(event));
        this.journals.set(event.turnId, list);
      }
      this.permissions(event);
    }
    const pending = new Set(state.pendingPermissions.map((item) => item.id));
    for (const id of this.approvals.keys())
      if (!pending.has(id)) this.approvals.delete(id);
    for (const item of state.pendingPermissions)
      if (!this.approvals.has(item.id))
        this.approvals.set(item.id, {
          ...item,
          name: "tool",
          input: {},
          rule: null,
        });
    for (const [id, question] of this.questions)
      if (!this.isActive(question.turnId)) this.questions.delete(id);
    if (state.pendingQuestions) {
      this.questions.clear();
      for (const question of state.pendingQuestions) this.questions.set(question.id,question);
    }
  }
  get session() {
    return this.state.session;
  }
  get active() {
    return (
      this.session.turns.findLast(
        (turn) => turn.status === "running" || turn.status === "queued",
      ) ?? null
    );
  }
  isActive(id: string) {
    const t = this.session.turns.find((turn) => turn.id === id);
    return t?.status === "running" || t?.status === "queued";
  }
  ensureTurn(turn: Turn) {
    if (!this.session.turns.some((item) => item.id === turn.id))
      this.session.turns.push(structuredClone(turn));
  }
  apply(event: EventEnvelope): boolean {
    if (event.sessionId !== this.session.id || event.eventId <= this.cursor)
      return false;
    this.cursor = event.eventId;
    this.state.lastEventId = this.cursor;
    this.session.updatedAt = event.occurredAt;
    const p = event.payload;
    if (event.type === "session.renamed" && typeof p.title === "string")
      this.session.title = p.title;
    if (event.type === "session.permissions_changed" && typeof p.autoApprove === "boolean")
      this.session.autoApprove = p.autoApprove;
    if (event.type === "turn.created" && event.turnId)
      this.ensureTurn({
        id: event.turnId,
        sessionId: event.sessionId,
        content: String(p.content ?? ""),
        responseText: "",
        status: "queued",
        createdAt: event.occurredAt,
        completedAt: null,
        permissionMode: "ask",
        thinkingEnabled:
          typeof p.thinkingEnabled === "boolean" ? p.thinkingEnabled : null,
        planOnly: p.planOnly === true,
        ...(p.kind === "compaction" ? { kind: "compaction" as const } : {}),
      });
    const turn = this.session.turns.find((turn) => turn.id === event.turnId);
    if (turn) {
      const list = this.journals.get(turn.id) ?? [],
        last = list.at(-1);
      if (
        (event.type === "message.delta" || event.type === "reasoning.delta") &&
        last?.type === event.type &&
        last.payload.providerCallId === p.providerCallId
      ) {
        last.payload.delta =
          String(last.payload.delta ?? "") + String(p.delta ?? "");
        last.throughEventId = event.eventId;
        last.deltaCount = (last.deltaCount ?? 1) + 1;
      } else list.push(structuredClone(event));
      this.journals.set(turn.id, list);
      this.cache.delete(turn.id);
      if (
        event.type === "agent.started" ||
        event.type === "model.request_started"
      )
        turn.status = "running";
      if (event.type === "message.delta")
        turn.responseText += String(p.delta ?? "");
      if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) {
        turn.status = event.type.slice(5) as Turn["status"];
        turn.completedAt = event.occurredAt;
        for (const [id, item] of this.approvals)
          if (item.turnId === turn.id) this.approvals.delete(id);
        for (const [id, item] of this.questions)
          if (item.turnId === turn.id && item.status !== "paused") this.questions.delete(id);
      }
    }
    if (event.type === "model.request_started")
      this.provider = {
        provider: String(p.provider ?? this.provider?.provider ?? ""),
        model: String(p.model ?? this.provider?.model ?? ""),
        contextPlan: isRecord(p.contextPlan)
          ? (p.contextPlan as unknown as ProviderCallSnapshot["contextPlan"])
          : null,
        usage: null,
        metrics: null,
      };
    if (this.provider && event.type === "model.usage")
      this.provider.usage = {
        inputTokens: Number.isFinite(p.inputTokens)
          ? (p.inputTokens as number)
          : null,
        outputTokens: Number.isFinite(p.outputTokens)
          ? (p.outputTokens as number)
          : null,
        totalTokens: Number.isFinite(p.totalTokens)
          ? (p.totalTokens as number)
          : null,
        ...(Number.isFinite(p.cachedInputTokens)
          ? { cachedInputTokens: p.cachedInputTokens as number }
          : {}),
      };
    if (this.provider && event.type === "model.metrics")
      this.provider.metrics = {
        durationMs: Number(p.durationMs),
        timeToFirstTokenMs:
          typeof p.timeToFirstTokenMs === "number"
            ? p.timeToFirstTokenMs
            : null,
        queueDurationMs:
          typeof p.queueDurationMs === "number" ? p.queueDurationMs : null,
      };
    if (event.type === "session.compacted" && isRecord(p.checkpoint))
      this.state.checkpoint =
        p.checkpoint as unknown as SessionStateResponse["checkpoint"];
    this.permissions(event);
    return true;
  }
  private permissions(event: ReplayEvent) {
    const p = event.payload;
    if (
      event.type === "permission.requested" &&
      event.turnId &&
      typeof p.permissionId === "string"
    )
      this.approvals.set(p.permissionId, {
        id: p.permissionId,
        turnId: event.turnId,
        toolCallId: String(p.toolCallId ?? ""),
        name: String(p.name ?? "tool"),
        summary: String(p.summary ?? "Allow this operation?"),
        input: toolArguments(p.arguments),
        rule: derivePersistedRule(
          typeof p.name === "string" ? p.name : undefined,
          p.arguments,
        ),
      });
    if (event.type === "permission.resolved")
      this.approvals.delete(String(p.permissionId));
    if (
      event.type === "question.requested" &&
      event.turnId &&
      typeof p.questionId === "string"
    )
      this.questions.set(p.questionId, {
        id: p.questionId,
        turnId: event.turnId,
        toolCallId: String(p.toolCallId),
        questions: parseUserQuestions(p.questions),
        ...(isRecord(p.state) ? p.state : {}),
      });
    if (event.type === "question.updated" && isRecord(p.state)) {
      const current=this.questions.get(String(p.questionId));
      if (current) this.questions.set(current.id,{...current,...p.state} as GraphicsQuestion);
    }
    if (event.type === "question.resolved" || event.type === "question.cancelled")
      this.questions.delete(String(p.questionId));
  }
  runs(): GraphicsRun[] {
    return this.session.turns.map((turn, index) => {
      let run = this.cache.get(turn.id);
      if (!run) {
        const entries = restoreSessionEntries(
          { ...this.state, session: { ...this.session, turns: [turn] } },
          this.journals.get(turn.id) ?? [],
        ).filter((entry) => entry.type !== "user");
        const close = entries.findLast(
          (entry) => entry.type === "notice" && entry.closesTurn,
        );
        run = {
          id: turn.id,
          number: index + 1,
          content: turn.content,
          status: turn.status,
          createdAt: turn.createdAt,
          completedAt: turn.completedAt,
          planOnly: turn.planOnly ?? false,
          kind: turn.kind,
          entries,
          receipt: close?.type === "notice" ? close.receipt : undefined,
        };
        this.cache.set(turn.id, run);
      }
      return run;
    });
  }
  changes(id: string): GraphicsChange[] {
    const run = this.runs().find((run) => run.id === id);
    if (!run) return [];
    const files = new Map<
      string,
      {
        before: string;
        after: string;
        state: string;
        unavailable?: string;
        edits: number;
      }
    >();
    for (const tool of run.entries.filter(
      (entry): entry is ToolEntry =>
        entry.type === "tool" && entry.phase === "change",
    )) {
      const status = tool.waiting
        ? "approval"
        : tool.drafting
          ? "drafting"
          : tool.state === "done"
            ? "applied"
            : tool.state === "running"
              ? "pending"
              : tool.state;
      if (tool.changes?.length)
        for (const change of tool.changes) {
          const earlier = files.get(change.path);
          files.set(change.path, {
            before: earlier?.before ?? change.before ?? "",
            after: change.after ?? "",
            state: status,
            unavailable: change.unavailable,
            edits: (earlier?.edits ?? 0) + 1,
          });
        }
      else if (tool.diff && typeof tool.input.path === "string") {
        const earlier = files.get(tool.input.path);
        files.set(tool.input.path, {
          before: earlier?.before ?? tool.diff.oldText,
          after: tool.diff.newText,
          state: status,
          edits: (earlier?.edits ?? 0) + 1,
        });
      }
    }
    return [...files].map(([path, file]) => ({
      path,
      state: file.state,
      edits: file.edits,
      before: file.before,
      after: file.after,
      unavailable: file.unavailable,
      ...codeDiff(file.before, file.after),
    }));
  }
}
