import { sanitizeTerminalLine, truncateText, visibleLength, type Painter } from "@demesne/brand";
import { Canvas } from "./canvas.ts";
import { clockLabel, tint } from "./interaction.ts";

export function sessionHeader(options: { width: number; paint: Painter; path: string; now: number; openedAt: number;
  createdAt?: number; accent: boolean; pointer?: { row: number; column: number } | null; historyActive?: boolean }) {
  const { width, paint, now } = options;
  const row = options.accent ? 1 : 0;
  const canvas = new Canvas(width, row + 1, paint);
  const inset = width >= 65 ? 2 : 1;
  for (let y = 0; y <= row; y++) canvas.put(y, 0, "", width, "surface");
  if (options.accent) canvas.put(0, 0, tint(paint, "─".repeat(width), "surface", "electric", 0.4), width, "surface");
  const history = width >= 55 ? "[ HISTORY ↓ ]" : "[H↓]";
  const historyColumn = Math.max(inset, width - inset - history.length);
  const safePath = sanitizeTerminalLine(options.path);
  const basename = safePath.split(/[\\/]/).filter(Boolean).at(-1) ?? safePath;
  const pathWidth = Math.max(0, Math.min(32, Math.floor(width * 0.27), historyColumn - inset - 15));
  const path = visibleLength(safePath) <= pathWidth ? safePath : visibleLength(basename) + 2 <= pathWidth ? `…/${basename}` : truncateText(basename, pathWidth);
  const pathColumn = historyColumn - 3 - visibleLength(path);
  const leftWidth = Math.max(0, (path ? pathColumn - 3 : historyColumn - 2) - inset);
  const date = new Date(options.createdAt ?? options.openedAt);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const seconds = Math.max(0, Math.floor((now - options.openedAt) / 1000));
  const elapsed = `+${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const separator = paint.text(" · ", "borderBright");
  const identity = paint.bold("// demesne", "electric");
  const choices = [
    [identity, paint.text(day, "muted"), paint.text(clockLabel(now), "secondary"), paint.text(elapsed, "muted")],
    [identity, paint.text(clockLabel(now), "secondary"), paint.text(elapsed, "muted")],
    [identity, paint.text(clockLabel(now), "secondary")],
    [identity],
  ];
  const left = choices.map((parts) => parts.join(separator)).find((text) => visibleLength(text) <= leftWidth) ?? identity;
  canvas.put(row, inset, left, leftWidth, "surface");
  if (path) {
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
    canvas.put(row, pathColumn, paint.text(path.slice(0, slash), "muted") + paint.text(path.slice(slash), "secondary"), visibleLength(path), "surface");
    canvas.put(row, historyColumn - 3, separator, 3, "surface");
  }
  const hovered = options.pointer?.row === row && options.pointer.column >= historyColumn && options.pointer.column < historyColumn + history.length;
  canvas.put(row, historyColumn, paint.text(history, hovered || options.historyActive ? "electric" : "secondary"), history.length, "surface");
  return { rows: canvas.rows, row, history: { column: historyColumn, width: history.length }, path: { column: pathColumn, width: visibleLength(path) } };
}
