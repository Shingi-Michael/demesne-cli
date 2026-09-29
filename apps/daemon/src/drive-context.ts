import { driveAnswerText, type DriveRequest } from "@demesne/protocol";

/** Transport/validation retain full observations. The model gets one copy of
 * each visible row with provenance indexes, not four padded screen copies. */
export function drivePlannerInput(request: DriveRequest) {
  const screen = request.observation;
  if (!screen.navigation) return request;
  const reviewed = new Set(request.inspection?.pages.flatMap((page) => page.rows.map((row) => row.trim())) ?? []);
  // Rows already quoted by the inspection, and answer-card rows that are only
  // rail and padding, carry nothing new for the planner.
  const railOnly = (row: string) => /^[│▎]/.test(row.trim()) && !driveAnswerText(row);
  const rows = (screen.evidenceRows ?? screen.rows).map((row) => reviewed.has(row.trim()) || reviewed.has(driveAnswerText(row)) || railOnly(row) ? "" : row.trimEnd());
  const indexes = (source?: string[]) => rows.flatMap((row, index) => row.trim() && source?.some((text) => text.trim() && row.includes(text.trim())) ? [index] : []);
  return { ...request,
    memory: { ...request.memory, steps: request.memory.steps.slice(-6).map((step) => ({ ...step, action: step.action.slice(0, 500), note: step.note.slice(0, 350), result: step.result.slice(0, 600) })) },
    observation: { ...screen, rows, evidenceRows: undefined, answerRows: undefined, latestAnswerRows: undefined,
      answerRowIndexes: indexes(screen.answerRows), latestAnswerRowIndexes: indexes(screen.latestAnswerRows) },
  };
}
