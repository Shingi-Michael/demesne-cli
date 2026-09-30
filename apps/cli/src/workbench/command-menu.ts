import { formatFooterLine, sanitizeTerminalLine, slashCommandUsage, truncateText, visibleLength, type Painter, type SlashCommand } from "@demesne/brand";
import { Canvas } from "./canvas.ts";
import type { Rect } from "./layout.ts";
import { keycap, keyHints } from "./session-chrome.ts";

/// Figma 14:9 groups: the command's own section, with custom commands last.
const SECTIONS = ["SESSION", "INSPECT", "CONTROL", "CUSTOM"] as const;
type Section = typeof SECTIONS[number];
function section(command: SlashCommand): Section {
  if (command.id.startsWith("custom:")) return "CUSTOM";
  return command.section === "session" ? "SESSION" : command.section === "inspect" ? "INSPECT" : "CONTROL";
}

/// Keep the keyboard order identical to the visual groups, including custom commands.
export function groupSlashCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return [...commands].sort((a, b) => SECTIONS.indexOf(section(a)) - SECTIONS.indexOf(section(b)));
}

type MenuRow = { section: Section; count: number; index?: never } | { index: number; section?: never; count?: never };
export interface CommandMenuFrame {
  rect: Rect;
  lines: string[];
  zones: { row: number; index: number }[];
}

/// Figma 14:9: an overlay above the composer. Group headers carry counts;
/// each row shows the command with its argument, what it does, and an alias
/// or the Enter key on the selected row; a keycap footer says how many more.
/// Opening, filtering and scrolling never reflow the transcript.
export class CommandMenu {
  private offset = 0;
  private query = "";

  reset(): void { this.offset = 0; this.query = ""; }

  render(options: { commands: readonly SlashCommand[]; selected: number; query: string; input: Rect; paint: Painter; top: number }): CommandMenuFrame | null {
    const { commands, input, paint } = options;
    // At most twelve rows in all: the top edge, ten entries and the footer.
    const capacity = Math.min(10, input.row - options.top - 2);
    if (!commands.length || capacity < 1) { this.reset(); return null; }
    if (this.query !== options.query) { this.offset = 0; this.query = options.query; }
    const rows: MenuRow[] = [];
    let previous: Section | undefined;
    commands.forEach((command, index) => {
      const current = section(command);
      if (current !== previous) rows.push({ section: current, count: commands.filter((other) => section(other) === current).length });
      rows.push({ index });
      previous = current;
    });
    const selected = Math.max(0, Math.min(commands.length - 1, options.selected));
    const anchor = rows.findIndex((row) => row.index === selected);
    this.offset = Math.max(0, Math.min(this.offset, rows.length - capacity));
    if (anchor < this.offset) this.offset = anchor > 0 && rows[anchor - 1]?.section && capacity > 1 ? anchor - 1 : anchor;
    if (anchor >= this.offset + capacity) this.offset = anchor - capacity + 1;
    const visible = rows.slice(this.offset, this.offset + capacity);
    const below = rows.slice(this.offset + capacity).filter((row) => row.index !== undefined).length;
    const rect = { row: input.row - visible.length - 2, column: input.column, width: input.width, height: visible.length + 2 };
    const canvas = new Canvas(rect.width, rect.height, paint);
    const zones: CommandMenuFrame["zones"] = [];
    const border = (text: string) => paint.text(text, "rule");
    canvas.put(0, 0, border(`┌${"─".repeat(Math.max(0, rect.width - 2))}┐`), rect.width, "surface");
    const inset = rect.width >= 65 ? 2 : 1;
    const labelColumn = inset + 1;
    const inner = rect.width - labelColumn - inset - 1;
    // Usage (`/resume <id>`) gets a column wide enough for the longest shown.
    const shown = visible.flatMap((row) => row.index === undefined ? [] : [commands[row.index]!]);
    const usageWidth = Math.min(Math.max(12, ...shown.map((command) => slashCommandUsage(command).length + 2)), Math.floor(inner * 0.45));
    visible.forEach((entry, index) => {
      const row = index + 1;
      const active = entry.index === selected;
      const background = active ? "menuSelection" : "surface";
      canvas.put(row, 0, "", rect.width, background);
      canvas.put(row, 0, active ? paint.text("▎", "electric") : border("│"), 1, background);
      canvas.put(row, rect.width - 1, border("│"), 1, "surface");
      if (entry.section) {
        canvas.put(row, labelColumn, formatFooterLine(paint.text(entry.section, "muted"), paint.text(String(entry.count), "muted"), inner), inner, background);
        return;
      }
      const command = commands[entry.index]!;
      const usage = slashCommandUsage(command);
      const argument = usage.slice(command.name.length);
      const name = paint.text(command.name, active ? "electric" : "paper") + paint.text(argument, "muted");
      const right = active ? keycap(paint, "↵") : command.aliases[0] ? paint.text(command.aliases[0], "muted") : "";
      const descriptionWidth = Math.max(0, inner - usageWidth - visibleLength(right) - 2);
      const text = truncateText(name, usageWidth - 1) + " ".repeat(Math.max(1, usageWidth - Math.min(usage.length, usageWidth - 1)))
        + paint.text(truncateText(sanitizeTerminalLine(command.description), descriptionWidth), active ? "paper" : "secondary");
      canvas.put(row, labelColumn, formatFooterLine(text, right, inner), inner, background);
      zones.push({ row: rect.row + row, index: entry.index });
    });
    // Footer: the keys, then how many commands match and how many are below.
    const footerRow = rect.height - 1;
    canvas.put(footerRow, 0, border("│"), 1, "surface");
    canvas.put(footerRow, rect.width - 1, border("│"), 1, "surface");
    const keys = keyHints(paint, rect.width >= 80 ? [["↑↓", "select"], ["↵", "run"], ["Tab", "complete"], ["Esc", "close"]] : [["↑↓", "select"], ["↵", "run"]]);
    const count = `${commands.length} command${commands.length === 1 ? "" : "s"}${below ? ` · ${below} more below ↓` : ""}`;
    canvas.put(footerRow, labelColumn, formatFooterLine(keys, visibleLength(keys) + count.length + 2 <= inner ? paint.text(count, "muted") : "", inner), inner, "surface");
    return { rect, lines: canvas.rows, zones };
  }
}
