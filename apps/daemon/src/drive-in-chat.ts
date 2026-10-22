import type { DriveAuto, DriveAway, DriveFix, DriveProposal } from "@demesne/protocol";
/// What every chat in a project is told about Drive, so "does Drive have
/// ideas?" or "what did Drive change?" gets a real answer instead of "who is
/// Drive?". Facts only, kept short: the ideas, what it's working on, what
/// waits for review and what failed lately. Drive's own coder sessions (in
/// its worktrees) don't get it.

const IDEAS = 5, RECENT = 4;
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text).replace(/\s+/g, " ").trim();

export function driveContext(state: { auto: DriveAuto | null; ideas: DriveProposal[]; fixes: DriveFix[]; away: DriveAway | null }): string {
  const { auto, ideas, fixes, away } = state;
  const lines = [
    "Drive: Demesne's background agent for this project. It works on one idea at a time in its own git worktree and branch, never in this checkout, and never pushes; the person reviews each branch before it is applied.",
    auto
      ? auto.on
        ? `It starts its top idea on its own after ${auto.quietMinutes} quiet minutes (${auto.usedToday} of ${auto.perDay} runs used today).`
        : "Starting on its own is turned off in this project."
      : null,
    "The person starts an idea with Run on Drive's line under the conversation, a mission with /drive <goal>, and reviews finished branches from that line. You can't start, stop or apply Drive's work yourself: say which of those to use.",
  ];
  if (ideas.length) lines.push(`Drive's ideas now: ${ideas.slice(0, IDEAS).map((idea, index) => `${index + 1}. ${clip(idea.title, 120)} (${clip(idea.why, 160)})`).join(" ")}`);
  else lines.push("Drive has no ideas listed right now.");
  const working = fixes.filter((fix) => fix.status === "starting" || fix.status === "running");
  if (working.length) lines.push(`Working now: ${working.map((fix) => `${clip(fix.title, 120)} on branch ${fix.branch}${away?.auto && away.status === "running" ? " (started on its own)" : ""}`).join("; ")}.`);
  const ready = fixes.filter((fix) => fix.status === "ready").slice(-RECENT);
  if (ready.length) lines.push(`Waiting for review: ${ready.map((fix) => `${clip(fix.title, 120)}${fix.diff ? ` (+${fix.diff.additions} -${fix.diff.deletions} in ${fix.diff.files} files)` : ""}${fix.summary ? `: ${clip(fix.summary, 200)}` : ""}`).join("; ")}.`);
  const failed = fixes.filter((fix) => fix.status === "failed").slice(-RECENT);
  if (failed.length) lines.push(`Recently failed: ${failed.map((fix) => `${clip(fix.title, 120)}: ${clip(fix.error ?? fix.summary ?? "no reason recorded", 200)}`).join("; ")}.`);
  return lines.filter((line): line is string => Boolean(line)).join(" ");
}
