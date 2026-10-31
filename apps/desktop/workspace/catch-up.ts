/// "Since you looked" (pass 115): when you open a chat that worked while you
/// were elsewhere, one line before the first turn you didn't see says what
/// happened, from the turns themselves (no model call): how many finished,
/// the files they changed, how their checks went, and what waits for you.
import type { WorkspaceRun } from "./session-model.ts";

/// When each chat was last on screen, in this window.
const SEEN_KEY = "demesne-seen";
export function readSeen(raw: string | null): Record<string, number> {
  try { const value = JSON.parse(raw ?? "{}"); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}

const count = (n: number, one: string, many = `${one}s`) => `${n === 1 ? "one" : n} ${n === 1 ? one : many}`;

/// The line, and the turn it sits before; null when there's nothing new.
export function catchUp(runs: readonly WorkspaceRun[], since: number | null, waiting: { approvals: number; questions: number }): { before: string; words: string } | null {
  if (since === null) return null;
  const unseen = runs.filter((run) => run.completedAt && Date.parse(run.completedAt) > since && run.status !== "running" && run.status !== "queued");
  if (!unseen.length) return null;
  const tools = unseen.flatMap((run) => run.entries.flatMap((entry) => entry.type === "tool" ? [entry] : []));
  const files = new Set(tools.filter((tool) => tool.phase === "change" && tool.state === "done").flatMap((tool) => tool.changes?.map((change) => change.path) ?? [String(tool.input.path ?? tool.detail ?? "")]).filter(Boolean));
  const checks = tools.filter((tool) => tool.phase === "verify" && tool.name === "run_command" && tool.input.background !== true);
  const failedTurns = unseen.filter((run) => run.status === "failed").length;
  const done = [
    unseen.length === 1 ? (failedTurns ? "it stopped with an error" : "it finished a turn") : `it finished ${count(unseen.length, "turn")}${failedTurns ? ` (${failedTurns} with an error)` : ""}`,
    files.size ? `changed ${count(files.size, "file")}` : "",
    checks.length ? (checks.some((tool) => tool.state === "failed" || tool.state === "denied" || (tool.state === "done" && tool.exitCode !== 0)) ? "a check failed" : "its checks pass") : "",
  ].filter(Boolean);
  const said = done.length > 1 ? `${done.slice(0, -1).join(", ")} and ${done.at(-1)}` : done[0]!;
  const waits = waiting.approvals ? `${waiting.approvals === 1 ? "One approval waits" : `${waiting.approvals} approvals wait`} for you.` : waiting.questions ? `${waiting.questions === 1 ? "A question waits" : `${waiting.questions} questions wait`} for you.` : "";
  return { before: unseen[0]!.id, words: `${said}.${waits ? ` ${waits}` : ""}` };
}

export const seenStore = {
  read: () => { try { return readSeen(localStorage.getItem(SEEN_KEY)); } catch { return {}; } },
  write: (seen: Record<string, number>) => {
    // Only the most recent hundred chats are worth remembering.
    const kept = Object.fromEntries(Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 100));
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(kept)); } catch {}
  },
};
