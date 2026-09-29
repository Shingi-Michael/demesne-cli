import { sanitizeTerminalLine, wrapDisplayText, type Painter } from "@demesne/brand";
import type { DriveState, DriveTrace } from "@demesne/protocol";
import { traceActive } from "../drive-trace.ts";
import { partialToolArguments } from "./tool-preview.ts";
import { thinkingDots } from "./interaction.ts";
import { reducedMotionEnabled } from "../motion.ts";

export function driveTraceLabel(trace: DriveTrace): string {
  if (trace.source === "controller") return traceActive(trace) ? "CONTROLLER" : `CONTROLLER · ${trace.status.toUpperCase()}`;
  return trace.status === "queued" ? "QUEUED" : trace.status === "thinking" ? "THINKING" : trace.status === "drafting" ? "CHOOSING ACTION"
    : trace.status === "acting" ? "ACTING" : trace.status.toUpperCase();
}
export function driveActivityLabel(state: DriveState, trace: DriveTrace): string {
  if (state.recovery) return "RETRYING";
  return state.status === "waiting" ? "WATCHING" : state.status !== "running" ? state.status.toUpperCase()
    : trace.status === "completed" ? "ACTION DONE" : driveTraceLabel(trace);
}
export function driveTracePreview(trace: DriveTrace): string {
  const draft = partialToolArguments(trace.actionDraft);
  if (trace.status === "acting" || !traceActive(trace)) return trace.note || trace.result || trace.text || trace.reasoning;
  if (trace.status === "drafting") return typeof draft.note === "string" ? draft.note : draft.action ? JSON.stringify(draft.action) : "Preparing drive_ui…";
  return trace.text || trace.reasoning || (trace.status === "queued" ? "Waiting for the model slot…" : "Waiting for model output…");
}
export function driveTraceLines(trace: DriveTrace, width: number, paint: Painter, expanded: boolean, now = Date.now()) {
  const rows: string[] = [];
  const add = (text: string, tone: Parameters<Painter["text"]>[1] = "secondary", field?: string) => {
    if (field) { for (const row of wrappedTraceText(`${trace.id}:${field}`, text, width, paint, tone)) rows.push(row); return; }
    for (const line of text.split("\n")) rows.push(...wrapDisplayText(sanitizeTerminalLine(line), Math.max(1, width)).map((row) => paint.text(row, tone)));
  };
  const live = traceActive(trace), seconds = Math.max(0, ((trace.completedAt ?? now) - trace.startedAt) / 1000).toFixed(1);
  add(`DRIVE · step ${trace.step}${trace.attempt > 1 ? ` · attempt ${trace.attempt}` : ""}`, "electric");
  add(`${driveTraceLabel(trace)} · ${seconds}s`, live ? "thinking" : trace.status === "failed" ? "signal" : "muted");
  const thinkingRow = rows.length;
  rows.push(trace.source === "controller" ? paint.text("UI navigation · no model inference", "muted") : (live && trace.status === "thinking" ? thinkingDots(paint, now, reducedMotionEnabled()) : paint.text("●", "thinking"))
    + paint.text(` THINKING ${expanded ? "▾" : "▸"}`, "thinking"));
  if (expanded && trace.source !== "controller") {
    if (trace.reasoning) add(trace.reasoning, "secondary", "reasoning");
    else add(live ? "Waiting for thinking output…" : "No thinking text returned by the provider.", "muted");
  }
  if (trace.text) { add(""); add(trace.text, "paper", "text"); }
  const draft = partialToolArguments(trace.actionDraft);
  if (trace.action || draft.action) { add(""); add(trace.action ? "drive_ui" : "drive_ui · draft", "electric"); add(trace.action || JSON.stringify(draft.action)); }
  if (trace.note || typeof draft.note === "string") add(trace.note || String(draft.note), "paper");
  if (trace.result) { add(""); add(trace.result, trace.status === "failed" || trace.status === "corrected" ? "signal" : "citron"); }
  if (trace.truncated) add("Retained trace limit reached; later text is omitted.", "muted");
  add(`${trace.source === "controller" ? "Local controller" : trace.model ?? "Selected model"} · ${seconds}s${trace.usage?.outputTokens != null ? ` · ${trace.usage.outputTokens.toLocaleString()} output tokens` : ""}`, "muted");
  return { rows, thinkingRow };
}

interface WrappedTrace { source: string; width: number; completeAt: number; complete: string[]; rows: string[] }
const wrapped = new WeakMap<Painter, Map<string, WrappedTrace>>();
// Timers repaint the live receipt without rewrapping saved thinking. Appends
// only reflow the final paragraph; completed paragraphs stay cached.
function wrappedTraceText(key: string, source: string, width: number, paint: Painter, tone: Parameters<Painter["text"]>[1]): string[] {
  let cache = wrapped.get(paint);
  if (!cache) { cache = new Map(); wrapped.set(paint, cache); }
  let entry = cache.get(key);
  if (!entry || entry.width !== width || !source.startsWith(entry.source)) entry = { source: "", width, completeAt: 0, complete: [], rows: [] };
  if (entry.source === source && entry.rows.length) return entry.rows;
  const end = source.lastIndexOf("\n") + 1;
  const wrap = (text: string) => wrapDisplayText(sanitizeTerminalLine(text), Math.max(1, width)).map((row) => paint.text(row, tone));
  if (end > entry.completeAt) for (const line of source.slice(entry.completeAt, end - 1).split("\n")) for (const row of wrap(line)) entry.complete.push(row);
  entry.source = source; entry.completeAt = end;
  entry.rows = entry.complete.concat(wrap(source.slice(end)));
  cache.delete(key); cache.set(key, entry);
  let characters = 0;
  for (const item of cache.values()) characters += item.source.length;
  while ((cache.size > 24 || characters > 4_200_000) && cache.size > 1) {
    const oldest = cache.keys().next().value!; characters -= cache.get(oldest)!.source.length; cache.delete(oldest);
  }
  return entry.rows;
}
