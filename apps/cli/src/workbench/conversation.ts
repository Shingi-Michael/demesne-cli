import { sanitizeTerminalLine, truncateText, type Painter } from "@demesne/brand";
import { surface } from "./surface.ts";

export interface CardAction { row: number; column: number; width: number; action: "inspect" | "copy" | "activity" }

/// Shared card geometry keeps response actions attached to the rendered turn.
export function responseCard(options: {
  width: number; paint: Painter; model: string; status: string; body: string[];
  summary: string; activity: string; selected: boolean; expanded: boolean;
  canCopy?: boolean;
}): { lines: string[]; actions: CardAction[]; bodyStart: number } {
  const { width, paint } = options;
  const inner = Math.max(12, width - 8);
  const edge = (text: string) => `  ${paint.text(text, options.selected ? "electric" : "rule")}`;
  const row = (text: string) => `  ${paint.text("│", "rule")}${surface(` ${text}`, inner + 2, paint)}${paint.text("│", "rule")}`;
  const lines = [edge(`╭${"─".repeat(inner + 2)}╮`),
    row(`${paint.bold("DEMESNE", "electricBright")}  ${paint.text(sanitizeTerminalLine(options.status), options.status === "Failed" || options.status === "Needs your decision" ? "signal" : options.status === "Complete" ? "citron" : "secondary")}`),
    row(paint.dim(truncateText(sanitizeTerminalLine(options.model), inner))), row("")];
  const actions: CardAction[] = [{ row: 1, column: 3, width: inner + 2, action: "inspect" }];
  if (options.activity) {
    actions.push({ row: lines.length, column: 3, width: inner + 2, action: "activity" });
    lines.push(row(paint.text(`${options.expanded ? "▾" : "▸"} ${options.activity}`, "secondary")), row(""));
  }
  const bodyStart = lines.length;
  lines.push(...options.body.map(row), row(""), row(paint.dim(options.summary)));
  actions.push({ row: lines.length, column: 4, width: 9, action: "inspect" });
  if (options.canCopy !== false) actions.push({ row: lines.length, column: 16, width: 6, action: "copy" });
  lines.push(row(`${paint.text("Inspect ↗", "electricBright")}   ${options.canCopy === false ? paint.dim("Copy ⧉") : paint.text("Copy ⧉", "electricBright")}`), edge(`╰${"─".repeat(inner + 2)}╯`), "");
  return { lines, actions, bodyStart };
}

export function userCard(body: string[], width: number, paint: Painter, timestamp: string): string[] {
  const row = (text: string) => `  ${surface(`  ${text}`, width - 4, paint, "raised")}`;
  return ["", row(`${paint.bold("YOU", "electricBright")}  ${paint.dim(sanitizeTerminalLine(timestamp))}`), row(""), ...body.map(row), row(""), ""];
}
