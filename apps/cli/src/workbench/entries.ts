import type { ToolPhaseName } from "@demesne/brand";

export type ToolState = "running" | "done" | "failed" | "denied" | "stopped";
export interface UserEntry { turnId?: string; id: number; type: "user"; text: string; at: string; startedAt?: number; model?: string; planOnly?: boolean; compaction?: boolean }
export interface ContextReceipt { used: number | null; capacity: number | null; estimated: boolean }
export interface ResponseReceipt { mode: "Build" | "Plan" | "Compact"; model: string; durationMs: number | null; tokensPerSecond: number | null; context?: ContextReceipt }
export interface AssistantEntry { id: number; type: "assistant"; raw: string; streaming: boolean; revision: number; at?: string; receipt?: ResponseReceipt }
export interface ReasoningEntry { id: number; type: "reasoning"; raw: string; streaming: boolean; startedAt: number; durationMs: number | null }
export interface ToolEntry {
  id: number; type: "tool"; toolCallId: string; name: string; input: Record<string, unknown>;
  detail?: string; state: ToolState; durationMs?: number; message?: string; exitCode?: number;
  created?: boolean; diff?: { oldText: string; newText: string }; startedAt: number;
  waiting?: boolean; phase: ToolPhaseName;
  draftId?: string; draftArguments?: string; drafting?: boolean;
  changes?: import("@demesne/protocol").ToolFileChange[];
}
export interface NoticeEntry { id: number; type: "notice"; text: string; tone: "info" | "success" | "error"; closesTurn?: boolean; receipt?: ResponseReceipt }
export interface BlockEntry { id: number; type: "block"; lines: string[] }
export interface PanelEntry { id: number; type: "panel"; lines: string[]; title?: string; files?: import("@demesne/protocol").WorkspaceFileInfo[] }
export type WorkbenchEntry = UserEntry | AssistantEntry | ReasoningEntry | ToolEntry | NoticeEntry | BlockEntry | PanelEntry;
