import type { DaemonStatusResponse } from "@demesne/protocol";
import { padVisibleEnd, sanitizeTerminalLine, truncateText, type Painter } from "@demesne/brand";

/// Renders `demesne ps`: daemon-wide inference counts plus one row per session
/// with a queued or running turn. Kept pure so the layout can be tested at
/// several widths without a terminal.

export function formatProcessView(
  status: DaemonStatusResponse,
  width: number,
  painter: Painter,
  now = Date.now(),
): string {
  const safeWidth = Math.max(40, width);
  const finish = () => lines.map((line) => truncateText(line, safeWidth)).join("\n");
  const lines = [
    `  ${painter.bold("DEMESNE", "paper")} ${painter.dim(
      `· ${sanitizeTerminalLine(status.provider)}/${sanitizeTerminalLine(status.model)}`
        + ` · ${status.inferenceSlots} slot${status.inferenceSlots === 1 ? "" : "s"}`
        + ` · ${status.activeInferences} active`
        + ` · ${status.queuedInferences} queued`,
    )}`,
  ];
  if (status.active.length === 0) {
    lines.push(`  ${painter.dim("No active turns.")}`);
    return finish();
  }

  const sessionWidth = 10;
  const stateWidth = 9;
  const elapsedWidth = 9;
  const workspaceWidth = Math.max(10, Math.min(24, Math.floor(safeWidth / 5)));
  const titleWidth = Math.max(12, safeWidth - sessionWidth - stateWidth - workspaceWidth - elapsedWidth - 14);
  lines.push("");
  lines.push(
    `  ${padVisibleEnd(painter.bold("SESSION", "secondary"), sessionWidth)} `
      + `${padVisibleEnd(painter.bold("STATUS", "secondary"), stateWidth)} `
      + `${padVisibleEnd(painter.bold("TITLE", "secondary"), titleWidth)} `
      + `${padVisibleEnd(painter.bold("WORKSPACE", "secondary"), workspaceWidth)} `
      + `${painter.bold("ELAPSED", "secondary")}`,
  );
  for (const entry of status.active) {
    const elapsed = formatElapsed(now - Date.parse(entry.createdAt));
    const stateColor = entry.turnStatus === "running" ? "citron" : "electric";
    lines.push(
      `  ${padVisibleEnd(painter.text(entry.id.slice(0, 8), "secondary"), sessionWidth)} `
        + `${padVisibleEnd(painter.text(entry.turnStatus, stateColor), stateWidth)} `
        + `${padVisibleEnd(painter.bold(truncateText(sanitizeTerminalLine(entry.title), titleWidth), "paper"), titleWidth)} `
        + `${padVisibleEnd(painter.dim(truncateText(sanitizeTerminalLine(workspaceName(entry.workspace)), workspaceWidth)), workspaceWidth)} `
        + `${painter.dim(elapsed)}`,
    );
  }
  return finish();
}

function workspaceName(root: string | null): string {
  if (!root) return "—";
  const parts = root.split("/").filter(Boolean);
  return parts.at(-1) ?? root;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
