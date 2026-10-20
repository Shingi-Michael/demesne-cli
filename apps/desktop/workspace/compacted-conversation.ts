import type { SessionCheckpoint } from "@demesne/protocol";
import type { WorkspaceRun } from "./session-model.ts";

/** Collapse only the proven prefix, never guess from turn counts or timestamps. */
export function compactedConversation(runs: readonly WorkspaceRun[], checkpoint: SessionCheckpoint | null | undefined) {
  if (!checkpoint?.firstRetainedTurnId) return null;
  const boundary = runs.findIndex(run => run.id === checkpoint.firstRetainedTurnId);
  const compaction = runs.findIndex(run => run.id === checkpoint.turnId);
  if (boundary <= 0 || compaction < boundary) return null;
  const report = runs[compaction]!.entries.filter(entry => entry.type === "assistant").map(entry => entry.raw).join("\n\n");
  // The normal report already contains readable Markdown sections. The saved
  // checkpoint is a fallback while completion events are still arriving.
  return { hiddenIds: new Set(runs.slice(0, boundary).map(run => run.id)), count: boundary, summary: report || checkpoint.summary };
}
