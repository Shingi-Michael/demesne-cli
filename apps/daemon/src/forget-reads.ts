/// Old reads leave the transcript once their turn is over. Every model round
/// resends the whole chat, so a file read three turns ago rides along in
/// every later request; on the Codex plan a round averaged ~82k tokens, most
/// of it earlier turns' tool output. A finished turn keeps a short note of
/// what each large read-style result was (the paths, the start of the text)
/// and the model reads again when it needs the current text, which is also
/// fresher than the copy it had. Edits, answers, questions and short results
/// stay whole. Only turns up to the stored cut (nextForgetThrough) are
/// touched: the last two finished turns and the turn in progress keep everything.
import { isRecord, type ModelMessage } from "@demesne/protocol";

/// Tools whose output can be fetched again, and so need not be carried.
export const REREADABLE_TOOLS = new Set([
  "read_file", "read_files", "search_files", "list_files", "git_diff", "git_history", "git_status",
  "run_command", "command_logs",
]);

/// Results this long or shorter stay whole: a stub would save little.
export const KEEP_UNDER = 1500;
const HEAD = 300, TAIL = 300;

/// The paths a read-style result was about, from its JSON, for the note.
function pathsIn(text: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const paths = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || paths.size >= 12) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 40)) visit(item, depth + 1); return; }
    if (!isRecord(value)) return;
    if (typeof value.path === "string" && value.path) paths.add(value.path);
    for (const key of ["files", "results", "matches", "entries"]) if (key in value) visit(value[key], depth + 1);
  };
  visit(parsed, 0);
  return [...paths];
}

/// The note that stands in for a long result from an earlier turn.
export function forgottenResult(tool: string, text: string): string {
  const paths = pathsIn(text);
  // A command's last lines carry its exit and verdict, so they stay too.
  const tail = tool === "run_command" || tool === "command_logs" ? `\n…\n${text.slice(-TAIL)}` : "";
  return `${text.slice(0, HEAD)}${tail}\n[From an earlier turn: ${text.length.toLocaleString("en-US")} characters of ${tool} output not kept here${paths.length ? ` (${paths.join(", ")})` : ""}. Call ${tool} again if you need it; the files may have changed since.]`;
}

/// A finished turn's messages with its long read-style results cut to notes.
export function forgetOldReads<T extends ModelMessage>(messages: T[]): T[] {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  }
  return messages.map((message) => {
    if (message.role !== "tool" || typeof message.content !== "string" || message.content.length <= KEEP_UNDER) return message;
    const tool = names.get(message.toolCallId);
    if (!tool || !REREADABLE_TOOLS.has(tool)) return message;
    return { ...message, content: forgottenResult(tool, message.content) };
  });
}

/// Recent turns stay whole: a follow-up about what was just read answers
/// from the cached copy instead of reading again (measured on the Codex plan,
/// trimming the last turns too cost more rounds and more uncached tokens).
export const KEEP_RECENT_TURNS = 2;
/// Old turns are cut to notes only when it costs nothing: when the
/// provider's prompt cache has gone cold (the chat sat idle this long), the
/// next request is rebuilt from scratch anyway, so rewriting old turns then
/// is free. Cutting while the cache is warm throws it away: after cuts at a
/// fixed size (240k) long turns sent 2.4× more uncached tokens (measured on
/// Mike's Mac, 2026-11-05).
export const CACHE_COLD_MS = 15 * 60_000;
/// A cold cut is worth making once this much long output can come off.
export const COLD_CUT_CHARS = 8_000;
/// Even with a warm cache, past this much the cut pays for its rebuild.
export const CUT_AFTER_CHARS = 480_000;

const longOutput = (messages: ModelMessage[]) => {
  const names = new Map<string, string>();
  let total = 0;
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
    else if (message.role === "tool" && message.content.length > KEEP_UNDER && REREADABLE_TOOLS.has(names.get(message.toolCallId) ?? "")) total += message.content.length;
  }
  return total;
};

/// How many of the earliest turns the old rule (a cut each 240k, worked out
/// from the history alone) had cut: where a chat from before stored cuts
/// starts, so its request doesn't suddenly grow back.
export function cutPoint(turns: ModelMessage[][], every = 240_000): number {
  const sizes = turns.map(longOutput);
  let cut = 0, pending = 0, counted = 0;
  for (let length = 1; length <= turns.length; length++) {
    const end = length - KEEP_RECENT_TURNS;
    while (counted < end) pending += sizes[counted++]!;
    if (end > cut && pending > every) { cut = end; pending = 0; }
  }
  return cut;
}

interface Turn<T extends ModelMessage> { firstMessageId: number; messages: T[] }

/// Where the cut stands for this turn: kept from before unless the cache is
/// cold (or the pile is huge), then moved up to all but the last turns.
/// Decided once at the start of a turn, so every round of it sends the same
/// history and keeps the cache. `through` null = a chat from before stored
/// cuts; `idleMs` null = no request yet (nothing cached).
export function nextForgetThrough<T extends ModelMessage>(turns: Turn<T>[], through: number | null, idleMs: number | null): number {
  let at = through ?? (() => { const cut = cutPoint(turns.map((turn) => turn.messages)); return cut ? turns[cut - 1]!.firstMessageId : 0; })();
  const end = turns.length - KEEP_RECENT_TURNS;
  if (end <= 0 || turns[end - 1]!.firstMessageId <= at) return at;
  const pending = turns.slice(0, end).filter((turn) => turn.firstMessageId > at).reduce((total, turn) => total + longOutput(turn.messages), 0);
  const cold = idleMs === null || idleMs >= CACHE_COLD_MS;
  if ((cold && pending >= COLD_CUT_CHARS) || pending > CUT_AFTER_CHARS) at = turns[end - 1]!.firstMessageId;
  return at;
}

/// The history's turns, those up to the cut with their long reads as notes.
export function forgetThrough<T extends ModelMessage, U extends Turn<T>>(turns: U[], through: number): U[] {
  return turns.map((turn) => turn.firstMessageId <= through ? { ...turn, messages: forgetOldReads(turn.messages) } : turn);
}
