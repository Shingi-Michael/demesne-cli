import { formatFooterLine, formatTokenCount, sanitizeTerminalLine, truncateText, visibleLength, type Painter, type PaletteColor, type PresenceState } from "@demesne/brand";
import type { ContextReceipt, ResponseReceipt } from "./entries.ts";

const throughput = (rate: number | null | undefined): string => rate != null && Number.isFinite(rate) && rate >= 0
  ? rate >= 1000 ? formatTokenCount(rate) : rate.toFixed(1) : "—";

function elapsedLabel(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—s";
  return `${(ms / 1000).toFixed(1)}s`;
}

/// A settled response owns its receipt; later runs and model changes cannot
/// alter these values. The conversation wraps this line on narrow terminals.
export function responseSummary(receipt: ResponseReceipt, compact = false): string {
  return `${receipt.mode} · ${sanitizeTerminalLine(receipt.model)} · ${compact ? "" : "elapsed "}${elapsedLabel(receipt.durationMs)} · ${compact ? "" : "speed "}${throughput(receipt.tokensPerSecond)} tok/s · ctx ${contextLabel(receipt.context)}`;
}

export function contextLabel(context?: ContextReceipt): string {
  return `${context?.estimated ? "~" : ""}${context?.used == null ? "—" : formatTokenCount(context.used)}/${context?.capacity ? formatTokenCount(context.capacity) : "?"}`;
}

export function contextPercentage(context?: ContextReceipt): number | null {
  return context?.used != null && Number.isFinite(context.used) && context.used >= 0 && context.capacity != null && Number.isFinite(context.capacity) && context.capacity > 0
    ? Math.round(context.used / context.capacity * 100) : null;
}

export function contextTone(context?: ContextReceipt): PaletteColor {
  const percentage = contextPercentage(context);
  return percentage !== null && percentage > 80 ? "signal" : percentage !== null && percentage > 50 ? "thinking" : "secondary";
}

export function contextMeter(context: ContextReceipt | undefined, paint: Painter, cells = 6): string {
  const percentage = contextPercentage(context);
  if (percentage === null) return "";
  const used = Math.min(cells, percentage * cells / 100);
  const count = Math.floor(used);
  const partial = used > count ? 1 : 0;
  const tone = percentage > 80 ? "signal" : percentage > 50 ? "thinking" : "citron";
  return `${paint.text("─".repeat(count) + (partial ? "╴" : ""), tone)}${paint.text("─".repeat(cells - count - partial), "rule")} ${paint.text(`${percentage}%`, percentage > 50 ? tone : "muted")}`;
}

/// Figma 28:306 receipt: `Build · model · 14.2s · 31.4 tok/s · ctx 46%`.
/// Values need no labels; context reads as a percentage when both numbers
/// are known and as `ctx used/capacity` otherwise, so gaps stay explicit.
export function responseMetadata(receipt: ResponseReceipt, paint: Painter, _compact = false, _width = 80): string[] {
  const percentage = contextPercentage(receipt.context);
  const context = percentage === null ? `ctx ${contextLabel(receipt.context)}` : `ctx ${percentage}%`;
  return [paint.text(receipt.mode, "muted"), paint.text(sanitizeTerminalLine(receipt.model), "secondary"),
    paint.text(elapsedLabel(receipt.durationMs), "secondary"), paint.text(`${throughput(receipt.tokensPerSecond)} tok/s`, "secondary"),
    paint.text(context, contextTone(receipt.context))];
}

/// A key drawn as a keycap, as in the Figma hints: Figma outlines the key in
/// the bright border color, which a terminal cell can only show as a chip of
/// that color, with the key in the main text color. Plain output keeps the text.
export function keycap(paint: Painter, key: string): string {
  return paint.onBackground(paint.text(key, "paper"), "borderBright");
}

/// `Ctrl+B log  Ctrl+G live`: keycaps followed by what they do.
export function keyHints(paint: Painter, hints: readonly (readonly [string, string])[], gap = "  "): string {
  return hints.map(([key, label]) => `${keycap(paint, key)} ${paint.text(label, "muted")}`).join(gap);
}

/// Figma's usage bar: a filled track in the context tone, then the numbers,
/// `120.8k / 262.1k · 46%`. Unknown usage keeps the explicit `ctx —/cap`.
export function usageBar(context: ContextReceipt | undefined, paint: Painter, cells = 10): string {
  const percentage = contextPercentage(context);
  if (percentage === null) return "";
  const filled = Math.min(cells, Math.max(percentage > 0 ? 1 : 0, Math.round(percentage * cells / 100)));
  const tone = percentage > 80 ? "signal" : percentage > 50 ? "thinking" : "citron";
  return paint.text("━".repeat(filled), tone) + paint.text("━".repeat(cells - filled), "rule");
}

export function usageLabel(context: ContextReceipt | undefined): string {
  const percentage = contextPercentage(context);
  if (percentage === null) return `ctx ${contextLabel(context)}`;
  return `${context?.estimated ? "~" : ""}${formatTokenCount(context!.used!)} / ${formatTokenCount(context!.capacity!)} · ${percentage}%`;
}

/// The status bar, kept quiet: a state only when it needs attention and the
/// model on the left; context usage (and `live ↓` once scrolled away) on the right.
/// Optional fields drop first as width runs out.
export function sessionStatus(options: {
  width: number; paint: Painter; state: string; context: ContextReceipt; model?: string;
  presence: PresenceState; elapsed?: number; tokensPerSecond?: number | null;
  paused?: boolean; hasResponse?: boolean; now?: number; reducedMotion?: boolean;
}): { text: string; zones: { column: number; width: number; action: "context" | "response-start" | "follow" | "log" }[] } {
  const { width, paint, state } = options;
  const working = state === "WORKING";
  const name = state === "COMPLETE" ? "READY" : state;
  const label = name.toLowerCase();
  // Approval needs the reader, not a repair: amber, like its header pill.
  const tone = state === "FAILED" ? "signal" : state === "APPROVAL" || state === "QUESTION" ? "thinking" : state === "STOPPED" ? "secondary" : working ? "thinking" : "citron";
  // A colored dot carries the state; the label keeps it readable without color.
  const mark = paint.text("●", tone);
  // A quiet footer: "ready" says nothing, and working shows in the composer.
  // Only states that need attention (failed, approval, stopped…) get a word.
  const phase = working || name === "READY" ? "" : `${mark} ${paint.text(label, tone)}`;
  const bar = usageBar(options.context, paint);
  const percentage = contextPercentage(options.context);
  const usage = paint.text(percentage === null ? "ctx —" : `${formatTokenCount(options.context.used!)} · ${percentage}%`, contextTone(options.context));
  const model = options.model ? paint.text(truncateText(sanitizeTerminalLine(options.model), 28), "secondary") : "";
  // Ctrl+B and Ctrl+G still work; the footer only points back to live output
  // once the reader has scrolled away from it.
  const live = options.paused ? paint.text("live ↓", "muted") : "";
  // Unrelated groups sit apart: who is answering (state, model) on the left,
  // context usage (and live ↓ once scrolled away) on the right. Speed lives in
  // each response's receipt. Drop the model, then the bar's track; state and
  // usage numbers always stay.
  let show = { model: Boolean(model), bar: Boolean(bar) };
  const build = () => {
    const usagePart = (show.bar && bar ? `${bar} ` : "") + usage;
    return { left: [phase, show.model ? model : ""].filter(Boolean).join("  "), usagePart, right: [usagePart, live].filter(Boolean).join("   ") };
  };
  for (const drop of ["model", "bar"] as const) {
    const { left, right } = build();
    if (visibleLength(left) + visibleLength(right) + (left ? 4 : 0) <= width) break;
    show = { ...show, [drop]: false };
  }
  const { left: leftText, usagePart, right } = build();
  const left = truncateText(leftText, Math.max(0, width - visibleLength(right) - 2));
  const zones: { column: number; width: number; action: "context" | "response-start" | "follow" | "log" }[] = [];
  const rightColumn = Math.max(0, width - visibleLength(right));
  zones.push({ column: rightColumn, width: Math.min(width, visibleLength(usagePart)), action: "context" });
  if (live) zones.push({ column: width - visibleLength(live), width: visibleLength(live), action: "follow" });
  // The first item (state, else model) jumps to the start of the answer.
  const lead = phase || (show.model ? model : "");
  if (options.hasResponse && lead && visibleLength(left)) zones.push({ column: 0, width: Math.min(visibleLength(lead), visibleLength(left)), action: "response-start" });
  return { text: formatFooterLine(left, right, width), zones };
}
