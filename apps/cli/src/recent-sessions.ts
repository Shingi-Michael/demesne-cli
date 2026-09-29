import type { Session, SessionStateResponse, TurnStatus } from "@demesne/protocol";
import type { ContextReceipt } from "./workbench/entries.ts";

export interface RecentSession {
  id: string; title: string; updatedAt: string; context?: ContextReceipt;
  /// Known only when the session state was loaded; never guessed.
  turns?: number; lastStatus?: TurnStatus;
}

export function recentSession(state: SessionStateResponse): RecentSession {
  const snapshot = state.latestProviderCall;
  const plan = snapshot?.contextPlan;
  const usage = snapshot?.usage;
  const reported = usage?.totalTokens ?? (usage?.inputTokens != null && usage.outputTokens != null ? usage.inputTokens + usage.outputTokens : null);
  return { id: state.session.id, title: state.session.title, updatedAt: state.session.updatedAt,
    turns: state.session.turns.length, lastStatus: state.session.turns.at(-1)?.status,
    context: { used: plan?.estimatedInputTokens ?? reported, capacity: plan?.capacityTokens ?? null, estimated: plan?.estimatedInputTokens != null } };
}

/// Up to three recent, unarchived sessions that have at least one turn. The
/// start screen only opens on an empty session, so the current one and other
/// untouched launches would just fill the list with "0 turns" rows. Missing
/// measurements stay unknown; opening the start screen never replays whole
/// event journals.
export async function loadRecentSessions(current: SessionStateResponse, source: {
  list(): Promise<Session[]>; state(id: string): Promise<SessionStateResponse>;
}): Promise<RecentSession[]> {
  const sessions = (await source.list())
    .filter((session) => !session.archivedAt && session.id !== current.session.id && session.turns.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  return Promise.all(sessions.map(async (session) => {
    try { return recentSession(await source.state(session.id)); }
    catch { return { id: session.id, title: session.title, updatedAt: session.updatedAt, turns: session.turns.length }; }
  }));
}
