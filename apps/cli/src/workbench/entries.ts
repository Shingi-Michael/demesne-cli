import type { ToolPhaseName } from "@demesne/brand";

import { subagentStatus } from "./subagent-phrases.ts";

export interface TraceSegment { kind: "thinking" | "step"; text: string }
const TRACE_LIMIT = 64 * 1024;

/// Folds one `tool.call_progress` payload into a tool's trace: consecutive
/// thinking slices join one block; a step line follows it. Live updates and
/// history replay share this, so a reopened session shows the same trace.
export function applyToolProgress(tool: { trace?: TraceSegment[] }, payload: Record<string, unknown>): void {
  const trace = tool.trace ??= [];
  const size = trace.reduce((sum, segment) => sum + segment.text.length, 0);
  if (size >= TRACE_LIMIT) return;
  const room = (text: string) => text.slice(0, TRACE_LIMIT - size);
  if (typeof payload.thinking === "string" && payload.thinking) {
    const last = trace.at(-1);
    if (last?.kind === "thinking") last.text += room(payload.thinking); else trace.push({ kind: "thinking", text: room(payload.thinking) });
  }
  if (typeof payload.text === "string" && payload.text && !subagentStatus(payload.text))
    trace.push({ kind: "step", text: room(payload.text) });
}

export type ToolState = "running" | "done" | "failed" | "denied" | "stopped";
export interface UserEntry { turnId?: string; id: number; type: "user"; text: string; at: string; startedAt?: number; model?: string; planOnly?: boolean; compaction?: boolean }
export interface ContextReceipt { used: number | null; capacity: number | null; estimated: boolean }
export interface ResponseReceipt { mode: "Build" | "Plan" | "Compact" | "Themefy"; model: string; durationMs: number | null; tokensPerSecond: number | null; context?: ContextReceipt }
export interface AssistantEntry { id: number; type: "assistant"; raw: string; streaming: boolean; revision: number; at?: string; receipt?: ResponseReceipt }
export interface ReasoningEntry { id: number; type: "reasoning"; raw: string; streaming: boolean; startedAt: number; durationMs: number | null }
export interface ToolEntry {
  id: number; type: "tool"; toolCallId: string; name: string; input: Record<string, unknown>;
  detail?: string; state: ToolState; durationMs?: number; message?: string; exitCode?: number;
  created?: boolean; diff?: { oldText: string; newText: string }; startedAt: number;
  waiting?: boolean; phase: ToolPhaseName;
  draftId?: string; draftArguments?: string; drafting?: boolean;
  changes?: import("@demesne/protocol").ToolFileChange[];
  /// A sub-agent's thinking and steps, in order, for its card.
  trace?: TraceSegment[];
  /// The model a sub-agent reported running on (it picks the card's pokes).
  subagentModel?: string;
}
export interface NoticeEntry { id: number; type: "notice"; text: string; tone: "info" | "success" | "error"; closesTurn?: boolean; receipt?: ResponseReceipt }
export interface BlockEntry { id: number; type: "block"; lines: string[] }
export interface PanelEntry { id: number; type: "panel"; lines: string[]; title?: string; files?: import("@demesne/protocol").WorkspaceFileInfo[] }
export type WorkbenchEntry = UserEntry | AssistantEntry | ReasoningEntry | ToolEntry | NoticeEntry | BlockEntry | PanelEntry;
