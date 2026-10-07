import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DriveCalibration, DriveFix, DriveProposal } from "@demesne/protocol";

/// Drive learns how good its own proposals are. Each Next proposal you Run
/// leaves an outcome (landed: applied or opened as a PR; missed: discarded,
/// failed, or nothing worth changing) and how long it really took. The queue
/// then ranks with this project's observed landing rate per confidence level
/// instead of the model's word for it, and scales time estimates by how far
/// off they have been.

export interface CalibrationRecord {
  at: string;
  workspace: string;
  proposalId: string;
  kind: DriveProposal["kind"];
  confidence: DriveProposal["confidence"] | null;
  /// The model's estimate and the real coding time, in minutes.
  minutes: number | null;
  actualMinutes: number | null;
  outcome: "landed" | "discarded" | "failed" | "unchanged";
  /// The model that did the run, for the model scoreboard.
  provider?: string | null; model?: string | null;
}

/// The model's own confidence, and the prior each level starts from.
export const CONFIDENCE = { high: 1, medium: 0.7, low: 0.4 } as const;
/// How many outcomes the prior counts as: a few real ones move it, one doesn't.
const PRIOR_WEIGHT = 3;
/// Time estimates are scaled once there are this many timed runs.
const MIN_TIMED = 3;
/// Only the most recent outcomes count, so the ranking follows the project.
const RECENT = 50;

/// The outcome a finished proposal run counts as, or null when it says
/// nothing about the proposal (an investigation that rightly changed nothing).
export function outcomeOf(fix: DriveFix, before: DriveFix["status"]): CalibrationRecord["outcome"] | null {
  if (fix.status === "applied" || fix.status === "pr") return "landed";
  if (fix.status !== "discarded") return null;
  if (before === "ready") return "discarded";
  if (fix.unchanged) return fix.proposal?.kind === "investigate" ? null : "unchanged";
  return "failed";
}

export function calibrate(records: CalibrationRecord[]): DriveCalibration {
  const recent = records.slice(-RECENT);
  const landed = recent.filter((record) => record.outcome === "landed").length;
  const levels = {} as DriveCalibration["levels"];
  for (const level of ["high", "medium", "low"] as const) {
    const mine = recent.filter((record) => record.confidence === level);
    const hits = mine.filter((record) => record.outcome === "landed").length;
    levels[level] = { landed: hits, total: mine.length, weight: Math.round(((hits + CONFIDENCE[level] * PRIOR_WEIGHT) / (mine.length + PRIOR_WEIGHT)) * 100) / 100 };
  }
  const ratios = recent.filter((record) => record.minutes && record.actualMinutes !== null && record.actualMinutes > 0)
    .map((record) => record.actualMinutes! / record.minutes!).sort((a, b) => a - b);
  const median = ratios.length ? ratios[Math.floor(ratios.length / 2)]! : 1;
  const timeRatio = ratios.length >= MIN_TIMED ? Math.round(Math.min(4, Math.max(0.25, median)) * 100) / 100 : 1;
  return { landed, total: recent.length, levels, timeRatio, timed: ratios.length };
}

/// value × confidence ÷ cost, where cost grows with time and coders; an
/// urgent cited signal (failing check, red CI) doubles the score. With a
/// calibration, confidence is this project's observed landing rate for that
/// level and time is scaled by how long runs really took.
export function scoreProposal(item: Pick<DriveProposal, "value" | "confidence" | "minutes" | "coders">, urgent: boolean, calibration?: DriveCalibration | null) {
  const confidence = calibration ? calibration.levels[item.confidence].weight : CONFIDENCE[item.confidence];
  const minutes = item.minutes * (calibration?.timeRatio ?? 1);
  const cost = Math.max(0.5, (minutes / 30) * item.coders);
  return Math.round((100 * item.value * confidence * (urgent ? 2 : 1)) / cost) / 100;
}

/// Re-scores a ranked queue with a calibration and re-sorts it. Each
/// proposal keeps the model's estimate in `minutes`; `expectedMinutes` is
/// the calibrated one shown to you.
export function applyCalibration(proposals: DriveProposal[], calibration: DriveCalibration | null): DriveProposal[] {
  if (!calibration?.total) return proposals;
  return proposals.map((item) => {
    const expectedMinutes = Math.max(5, Math.round(item.minutes * calibration.timeRatio));
    return { ...item, score: scoreProposal(item, item.urgent, calibration), ...(calibration.timeRatio !== 1 ? { expectedMinutes } : {}) };
  }).sort((a, b) => b.score - a.score);
}

/// The append-only outcome log, one JSON record per line.
export class CalibrationLog {
  constructor(private readonly path: string) {}

  /// One workspace's outcomes, or every workspace's.
  records(workspace?: string | null): CalibrationRecord[] {
    if (!existsSync(this.path)) return [];
    const out: CalibrationRecord[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const record = JSON.parse(line) as CalibrationRecord; if (!workspace || record.workspace === workspace) out.push(record); } catch { /* a torn line */ }
    }
    return out;
  }

  calibration(workspace: string): DriveCalibration | null {
    const records = this.records(workspace);
    return records.length ? calibrate(records) : null;
  }

  /// Records a proposal run that just ended, if it says anything.
  settle(fix: DriveFix, before: DriveFix["status"], by?: { provider: string; model: string } | null) {
    if (!fix.proposal) return;
    const outcome = outcomeOf(fix, before);
    if (!outcome) return;
    const finished = fix.finishedAt ? Date.parse(fix.finishedAt) : NaN;
    const actualMinutes = Number.isFinite(finished) ? Math.max(0, Math.round((finished - Date.parse(fix.startedAt)) / 6_000) / 10) : null;
    const record: CalibrationRecord = { at: new Date().toISOString(), workspace: fix.workspace, proposalId: fix.proposal.id, kind: fix.proposal.kind,
      confidence: fix.proposal.confidence ?? null, minutes: fix.proposal.minutes ?? null, actualMinutes: outcome === "landed" || outcome === "discarded" ? actualMinutes : null, outcome,
      ...(by ? { provider: by.provider, model: by.model } : {}) };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
}
