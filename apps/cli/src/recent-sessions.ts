import type { Session, SessionStateResponse } from "@demesne/protocol";
import type { ContextReceipt } from "./workbench/entries.ts";

export interface RecentSession {
  id: string; title: string; updatedAt: string; context?: ContextReceipt;
}

export function recentSession(state: SessionStateResponse): RecentSession {
  const snapshot = state.latestProviderCall;
  const plan = snapshot?.contextPlan;
  const usage = snapshot?.usage;
  const reported = usage?.totalTokens ?? (usage?.inputTokens != null && usage.outputTokens != null ? usage.inputTokens + usage.outputTokens : null);
  return { id: state.session.id, title: state.session.title, updatedAt: state.session.updatedAt,
    context: { used: plan?.estimatedInputTokens ?? reported, capacity: plan?.capacityTokens ?? null, estimated: plan?.estimatedInputTokens != null } };
}

/// The active session and two recent, unarchived sessions. Missing measurements
/// stay unknown; opening the start screen never replays whole event journals.
export async function loadRecentSessions(current: SessionStateResponse, source: {
  list(): Promise<Session[]>; state(id: string): Promise<SessionStateResponse>;
}): Promise<RecentSession[]> {
  const sessions = (await source.list()).filter((session) => !session.archivedAt && session.id !== current.session.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 2);
  return [recentSession(current), ...await Promise.all(sessions.map(async (session) => {
    try { return recentSession(await source.state(session.id)); }
    catch { return { id: session.id, title: session.title, updatedAt: session.updatedAt }; }
  }))];
}
