/// A finished Drive mission's report, delivered as a turn in the chat the
/// mission started from: the daemon writes it with `formatDriveReport`, so
/// that chat's model knows what Drive changed, and the window reads it back
/// with `parseDriveReport` to draw it as a receipt instead of as something
/// the person typed. Both sides share this file so the format has one
/// definition.

export const DRIVE_REPORT_HEADER = "Drive report: ";
const NOTE = "(This is Drive reporting a mission started from this chat. It worked in its own git worktree; nothing is applied to the person's checkout until they review the branch. Acknowledge it in one short sentence and use no tools. Later in this chat, use this report to answer what Drive did or changed.)";

export interface DriveReport {
  /// The mission's first line.
  title: string;
  /// The worktree job, for Review.
  fix: string;
  /// The mission's own chat, for Open its chat.
  chat: string;
  branch: string;
  status: "ready" | "failed";
  diff?: { files: number; additions: number; deletions: number; paths: string[] };
  /// The receipt's headline: tasks verified and checks.
  headline?: string;
  /// What Drive said it did (or why it stopped).
  summary: string;
}

export function formatDriveReport(report: DriveReport): string {
  const lines = [
    `${DRIVE_REPORT_HEADER}${report.title.replace(/\n/g, " ")}`,
    `fix: ${report.fix}`,
    `chat: ${report.chat}`,
    `branch: ${report.branch}`,
    `status: ${report.status}`,
  ];
  if (report.diff) lines.push(`changed: +${report.diff.additions} -${report.diff.deletions} in ${report.diff.files} file${report.diff.files === 1 ? "" : "s"}${report.diff.paths.length ? ` (${report.diff.paths.join(", ")})` : ""}`);
  if (report.headline) lines.push(`headline: ${report.headline.replace(/\n/g, " ")}`);
  return [...lines, "", report.summary.trim() || "Drive gave no summary.", "", NOTE].join("\n");
}

export function isDriveReport(content: string): boolean { return content.startsWith(DRIVE_REPORT_HEADER); }

/// Reads a report turn's text back into its parts; null for any other turn.
export function parseDriveReport(content: string): DriveReport | null {
  if (!isDriveReport(content)) return null;
  const [head = "", ...rest] = content.split("\n\n");
  const lines = head.split("\n");
  const field = (key: string) => lines.find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2).trim() ?? "";
  const report: DriveReport = {
    title: lines[0]!.slice(DRIVE_REPORT_HEADER.length).trim(),
    fix: field("fix"),
    chat: field("chat"),
    branch: field("branch"),
    status: field("status") === "failed" ? "failed" : "ready",
    summary: rest.filter((part) => part !== NOTE).join("\n\n").trim(),
  };
  const changed = /^\+(\d+) -(\d+) in (\d+) files?(?: \((.*)\))?$/.exec(field("changed"));
  if (changed) report.diff = { additions: Number(changed[1]), deletions: Number(changed[2]), files: Number(changed[3]), paths: changed[4] ? changed[4].split(", ") : [] };
  const headline = field("headline");
  if (headline) report.headline = headline;
  return report;
}
