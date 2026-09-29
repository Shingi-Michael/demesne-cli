import { sanitizeTerminalLine, truncateText, type Painter, type SlashCommand } from "@demesne/brand";
import { Canvas } from "./canvas.ts";
import type { Rect } from "./layout.ts";

const SECTIONS = ["SESSION", "MODEL", "CONTEXT", "TOOLS", "CONTROL", "CUSTOM"] as const;
type Section = typeof SECTIONS[number];
const groups: Partial<Record<SlashCommand["id"], Section>> = {
  model: "MODEL", context: "CONTEXT", compact: "CONTEXT", export: "SESSION",
  diff: "TOOLS", plan: "TOOLS", undo: "TOOLS", status: "TOOLS", theme: "CONTROL",
};
function section(command: SlashCommand): Section {
  if (command.id.startsWith("custom:")) return "CUSTOM";
  return groups[command.id] ?? (command.section === "session" ? "SESSION" : command.section === "inspect" ? "TOOLS" : "CONTROL");
}

/// Keep the keyboard order identical to the visual groups, including custom commands.
export function groupSlashCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return [...commands].sort((a, b) => SECTIONS.indexOf(section(a)) - SECTIONS.indexOf(section(b)));
}

type MenuRow = { section: Section; index?: never } | { index: number; section?: never };
export interface CommandMenuFrame {
  rect: Rect;
  lines: string[];
  zones: { row: number; index: number }[];
}

/// V21 is an overlay: opening, filtering and scrolling never reflow the transcript.
/// Twelve terminal rows approximate the reference's 280px bound at 18pt.
export class CommandMenu {
  private offset = 0;
  private query = "";

  reset(): void { this.offset = 0; this.query = ""; }

  render(options: { commands: readonly SlashCommand[]; selected: number; query: string; input: Rect; paint: Painter; top: number }): CommandMenuFrame | null {
    const { commands, input, paint } = options;
    const capacity = Math.min(11, input.row - options.top - 1);
    if (!commands.length || capacity < 1) { this.reset(); return null; }
    if (this.query !== options.query) { this.offset = 0; this.query = options.query; }
    const rows: MenuRow[] = [];
    let previous: Section | undefined;
    commands.forEach((command, index) => {
      const current = section(command);
      if (current !== previous) rows.push({ section: current });
      rows.push({ index });
      previous = current;
    });
    const selected = Math.max(0, Math.min(commands.length - 1, options.selected));
    const anchor = rows.findIndex((row) => row.index === selected);
    this.offset = Math.max(0, Math.min(this.offset, rows.length - capacity));
    if (anchor < this.offset) this.offset = anchor > 0 && rows[anchor - 1]?.section && capacity > 1 ? anchor - 1 : anchor;
    if (anchor >= this.offset + capacity) this.offset = anchor - capacity + 1;
    const visible = rows.slice(this.offset, this.offset + capacity);
    const rect = { row: input.row - visible.length - 1, column: input.column, width: input.width, height: visible.length + 1 };
    const canvas = new Canvas(rect.width, rect.height, paint);
    const zones: CommandMenuFrame["zones"] = [];
    const border = (text: string) => paint.text(text, "rule");
    canvas.put(0, 0, border(`┌${"─".repeat(Math.max(0, rect.width - 2))}┐`), rect.width, "surface");
    const inset = rect.width >= 65 ? 2 : 1;
    const labelColumn = inset + 1;
    const descriptionColumn = labelColumn + 12;
    visible.forEach((entry, index) => {
      const row = index + 1;
      const active = entry.index === selected;
      const background = entry.section ? "ink" : active ? "menuSelection" : "surface";
      canvas.put(row, 0, "", rect.width, background);
      canvas.put(row, 0, active ? paint.text("▎", "electric") : border("│"), 1, background);
      canvas.put(row, rect.width - 1, border("│"), 1, "surface");
      if (entry.section) {
        canvas.put(row, labelColumn, paint.text(entry.section, "muted"), rect.width - labelColumn - 1, background);
      } else {
        const command = commands[entry.index]!;
        canvas.put(row, labelColumn, paint.text(truncateText(sanitizeTerminalLine(command.name), 11), active ? "electric" : "secondary"), 12, background);
        canvas.put(row, descriptionColumn, paint.text(sanitizeTerminalLine(command.description), "muted"), Math.max(0, rect.width - descriptionColumn - inset - 1), background);
        zones.push({ row: rect.row + row, index: entry.index });
      }
    });
    return { rect, lines: canvas.rows, zones };
  }
}
