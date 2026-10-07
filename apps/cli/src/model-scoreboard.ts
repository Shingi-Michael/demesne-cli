import type { ModelScore, ModelScoreboardResponse } from "@demesne/protocol";
import { sanitizeTerminalText } from "@demesne/brand";

/// `demesne models scoreboard`: how each model has done on your recorded work.

const percent = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : "—");
const ratio = (part: number, whole: number) => (whole ? `${part}/${whole}` : "—");

export function scoreRow(score: ModelScore) {
  return [
    `${score.provider} / ${score.model}${score.local ? " (local)" : ""}`,
    String(score.turns),
    percent(score.finished, score.finished + score.failed),
    percent(score.toolCalls - score.toolErrors, score.toolCalls),
    score.tokensPerSecond === null ? "—" : String(Math.round(score.tokensPerSecond)),
    score.firstTokenMs === null ? "—" : `${(score.firstTokenMs / 1000).toFixed(1)}s`,
    ratio(score.passingTurns, score.checkedTurns),
    ratio(score.driveLanded, score.driveRuns),
  ];
}

export function scoreboardTable(result: ModelScoreboardResponse) {
  const scope = result.workspace ? `in ${result.workspace}` : "across your projects";
  if (!result.models.length) return `No recorded model work ${scope} in the last ${result.days} days.`;
  const rows = [["MODEL", "TURNS", "FINISHED", "TOOLS OK", "TOK/S", "1ST TOKEN", "CHECKS", "DRIVE KEPT"], ...result.models.map(scoreRow)]
    .map((row) => row.map((cell) => sanitizeTerminalText(cell)));
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const lines = rows.map((row) => row.map((cell, column) => (column ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!))).join("  ").trimEnd());
  return [`Models on your own work ${scope}, last ${result.days} days`, "", ...lines, "",
    "FINISHED: turns that completed rather than failed · TOOLS OK: tool calls that didn't error · TOK/S: median generation speed",
    "CHECKS: turns whose last check passed · DRIVE KEPT: Drive proposal runs you applied or opened as a PR"].join("\n");
}
