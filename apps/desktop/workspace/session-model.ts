import {
  isRecord,
  parseUserQuestions,
  type EventEnvelope,
  type ReplayEvent,
  type SessionStateResponse,
  type Turn,
  type ProviderCallSnapshot,
  type UserQuestion,
  type UserAnswer,
  type QuestionState,
  type TurnAttachment,
  type NearbyAgent,
} from "@demesne/protocol";
import {
  restoreSessionEntries,
  toolArguments,
} from "@demesne/workbench/history.ts";
import { derivePersistedRule } from "@demesne/workbench/allow-rules.ts";
import { codeDiff } from "@demesne/workbench/change-diff.ts";
import type {
  WorkbenchEntry,
  ToolEntry,
  ResponseReceipt,
} from "@demesne/workbench/entries.ts";

export interface WorkspaceApproval {
  id: string;
  turnId: string;
  toolCallId: string;
  name: string;
  summary: string;
  input: Record<string, unknown>;
  rule: string | null;
  /// Times in a row this rule was allowed once in the project; at three the
  /// row puts Always under Enter.
  allowedBefore: number;
  /// The write would change a file another agent changed since this chat
  /// saw it; the window asks "Ask it first" or "Change anyway".
  overlap?: { path: string; agents: NearbyAgent[] };
}
export interface WorkspaceQuestion extends Partial<Omit<QuestionState,"id" | "turnId" | "toolCallId" | "questions">> {
  id: string;
  turnId: string;
  toolCallId: string;
  questions: UserQuestion[];
}
export interface WorkspaceRun {
  id: string;
  number: number;
  content: string;
  status: Turn["status"];
  createdAt: string;
  completedAt: string | null;
  planOnly: boolean;
  kind?: string;
  fromDrive?: boolean;
  fromRoutine?: string;
  attachments?: TurnAttachment[];
  entries: WorkbenchEntry[];
  receipt?: ResponseReceipt;
}
export interface WorkspaceChange {
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
export class WorkspaceSession {
  state: SessionStateResponse;
  cursor: number;
  provider: ProviderCallSnapshot | null;
  approvals = new Map<string, WorkspaceApproval>();
  questions = new Map<string, WorkspaceQuestion>();
  /// Answered questions by the step that asked them, for its folded line.
  answered = new Map<string, { questions: UserQuestion[]; answers: UserAnswer[] }>();
  private journals = new Map<string, ReplayEvent[]>();
  private cache = new Map<string, WorkspaceRun>();
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
          rule: item.rule ?? null,
          allowedBefore: item.allowedBefore ?? 0,
        });
    for (const [id, question] of this.questions)
      if (!question.open && !this.isActive(question.turnId)) this.questions.delete(id);
    if (state.pendingQuestions) {
      this.questions.clear();
      for (const question of state.pendingQuestions) this.questions.set(question.id,question);
    }
    for (const question of state.answeredQuestions ?? [])
      this.answered.set(question.toolCallId, { questions: question.questions, answers: question.answers });
  }
  get session() {
    return this.state.session;
  }
  get rewinds() {
    return this.state.rewinds ?? [];
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
    if (event.type === "session.permissions_changed" && typeof p.acceptEdits === "boolean")
      this.session.acceptEdits = p.acceptEdits;
    // A new message seals the last rewind: Redo no longer applies.
    if (event.type === "turn.created") for (const rewind of this.state.rewinds ?? []) rewind.redoable = false;
    if (event.type === "session.rewound" && typeof p.rewindId === "string" && typeof p.turnId === "string")
      this.state.rewinds = [...(this.state.rewinds ?? []).map((rewind) => ({ ...rewind, redoable: false })), {
        id: p.rewindId, turnId: p.turnId, toolCallId: typeof p.toolCallId === "string" ? p.toolCallId : null,
        hiddenTurnIds: Array.isArray(p.hiddenTurnIds) ? p.hiddenTurnIds.map(String) : [],
        files: Array.isArray(p.files) ? p.files.map(String) : [], commands: Number(p.commands ?? 0), redoable: true,
      }];
    if (event.type === "session.rewind_redone") this.state.rewinds = (this.state.rewinds ?? []).filter((rewind) => rewind.id !== p.rewindId);
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
        ...(p.kind === "compaction" || p.kind === "themefy" ? { kind: p.kind } : {}),
        ...(p.fromDrive === true ? { fromDrive: true } : {}),
        ...(typeof p.fromRoutine === "string" && p.fromRoutine ? { fromRoutine: p.fromRoutine } : {}),
        ...(Array.isArray(p.attachments) ? { attachments: p.attachments as TurnAttachment[] } : {}),
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
          if (item.turnId === turn.id && item.status !== "paused" && !item.open) this.questions.delete(id);
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
    if (event.type === "session.compacted" && isRecord(p.checkpoint)) {
      const checkpoint = p.checkpoint as unknown as NonNullable<SessionStateResponse["checkpoint"]>;
      this.state.checkpoint = checkpoint;
      // The summarizer's request consumed the old history. The context meter
      // must now describe the saved summary plus retained turns, just as the
      // persisted session snapshot does. Keep actual provider usage intact.
      if (this.provider) this.provider = { ...this.provider, contextPlan: checkpoint.contextPlan };
    }
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
        allowedBefore: typeof p.allowedBefore === "number" ? p.allowedBefore : 0,
        ...(isRecord(p.overlap) && typeof p.overlap.path === "string" && Array.isArray(p.overlap.agents)
          ? { overlap: { path: p.overlap.path, agents: p.overlap.agents as NearbyAgent[] } } : {}),
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
      if (current) this.questions.set(current.id,{...current,...p.state} as WorkspaceQuestion);
    }
    if (event.type === "question.resolved") {
      const asked = this.questions.get(String(p.questionId));
      if (asked && Array.isArray(p.answers)) this.answered.set(asked.toolCallId, { questions: asked.questions, answers: p.answers as UserAnswer[] });
    }
    if (event.type === "question.resolved" || event.type === "question.cancelled")
      this.questions.delete(String(p.questionId));
  }
  runs(): WorkspaceRun[] {
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
          ...(turn.fromDrive ? { fromDrive: true } : {}),
          ...(turn.fromRoutine ? { fromRoutine: turn.fromRoutine } : {}),
          ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
          entries,
          receipt: close?.type === "notice" ? close.receipt : undefined,
        };
        this.cache.set(turn.id, run);
      }
      return run;
    });
  }
  changes(id: string): WorkspaceChange[] {
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
