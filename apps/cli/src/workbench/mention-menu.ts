import { formatFooterLine, sanitizeTerminalLine, truncateText, visibleLength, type Painter, type PaletteColor } from "@demesne/brand";
import { Canvas } from "./canvas.ts";
import type { Rect } from "./layout.ts";
import type { CommandMenuFrame } from "./command-menu.ts";
import { keycap, keyHints } from "./session-chrome.ts";

/// The part of `text` matching `query` in the accent color, the rest in `tone`.
function highlight(text: string, query: string, tone: PaletteColor, paint: Painter): string {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return paint.text(text, tone);
  return paint.text(text.slice(0, at), tone) + paint.text(text.slice(at, at + query.length), "electric") + paint.text(text.slice(at + query.length), tone);
}

/// Figma 39:452. Like slash commands, file suggestions overlay the transcript,
/// never the editor: a FILES header with the match count, the filename with the
/// matched letters in the accent, its folder, Tab on the selected row, and a
/// keycap footer. Selection scrolls within a bounded window.
export class MentionMenu {
  private offset = 0;
  private query = "";

  reset(): void { this.offset = 0; this.query = ""; }

  render(options: { files: readonly string[]; selected: number; query: string; input: Rect; top: number; paint: Painter }): CommandMenuFrame | null {
    const { files, input, paint } = options;
    const space = Math.min(12, input.row - options.top);
    if (!files.length || space < 2) { this.reset(); return null; }
    const framed = space >= 5;
    const capacity = space - (framed ? 3 : 1);
    if (this.query !== options.query) { this.offset = 0; this.query = options.query; }
    const selected = Math.max(0, Math.min(files.length - 1, options.selected));
    this.offset = Math.max(0, Math.min(this.offset, files.length - capacity));
    if (selected < this.offset) this.offset = selected;
    if (selected >= this.offset + capacity) this.offset = selected - capacity + 1;
    const visible = files.slice(this.offset, this.offset + capacity);
    const height = visible.length + (framed ? 3 : 1);
    const rect = { row: input.row - height, column: input.column, width: input.width, height };
    const canvas = new Canvas(rect.width, rect.height, paint), zones: CommandMenuFrame["zones"] = [];
    const inner = rect.width - 4;
    const side = (row: number, background: PaletteColor = "surface") => { canvas.put(row, 0, paint.text("│", "rule"), 1, background); canvas.put(row, rect.width - 1, paint.text("│", "rule"), 1, "surface"); };
    canvas.put(0, 0, paint.text(`┌${"─".repeat(Math.max(0, rect.width - 2))}┐`, "rule"), rect.width, "surface");
    const query = sanitizeTerminalLine(options.query);
    if (framed) {
      side(1);
      const count = query ? `${files.length} match "${truncateText(query, 16)}"` : `${files.length} file${files.length === 1 ? "" : "s"}`;
      canvas.put(1, 2, formatFooterLine(paint.text("FILES", "muted"), paint.text(count, "muted"), inner), inner, "surface");
    }
    const names = visible.map((file) => { const safe = sanitizeTerminalLine(file), slash = safe.lastIndexOf("/"); return { name: safe.slice(slash + 1), directory: slash < 0 ? "" : safe.slice(0, slash + 1) }; });
    const nameWidth = Math.min(Math.max(12, ...names.map((item) => item.name.length + 2)), Math.floor(inner * 0.45));
    visible.forEach((_, index) => {
      const row = index + (framed ? 2 : 1), active = index + this.offset === selected;
      const background: PaletteColor = active ? "menuSelection" : "surface";
      canvas.put(row, 0, "", rect.width, background);
      side(row, background);
      if (active) canvas.put(row, 0, paint.text("▎", "electric"), 1, background);
      const { name, directory } = names[index]!;
      const shownName = truncateText(name, nameWidth - 1);
      const text = highlight(shownName, query, "paper", paint) + " ".repeat(Math.max(1, nameWidth - visibleLength(shownName)))
        + highlight(truncateText(directory, Math.max(0, inner - nameWidth - 6)), query, "muted", paint);
      canvas.put(row, 2, formatFooterLine(text, active ? keycap(paint, "Tab") : "", inner), inner, background);
      zones.push({ row: rect.row + row, index: index + this.offset });
    });
    if (framed) {
      const footer = rect.height - 1;
      side(footer);
      const keys = keyHints(paint, [["↑↓", "select"], ["↵", "insert"], ["Esc", "close"]]);
      const note = "files with spaces are skipped";
      canvas.put(footer, 2, formatFooterLine(keys, visibleLength(keys) + note.length + 2 <= inner ? paint.text(note, "muted") : "", inner), inner, "surface");
    }
    return { rect, lines: canvas.rows, zones };
  }
}
