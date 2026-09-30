import { sliceAnsi } from "bun";
import { truncateText, visibleLength, type Painter, type PaletteColor } from "@demesne/brand";
import { surface } from "./surface.ts";

/// Cell-based drawing shared by the workspace and composer. All positions are
/// terminal cells, including labels and their mouse targets.
export { workspaceInset } from "./layout.ts";

/// Hard-wrap recorded output without losing indentation, ANSI state, or a wide
/// grapheme that straddles the requested cell boundary. sliceAnsi may include
/// that whole grapheme, so advance by the cells actually emitted.
export function foldCells(line: string, width: number): string[] {
  const lines: string[] = [];
  const length = visibleLength(line);
  width = Math.max(1, width);
  for (let column = 0; column < length;) {
    let span = width;
    let part = sliceAnsi(line, column, column + span);
    while (visibleLength(part) > width && span > 0) part = sliceAnsi(line, column, column + --span);
    if (!visibleLength(part)) {
      part = sliceAnsi(line, column, column + width);
      column += Math.max(1, visibleLength(part));
      lines.push(truncateText(part, width));
    } else {
      column += visibleLength(part);
      lines.push(part);
    }
  }
  return lines.length ? lines : [""];
}

export function edge(width: number, paint: Painter, options: {
  left?: string; right?: string; bottom?: boolean; tone?: PaletteColor;
} = {}): string {
  const color = options.tone ?? "rule";
  const left = options.left ? ` ${options.left} ` : "";
  const right = options.right ? ` ${options.right} ` : "";
  const available = Math.max(0, width - 4);
  const rightText = truncateText(right, Math.min(available, visibleLength(right)));
  const leftText = truncateText(left, Math.max(0, available - visibleLength(rightText)));
  return paint.text(options.bottom ? "╰─" : "╭─", color) + leftText
    + paint.text("─".repeat(Math.max(0, available - visibleLength(leftText) - visibleLength(rightText))), color)
    + rightText + paint.text(options.bottom ? "─╯" : "─╮", color);
}

export class Canvas {
  readonly rows: string[];
  constructor(readonly width: number, readonly height: number, readonly paint: Painter) {
    this.rows = Array.from({ length: height }, () => surface("", width, paint, "ink"));
  }
  put(row: number, column: number, text: string, width: number, background: PaletteColor = "ink"): void {
    if (row < 0 || row >= this.height || column < 0 || column >= this.width || width <= 0) return;
    width = Math.min(width, this.width - column);
    this.rows[row] = sliceAnsi(this.rows[row]!, 0, column) + surface(text, width, this.paint, background)
      + sliceAnsi(this.rows[row]!, column + width, this.width);
  }
  panel(row: number, column: number, width: number, height: number, title: string, trailing = "", background: PaletteColor = "surface"): void {
    if (height < 2) return;
    // The border sits on the panel's own fill, so a panel reads as a filled
    // tile (Figma 1:2), not an outline on the page.
    this.put(row, column, edge(width, this.paint, { left: title, right: trailing }), width, background);
    for (let y = row + 1; y < row + height - 1; y++) {
      this.put(y, column, this.paint.text("│", "rule"), 1, background);
      this.put(y, column + 1, "", width - 2, background);
      this.put(y, column + width - 1, this.paint.text("│", "rule"), 1, background);
    }
    this.put(row + height - 1, column, edge(width, this.paint, { bottom: true }), width, background);
  }
}
