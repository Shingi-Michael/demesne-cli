import { isRecord, ProtocolValidationError } from "./index.ts";
export const DRIVE_CHECKPOINTS = [
  "check_completed",
  "edit_batch",
  "repeated_tools",
  "interval",
] as const;
export type DriveCheckpointReason = (typeof DRIVE_CHECKPOINTS)[number];
export interface DriveReview {
  id: string;
  sessionId: string;
  turnId: string;
  revision: string;
  cursor: number;
  capturedAt: string;
  queueMs: number;
  modelMs?: number;
  reason: DriveCheckpointReason;
  status: string;
  waitingForHuman: boolean;
  rows: string[];
}
export function parseDriveReview(value: unknown): DriveReview {
  const fail = () => {
    throw new ProtocolValidationError("Agent Drive review packet is invalid");
  };
  if (!isRecord(value)) return fail();
  for (const key of [
    "id",
    "sessionId",
    "turnId",
    "revision",
    "capturedAt",
    "status",
  ])
    if (typeof value[key] !== "string" || String(value[key]).length > 100)
      return fail();
  if (
    !Number.isSafeInteger(value.cursor) ||
    Number(value.cursor) < 0 ||
    typeof value.queueMs !== "number" ||
    !Number.isFinite(value.queueMs) ||
    Number(value.queueMs) < 0 ||
    typeof value.waitingForHuman !== "boolean" ||
    !DRIVE_CHECKPOINTS.includes(value.reason as DriveCheckpointReason) ||
    !Array.isArray(value.rows) ||
    value.rows.length > 40 ||
    value.rows.some((row) => typeof row !== "string" || row.length > 2000) ||
    value.rows.join("").length > 16000
  )
    return fail();
  if (
    value.modelMs !== undefined &&
    (typeof value.modelMs !== "number" ||
      !Number.isFinite(value.modelMs) ||
      value.modelMs < 0)
  )
    return fail();
  return structuredClone(value) as unknown as DriveReview;
}
