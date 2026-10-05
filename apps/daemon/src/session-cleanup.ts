import type { SessionCleanupCandidate } from "@demesne/protocol";
import type { DemesneStore } from "@demesne/storage";

/// Which sessions are worth deleting, and why: empty ones, ones that never
/// finished a turn, quick ones that changed nothing, archived ones, and ones
/// nobody has opened in a month. Rules, not a model: the reasons are exact
/// and the scan costs nothing. Running sessions are never suggested.

const DAY = 86_400_000;
export const STALE_DAYS = 30;

export function suggestCleanup(activity: ReturnType<DemesneStore["sessionActivity"]>, options: { now?: number; keep?: string[]; exists?: (path: string) => boolean } = {}): SessionCleanupCandidate[] {
  const now = options.now ?? Date.now(), keep = new Set(options.keep ?? []);
  const candidates: SessionCleanupCandidate[] = [];
  for (const session of activity) {
    if (session.active || keep.has(session.id)) continue;
    const idle = Math.floor((now - Date.parse(session.updatedAt)) / DAY);
    const work = session.files > 0 || session.commands > 0;
    const size = [`${session.turns} turn${session.turns === 1 ? "" : "s"}`, session.files ? `${session.files} file${session.files === 1 ? "" : "s"} changed` : "no changes"].join(" · ");
    const base = { id: session.id, title: session.title, workspace: session.workspace, updatedAt: session.updatedAt, idleDays: idle, turns: session.turns, files: session.files, commands: session.commands };
    // An empty session that was just created is probably about to be used.
    if (session.turns === 0 && idle >= 1) candidates.push({ ...base, reason: "empty", detail: "No messages", suggested: true });
    else if (session.turns === 0) continue;
    else if (session.workspace && options.exists && !options.exists(session.workspace)) candidates.push({ ...base, reason: "missing", detail: `${size} · its folder is gone`, suggested: true });
    else if (session.archivedAt) candidates.push({ ...base, reason: "archived", detail: `${size} · archived`, suggested: true });
    else if (session.completed === 0 && idle >= 1) candidates.push({ ...base, reason: "unfinished", detail: `${size} · never finished a turn`, suggested: !work });
    else if (session.turns <= 2 && !work && idle >= 1) candidates.push({ ...base, reason: "quick", detail: `${size} · a quick question`, suggested: true });
    else if (idle >= STALE_DAYS) candidates.push({ ...base, reason: "stale", detail: size, suggested: !work && session.turns <= 5 });
  }
  return candidates;
}
