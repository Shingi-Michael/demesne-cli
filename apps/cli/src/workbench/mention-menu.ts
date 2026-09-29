import { sanitizeTerminalLine, truncateText, type Painter } from "@demesne/brand";
import { Canvas } from "./canvas.ts";
import type { Rect } from "./layout.ts";
import type { CommandMenuFrame } from "./command-menu.ts";

/// Like slash commands, file suggestions overlay the transcript, never the
/// editor. Selection scrolls within a bounded window above the same separator.
export class MentionMenu {
  private offset = 0;
  private query = "";

  reset(): void { this.offset = 0; this.query = ""; }

  render(options: { files: readonly string[]; selected: number; query: string; input: Rect; top: number; paint: Painter }): CommandMenuFrame | null {
    const { files, input, paint } = options;
    const space = Math.min(12, input.row - options.top);
    if (!files.length || space < 2) { this.reset(); return null; }
    const heading = space >= 4;
    const capacity = space - (heading ? 2 : 1);
    if (this.query !== options.query) { this.offset = 0; this.query = options.query; }
    const selected = Math.max(0, Math.min(files.length - 1, options.selected));
    this.offset = Math.max(0, Math.min(this.offset, files.length - capacity));
    if (selected < this.offset) this.offset = selected;
    if (selected >= this.offset + capacity) this.offset = selected - capacity + 1;
    const visible = files.slice(this.offset, this.offset + capacity);
    const height = visible.length + (heading ? 2 : 1);
    const rect = { row: input.row - height, column: input.column, width: input.width, height };
    const canvas = new Canvas(rect.width, rect.height, paint), zones: CommandMenuFrame["zones"] = [];
    canvas.put(0, 0, paint.text(`┌${"─".repeat(Math.max(0, rect.width - 2))}┐`, "rule"), rect.width, "surface");
    if (heading) {
      canvas.put(1, 0, paint.text("│", "rule"), rect.width, "surface");
      canvas.put(1, 2, paint.text("Files · ↑↓ choose · Enter / Tab insert · Esc close", "muted"), rect.width - 4, "surface");
      canvas.put(1, rect.width - 1, paint.text("│", "rule"), 1, "surface");
    }
    visible.forEach((file, index) => {
      const row = index + (heading ? 2 : 1), active = index + this.offset === selected;
      const background = active ? "menuSelection" : "surface";
      canvas.put(row, 0, "", rect.width, background);
      canvas.put(row, 0, paint.text(active ? "▎" : "│", active ? "electric" : "rule"), 1, background);
      canvas.put(row, rect.width - 1, paint.text("│", "rule"), 1, "surface");
      const safe = sanitizeTerminalLine(file), slash = safe.lastIndexOf("/");
      const name = truncateText(safe.slice(slash + 1), rect.width - 4);
      const directory = slash < 0 ? "" : safe.slice(0, slash + 1);
      const label = paint.text(name, active ? "electric" : "paper") + paint.text(directory ? `  ${directory}` : "", "muted");
      canvas.put(row, 2, label, rect.width - 4, background);
      zones.push({ row: rect.row + row, index: index + this.offset });
    });
    return { rect, lines: canvas.rows, zones };
  }
}
