import type { ProviderMessage } from "@demesne/providers";

/// Compaction from notes (pass 114). Once a chat is past NOTES_FROM of its
/// window, the model ends each answer with a short hidden note, and every
/// finished turn also has a free part read from what Demesne recorded: the
/// ask, the files changed, the commands and how they ended. Compacting swaps
/// older turns for their notes, with no model call. A Keep list of the
/// user's standing rules rides ahead of the notes, word for word.

export const NOTE_OPEN = "<turn-note>";
export const NOTE_CLOSE = "</turn-note>";
/// Share of the window at which the model starts writing notes.
export const NOTES_FROM = 0.4;
/// Share of the room for input (the window less the reply) at which a chat
/// compacts itself after a turn.
export const AUTO_COMPACT_AT = 0.75;
const MAX_KEEP = 24;
const MAX_LINE = 300;

export const NOTE_INSTRUCTION = `
This chat is getting long, so older turns will later be replaced by short notes. End your final answer to each request with one hidden note, the very last thing you write: ${NOTE_OPEN} then one line per fact, ${NOTE_CLOSE}. Use "Decided: …" for each decision made and why, "Keep: …" for a standing rule the user gave (their words) or a lasting fact that must never be lost, and "Open: …" for anything unfinished. Two to four lines, no more. The user never sees the note, so never mention it.`;

/// Strips the hidden note from streamed text: trailing space and what could
/// still be the start of the opening tag are held back, and everything from
/// the tag on is dropped.
export class NoteFilter {
  private held = "";
  private hiding = false;

  push(delta: string): string {
    if (this.hiding) return "";
    const text = this.held + delta;
    const at = text.indexOf(NOTE_OPEN);
    if (at >= 0) {
      this.hiding = true;
      this.held = "";
      return text.slice(0, at).replace(/\s+$/, "");
    }
    let keep = 0;
    for (let size = Math.min(NOTE_OPEN.length - 1, text.length); size > 0; size--) {
      if (NOTE_OPEN.startsWith(text.slice(-size))) { keep = size; break; }
    }
    // Trailing blank lines wait too, so a note never leaves them behind.
    let cut = text.length - keep;
    while (cut > 0 && /\s/.test(text[cut - 1]!)) cut--;
    this.held = text.slice(cut);
    return text.slice(0, cut);
  }

  /// The end of a round: text held back that never became the tag.
  end(): string {
    const rest = this.hiding ? "" : this.held;
    this.held = "";
    this.hiding = false;
    return rest;
  }
}

/// An answer's text without its note, and the note's lines.
export function splitNote(text: string): { text: string; lines: string[] } {
  const at = text.indexOf(NOTE_OPEN);
  if (at < 0) return { text, lines: [] };
  const close = text.indexOf(NOTE_CLOSE, at);
  const body = text.slice(at + NOTE_OPEN.length, close < 0 ? undefined : close);
  return {
    text: text.slice(0, at).trimEnd(),
    lines: body.split("\n").map((line) => line.replace(/^[-*•]\s*/, "").trim()).filter(Boolean).map((line) => clip(line)),
  };
}

/// Rough tokens for a set of messages, the planner's way (bytes / 3, plus 20%).
export function roughTokens(messages: ProviderMessage[]): number {
  return Math.ceil((Buffer.byteLength(JSON.stringify(messages), "utf8") / 3) * 1.2);
}

/// One finished turn's note: its free part from the record, then the model's lines.
export function turnNote(messages: ProviderMessage[]): string {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const lines: string[] = [];
  const changed = new Set<string>(), ran: string[] = [], failed: string[] = [], modelLines: string[] = [];
  let asked = "", replied = "";
  for (const message of messages) {
    if (message.role === "user" && !asked) asked = message.content;
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) calls.set(call.id, { name: call.name, input: parseInput(call.arguments) });
      if (message.content) {
        const { text, lines: note } = splitNote(message.content);
        if (text.trim()) replied = text;
        modelLines.push(...note);
      }
    }
    if (message.role === "tool") {
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      const result = parseInput(message.content);
      const path = typeof call.input.path === "string" ? call.input.path : "";
      if (["edit_file", "write_file", "delete_path", "move_path"].includes(call.name) && path && !("error" in result)) changed.add(path);
      if (call.name === "run_command" && typeof call.input.command === "string") {
        const exit = typeof result.exitCode === "number" ? result.exitCode : null;
        ran.push(`${clip(call.input.command, 120)}${exit === null ? "" : exit === 0 ? " ✓" : ` ✗ (exit ${exit})`}`);
      }
      if (typeof result.error === "string") failed.push(`${call.name}${path ? ` ${path}` : ""}: ${clip(result.error, 160)}`);
    }
  }
  if (asked) lines.push(`You asked: ${clip(asked)}`);
  if (changed.size) lines.push(`Changed: ${[...changed].join(", ")}`);
  if (ran.length) lines.push(`Ran: ${ran.slice(-6).join("; ")}`);
  if (failed.length) lines.push(`Failed: ${failed.slice(-3).join("; ")}`);
  lines.push(...modelLines.filter((line) => !/^keep:/i.test(line)));
  if (replied) lines.push(`Replied: ${clip(replied.replace(/\s+/g, " "), 400)}`);
  return lines.join("\n");
}

/// The user's standing rules ("never…", "always…", "from now on…") and the
/// model's Keep lines, newest last, without repeats.
export function keepLines(messages: ProviderMessage[], previous: string[] = []): string[] {
  const found = [...previous];
  for (const message of messages) {
    if (message.role === "user") {
      for (const sentence of message.content.split(/(?<=[.!?])\s+|\n+/)) {
        const text = sentence.trim();
        if (text.length >= 8 && text.length <= 200 && /\b(always|never|from now on|do not ever|don'?t ever|make sure to always|remember that)\b/i.test(text)) found.push(text);
      }
    }
    if (message.role === "assistant" && message.content) {
      for (const line of splitNote(message.content).lines) if (/^keep:/i.test(line)) found.push(line.replace(/^keep:\s*/i, ""));
    }
  }
  const seen = new Set<string>();
  return found.filter((line) => {
    const key = line.toLowerCase().replace(/\W+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(-MAX_KEEP);
}

/// The checkpoint the model reads in place of the older turns.
export function renderNotes(keep: string[], notes: string[]): string {
  return [
    "Summary of earlier turns, kept as notes. The full turns are in History.",
    keep.length ? `### Keep\nThe user's standing rules and lasting facts, word for word:\n${keep.map((line) => `- ${line}`).join("\n")}` : "",
    `### Turn notes, oldest first\n${notes.map((note, index) => `${index + 1}. ${note.split("\n").join("\n   ")}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
}

function parseInput(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function clip(text: string, length = MAX_LINE): string {
  const flat = text.trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}
