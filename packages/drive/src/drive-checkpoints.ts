import {
  isRecord,
  type DriveProtection,
  type ReplayEvent,
  type DriveCheckpointReason,
} from "@demesne/protocol";
import { fingerprint } from "./drive-protection.ts";
export const CHECKPOINT_COOLDOWN_MS = 15000;
type Worker = NonNullable<DriveProtection["worker"]>;
const stable = (value: unknown, depth = 0): unknown =>
  depth >= 8
    ? "[nested]"
    : Array.isArray(value)
      ? value.map((item) => stable(item, depth + 1))
      : isRecord(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, stable(value[key], depth + 1)]),
          )
        : value;
export function recordDriveCheckpoint(
  worker: Worker,
  event: ReplayEvent,
): boolean {
  const payload = event.payload,
    id = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
  if (event.type === "tool.call_requested" && id) {
    let args: Record<string, unknown> = {};
    try {
      args =
        typeof payload.arguments === "string"
          ? JSON.parse(payload.arguments)
          : isRecord(payload.arguments)
            ? payload.arguments
            : {};
    } catch {}
    if (!isRecord(args)) args = {};
    const name = typeof payload.name === "string" ? payload.name : "",
      key = fingerprint(JSON.stringify([name, stable(args)]));
    worker.recentTools = [
      ...(worker.recentTools ?? []),
      {
        id,
        key,
        check:
          name === "run_command" &&
          args.background !== true &&
          /\b(test|typecheck|check|lint|build|pytest|tsc|eslint|vitest|jest|xcodebuild)\b/i.test(
            Array.isArray(args.argv) &&
              args.argv.every((arg) => typeof arg === "string")
              ? args.argv.join(" ")
              : "",
          ),
      },
    ].slice(-12);
    return false;
  }
  let reason: DriveCheckpointReason | undefined;
  if (["tool.call_completed", "tool.call_failed"].includes(event.type)) {
    const call = worker.recentTools?.find((call) => call.id === id);
    if (call?.check) reason = "check_completed";
    if (
      event.type === "tool.call_completed" &&
      ["edit_file", "write_file", "move_path", "delete_path"].includes(
        typeof payload.name === "string" ? payload.name : "",
      )
    ) {
      worker.editBatch = Math.min(12, (worker.editBatch ?? 0) + 1);
      if (worker.editBatch >= 2) reason = "edit_batch";
    }
    if (
      call &&
      worker.recentTools!.filter((item) => item.key === call.key).length >= 3
    )
      reason = "repeated_tools";
  }
  if (reason) {
    // Several quick tools become one review. Repetition is more urgent than a routine batch.
    if (worker.checkpoint?.reason === "repeated_tools")
      reason = "repeated_tools";
    worker.checkpoint = {
      reason,
      cursor: event.throughEventId ?? event.eventId,
    };
    return true;
  }
  return false;
}
export function checkpointDue(worker: Worker, now: number) {
  return Boolean(
    worker.checkpoint &&
      worker.checkpoint.cursor > worker.checkCursor &&
      now >= (worker.checkpointReadyAt ?? 0),
  );
}
export function acknowledgeCheckpoint(worker: Worker, cursor: number) {
  worker.checkCursor = Math.max(worker.checkCursor, cursor);
  if (worker.checkpoint && worker.checkpoint.cursor <= cursor)
    worker.checkpoint = undefined;
}
