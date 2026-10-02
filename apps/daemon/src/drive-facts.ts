import { createHash } from "node:crypto";
import type { DemesneStore } from "@demesne/storage";
import {
  ProtocolValidationError,
  type DriveFacts,
  type DriveLedger,
} from "@demesne/protocol";
import type { CommandMonitor } from "./command-monitor.ts";
import { readWorkspaceText } from "./tools.ts";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function driveTrackedPaths(ledger?: DriveLedger): string[] {
  return [
    ...new Set(
      ledger?.tasks.flatMap(
        (task) => task.completions.at(-1)?.files.map((file) => file.path) ?? [],
      ) ?? [],
    ),
  ].slice(-128);
}
/** Read-only recorded state. Assistant prose and UI annotations cannot change progress. */
export function collectDriveFacts(
  store: DemesneStore,
  commands: CommandMonitor,
  sessionId: string,
  turnId?: string,
  paths: string[] = [],
): DriveFacts {
  const session = store.getSession(sessionId);
  if (!session?.workspace)
    throw new ProtocolValidationError("Drive needs a workspace session");
  const root = session.workspace.root,
    latest = session.turns.at(-1) ?? null;
  const turn = turnId
    ? session.turns.find((turn) => turn.id === turnId)
    : latest;
  if (turnId && !turn)
    throw new ProtocolValidationError(
      "Drive selected turn does not belong to this session",
    );
  commands.fingerprint(root, true);
  const recorded = commands.list(sessionId, root, "none"),
    checks: DriveFacts["checks"] = [];
  const keys = new Set<string>();
  for (const check of recorded.commands.filter((check) => check.check)) {
    const key = digest([check.argv, check.cwd]);
    if (keys.has(key)) continue;
    keys.add(key);
    checks.push({
      id: check.id,
      key,
      turnId: check.turnId,
      command: check.argv.join(" ").slice(0, 1000),
      status: check.status,
      freshness: check.freshness,
      revision: check.fingerprint?.value ?? null,
    });
    if (checks.length === 32) break;
  }
  const changed = turn
    ? (store.snapshotsForTurn(sessionId, turn.id)?.map((file) => file.path) ??
      [])
    : [];
  const targets = [...new Set([...changed, ...paths])].slice(0, 128);
  let budget = 64 * 1024 * 1024;
  const files = targets.map((path) => {
    if (budget <= 0) return { path, revision: null };
    const file = readWorkspaceText(root, path);
    budget -= file.byteLength ?? 0;
    return {
      path,
      revision:
        file.revision ??
        (/not exist|not found/.test(file.reason ?? "") ? "missing" : null),
    };
  });
  const workspaceRevision = recorded.fingerprint.value;
  const outcomes = checks
    .map((check) => [check.key, check.status, check.freshness, check.revision])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return {
    sessionId,
    workspace: root,
    capturedAt: new Date().toISOString(),
    latestTurn: latest ? { id: latest.id, status: latest.status } : null,
    selectedTurn: turn ? { id: turn.id, status: turn.status } : null,
    workspaceRevision,
    changedFiles: changed.slice(0, 128),
    files,
    checks,
    progress: digest([workspaceRevision, outcomes]),
  };
}
