/// Its pull request on the row (pass 76 D): a chat that opened a pull
/// request keeps it, and the sidebar shows its number, what's new on it, and
/// when it merges.

export interface PullRequestNote {
  author: string;
  /// "approved", "changes requested", "commented".
  state: string;
  body: string;
  at: string;
}

export interface PullRequestCheck {
  name: string;
  state: "passed" | "failed" | "running" | "skipped";
  at: string | null;
}

export interface SessionPullRequest {
  url: string;
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  /// Reviews and comments, oldest first.
  notes: PullRequestNote[];
  checks: PullRequestCheck[];
  /// The newest review, comment or finished check: what "new since you
  /// looked" compares against.
  activityAt: string;
}

export interface SessionPullRequestsResponse {
  pullRequests: Record<string, SessionPullRequest>;
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

export const isPullRequestUrl = (value: string) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(value);

/// The pull request a finished tool call opened: `gh pr create` through
/// run_command, or a create-pull-request tool. Its last PR link wins.
export function openedPullRequest(name: string, argumentsJson: string, resultText: string): string | null {
  const creates = /\bpr\b["',\s]+create\b/.test(argumentsJson) || /create_?pull_?request|create_pr\b/i.test(name);
  if (!creates) return null;
  return resultText.match(PR_URL)?.at(-1) ?? null;
}

const STATES: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed" };

/// `gh pr view --json number,title,url,state,isDraft,createdAt,mergedAt,closedAt,reviews,comments,statusCheckRollup`
/// in our words.
export function pullRequestFromGh(raw: unknown): SessionPullRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const pr = raw as Record<string, any>;
  if (typeof pr.number !== "number" || typeof pr.url !== "string") return null;
  const login = (value: any) => typeof value?.login === "string" ? value.login : "someone";
  const notes: PullRequestNote[] = [
    ...(Array.isArray(pr.reviews) ? pr.reviews : []).filter((review: any) => review?.state !== "PENDING" && (review?.state !== "COMMENTED" || String(review?.body ?? "").trim()))
      .map((review: any) => ({ author: login(review.author), state: STATES[review.state] ?? String(review.state ?? "").toLowerCase(), body: String(review.body ?? "").trim(), at: String(review.submittedAt ?? "") })),
    ...(Array.isArray(pr.comments) ? pr.comments : [])
      .map((comment: any) => ({ author: login(comment.author), state: "commented", body: String(comment.body ?? "").trim(), at: String(comment.createdAt ?? "") })),
  ].filter((note) => note.at).sort((a, b) => a.at.localeCompare(b.at));
  const checks: PullRequestCheck[] = (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []).map((check: any) => {
    // CheckRun: status + conclusion; StatusContext: state.
    const conclusion = String(check?.conclusion ?? check?.state ?? "").toUpperCase(), status = String(check?.status ?? "").toUpperCase();
    const state: PullRequestCheck["state"] = status && status !== "COMPLETED" || conclusion === "PENDING" || conclusion === "EXPECTED" || !conclusion ? "running"
      : ["SUCCESS", "NEUTRAL"].includes(conclusion) ? "passed"
      : conclusion === "SKIPPED" ? "skipped" : "failed";
    return { name: String(check?.name ?? check?.context ?? "check"), state, at: state === "running" ? null : String(check?.completedAt ?? check?.startedAt ?? "") || null };
  });
  const createdAt = String(pr.createdAt ?? "");
  const activityAt = [createdAt, ...notes.map((note) => note.at), ...checks.flatMap((check) => check.at ? [check.at] : [])].sort().at(-1) ?? createdAt;
  return {
    url: pr.url, number: pr.number, title: String(pr.title ?? ""),
    state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
    draft: Boolean(pr.isDraft), createdAt, mergedAt: pr.mergedAt || null, closedAt: pr.closedAt || null,
    notes, checks, activityAt,
  };
}

/// What happened on it after `since`, as short lines: each review or comment,
/// then the checks in one line.
export function pullRequestNews(pr: SessionPullRequest, since: string): string[] {
  const lines = pr.notes.filter((note) => note.at > since).map((note) => {
    const first = note.body.replace(/\s+/g, " ").trim();
    const said = first.length > 90 ? `${first.slice(0, 89).trimEnd()}…` : first;
    return note.state === "commented" ? `${note.author}: ${said}` : `${note.author} ${note.state}${said ? `: ${said}` : ""}`;
  });
  if (pr.checks.some((check) => check.at && check.at > since)) {
    const checks = checksWords(pr);
    if (checks) lines.push(checks);
  }
  return lines;
}

export function checksWords(pr: SessionPullRequest): string {
  const counted = pr.checks.filter((check) => check.state !== "skipped");
  if (!counted.length) return "";
  const failed = counted.filter((check) => check.state === "failed");
  if (failed.length) return `${failed.length === 1 ? "1 check" : `${failed.length} checks`} failed: ${failed.map((check) => check.name).slice(0, 3).join(", ")}`;
  if (counted.some((check) => check.state === "running")) return "checks running";
  return "checks passed";
}
