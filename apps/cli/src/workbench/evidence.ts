/// Single-source projection of a run's recorded evidence.
///
/// Both the response summary and the change-review surface read from this, so
/// they cannot disagree about what a run changed or whether it was verified.
/// The projection is a pure function of the recorded entries: live runs and
/// replayed sessions both produce `ToolEntry` records with the same fields, so
/// they project identically.

import type { ToolEntry, WorkbenchEntry } from "./entries.ts";

/// The outcome of a single recorded change operation. A failed or denied write
/// is never reported as a successful change.
export type ChangeOutcome = "done" | "failed" | "denied" | "stopped" | "pending";

export interface ChangeEvidence {
  id: number;
  toolCallId: string;
  name: string;
  /// The recorded target: a path, or `from → to` for a move.
  path: string;
  operation: "A" | "M" | "R" | "D";
  outcome: ChangeOutcome;
  /// Per-edit replacement pair, retained for `edit_file`. Repeated edits to one
  /// file stay separate — they are never merged into a synthesized net diff.
  diff?: { oldText: string; newText: string };
  message?: string;
  exitCode?: number;
  durationMs?: number;
}

/// The outcome of a single recorded verification command.
export type VerificationOutcome = "passed" | "failed" | "running" | "waiting" | "denied" | "stopped" | "unknown";

export interface VerificationEvidence {
  id: number;
  toolCallId: string;
  name: string;
  command: string;
  outcome: VerificationOutcome;
  exitCode?: number;
  /// Recorded stdout/stderr, including any truncation marker.
  output?: string;
  durationMs?: number;
}

/// The aggregate verification state for a run, as far as the records support it.
export type VerificationState = "not-run" | VerificationOutcome;

export interface RunEvidence {
  changes: ChangeEvidence[];
  verifications: VerificationEvidence[];
  /// Any change-phase operation was recorded, successful or not.
  hasChanges: boolean;
  successfulChanges: number;
  /// Failed or denied change operations.
  failedChanges: number;
  verification: VerificationState;
  /// Every recorded tool that failed or was denied, across all phases.
  failedOrDenied: number;
}

/// A cancelled command may have a signal-derived exit code. It is still a
/// stopped operation, not a failed check or a denied permission.
export const toolFailed = (tool: { state?: string; exitCode?: number }): boolean =>
  tool.state === "failed" || tool.state === "done" && typeof tool.exitCode === "number" && tool.exitCode !== 0;

export function changeOutcome(tool: ToolEntry): ChangeOutcome {
  if (tool.state === "denied") return "denied";
  if (tool.state === "stopped") return "stopped";
  if (toolFailed(tool)) return "failed";
  if (tool.state === "done") return "done";
  return "pending"; // still running or waiting for approval
}

export function verificationOutcome(tool: ToolEntry): VerificationOutcome {
  if (tool.state === "denied") return "denied";
  if (tool.state === "stopped") return "stopped";
  if (tool.state === "running") return tool.waiting ? "waiting" : "running";
  if (toolFailed(tool)) return "failed";
  return tool.exitCode === 0 ? "passed" : "unknown";
}

function changeOperation(tool: ToolEntry): "A" | "M" | "R" | "D" {
  if (tool.name === "move_path") return "R";
  if (tool.name === "delete_path") return "D";
  return tool.created ? "A" : "M";
}

export function aggregateVerification(verifications: readonly VerificationEvidence[]): VerificationState {
  if (verifications.length === 0) return "not-run";
  if (verifications.some((verification) => verification.outcome === "running")) return "running";
  if (verifications.some((verification) => verification.outcome === "waiting")) return "waiting";
  if (verifications.some((verification) => verification.outcome === "failed")) return "failed";
  if (verifications.some((verification) => verification.outcome === "denied")) return "denied";
  if (verifications.some((verification) => verification.outcome === "stopped")) return "stopped";
  if (verifications.some((verification) => verification.outcome === "unknown")) return "unknown";
  return "passed";
}

export function projectRunEvidence(entries: readonly WorkbenchEntry[]): RunEvidence {
  const changes: ChangeEvidence[] = [];
  const verifications: VerificationEvidence[] = [];
  let failedOrDenied = 0;
  for (const entry of entries) {
    if (entry.type !== "tool") continue;
    const tool: ToolEntry = entry;
    if (toolFailed(tool) || tool.state === "denied") failedOrDenied++;
    if (tool.phase === "change") {
      changes.push({
        id: tool.id,
        toolCallId: tool.toolCallId,
        name: tool.name,
        path: tool.detail ?? tool.name,
        operation: changeOperation(tool),
        outcome: changeOutcome(tool),
        ...(tool.diff ? { diff: tool.diff } : {}),
        ...(tool.message ? { message: tool.message } : {}),
        ...(tool.exitCode !== undefined ? { exitCode: tool.exitCode } : {}),
        ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
      });
    } else if (tool.phase === "verify" && tool.name === "run_command") {
      verifications.push({
        id: tool.id,
        toolCallId: tool.toolCallId,
        name: tool.name,
        command: (tool.detail ?? "").replace(/^\$\s*/, ""),
        outcome: verificationOutcome(tool),
        ...(tool.exitCode !== undefined ? { exitCode: tool.exitCode } : {}),
        ...(tool.message ? { output: tool.message } : {}),
        ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
      });
    }
  }
  const successfulChanges = changes.filter((change) => change.outcome === "done").length;
  const failedChanges = changes.filter((change) => change.outcome === "failed" || change.outcome === "denied").length;
  return {
    changes,
    verifications,
    hasChanges: changes.length > 0,
    successfulChanges,
    failedChanges,
    verification: aggregateVerification(verifications),
    failedOrDenied,
  };
}
