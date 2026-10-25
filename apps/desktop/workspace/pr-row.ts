import { checksWords, pullRequestNews, type SessionPullRequest } from "../../../packages/protocol/src/pull-requests.ts";

/// Its pull request on the row (pass 76 D): the words the row unfolds, and
/// what "Hand it to the chat" puts in the composer.

/// What the row says when nothing is new: each reviewer's latest word, then
/// the checks.
export function prStanding(pr: SessionPullRequest): string[] {
  const latest = new Map<string, string>();
  for (const note of pr.notes) if (note.state !== "commented") latest.set(note.author, `${note.author} ${note.state}`);
  const lines = [...latest.values()];
  const checks = checksWords(pr);
  if (checks) lines.push(checks);
  return lines.length ? lines : [pr.draft ? "A draft, no reviews yet" : "No reviews yet"];
}

/// Something the chat can act on: new reviews or comments, or failing checks.
export function prHandable(pr: SessionPullRequest, since: string): boolean {
  return pr.state === "open" && (pullRequestNews(pr, since).length > 0 || pr.checks.some((check) => check.state === "failed"));
}

/// The message "Hand it to the chat" writes: what's new, then the ask.
export function prHandText(pr: SessionPullRequest, since: string): string {
  const news = pullRequestNews(pr, since);
  const lines = news.length ? news : [checksWords(pr)].filter(Boolean);
  return `Pull request #${pr.number} (${pr.url}) has news:\n${lines.map((line) => `- ${line}`).join("\n")}\n\nAddress it on the same branch and push.`;
}

/// "2h ago", "yesterday", "on Oct 3".
export function agoWords(date: string, now = Date.now()): string {
  const ms = now - Date.parse(date);
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  if (ms < 172_800_000) return "yesterday";
  if (ms < 7 * 86_400_000) return `${Math.floor(ms / 86_400_000)} days ago`;
  return `on ${new Date(date).toLocaleDateString([], { month: "short", day: "numeric" })}`;
}
