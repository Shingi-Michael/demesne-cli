import { computePromptVisualLines, formatTokenCount, layoutCommandMenu, sanitizeTerminalLine, truncateText, visibleLength, type Painter, type SlashCommandSection } from "@demesne/brand";
import { mentionMatches, mentionTokenAt, reverseSearchMatches, type PromptEditorState } from "../prompt-editor.ts";
import { Canvas } from "./canvas.ts";
import type { ContextReceipt } from "./entries.ts";
import { thinkingDots, tint } from "./interaction.ts";

type ComposerAction = { kind: "submit" | "stop" | "clear" }
  | { kind: "mention"; index: number }
  | { kind: "remove"; start: number; length: number }
  | { kind: "caret"; start: number; text: string };
export interface ComposerZone { row: number; column: number; width: number; action: ComposerAction }
interface ComposerOptions {
  width: number; editor: PromptEditorState;
  mentions: readonly string[]; history: readonly string[]; streaming: boolean; context?: ContextReceipt; hero?: boolean;
  /// The draft is a queue returned unsent because its turn stopped or failed.
  restored?: boolean;
}
/// Queued and restored drafts each carry a one-row label above the prompt.
function hasDraftLabel(options: ComposerOptions): boolean {
  if (!options.editor.value.trim()) return false;
  return options.streaming || (Boolean(options.restored) && !options.hero);
}
/// Mention rows, sharing the brand layout so the prompt renderer and any line
/// map can never disagree about what is on the screen.
interface ComposerRow {
  label: string;
  index: number;
  kind: "mention";
  /// Mentions carry no section; the field satisfies the shared menu layout's
  /// row constraint and stays undefined so no labels are drawn.
  section?: SlashCommandSection;
}
function completions(options: ComposerOptions): ComposerRow[] {
  if (options.streaming || options.editor.search) return [];
  const token = mentionTokenAt(options.editor.value, options.editor.cursor);
  const mentions = token ? mentionMatches(options.mentions, token.query) : [];
  return mentions.map((label, index) => ({ label: `@${label}`, index, kind: "mention" as const }));
}
export function composerHeight(options: ComposerOptions): number {
  if (options.editor.search) return 4;
  const lines = computePromptVisualLines(options.editor.value, options.editor.cursor, Math.max(8, options.width - (options.width >= 65 ? 18 : 16))).lines.length;
  const rows = layoutCommandMenu(completions(options), Number.POSITIVE_INFINITY).length;
  return (options.hero ? 2 : 4) + Math.max(options.hero ? 1 : 2, Math.min(6, lines)) + Math.min(5, rows) + (/\B@\S+/.test(options.editor.value) ? 1 : 0)
    + (hasDraftLabel(options) ? 1 : 0);
}

/// Draft text uses the context planner's conservative UTF-8 / 3 estimate.
/// File contents, system instructions and tool definitions are not draft text.
export function draftTokens(value: string): number { return Math.ceil(Buffer.byteLength(value, "utf8") / 3); }

/// The V20 composer aligns the prompt, draft and rectangular send control.
/// Hints and the status separator form one footer; the hero retains its outer box.
/// A bounded editor keeps its cursor and selected completion visible.
export function composeDraft(options: ComposerOptions & { height: number; paint: Painter; focused?: boolean; reveal?: number; now?: number; reducedMotion?: boolean }): {
  lines: string[]; zones: ComposerZone[]; cursor: { row: number; column: number };
} {
  const { width, height, paint, editor } = options;
  const canvas = new Canvas(width, height, paint);
  const inset = width >= 65 ? 2 : 1;
  const textColumn = inset + 2;
  const buttonColumn = width - inset - 10;
  const textWidth = Math.max(8, buttonColumn - textColumn - 2);
  const zones: ComposerZone[] = [];
  const accent = options.focused === false ? "rule" : "electric";
  const outline = (text: string) => options.hero ? tint(paint, text, "rule", "electric", options.focused === false ? 0 : 0.45) : paint.text(text, accent);
  for (let row = 0; row < height; row++) canvas.put(row, 0, "", width, "surface");
  canvas.put(0, 0, outline(options.hero ? `┌${"─".repeat(Math.max(0, width - 2))}┐` : "─".repeat(width)), width, "surface");
  if (options.hero) {
    canvas.put(height - 1, 0, outline(`└${"─".repeat(Math.max(0, width - 2))}┘`), width, "surface");
    for (let row = 1; row < height - 1; row++) {
      canvas.put(row, 0, outline("│"), 1, "surface");
      canvas.put(row, width - 1, outline("│"), 1, "surface");
    }
    const length = Math.max(1, Math.ceil(3 * (options.reveal ?? 1)));
    for (const row of [0, height - 1]) {
      canvas.put(row, 0, paint.text((row === 0 ? "┌" : "└") + "─".repeat(length), accent), length + 1, "surface");
      canvas.put(row, width - length - 1, paint.text("─".repeat(length) + (row === 0 ? "┐" : "┘"), accent), length + 1, "surface");
    }
  }
  const tokens = draftTokens(editor.value);
  const budget = options.context?.capacity;
  const estimate = `Draft ~${formatTokenCount(tokens)} tok`;
  const remaining = budget && options.context?.used != null ? Math.max(0, budget - options.context.used - tokens) : null;
  const label = width >= 60 && remaining !== null ? `${estimate} · ~${formatTokenCount(remaining)} ctx left` : estimate;
  const counter = ` ${label} `;
  if (options.hero) {
    const end = height === 3 ? buttonColumn - 1 : width - 2;
    const size = Math.min(counter.length, Math.max(0, end - 2));
    canvas.put(height - 1, Math.max(2, end - size), paint.text(truncateText(counter, size), "muted"), size, "surface");
  }
  const put = (row: number, text: string) => canvas.put(row, textColumn, text, textWidth, "surface");
  const control = (row: number, column: number, label: string, action?: ComposerAction) => {
    canvas.put(row, column, label, visibleLength(label), "surface");
    if (action) zones.push({ row, column, width: visibleLength(label), action });
  };
  const queued = options.streaming && Boolean(editor.value.trim());
  const restored = !options.streaming && hasDraftLabel(options);
  const headerRows = (queued || restored) && height >= 5 ? 1 : 0;
  if (headerRows) {
    const label = queued ? paint.text("Queued · sends after this turn", "thinking")
      : `${paint.text("Restored · not sent", "electric")}${paint.text(" · the turn did not finish", "muted")}`;
    const clear = queued ? "Clear queue ×" : "Clear ×";
    canvas.put(1, textColumn, label, width - textColumn - inset - (width >= 60 ? clear.length + 1 : 0), "surface");
    if (width >= 60) control(1, width - inset - clear.length, paint.text(clear, "muted"), { kind: "clear" });
  }
  const firstRow = (!options.hero && height >= 6 ? 2 : 1) + headerRows;
  const hintsRow = !options.hero && height >= 5 ? height - 2 : height - 1;
  if (!options.hero && height >= 5) canvas.put(height - 1, 0, paint.text("─".repeat(width), "rule"), width, "surface");
  if (!options.hero) {
    const counterRow = hintsRow;
    const tokenLabel = editor.value ? `~${formatTokenCount(tokens)} tok` : "";
    const hintEnd = hintsRow === firstRow + 1 ? buttonColumn - 2 : width - inset;
    if (tokenLabel) canvas.put(counterRow, hintEnd - tokenLabel.length, paint.text(tokenLabel, "muted"), tokenLabel.length, "surface");
    const hintWidth = Math.max(0, hintEnd - inset - (tokenLabel ? tokenLabel.length + 2 : 0));
    const hints = options.streaming ? ["Type to queue a follow-up · Esc Esc / Ctrl+C stop", "Type to queue · Esc Esc stop", "Type to queue · ^C stop"]
      : ["↵ send · ⇧↵ newline · / commands · @ files", "↵ send · ⇧↵ newline · / cmds · @ files", "↵ send · ⇧↵ line · / @"];
    const hint = hints.find((hint) => visibleLength(hint) <= hintWidth) ?? hints.at(-1)!;
    const styledHint = truncateText(hint, hintWidth).split(/([/@])/).map((part) => paint.text(part, part === "/" || part === "@" ? "electric" : "muted")).join("");
    canvas.put(hintsRow, inset, styledHint, hintWidth, "surface");
  }
  const room = Math.max(1, (options.hero ? height - 1 : hintsRow) - firstRow);
  const menu = completions(options);
  const selected = editor.mentionSelected;
  const rows = layoutCommandMenu(menu, Math.max(0, room - 1), selected);
  const attachments = [...editor.value.matchAll(/(?:^|\s)(@[^\s]+)/g)];
  const showAttachments = attachments.length > 0 && room - rows.length > 1;
  const promptCapacity = Math.max(1, room - rows.length - (showAttachments ? 1 : 0));
  const visual = computePromptVisualLines(editor.value, editor.cursor, textWidth);
  const start = Math.max(0, visual.cursorLine - promptCapacity + 1);
  let cursor = { row: firstRow + visual.cursorLine - start, column: Math.min(textColumn + textWidth - 1, textColumn + visual.cursorCol) };
  for (let index = 0; index < Math.min(promptCapacity, visual.lines.length); index++) {
    const info = visual.lineInfos[start + index]!;
    const placeholder = options.streaming ? "Agent is running..." : options.hero ? "Describe what you want to build, fix, or explore..." : "Continue the conversation...";
    const row = firstRow + index;
    if (options.hero) canvas.put(row, inset, paint.text(index === 0 ? start ? "↑" : "▶" : "·", index === 0 ? options.focused === false ? "muted" : "electric" : "rule"), 1, "surface");
    put(row, info.text || (editor.value ? "" : paint.text(placeholder, "muted")));
    zones.push({ row, column: textColumn, width: textWidth, action: { kind: "caret", start: info.start, text: info.text } });
  }
   const glyphRow = firstRow;
  if (!options.hero) canvas.put(glyphRow, inset, paint.text(options.streaming ? "◎" : "▶", options.streaming ? "thinking" : options.focused === false ? "muted" : "electric"), 1, "surface");
  let row = firstRow + Math.min(promptCapacity, visual.lines.length);
  if (showAttachments) {
    let text = "";
    for (const match of attachments) {
      const label = ` ${match[1]} × `;
      if (visibleLength(text) + visibleLength(label) > textWidth) break;
      zones.push({ row, column: textColumn + visibleLength(text), width: visibleLength(label), action: { kind: "remove", start: match.index! + match[0].indexOf(match[1]!), length: match[1]!.length } });
      text += paint.dim(label);
    }
    put(row++, text);
  }
  // Mention rows: the label stays quiet, the selection is a surface not a
  // glyph, and a `…` row marks mentions hidden outside the window.
  let menuRow = row;
  for (const entry of rows) {
    if (entry.kind === "more") {
      put(menuRow, paint.dim("  …"));
    } else {
      const item = menu[entry.index]!;
      const label = truncateText(item.label, textWidth - 2);
      put(menuRow, entry.index === selected
        ? paint.wash(`› ${label}`.padEnd(textWidth), "electric")
        : `  ${paint.text(item.label, "secondary")}`);
      zones.push({ row: menuRow, column: textColumn, width: textWidth, action: { kind: "mention", index: entry.index } });
    }
    menuRow += 1;
  }
  row = menuRow;
  if (editor.search) {
    const matches = reverseSearchMatches(options.history, editor.search.query);
    const selected = matches[Math.min(editor.search.index, Math.max(0, matches.length - 1))];
    zones.length = 0;
    const queryRow = 1;
    for (let y = 1; y < height - 1; y++) put(y, "");
    put(queryRow, `⌕ ${sanitizeTerminalLine(editor.search.query)}`);
    put(queryRow + 1, paint.dim(truncateText(selected ?? "No matching history", textWidth)));
    cursor = { row: queryRow, column: Math.min(textColumn + textWidth - 1, textColumn + 2 + visibleLength(editor.search.query)) };
    canvas.put(0, textColumn, paint.text(" Enter use · Esc cancel ", "secondary"), Math.min(width - textColumn, 24), "surface");
  } else {
    const sending = !options.streaming && Boolean(editor.value.trim());
    const buttonRow = firstRow;
    const rectangle = (label: string, tone: "muted" | "electric", action?: ComposerAction) => {
      const border = (text: string) => paint.text(text, tone);
      control(buttonRow - 1, buttonColumn, border("┌────────┐"), action);
      control(buttonRow, buttonColumn, border("│") + label + border("│"), action);
      control(buttonRow + 1, buttonColumn, border("└────────┘"), action);
    };
    if (options.streaming) {
      // The running glyphs occupy the same control as Send. Its native action
      // remains interruption, alongside the explicit keyboard hint below.
      const dots = thinkingDots(paint, options.now ?? 0, options.reducedMotion);
      rectangle("  " + dots + "   ", "muted", { kind: "stop" });
      if (queued && width < 60) control(0, textColumn, paint.text(" Clear queue × ", "secondary"), { kind: "clear" });
    } else {
      rectangle(sending ? paint.wash(" SEND ↵ ", "accentSurface", "electric") : paint.text(" SEND ↵ ", "muted"), sending ? "electric" : "muted", sending ? { kind: "submit" } : undefined);
      if (restored && width < 60) control(0, textColumn, paint.text(" Clear × ", "secondary"), { kind: "clear" });
    }
  }
  return { lines: canvas.rows, zones, cursor };
}
