import type { EventEnvelope, SessionStateResponse } from "@demesne/protocol";
import { classifyTurnPhase } from "../turn-activity.ts";
import type { AssistantEntry, ContextReceipt, ReasoningEntry, ResponseReceipt, ToolEntry, WorkbenchEntry } from "./entries.ts";
import { toolCompletion } from "./tool-result.ts";
import { TurnThroughputTracker } from "../turn-throughput.ts";

export function toolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return toolArguments(JSON.parse(value)); } catch { return {}; } }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function toolTarget(name: string, input: Record<string, unknown>): string | undefined {
  if (name === "move_path" && typeof input.from === "string" && typeof input.to === "string") return `${input.from} → ${input.to}`;
  if (typeof input.path === "string") return input.path;
  if (Array.isArray(input.paths) && input.paths.every((value) => typeof value === "string")) return input.paths.length === 1 ? input.paths[0] : `${input.paths.length} files`;
  if (Array.isArray(input.argv) && input.argv.every((value) => typeof value === "string")) return `$ ${input.argv.join(" ")}`;
  if (typeof input.query === "string") return `"${input.query}"`;
  return undefined;
}

/// Replay is bounded by the snapshot cursor. Original messages and evidence
/// retain event order; session summary text is a fallback for older journals.
export function restoreSessionEntries(state: SessionStateResponse, events: readonly EventEnvelope[]): WorkbenchEntry[] {
  const entries: WorkbenchEntry[] = [];
  let id = 1;
  const seen = new Set<number>();
  const journal = events.filter((event) => {
    if (event.sessionId !== state.session.id || event.eventId > state.lastEventId || seen.has(event.eventId)) return false;
    seen.add(event.eventId); return true;
  }).sort((a, b) => a.eventId - b.eventId);
  for (const turn of [...state.session.turns].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const recorded = journal.filter((event) => event.turnId === turn.id);
    const model = recorded.find((event) => event.type === "model.request_started" && typeof event.payload.model === "string")?.payload.model;
    const request = { id: id++, type: "user" as const, text: turn.content, at: new Date(turn.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), startedAt: Date.parse(turn.createdAt), model: typeof model === "string" ? model : "Model not recorded", planOnly: turn.planOnly ?? false };
    entries.push(request);
    const throughput = new TurnThroughputTracker();
    const tools = new Map<string, ToolEntry>();
    const permissions = new Map<string, string>();
    let assistant: AssistantEntry | undefined;
    let reasoning: ReasoningEntry | undefined;
    let wroteProse = false;
    let context: ContextReceipt | undefined;
    for (const event of recorded) {
      throughput.apply(event);
      const payload = event.payload;
      if (reasoning && reasoning.durationMs === null && ["message.delta", "tool.call_requested", "model.request_completed", "model.request_started"].includes(event.type)) {
        const elapsed = Date.parse(event.occurredAt) - reasoning.startedAt;
        if (Number.isFinite(elapsed) && elapsed >= 0) reasoning.durationMs = elapsed;
      }
      if (event.type === "model.request_started") {
        assistant = undefined; reasoning = undefined;
        const plan = payload.contextPlan as { estimatedInputTokens?: number; capacityTokens?: number } | undefined;
        context = { used: typeof plan?.estimatedInputTokens === "number" ? plan.estimatedInputTokens : null,
          capacity: typeof plan?.capacityTokens === "number" ? plan.capacityTokens : null, estimated: typeof plan?.estimatedInputTokens === "number" };
      }
      if (event.type === "model.usage" && context && !context.estimated) {
        context.used = typeof payload.totalTokens === "number" ? payload.totalTokens
          : typeof payload.inputTokens === "number" && typeof payload.outputTokens === "number" ? payload.inputTokens + payload.outputTokens : null;
      }
      if (event.type === "message.delta" && typeof payload.delta === "string" && payload.delta) {
        if (!assistant) { assistant = { id: id++, type: "assistant", raw: "", streaming: false, revision: 0, at: event.occurredAt }; entries.push(assistant); }
        assistant.raw += payload.delta; assistant.revision++; wroteProse = true;
      }
      if (event.type === "reasoning.delta" && typeof payload.delta === "string") {
        if (!reasoning) { reasoning = { id: id++, type: "reasoning", raw: "", streaming: false, startedAt: Date.parse(event.occurredAt), durationMs: null }; entries.push(reasoning); }
        reasoning.raw += payload.delta;
      }
      if (event.type === "tool.call_requested") {
        assistant = undefined;
        const name = String(payload.name ?? "tool");
        const input = toolArguments(payload.arguments);
        const tool: ToolEntry = { id: id++, type: "tool", toolCallId: String(payload.toolCallId ?? ""), name, input,
          detail: toolTarget(name, input), phase: classifyTurnPhase(name, input, [...tools.values()].some((tool) => tool.phase === "change")), state: "running", startedAt: Date.parse(event.occurredAt),
          ...(name === "edit_file" && typeof input.oldText === "string" && typeof input.newText === "string" ? { diff: { oldText: input.oldText, newText: input.newText } } : {}) };
        tools.set(tool.toolCallId, tool); entries.push(tool);
      }
      if (/^tool\.call_(completed|failed|denied|cancelled|interrupted)$/.test(event.type)) {
        const tool = tools.get(String(payload.toolCallId ?? ""));
        if (tool) Object.assign(tool, toolCompletion(event), { waiting: false, durationMs: typeof payload.durationMs === "number" ? payload.durationMs : Math.max(0, Date.parse(event.occurredAt) - tool.startedAt) });
      }
      if (event.type === "permission.requested") {
        const tool = tools.get(String(payload.toolCallId ?? ""));
        if (tool) { tool.waiting = true; permissions.set(String(payload.permissionId ?? ""), tool.toolCallId); }
      }
      if (event.type === "permission.resolved" || event.type === "tool.call_started") {
        const tool = tools.get(String(payload.toolCallId ?? permissions.get(String(payload.permissionId ?? "")) ?? ""));
        if (tool) tool.waiting = false;
      }
    }
    if (!wroteProse && turn.responseText) entries.push({ id: id++, type: "assistant", raw: turn.responseText, streaming: false, revision: 1,
      at: turn.completedAt ?? recorded.findLast((event) => event.type === "message.completed" || /^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type))?.occurredAt });
    if (turn.status !== "running" && turn.status !== "queued") {
      for (const tool of tools.values()) {
        if (tool.state === "running") {
          const stopped = turn.status === "cancelled" || turn.status === "interrupted";
          tool.state = stopped ? "stopped" : "failed"; tool.waiting = false;
          tool.message = stopped ? "Stopped before a result was recorded." : "The run ended before a result was recorded.";
        }
      }
      const close = recorded.findLast((event) => /^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type));
      const answer = entries.findLast((entry) => entry.type === "assistant");
      const startedAt = Date.parse(turn.createdAt);
      const endedAt = Date.parse(turn.completedAt ?? close?.occurredAt ?? "");
      const measured = throughput.snapshot();
      const responseModel = recorded.findLast((event) => event.type === "model.request_started" && typeof event.payload.model === "string")?.payload.model;
      const receipt: ResponseReceipt = { mode: turn.planOnly ? "Plan" : "Build", model: typeof responseModel === "string" ? responseModel : request.model,
        durationMs: Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt ? endedAt - startedAt : null,
        tokensPerSecond: measured.decodeTokensPerSecond ?? measured.tokensPerSecond, ...(context ? { context } : {}) };
      if (answer && answer.id > ([...tools.values()].at(-1)?.id ?? request.id)) answer.receipt = receipt;
      entries.push({ id: id++, type: "notice", text: typeof close?.payload.message === "string" ? close.payload.message : turn.status,
        tone: turn.status === "completed" ? "success" : turn.status === "failed" ? "error" : "info", closesTurn: true, receipt });
    }
  }
  return entries;
}

export async function replaySession(
  state: SessionStateResponse,
  stream: (sessionId: string, after: number, signal: AbortSignal) => AsyncIterable<EventEnvelope>,
): Promise<EventEnvelope[]> {
  if (state.lastEventId === 0 || state.session.turns.length === 0) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const events: EventEnvelope[] = [];
  try {
    for await (const event of stream(state.session.id, 0, controller.signal)) {
      if (event.sessionId !== state.session.id) continue;
      if (event.eventId <= state.lastEventId) events.push(event);
      if (event.eventId >= state.lastEventId) return events;
    }
    throw new Error("Session history replay ended before the saved cursor.");
  } finally { clearTimeout(timeout); controller.abort(); }
}
