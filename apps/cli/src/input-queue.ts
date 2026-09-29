import { previousGraphemeBoundary } from "@demesne/brand";

/// Pure reducer for type-ahead input captured while a turn is streaming.
///
/// The queue is submitted automatically when the turn finishes, so plain Enter
/// is a no-op rather than a submit: there is nothing to submit to yet.
/// Control keys are ignored so terminal shortcuts keep working during a turn.

export const QUEUED_INPUT_LIMIT = 4_000;

export interface QueuedInputKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export function reduceQueuedInput(queue: string, key: QueuedInputKey, text: string): string {
  if (isNewlineKey(key, text)) return clamp(`${queue}\n`);
  if (key.ctrl || key.meta) return queue;
  if (key.name === "backspace") {
    if (queue.length === 0) return queue;
    return queue.slice(0, previousGraphemeBoundary(queue, queue.length));
  }
  if (key.name === "return" || key.name === "enter" || key.name === "tab") return queue;
  if (!text) return queue;
  const cleaned = text
    .replace(/\r\n|\r/g, "\n")
    .replaceAll("\t", "  ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return cleaned ? clamp(queue + cleaned) : queue;
}

/// What happens to type-ahead once a turn ends. Only a completed turn sends
/// the queue as the next prompt. After a stop or a failure the follow-up was
/// written for a result that never arrived, so it returns to the editor
/// unsent for the user to revise.
export function settleQueuedInput(
  queue: string | undefined,
  outcome: "completed" | "stopped" | "failed",
): { send?: string; draft?: string } {
  const text = queue?.trim();
  if (!text) return {};
  return outcome === "completed" ? { send: text } : { draft: text };
}

/// A single-line preview of the queue for the footer, or null when empty.
export function queueSummary(queue: string): string | null {
  const collapsed = queue.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > 40 ? `${collapsed.slice(0, 39)}…` : collapsed;
}

function clamp(queue: string): string {
  return queue.length <= QUEUED_INPUT_LIMIT ? queue : queue.slice(queue.length - QUEUED_INPUT_LIMIT);
}

function isNewlineKey(key: QueuedInputKey, text: string): boolean {
  return Boolean(key.shift && (key.name === "return" || key.name === "enter"))
    || Boolean(key.ctrl && key.name === "j")
    || key.name === "linefeed"
    || text === "\x1b\r"
    || text === "\x1b\n";
}
