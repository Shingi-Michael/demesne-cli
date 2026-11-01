/// Old reads leave the transcript once their turn is over. Every model round
/// resends the whole chat, so a file read three turns ago rides along in
/// every later request; on the Codex plan a round averaged ~82k tokens, most
/// of it earlier turns' tool output. A finished turn keeps a short note of
/// what each large read-style result was (the paths, the start of the text)
/// and the model reads again when it needs the current text, which is also
/// fresher than the copy it had. Edits, answers, questions and short results
/// stay whole. Only turns before the cut point (cutPoint) are touched: the
/// last two finished turns and the turn in progress keep everything.
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
/// Older turns are cut to notes in one step once their long read-style
/// output passes this many characters (~30k tokens), then left alone until
/// it piles up again. Cutting rarely, all at once, keeps the cached prefix
/// valid in between, where trimming a turn every time would not.
export const CUT_AFTER_CHARS = 120_000;

const longOutput = (messages: ModelMessage[]) => {
  const names = new Map<string, string>();
  let total = 0;
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
    else if (message.role === "tool" && message.content.length > KEEP_UNDER && REREADABLE_TOOLS.has(names.get(message.toolCallId) ?? "")) total += message.content.length;
  }
  return total;
};

/// How many of the earliest turns are cut to notes: worked out from the
/// history alone, as if it grew one turn at a time, so every round and
/// every later turn agrees on it until the next cut.
export function cutPoint(turns: ModelMessage[][]): number {
  const sizes = turns.map(longOutput);
  let cut = 0, pending = 0, counted = 0;
  for (let length = 1; length <= turns.length; length++) {
    const end = length - KEEP_RECENT_TURNS;
    while (counted < end) pending += sizes[counted++]!;
    if (end > cut && pending > CUT_AFTER_CHARS) { cut = end; pending = 0; }
  }
  return cut;
}

/// The history's turns, the ones before the cut point with their long reads
/// as notes.
export function forgetOldReadsInHistory<T extends ModelMessage>(turns: T[][]): T[][] {
  const cut = cutPoint(turns);
  return turns.map((messages, index) => index < cut ? forgetOldReads(messages) : messages);
}
