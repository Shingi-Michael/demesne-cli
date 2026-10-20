import {
  driveReopenReason,
  parseDriveLedger,
  type DriveCompletion,
  type DriveDecision,
  type DriveFacts,
  type DriveLedger,
  type DriveMode,
  type DriveState,
  type DriveTask,
} from "@demesne/protocol";
import { driveIntent, similarIntent, fingerprint } from "./drive-protection.ts";

export function newDriveTask(title: string): DriveTask {
  return {
    id: crypto.randomUUID(),
    title,
    criteria: [title.slice(0, 1000)],
    status: "active",
    createdAt: new Date().toISOString(),
    workerTurns: [],
    completions: [],
  };
}
export function currentDriveTask(state: DriveState) {
  return state.ledger?.tasks.find(
    (task) => task.id === state.ledger!.currentTaskId,
  );
}
export function restoreDriveLedger(state: DriveState): DriveLedger {
  if (state.ledger !== undefined) return parseDriveLedger(state.ledger);
  const tasks: DriveTask[] = [];
  for (const item of state.autonomy?.history ?? []) {
    const task = newDriveTask(item.task);
    task.id=`legacy-${fingerprint(`${state.id}:${tasks.length}:${item.task}`).slice(0,24)}`; task.createdAt=item.at;
    task.status = "completed";
    task.completions.push({
      at: item.at,
      basis: "verified-work",
      summary: item.summary,
      criteria: task.criteria,
      evidence: [],
      turnId: null,
      workspaceRevision: null,
      files: [],
      checks: [],
    });
    tasks.push(task);
  }
  let current =
    state.autonomy?.phase === "discovering" ? tasks.at(-1) : undefined;
  if (!current) {
    current = newDriveTask(state.autonomy?.task ?? state.mission);
    current.id=`legacy-${fingerprint(`${state.id}:${tasks.length}:${current.title}`).slice(0,24)}`; current.createdAt=state.updatedAt;
    tasks.push(current);
    if (state.status === "completed") {
      current.status = "completed";
      current.completions.push({
        at: state.updatedAt,
        basis: "verified-work",
        summary: state.activity,
        criteria: current.criteria,
        evidence: state.evidence,
        turnId: null,
        workspaceRevision: null,
        files: [],
        checks: [],
      });
    }
  }
  return { version: 1, currentTaskId: current.id, tasks };
}
export function taskOverlaps(a: string, b: string): boolean {
  const left = driveIntent(a),
    right = driveIntent(b);
  // Completion already includes its review: changing only the phase cannot create a new goal.
  return similarIntent({ ...left, intent: "" }, { ...right, intent: "" });
}
export function completedOverlap(state: DriveState, text: string) {
  return state.ledger?.tasks.find(
    (task) => task.status === "completed" && taskOverlaps(task.title, text),
  );
}
export function taskTrackedPaths(state: DriveState) {
  return [
    ...new Set([
      ...(state.ledger?.tasks.flatMap(
        (task) => task.completions.at(-1)?.files.map((file) => file.path) ?? [],
      ) ?? []),
      ...driveIntent(currentDriveTask(state)?.title ?? state.mission).targets,
    ]),
  ].slice(-128);
}
export function completionRecord(
  task: DriveTask,
  decision: DriveDecision,
  facts?: DriveFacts,
): DriveCompletion {
  const turnId = facts?.selectedTurn?.id ?? task.workerTurns.at(-1) ?? null;
  return {
    at: new Date().toISOString(),
    basis:
      decision.action.kind === "complete" && decision.action.basis === "answer"
        ? "answer"
        : "verified-work",
    summary: decision.note,
    criteria: [...task.criteria],
    evidence: structuredClone(decision.evidence),
    turnId,
    workspaceRevision: facts?.workspaceRevision ?? null,
    files: structuredClone(
      facts?.files.filter(
        (file) =>
          facts.changedFiles.includes(file.path) ||
          task.completions
            .at(-1)
            ?.files.some((before) => before.path === file.path) ||
          driveIntent(
            [task.title, ...task.criteria].join(" "),
          ).targets.includes(file.path),
      ) ?? [],
    ),
    checks: structuredClone(
      facts?.checks.filter(
        (check) =>
          check.turnId === turnId || task.workerTurns.includes(check.turnId),
      ) ?? [],
    ),
  };
}
export function reopenDriveTask(
  state: DriveState,
  task: DriveTask,
  reason: string,
  source: "user" | "changed-evidence",
) {
  if (task.status !== "completed")
    throw new Error("Only completed tasks can be reopened.");
  if (currentDriveTask(state)?.status === "active")
    throw new Error(
      "Finish the active task or start a new mission with the revised goal.",
    );
  if (task.completions.length >= 16)
    throw new Error(
      "This task reached its saved revision limit. Start an explicit new mission.",
    );
  task.status = "active";
  task.workerTurns = [];
  task.attempts = undefined;
  task.reopened = { at: new Date().toISOString(), reason, source };
  state.ledger!.currentTaskId = task.id;
  if (state.autonomy)
    Object.assign(state.autonomy, {
      task: task.title,
      phase: "working",
      consulted: false,
      consultationTurnId: undefined,
      consultations: 0,
    });
  state.completed = state
    .ledger!.tasks.filter((task) => task.status === "completed")
    .map((task) => task.title.slice(0, 1000))
    .slice(-32);
  state.remaining = [task.title.slice(0, 1000)];
  state.evidence = [];
}
export function parseDriveStart(
  text: string,
  defaultMode: DriveMode = "bounded",
) {
  const value = text.trim();
  const mode = value.startsWith("--continuous ")
    ? "continuous"
    : value.startsWith("--bounded ")
      ? "bounded"
      : defaultMode;
  const mission = value.replace(/^--(?:continuous|bounded)\s+/, "");
  if (/^--(?:continuous|bounded)$/.test(value))
    throw new Error("Supply a mission after the Drive mode.");
  return { mission, mode };
}
export { driveReopenReason };

export function driveTaskScope(state: DriveState) {
  const task = currentDriveTask(state);
  return task ? `${task.id}:${task.completions.length}` : undefined;
}
