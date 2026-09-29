import { computePromptVisualLines, formatTokenCount, sanitizeTerminalLine, truncateText, visibleLength, type Painter } from "@demesne/brand";
import { mentionTokenAt, reverseSearchMatches, type PromptEditorState } from "../prompt-editor.ts";
import { Canvas } from "./canvas.ts";
import type { ContextReceipt } from "./entries.ts";
import { thinkingDots } from "./interaction.ts";

type ComposerAction = { kind: "submit" | "stop" | "clear" | "commands" | "files" | "newline" }
  | { kind: "remove"; start: number; length: number }
  | { kind: "caret"; start: number; text: string };
export interface ComposerZone { row: number; column: number; width: number; action: ComposerAction }
interface ComposerOptions {
  width: number; editor: PromptEditorState;
  mentions: readonly string[]; history: readonly string[]; streaming: boolean; context?: ContextReceipt; hero?: boolean;
  /// The draft is a queue returned unsent because its turn stopped or failed.
  restored?: boolean;
  stopArmed?: boolean;
}
type ComposeOptions = ComposerOptions & { height: number; paint: Painter; focused?: boolean; reveal?: number; now?: number; reducedMotion?: boolean };
interface ComposerFrame { lines: string[]; zones: ComposerZone[]; cursor: { row: number; column: number } }

function sessionComposerGeometry(options: ComposerOptions) {
  const inset = options.width >= 65 ? 2 : 1;
  const textColumn = inset + 4;
  const right = options.width - inset - 2;
  // Reserve stable control space even when the first Escape changes the hint.
  const controls = options.width >= 65 ? 28 : 8;
  return { inset, right, textColumn, textWidth: Math.max(8, right - textColumn - controls - 2) };
}
/// Queued and restored drafts each carry a one-row label above the prompt.
function hasDraftLabel(options: ComposerOptions): boolean {
  if (!options.editor.value.trim()) return false;
  return options.streaming || (Boolean(options.restored) && !options.hero);
}
function attachments(editor: PromptEditorState): RegExpMatchArray[] {
  const active = mentionTokenAt(editor.value, editor.cursor);
  return [...editor.value.matchAll(/(?:^|\s)(@[^\s]+)/g)].filter(match => match.index! + match[0].indexOf(match[1]!) !== active?.start);
}
export function composerHeight(options: ComposerOptions): number {
  if (options.editor.search) return 4;
  const textWidth = options.hero ? options.width - 4 : sessionComposerGeometry(options).textWidth;
  const lines = computePromptVisualLines(options.editor.value, options.editor.cursor, Math.max(8, textWidth)).lines.length;
  return (options.hero ? 3 : 2) + Math.max(options.hero ? 2 : 1, Math.min(6, lines)) + (attachments(options.editor).length ? 1 : 0)
    + (hasDraftLabel(options) ? 1 : 0);
}

/// Draft text uses the context planner's conservative UTF-8 / 3 estimate.
/// File contents, system instructions and tool definitions are not draft text.
export function draftTokens(value: string): number { return Math.ceil(Buffer.byteLength(value, "utf8") / 3); }

/// The hero follows Figma 8:285: full-width draft, then hints, token count and
/// an inline send control inside one quiet border.
/// A bounded editor keeps its cursor and selected completion visible.
export function composeDraft(options: ComposeOptions): ComposerFrame {
  if (!options.hero) return composeSessionDraft(options);
  const { width, height, paint, editor } = options;
  const canvas = new Canvas(width, height, paint);
  const inset = width >= 65 ? 2 : 1;
  const textColumn = options.hero ? 2 : inset + 2;
  const buttonColumn = width - inset - 10;
  const textWidth = Math.max(8, options.hero ? width - 4 : buttonColumn - textColumn - 2);
  const zones: ComposerZone[] = [];
  const accent = options.focused === false ? "rule" : "electric";
  const outline = (text: string) => paint.text(text, options.hero ? options.focused === false ? "rule" : "borderBright" : accent);
  for (let row = 0; row < height; row++) canvas.put(row, 0, "", width, "surface");
  canvas.put(0, 0, outline(options.hero ? `╭${"─".repeat(Math.max(0, width - 2))}╮` : "─".repeat(width)), width, "surface");
  if (options.hero) {
    canvas.put(height - 1, 0, outline(`╰${"─".repeat(Math.max(0, width - 2))}╯`), width, "surface");
    for (let row = 1; row < height - 1; row++) {
      canvas.put(row, 0, outline("│"), 1, "surface");
      canvas.put(row, width - 1, outline("│"), 1, "surface");
    }
  }
  const tokens = draftTokens(editor.value);
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
  const hintsRow = options.hero || height >= 5 ? height - 2 : height - 1;
  if (!options.hero && height >= 5) canvas.put(height - 1, 0, paint.text("─".repeat(width), "rule"), width, "surface");
  if (options.hero) {
    const tokenLabel = `~${formatTokenCount(tokens)} tok`;
    const end = width - 2 - 7 - 1;
    canvas.put(hintsRow, end - tokenLabel.length, paint.text(tokenLabel, "muted"), tokenLabel.length, "surface");
    const items: [string, ComposerAction][] = width >= 60
      ? [["/ commands", { kind: "commands" }], ["@ files", { kind: "files" }], ["⇧↵ newline", { kind: "newline" }]]
      : [["/", { kind: "commands" }], ["@", { kind: "files" }], ["⇧↵", { kind: "newline" }]];
    let column = 2;
    for (const [label, action] of items) {
      if (column + visibleLength(label) > end - tokenLabel.length - 2) break;
      control(hintsRow, column, paint.text(label, "muted"), action);
      column += visibleLength(label) + 2;
    }
  } else {
    const counterRow = hintsRow;
    const tokenLabel = editor.value ? `~${formatTokenCount(tokens)} tok` : "";
    const hintEnd = hintsRow === firstRow + 1 ? buttonColumn - 2 : width - inset;
    if (tokenLabel) canvas.put(counterRow, hintEnd - tokenLabel.length, paint.text(tokenLabel, "muted"), tokenLabel.length, "surface");
    const hintWidth = Math.max(0, hintEnd - inset - (tokenLabel ? tokenLabel.length + 2 : 0));
    const hints = options.streaming ? ["Type to queue a follow-up · Esc Esc / Ctrl+C stop", "Type to queue · Esc Esc stop", "Type to queue · ^C stop"]
      : options.hero ? ["↵ send · ⇧↵ newline · / commands · @ files", "↵ send · ⇧↵ newline · / cmds · @ files", "↵ send · ⇧↵ line · / @"]
        : ["⇧↵ newline · / commands · @ files", "⇧↵ newline · / cmds · @ files", "⇧↵ line · / @"];
    const hint = hints.find((hint) => visibleLength(hint) <= hintWidth) ?? hints.at(-1)!;
    const styledHint = truncateText(hint, hintWidth).split(/([/@])/).map((part) => paint.text(part, part === "/" || part === "@" ? "electric" : "muted")).join("");
    canvas.put(hintsRow, inset, styledHint, hintWidth, "surface");
  }
  const room = Math.max(1, hintsRow - firstRow);
  const attached = attachments(editor);
  const showAttachments = attached.length > 0 && room > 1;
  const promptCapacity = Math.max(1, room - (showAttachments ? 1 : 0));
  const visual = computePromptVisualLines(editor.value, editor.cursor, textWidth);
  const start = Math.max(0, visual.cursorLine - promptCapacity + 1);
  let cursor = { row: firstRow + visual.cursorLine - start, column: Math.min(textColumn + textWidth - 1, textColumn + visual.cursorCol) };
  for (let index = 0; index < Math.min(promptCapacity, visual.lines.length); index++) {
    const info = visual.lineInfos[start + index]!;
    const placeholder = options.streaming ? "Agent is running..." : options.hero ? "Describe what you want to build, fix, or explore..." : "Continue the conversation...";
    const row = firstRow + index;
    put(row, info.text || (editor.value ? "" : paint.text(placeholder, "muted")));
    zones.push({ row, column: textColumn, width: textWidth, action: { kind: "caret", start: info.start, text: info.text } });
  }
   const glyphRow = firstRow;
  if (!options.hero) canvas.put(glyphRow, inset, paint.text(options.streaming ? "◎" : "▶", options.streaming ? "thinking" : options.focused === false ? "muted" : "electric"), 1, "surface");
  let row = firstRow + Math.min(promptCapacity, visual.lines.length);
  if (showAttachments) {
    let text = "";
    for (const match of attached) {
      const label = ` ${match[1]} × `;
      if (visibleLength(text) + visibleLength(label) > textWidth) break;
      zones.push({ row, column: textColumn + visibleLength(text), width: visibleLength(label), action: { kind: "remove", start: match.index! + match[0].indexOf(match[1]!), length: match[1]!.length } });
      text += paint.dim(label);
    }
    put(row++, text);
  }
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
    const buttonRow = options.hero ? hintsRow : firstRow;
    const inline = (label: string, action?: ComposerAction) => control(buttonRow, width - (options.hero ? 2 : inset) - visibleLength(label), label, action);
    if (options.streaming) {
      // The running glyphs occupy the same control as Send. Its native action
      // remains interruption, alongside the explicit keyboard hint below.
      const dots = thinkingDots(paint, options.now ?? 0, options.reducedMotion);
      inline(dots + paint.text(" stop", "muted"), { kind: "stop" });
      if (queued && width < 60) control(0, textColumn, paint.text(" Clear queue × ", "secondary"), { kind: "clear" });
    } else {
      inline(sending ? paint.wash(" ↵ send ", "accentSurface", "electric") : paint.text(" ↵ send ", "muted"), sending ? { kind: "submit" } : undefined);
      if (restored && width < 60) control(0, textColumn, paint.text(" Clear × ", "secondary"), { kind: "clear" });
    }
  }
  return { lines: canvas.rows, zones, cursor };
}

/// Figma component 40:105: one compact, inset writing surface. Queue/restored
/// labels add one row; long drafts scroll within the same bounded editor.
function composeSessionDraft(options: ComposeOptions): ComposerFrame {
  const { width, height, paint, editor } = options;
  const { inset, right, textColumn, textWidth } = sessionComposerGeometry(options);
  const canvas = new Canvas(width, height, paint), zones: ComposerZone[] = [];
  const queued = options.streaming && Boolean(editor.value.trim());
  const restored = !options.streaming && hasDraftLabel(options);
  const tone = options.stopArmed ? "composerStoppedBorder" : queued ? "composerQueuedBorder" : restored ? "composerRestoredBorder" : options.focused === false ? "rule" : "borderBright";
  const boxWidth = width - inset * 2;
  const border = (text: string) => paint.text(text, tone);
  canvas.put(0, inset, border(`╭${"─".repeat(boxWidth - 2)}╮`), boxWidth);
  canvas.put(height - 1, inset, border(`╰${"─".repeat(boxWidth - 2)}╯`), boxWidth);
  for (let row = 1; row < height - 1; row++) {
    canvas.put(row, inset, border("│"), 1);
    canvas.put(row, inset + 1, "", boxWidth - 2, "surface");
    canvas.put(row, width - inset - 1, border("│"), 1);
  }
  const put = (row: number, text: string) => canvas.put(row, textColumn, text, textWidth, "surface");
  const control = (row: number, column: number, label: string, action?: ComposerAction) => {
    canvas.put(row, column, label, visibleLength(label), "surface");
    if (action) zones.push({ row, column, width: visibleLength(label), action });
  };
  if (editor.search) {
    const matches = reverseSearchMatches(options.history, editor.search.query);
    const selected = matches[Math.min(editor.search.index, Math.max(0, matches.length - 1))];
    canvas.put(0, inset + 2, paint.text(" Enter use · Esc cancel ", "secondary"), Math.min(boxWidth - 4, 24));
    canvas.put(1, inset + 2, `⌕ ${sanitizeTerminalLine(editor.search.query)}`, boxWidth - 4, "surface");
    canvas.put(2, inset + 2, paint.text(selected ?? "No matching history", "muted"), boxWidth - 4, "surface");
    return { lines: canvas.rows, zones, cursor: { row: 1, column: Math.min(right - 1, inset + 4 + visibleLength(editor.search.query)) } };
  }
  const header = (queued || restored) && height >= 4;
  if (header) {
    const clear = queued ? "Clear queue ×" : "Clear ×";
    const label = queued ? paint.text("Queued", "thinking") + paint.text(" · sends after this turn", "muted")
      : paint.text("Restored · not sent", "electric") + paint.text(" · the turn did not finish", "muted");
    canvas.put(1, inset + 2, label, right - inset - clear.length - 4, "surface");
    control(1, right - clear.length, paint.text(clear, "muted"), { kind: "clear" });
  }
  const firstRow = header ? 2 : 1;
  const room = Math.max(1, height - 1 - firstRow);
  const attached = attachments(editor), showAttachments = attached.length > 0 && room > 1;
  const capacity = room - Number(showAttachments);
  const visual = computePromptVisualLines(editor.value, editor.cursor, textWidth);
  const start = Math.max(0, visual.cursorLine - capacity + 1);
  for (let index = 0; index < Math.min(capacity, visual.lines.length); index++) {
    const info = visual.lineInfos[start + index]!;
    put(firstRow + index, info.text || (editor.value ? "" : paint.text(options.streaming ? "Type to queue a follow-up..." : "Continue the conversation...", "muted")));
    zones.push({ row: firstRow + index, column: textColumn, width: textWidth, action: { kind: "caret", start: info.start, text: info.text } });
  }
  canvas.put(firstRow, inset + 2, paint.text(options.streaming ? "◎" : "▶", options.stopArmed ? "signal" : options.streaming ? "thinking" : "electric"), 1, "surface");
  const controlRow = firstRow;
  if (options.streaming) {
    const label = options.stopArmed ? paint.text(width >= 65 ? "Press Esc again to stop" : "Esc stop", "signal")
      : thinkingDots(paint, options.now ?? 0, options.reducedMotion) + paint.text(" stop", "muted");
    control(controlRow, right - visibleLength(label), label, { kind: "stop" });
    if (!options.stopArmed && width >= 65) control(controlRow, right - visibleLength(label) - 10, paint.text("Esc Esc", "muted"), { kind: "stop" });
  } else {
    const items: [string, ComposerAction | undefined][] = [["↵ send", editor.value.trim() ? { kind: "submit" } : undefined]];
    if (width >= 65) items.push(["/ commands", { kind: "commands" }], ["@ files", { kind: "files" }]);
    const controlsWidth = items.reduce((sum, [label]) => sum + visibleLength(label), 0) + (items.length - 1) * 2;
    let column = right - controlsWidth;
    for (const [label, action] of items) {
      control(controlRow, column, paint.text(label, action?.kind === "submit" ? "electric" : "muted"), action);
      column += visibleLength(label) + 2;
    }
  }
  if (showAttachments) {
    const row = firstRow + Math.min(capacity, visual.lines.length);
    let column = textColumn;
    for (const match of attached) {
      const label = ` ${match[1]} × `;
      if (column + visibleLength(label) > textColumn + textWidth) break;
      control(row, column, paint.text(label, "secondary"), { kind: "remove", start: match.index! + match[0].indexOf(match[1]!), length: match[1]!.length });
      column += visibleLength(label);
    }
  }
  if (editor.value) {
    const counter = ` ~${formatTokenCount(draftTokens(editor.value))} tok `;
    canvas.put(height - 1, right - counter.length, paint.text(counter, "muted"), counter.length);
    if (width >= 65) canvas.put(height - 1, inset + 2, paint.text(" ⇧↵ newline ", "muted"), 12);
  }
  return { lines: canvas.rows, zones, cursor: { row: firstRow + visual.cursorLine - start, column: Math.min(textColumn + textWidth - 1, textColumn + visual.cursorCol) } };
}
