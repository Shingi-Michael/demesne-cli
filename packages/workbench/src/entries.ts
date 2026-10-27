import type { ToolPhaseName } from "@demesne/brand";

import { subagentStatus } from "./subagent-status.ts";

export interface TraceSegment { kind: "step"; text: string }
const TRACE_LIMIT = 64 * 1024;

/// Folds one `tool.call_progress` payload into a sub-agent's steps: a step
/// line as the sub-agent starts it, and at the end what it found. Status
/// lines (starting, writing report) and any thinking an old event carries
/// are dropped. Live updates and history replay share this, so a reopened
/// session shows the same steps.
export function applyToolProgress(tool: { trace?: TraceSegment[]; report?: string; subagentModel?: string }, payload: Record<string, unknown>): void {
  if (typeof payload.report === "string" && payload.report) tool.report = payload.report;
  if (typeof payload.text !== "string" || !payload.text) return;
  const status = subagentStatus(payload.text);
  if (status) { if (status.model) tool.subagentModel = status.model; return; }
  const trace = tool.trace ??= [];
  const size = trace.reduce((sum, segment) => sum + segment.text.length, 0);
  if (size >= TRACE_LIMIT) return;
  trace.push({ kind: "step", text: payload.text.slice(0, TRACE_LIMIT - size) });
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
  /// A sub-agent's steps, in order, for the guide that unfolds under its row.
  trace?: TraceSegment[];
  /// What a sub-agent found: its report, for the end of that guide.
  report?: string;
  /// The model a sub-agent reported running on, when not the chat's own.
  subagentModel?: string;
}
/// `quiet`: a line on the step guide (a provider switch), not a band.
/// `steer`: words you sent mid-turn, on the guide where the model read them.
export interface NoticeEntry { id: number; type: "notice"; text: string; tone: "info" | "success" | "error"; closesTurn?: boolean; quiet?: boolean; steer?: boolean; receipt?: ResponseReceipt }
export interface BlockEntry { id: number; type: "block"; lines: string[] }
export interface PanelEntry { id: number; type: "panel"; lines: string[]; title?: string; files?: import("@demesne/protocol").WorkspaceFileInfo[] }
export type WorkbenchEntry = UserEntry | AssistantEntry | ReasoningEntry | ToolEntry | NoticeEntry | BlockEntry | PanelEntry;
