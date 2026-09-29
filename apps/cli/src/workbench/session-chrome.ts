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

/// The Figma footer keeps field values readable, with a quiet label/separator
/// hierarchy. Context and its hairline meter wrap together as a single field.
export function responseMetadata(receipt: ResponseReceipt, paint: Painter, compact = false, width = 80): string[] {
  const label = (name: string, value: string, tone: PaletteColor = "secondary") => paint.text(compact ? "" : name, "muted") + paint.text(value, tone);
  const percentage = contextPercentage(receipt.context);
  const meter = width >= 38 ? contextMeter(receipt.context, paint) : percentage === null ? "" : paint.text(`${percentage}%`, contextTone(receipt.context));
  return [paint.text(receipt.mode, "muted"), paint.text(sanitizeTerminalLine(receipt.model), "secondary"),
    label("elapsed ", elapsedLabel(receipt.durationMs)), label("speed ", `${throughput(receipt.tokensPerSecond)} tok/s`, "citron"),
    paint.text("ctx ", "muted") + paint.text(contextLabel(receipt.context), contextTone(receipt.context)) + (meter ? ` ${meter}` : "")];
}

/// The reference status strip: scroll position, execution state, context budget,
/// and response/live navigation. Its controls share the same width budget.
export function sessionStatus(options: {
  width: number; paint: Painter; state: string; context: ContextReceipt;
  presence: PresenceState; elapsed?: number; tokensPerSecond?: number | null;
  paused?: boolean; hasResponse?: boolean; now?: number; reducedMotion?: boolean;
}): { text: string; zones: { column: number; width: number; action: "context" | "response-start" | "follow" }[] } {
  const { width, paint, state } = options;
  const working = state === "WORKING";
  const name = state === "COMPLETE" ? "READY" : state;
  const label = name.toLowerCase();
  const tone = state === "FAILED" || state === "APPROVAL" ? "signal" : state === "STOPPED" ? "secondary" : working ? "thinking" : "citron";
  // A colored dot carries the state; the label keeps it readable without color.
  const mark = paint.text("●", tone);
  const separator = paint.text(" · ", "borderBright");
  const percentage = contextPercentage(options.context);
  const context = paint.text("ctx ", "muted") + paint.text(contextLabel(options.context), contextTone(options.context));
  const fullPhase = working ? "" : `${mark} ${paint.text(label, tone)}`;
  const phase = !working && options.hasResponse && width < 45 && visibleLength(fullPhase + context) + 15 > width ? mark : fullPhase;
  let left = phase;
  const links: { text: string; action: "context" | "response-start" | "follow" }[] = [{ text: context, action: "context" }];
  const live = width >= 55 ? "Ctrl+G live" : "live ↓";
  if (visibleLength(left + links.map((link) => link.text).join(separator)) + live.length + 5 <= width) links.push({ text: paint.text(live, "muted"), action: "follow" });
  const meter = contextMeter(options.context, paint);
  if (meter && visibleLength(left + links.map((link) => link.text).join(separator)) + visibleLength(meter) + 4 <= width) links[0]!.text += ` ${meter}`;
  else if (percentage !== null && visibleLength(left + links.map((link) => link.text).join(separator)) + 8 <= width) links[0]!.text += paint.text(` · ${percentage}%`, "muted");
  const right = links.map((link) => link.text).join(separator);
  const room = width - visibleLength(right) - 2;
  left = truncateText(left, Math.max(0, room));
  let column = width - visibleLength(right);
  const zones = links.map((link) => { const zone = { column, width: visibleLength(link.text), action: link.action }; column += zone.width + 3; return zone; });
  if (options.hasResponse && visibleLength(left)) zones.push({ column: 0, width: visibleLength(left), action: "response-start" });
  return { text: formatFooterLine(left, right, width), zones };
}
