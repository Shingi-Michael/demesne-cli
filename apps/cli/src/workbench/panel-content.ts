import { formatUnifiedDiff, sanitizeTerminalLine, truncateText, visibleLength, type Painter } from "@demesne/brand";
import type { WorkspaceFileInfo } from "@demesne/protocol";
import type { ToolEntry } from "./entries.ts";
import { foldCells } from "./canvas.ts";

export function filePanelLines(files: WorkspaceFileInfo[], width: number, paint: Painter): string[] {
  return files.map((file) => {
    const size = file.byteLength === null ? "" : file.byteLength < 1000 ? `${file.byteLength}b`
      : file.byteLength < 1_000_000 ? `${(file.byteLength / 1000).toFixed(1)}k` : `${(file.byteLength / 1_000_000).toFixed(1)}m`;
    const name = truncateText(sanitizeTerminalLine(file.path), Math.max(1, width - size.length - 4));
    return paint.text(file.status ?? " ", file.status === "M" ? "thinking" : "muted") + " "
      + paint.text(name, "secondary") + " ".repeat(Math.max(1, width - visibleLength(name) - size.length - 2)) + paint.text(size, "muted");
  });
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
