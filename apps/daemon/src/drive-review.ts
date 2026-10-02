import { createHash } from "node:crypto";
import type { DemesneStore } from "@demesne/storage";
import {
  isRecord,
  type DriveCheckpointReason,
  type DriveReview,
} from "@demesne/protocol";
import type { CommandMonitor } from "./command-monitor.ts";
import { collectDriveFacts } from "./drive-facts.ts";

/** Captured only after the review owns a model slot. Streaming tokens and clocks
 * do not change the revision; concrete tool actions, outcomes and source do. */
export function collectDriveReview(
  store: DemesneStore,
  commands: CommandMonitor,
  sessionId: string,
  turnId: string,
  reason: DriveCheckpointReason = "interval",
  queueMs = 0,
) {
  const snapshot = store.driveReviewSnapshot(sessionId, turnId);
  const facts = collectDriveFacts(store, commands, sessionId, turnId);
  const revision = createHash("sha256")
    .update(
      JSON.stringify([
        sessionId,
        turnId,
        snapshot.cursor,
        snapshot.turn.status,
        snapshot.waitingForHuman,
        facts.progress,
      ]),
    )
    .digest("hex");
  const rows: string[] = [];
  let remaining = 16000;
  const add = (text: string) => {
    if (rows.length >= 40 || remaining <= 0) return;
    const line = text
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, Math.min(1600, remaining));
    if (line) {
      rows.push(line);
      remaining -= line.length;
    }
  };
  for (const call of snapshot.calls) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments_json);
    } catch {}
    if (!isRecord(args)) args = {};
    const target =
      Array.isArray(args.argv) &&
      args.argv.every((arg) => typeof arg === "string")
        ? args.argv.join(" ")
        : ([args.path, args.pattern, args.query, args.from].find(
            (value) => typeof value === "string",
          ) ?? "");
    add(`${call.name} [${call.status}] ${String(target).slice(0, 900)}`);
    if (call.result_text)
      add(`Result ${call.name}: ${call.result_text.slice(0, 1200)}`);
  }
  for (const check of facts.checks
    .filter((c) => c.turnId === turnId)
    .slice(0, 6))
    add(`Check ${check.command}: ${check.status}, ${check.freshness}`);
  for (const path of facts.changedFiles.slice(0, 6))
    add(`Changed file: ${path}`);
  const review: DriveReview = {
    id: `review-${revision.slice(0, 24)}`,
    sessionId,
    turnId,
    revision,
    cursor: snapshot.cursor,
    capturedAt: new Date().toISOString(),
    queueMs,
    reason,
    status: snapshot.turn.status,
    waitingForHuman: snapshot.waitingForHuman,
    rows,
  };
  return { review, facts };
}
