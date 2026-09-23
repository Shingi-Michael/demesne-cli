import type { ToolPhaseName } from "@demesne/brand";

/// Plans how a turn's entries become transcript lines.
///
/// Reading six files in one round is one act of homework, not six rows. A run
/// of three or more contiguous same-verb inspection calls collapses into a
/// single summary row.
///
/// The run must be *contiguous*: narration between two tool calls ends the run.
/// Collapsing across narration would mean either dropping the agent's words or
/// burying them inside a row that claims to summarize tool calls, and the agent
/// should never appear to have said less than it did. Verbosity in the model's
/// narration is the model's business, not something the transcript silently
/// censors.

/// The fields a collapsed summary row needs, copied off the entries it
/// summarizes. Groups carry this reduced shape rather than the original entries
/// because rendering a summary only needs the columns it prints.
export interface PlannedTool {
  type: "tool";
  name: string;
  phase: ToolPhaseName;
  state: string;
  waiting?: boolean;
  detail?: string;
  durationMs?: number;
  message?: string;
  id?: number;
}

/// The shape the planner reads. Tool fields are optional here because the list
/// also contains prose, notices, and user turns.
export interface PlannedEntry {
  type: string;
  name?: string;
  phase?: ToolPhaseName;
  state?: string;
  waiting?: boolean;
  detail?: string;
  /// Nullable because reasoning entries report a null duration before they
  /// close; tool entries only ever set a number.
  durationMs?: number | null;
  message?: string;
  id?: number;
}

export type TranscriptPlan<T> =
  | { kind: "entry"; entry: T }
  | { kind: "group"; tools: PlannedTool[] };

export const MIN_COLLAPSED_INSPECTIONS = 3;

/// Inspection is the agent's homework: it is worth knowing that six files were
/// read, rarely worth six lines. Changes and verification are the evidence of
/// what happened, so they are never collapsed.
function collapsible(entry: PlannedEntry): boolean {
  return entry.type === "tool" && entry.phase === "inspect" && entry.waiting !== true && entry.state !== "stopped" && entry.state !== "denied";
}

function asPlannedTool(entry: PlannedEntry): PlannedTool {
  return {
    type: "tool",
    name: entry.name ?? "",
    phase: entry.phase ?? "inspect",
    state: entry.state ?? "done",
    ...(entry.waiting !== undefined ? { waiting: entry.waiting } : {}),
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    ...(typeof entry.durationMs === "number" ? { durationMs: entry.durationMs } : {}),
    ...(entry.message !== undefined ? { message: entry.message } : {}),
    ...(entry.id !== undefined ? { id: entry.id } : {}),
  };
}

export function planTranscript<T extends PlannedEntry>(
  entries: readonly T[],
  minimum = MIN_COLLAPSED_INSPECTIONS,
): Array<TranscriptPlan<T>> {
  const plan: Array<TranscriptPlan<T>> = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (!collapsible(entry)) {
      plan.push({ kind: "entry", entry });
      index += 1;
      continue;
    }
    const tools: PlannedTool[] = [asPlannedTool(entry)];
    let cursor = index + 1;
    while (cursor < entries.length) {
      const next = entries[cursor]!;
      if (!collapsible(next) || next.name !== entry.name) break;
      tools.push(asPlannedTool(next));
      cursor += 1;
    }
    if (tools.length >= minimum) {
      plan.push({ kind: "group", tools });
      index = cursor;
    } else {
      plan.push({ kind: "entry", entry });
      index += 1;
    }
  }
  return plan;
}
