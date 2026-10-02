import { isRecord, ProtocolValidationError } from "./index.ts";
import type { DriveEvidence } from "./drive.ts";

export type DriveMode = "bounded" | "continuous";
export interface DriveFacts {
  sessionId: string;
  workspace: string;
  capturedAt: string;
  latestTurn: { id: string; status: string } | null;
  selectedTurn: { id: string; status: string } | null;
  workspaceRevision: string | null;
  changedFiles: string[];
  files: { path: string; revision: string | null }[];
  checks: {
    id: string;
    key: string;
    turnId: string;
    command: string;
    status: string;
    freshness: string;
    revision: string | null;
  }[];
  /** Digest of repository and check outcomes; excludes prose, turn IDs and clocks. */
  progress: string;
}
export interface DriveCompletion {
  at: string;
  basis: "answer" | "verified-work";
  summary: string;
  criteria: string[];
  evidence: DriveEvidence[];
  turnId: string | null;
  workspaceRevision: string | null;
  files: DriveFacts["files"];
  checks: DriveFacts["checks"];
}
export interface DriveTask {
  id: string;
  title: string;
  criteria: string[];
  status: "active" | "completed";
  createdAt: string;
  workerTurns: string[];
  completions: DriveCompletion[];
  attempts?: { progress: string; requests: number };
  reopened?: {
    at: string;
    reason: string;
    source: "user" | "changed-evidence";
  };
}
export interface DriveLedger {
  version: 1;
  currentTaskId: string;
  tasks: DriveTask[];
}

const fail = (): never => {
  throw new ProtocolValidationError(
    "Agent Drive task records are invalid; completion history must not be reset.",
  );
};
const str = (v: unknown, max = 8000): v is string =>
  typeof v === "string" && v.length <= max;
const nullable = (v: unknown): v is string | null => v === null || str(v, 100);
const strings = (v: unknown, max = 32): v is string[] =>
  Array.isArray(v) &&
  v.length <= max &&
  v.every((x) => str(x, 1000) && x.trim());
const files = (v: unknown): v is DriveFacts["files"] =>
  Array.isArray(v) &&
  v.length <= 128 &&
  v.every((f) => isRecord(f) && str(f.path, 4096) && nullable(f.revision));
const checks = (v: unknown): v is DriveFacts["checks"] =>
  Array.isArray(v) &&
  v.length <= 32 &&
  v.every(
    (c) =>
      isRecord(c) &&
      str(c.id, 100) &&
      str(c.key, 100) &&
      str(c.turnId, 100) &&
      str(c.command, 1000) &&
      str(c.status, 32) &&
      str(c.freshness, 32) &&
      nullable(c.revision),
  );
export function parseDriveFacts(value: unknown): DriveFacts {
  if (
    !isRecord(value) ||
    !str(value.sessionId, 100) ||
    !str(value.workspace, 4096) ||
    !str(value.capturedAt, 100) ||
    !nullable(value.workspaceRevision) ||
    !Array.isArray(value.changedFiles) ||
    value.changedFiles.length > 128 ||
    value.changedFiles.some((p) => !str(p, 4096)) ||
    !files(value.files) ||
    !checks(value.checks) ||
    !str(value.progress, 100)
  )
    return fail();
  for (const turn of [value.latestTurn, value.selectedTurn])
    if (
      turn !== null &&
      (!isRecord(turn) || !str(turn.id, 100) || !str(turn.status, 32))
    )
      return fail();
  return structuredClone(value) as unknown as DriveFacts;
}
export function parseDriveLedger(value: unknown): DriveLedger {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !str(value.currentTaskId, 100) ||
    !Array.isArray(value.tasks) ||
    !value.tasks.length ||
    value.tasks.length > 64
  )
    return fail();
  const ids = new Set<string>();
  for (const task of value.tasks) {
    if (
      !isRecord(task) ||
      !str(task.id, 100) ||
      !task.id ||
      ids.has(task.id) ||
      !str(task.title) ||
      !task.title.trim() ||
      !strings(task.criteria) ||
      !task.criteria.length ||
      !["active", "completed"].includes(String(task.status)) ||
      !str(task.createdAt, 100) ||
      !strings(task.workerTurns, 256) ||
      !Array.isArray(task.completions) ||
      task.completions.length > 16
    )
      return fail();
    ids.add(task.id);
    if (
      task.attempts !== undefined &&
      (!isRecord(task.attempts) ||
        !str(task.attempts.progress, 100) ||
        !Number.isSafeInteger(task.attempts.requests) ||
        Number(task.attempts.requests) < 0)
    )
      return fail();
    if (task.status === "completed" && !task.completions.length) return fail();
    for (const c of task.completions) {
      if (
        !isRecord(c) ||
        !str(c.at, 100) ||
        !["answer", "verified-work"].includes(String(c.basis)) ||
        !str(c.summary, 2000) ||
        !strings(c.criteria) ||
        !nullable(c.turnId) ||
        !nullable(c.workspaceRevision) ||
        !files(c.files) ||
        !checks(c.checks) ||
        !Array.isArray(c.evidence) ||
        c.evidence.length > 32 ||
        c.evidence.some(
          (e) =>
            !isRecord(e) || !str(e.observationId, 100) || !str(e.quote, 2000),
        )
      )
        return fail();
    }
    if (
      task.reopened !== undefined &&
      (!isRecord(task.reopened) ||
        !str(task.reopened.at, 100) ||
        !str(task.reopened.reason, 2000) ||
        !["user", "changed-evidence"].includes(String(task.reopened.source)))
    )
      return fail();
  }
  if (
    !ids.has(value.currentTaskId) ||
    value.tasks.filter((t) => t.status === "active").length > 1 ||
    value.tasks.some(
      (t) => t.status === "active" && t.id !== value.currentTaskId,
    )
  )
    return fail();
  return structuredClone(value) as unknown as DriveLedger;
}
/** Reasons come from changed recorded results, never a model's assertion. */
export function driveReopenReason(
  task: DriveTask,
  facts?: DriveFacts,
): string | undefined {
  const completed = task.completions.at(-1);
  if (!completed || !facts) return;
  const file = completed.files.find(
    (before) =>
      before.revision !== null &&
      facts.files.some(
        (now) =>
          now.path === before.path &&
          now.revision !== null &&
          now.revision !== before.revision,
      ),
  );
  if (file) return `Recorded file changed: ${file.path}`;
  const check = completed.checks.find(
    (before) =>
      before.status === "completed" &&
      facts.checks.some(
        (now) =>
          now.key === before.key &&
          now.status === "failed" &&
          now.freshness === "current" &&
          now.id !== before.id,
      ),
  );
  if (check) return `Previously passing check now fails: ${check.command}`;
}
