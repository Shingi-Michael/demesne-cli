import { formatUnifiedDiff, sanitizeTerminalLine, truncateText, visibleLength, type Painter } from "@demesne/brand";
import type { ToolEntry } from "./entries.ts";
import { foldCells } from "./canvas.ts";

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
