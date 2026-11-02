/// A finished thread's report, delivered as a turn in the orchestrator chat
/// that started it: the daemon writes it with `formatThreadReport`, so the
/// orchestrator's model knows what each thread did, and the window reads it
/// back with `parseThreadReport` to draw it as one quiet line instead of as
/// something the person typed.

export const THREAD_REPORT_HEADER = "Thread report: ";
const NOTE = "(This is one of the threads you started reporting back. It worked in its own git worktree and branch; nothing reaches the person's checkout until they press Merge on the thread list. If other threads are still working, acknowledge this in one short sentence. If it was the last one, read the reports, say in two or three sentences whether each stayed inside its files and passed its checks, and suggest the order to merge them. You can't merge: the person does. Use no tools.)";

export interface ThreadReport {
  title: string;
  /// The worktree job, for Merge.
  fix: string;
  /// The thread's own chat.
  chat: string;
  branch: string;
  status: "ready" | "failed";
  /// How many of the orchestrator's other threads are still working.
  working: number;
  diff?: { files: number; additions: number; deletions: number; paths: string[] };
  checks?: { command: string; passed: boolean }[];
  summary: string;
}

export function formatThreadReport(report: ThreadReport): string {
  const lines = [
    `${THREAD_REPORT_HEADER}${report.title.replace(/\n/g, " ")}`,
    `fix: ${report.fix}`,
    `chat: ${report.chat}`,
    `branch: ${report.branch}`,
    `status: ${report.status}`,
    `still working: ${report.working}`,
  ];
  if (report.diff) lines.push(`changed: +${report.diff.additions} -${report.diff.deletions} in ${report.diff.files} file${report.diff.files === 1 ? "" : "s"}${report.diff.paths.length ? ` (${report.diff.paths.join(", ")})` : ""}`);
  if (report.checks?.length) lines.push(`checks: ${report.checks.map((check) => `${check.passed ? "passed" : "failed"} ${check.command.replace(/\n/g, " ")}`).join("; ")}`);
  return [...lines, "", report.summary.trim() || "The thread gave no summary.", "", NOTE].join("\n");
}

export function isThreadReport(content: string): boolean { return content.startsWith(THREAD_REPORT_HEADER); }

export function parseThreadReport(content: string): ThreadReport | null {
  if (!isThreadReport(content)) return null;
  const [head = "", ...rest] = content.split("\n\n");
  const lines = head.split("\n");
  const field = (key: string) => lines.find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2).trim() ?? "";
  const report: ThreadReport = {
    title: lines[0]!.slice(THREAD_REPORT_HEADER.length).trim(),
    fix: field("fix"), chat: field("chat"), branch: field("branch"),
    status: field("status") === "failed" ? "failed" : "ready",
    working: Number(field("still working")) || 0,
    summary: rest.filter((part) => part !== NOTE).join("\n\n").trim(),
  };
  const changed = /^\+(\d+) -(\d+) in (\d+) files?(?: \((.*)\))?$/.exec(field("changed"));
  if (changed) report.diff = { additions: Number(changed[1]), deletions: Number(changed[2]), files: Number(changed[3]), paths: changed[4] ? changed[4].split(", ") : [] };
  const checks = field("checks");
  if (checks) report.checks = checks.split("; ").map((part) => ({ passed: part.startsWith("passed "), command: part.replace(/^(passed|failed) /, "") }));
  return report;
}
