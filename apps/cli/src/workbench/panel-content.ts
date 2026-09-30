import { formatUnifiedDiff, sanitizeTerminalLine, truncateText, visibleLength, type Painter } from "@demesne/brand";
import type { WorkspaceFileInfo } from "@demesne/protocol";
import type { ToolEntry } from "./entries.ts";
import { foldCells } from "./canvas.ts";

/// Figma 51:638: CHANGED files first, then ALL FILES, each under a quiet
/// heading with its count. Folders are dim and filenames bright; git status
/// letters keep their meaning (modified amber, added green, deleted red) and
/// sizes sit on the right.
export function filePanelLines(files: WorkspaceFileInfo[], width: number, paint: Painter): string[] {
  const size = (bytes: number | null) => bytes === null ? "" : bytes < 1000 ? `${bytes}b` : bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)}k` : `${(bytes / 1_000_000).toFixed(1)}m`;
  const row = (file: WorkspaceFileInfo) => {
    const label = size(file.byteLength);
    const path = sanitizeTerminalLine(file.path), slash = path.lastIndexOf("/");
    const tone = file.status === "M" ? "thinking" : file.status === "A" || file.status === "??" ? "citron" : file.status === "D" ? "signal" : "muted";
    // Untracked files are new but not staged: `?`, in the added color.
    const status = paint.text((file.status ?? " ").slice(0, 1), tone);
    const room = Math.max(1, width - label.length - 4);
    const shown = truncateText(path, room), cut = shown.length < path.length;
    const name = cut ? paint.text(shown, "paper") : paint.text(path.slice(0, slash + 1), "muted") + paint.text(path.slice(slash + 1), "paper");
    return `${status} ${name}${" ".repeat(Math.max(1, width - visibleLength(shown) - label.length - 2))}${paint.text(label, "muted")}`;
  };
  const heading = (label: string, count: number) => paint.text(label, "muted") + " ".repeat(Math.max(1, width - label.length - String(count).length)) + paint.text(String(count), "muted");
  const changed = files.filter((file) => file.status), rest = files.filter((file) => !file.status);
  const lines: string[] = [];
  if (changed.length) lines.push(heading("CHANGED", changed.length), ...changed.map(row), "");
  lines.push(heading("ALL FILES", rest.length), ...rest.map(row));
  return lines;
}

export function diffPanelLines(tool: ToolEntry, width: number, paint: Painter): string[] {
  const path = sanitizeTerminalLine(tool.detail ?? tool.name);
  const lines = [paint.text(truncateText(path, width), "muted"), ""];
  if (tool.diff) {
    const diff = formatUnifiedDiff(tool.diff.oldText, tool.diff.newText, { compact: true, hunkHeader: true, maxLines: 10_000, painter: paint });
    lines.push(...(diff.length ? diff : [paint.text("No textual change.", "muted")]).flatMap((line) => foldCells(line, width)));
  }
  else if (tool.message) lines.push(...tool.message.split("\n").flatMap((line) => foldCells(sanitizeTerminalLine(line), width)));
  else lines.push(paint.text("No diff content recorded.", "muted"));
  return lines;
}
