import type { DriveProgress, DriveState, DriveTrace } from "@demesne/protocol";

const TEXT_LIMIT = 2_100_000;
const HISTORY_LIMIT = TEXT_LIMIT * 2;
export const traceActive = (trace: DriveTrace): boolean => ["queued", "thinking", "drafting", "acting"].includes(trace.status);
const size = (trace: DriveTrace) => trace.reasoning.length + trace.text.length + trace.actionDraft.length;

export function beginDriveTrace(state: DriveState, attempt = 1): DriveTrace {
  const trace: DriveTrace = { id: crypto.randomUUID(), step: state.step + 1, attempt, model: state.model, status: "queued", startedAt: Date.now(), completedAt: null,
    reasoning: "", text: "", actionDraft: "", action: "", note: "", result: "" };
  state.traces = [...(state.traces ?? []), trace].slice(-8);
  trimDriveTraces(state);
  return trace;
}

export function settleDriveTrace(state: DriveState, status: DriveTrace["status"], result: string): void {
  const trace = state.traces?.at(-1);
  if (!trace || !traceActive(trace)) return;
  trace.status = status; trace.result = result.slice(0, 8000); trace.completedAt = Date.now();
}

export function updateDriveTrace(state: DriveState, event: DriveProgress): void {
  let trace = state.traces?.at(-1);
  if (!trace || event.type === "attempt" && !traceActive(trace)) trace = beginDriveTrace(state, event.type === "attempt" ? event.attempt : 1);
  if (event.type === "attempt") {
    trace.attempt = event.attempt; trace.model = state.model = `${event.provider} / ${event.model}`; trace.status = "thinking";
    if (event.thinking !== undefined) trace.thinking = event.thinking;
  } else if (event.type === "queued") trace.status = "queued";
  else if (event.type === "correction") settleDriveTrace(state, "corrected", `Correcting decision: ${event.message}`);
  else if (event.type === "usage") trace.usage = event.usage;
  else {
    const field = event.type === "reasoning.delta" ? "reasoning" : event.type === "text.delta" ? "text" : "actionDraft";
    trace.status = field === "actionDraft" ? "drafting" : "thinking";
    const room = Math.max(0, TEXT_LIMIT - size(trace));
    trace[field] += event.delta.slice(0, room);
    if (room < event.delta.length) trace.truncated = true;
  }
  trimDriveTraces(state);
}

function trimDriveTraces(state: DriveState): void {
  let total = (state.traces ?? []).reduce((sum, trace) => sum + size(trace), 0);
  while (total > HISTORY_LIMIT && state.traces!.length > 1) total -= size(state.traces!.shift()!);
}

/** Trace corruption must not discard an otherwise recoverable mission. */
export function restoreDriveTraces(value: unknown): DriveTrace[] {
  if (!Array.isArray(value)) return [];
  const traces: DriveTrace[] = [];
  for (const trace of value.slice(-8)) {
    if (!trace || typeof trace.id !== "string" || !Number.isSafeInteger(trace.step) || !Number.isSafeInteger(trace.attempt)
      || !Number.isFinite(trace.startedAt) || !(trace.completedAt === null || Number.isFinite(trace.completedAt))
      || !(trace.model === null || typeof trace.model === "string")
      || !["queued", "thinking", "drafting", "acting", "completed", "corrected", "failed", "stopped"].includes(trace.status)
      || !["reasoning", "text", "actionDraft", "action", "note", "result"].every((key) => typeof trace[key] === "string" && trace[key].length <= TEXT_LIMIT)) continue;
    if (size(trace) > TEXT_LIMIT) continue;
    const usage = trace.usage && ["inputTokens", "outputTokens", "totalTokens"].every((key) => trace.usage[key] === null || Number.isSafeInteger(trace.usage[key]) && trace.usage[key] >= 0)
      ? { inputTokens: trace.usage.inputTokens, outputTokens: trace.usage.outputTokens, totalTokens: trace.usage.totalTokens } : undefined;
    // Keep only validated fields so a partial trace cannot poison restoration.
    traces.push({ id: trace.id, step: trace.step, attempt: trace.attempt, model: trace.model,
      ...(trace.source === "controller" ? { source: "controller" as const } : {}),
      ...(typeof trace.thinking === "boolean" ? { thinking: trace.thinking } : {}),
      status: traceActive(trace) ? "stopped" : trace.status, startedAt: trace.startedAt, completedAt: trace.completedAt ?? Date.now(),
      reasoning: trace.reasoning, text: trace.text, actionDraft: trace.actionDraft, action: trace.action, note: trace.note,
      result: traceActive(trace) ? "Planning interrupted when the workbench closed." : trace.result, truncated: trace.truncated === true, ...(usage ? { usage } : {}) });
  }
  let total = traces.reduce((sum, trace) => sum + size(trace), 0);
  while (total > HISTORY_LIMIT && traces.length > 1) total -= size(traces.shift()!);
  return traces;
}
