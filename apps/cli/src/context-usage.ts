import { formatTokenCount, type Painter, type PaletteColor } from "@demesne/brand";
import type { ContextPlan } from "@demesne/protocol";

const roles: PaletteColor[] = ["contextMessages", "contextTools", "contextReserved", "contextFree"];
const labels = ["Messages", "Tool definitions", "Reserved", "Available"];
const marks = ["M", "T", "R", "·"];
const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/// Estimates from one plan only: provider usage must never be mixed into the
/// stack, and unknown capacity/reserves must never look like free space.
export function contextUsageStack(plan: ContextPlan, width: number, paint: Painter): string[] {
  const capacity = plan.capacityTokens;
  if (!validCount(capacity) || !capacity) return [paint.dim("stack unavailable · capacity unknown")];
  const counts = [plan.estimatedMessageTokens, plan.estimatedToolDefinitionTokens, plan.reserves.totalTokens];
  if (!counts.every(validCount)) return [paint.dim("stack unavailable · breakdown unknown")];
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || plan.estimatedInputTokens !== counts[0]! + counts[1]!) return [paint.dim("stack unavailable · inconsistent plan")];
  counts.push(Math.max(0, capacity - total));
  const cells = Math.max(1, Math.floor(width));
  let tokens = 0, previous = 0;
  const bar = counts.map((value, index) => {
    tokens = Math.min(capacity, tokens + value);
    const end = Math.round(tokens / capacity * cells), size = end - previous;
    previous = end;
    return paint.text((paint.enabled ? index === 3 ? "░" : "█" : marks[index]!).repeat(size), roles[index]!);
  }).join("");
  const lines = [bar, ...counts.map((value, index) => `${paint.text(paint.enabled ? "■" : marks[index]!, roles[index]!)} ${paint.text(labels[index]!, "secondary")} ${paint.text(`~${formatTokenCount(value)}`, roles[index]!)}`)];
  if (total > capacity) lines.push(paint.text(`Over capacity by ~${formatTokenCount(total - capacity)}`, "signal"));
  return lines;
}
