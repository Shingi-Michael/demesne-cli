/// The cache meter. A provider's prompt cache reuses work only for the part
/// of a request that repeats the previous one from the first byte: the
/// instructions, then the tool list, then the conversation. One changed
/// character near the start and everything after it is read again at full
/// price. So every model request is compared with the one before it in the
/// same chat, and the provider call keeps what it found: how much of the
/// previous request was kept as a prefix, where the first difference was,
/// and a short reason. scripts/check-cache-prefix.ts fails when a change adds
/// a new break; scripts/cache-report.ts reads the record back from real chats.
///
/// Read more: https://code.claude.com/docs/en/prompt-caching (how a prefix
/// cache behaves) and https://developers.openai.com/api/docs/guides/prompt-caching.
import { createHash } from "node:crypto";
import type { PrefixReport } from "@demesne/protocol";
import type { ProviderMessage, ProviderToolDefinition } from "@demesne/providers";

interface Layer { hash: string; chars: number; role: string }

/// A request as a prompt cache sees it. The instructions and the tool list
/// are kept as text, so a difference can be named; messages as a hash each.
export interface RequestShape {
  instructions: string;
  tools: { name: string; text: string }[];
  messages: Layer[];
  at: number;
}

const digest = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);

/// What of a message reaches the provider. A picture counts by its artifact:
/// the same artifact is the same bytes.
function wire(message: ProviderMessage): string {
  return JSON.stringify([
    message.role,
    message.content ?? "",
    message.role === "assistant" ? (message.toolCalls ?? []).map((call) => [call.id, call.name, call.arguments]) : null,
    message.role === "tool" ? message.toolCallId : null,
    (message.imageInputs ?? []).map((image) => image.artifactId),
  ]);
}

export function requestShape(messages: readonly ProviderMessage[], tools: readonly ProviderToolDefinition[], at: number): RequestShape {
  const leading = messages[0]?.role === "system" ? 1 : 0;
  return {
    instructions: leading ? String(messages[0]!.content ?? "") : "",
    tools: tools.map((tool) => ({ name: tool.name, text: JSON.stringify(tool) })),
    messages: messages.slice(leading).map((message) => { const text = wire(message); return { hash: digest(text), chars: text.length, role: message.role }; }),
    at,
  };
}

const sharedStart = (a: string, b: string) => { let index = 0; const end = Math.min(a.length, b.length); while (index < end && a.charCodeAt(index) === b.charCodeAt(index)) index++; return index; };
const clip = (text: string, limit = 90) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line; };
const list = (names: string[]) => names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ");

/// What changed in the instructions at their first difference: a line that
/// is new there, or, when the line now at that place was already further
/// down, the line that went away.
function changedLine(before: string, after: string, at: number): string {
  const lineAt = (text: string) => { const end = text.indexOf("\n", at); return text.slice(text.lastIndexOf("\n", Math.max(0, at - 1)) + 1, end < 0 ? text.length : end); };
  const now = at < after.length ? lineAt(after) : "", was = at < before.length ? lineAt(before) : "";
  return now && !before.split("\n").includes(now) ? `now reading "${clip(now)}"` : `no longer reading "${clip(was || now)}"`;
}

function toolsCause(before: RequestShape["tools"], after: RequestShape["tools"]): string {
  const had = new Map(before.map((tool) => [tool.name, tool.text])), has = new Map(after.map((tool) => [tool.name, tool.text]));
  const added = after.filter((tool) => !had.has(tool.name)).map((tool) => tool.name);
  const removed = before.filter((tool) => !has.has(tool.name)).map((tool) => tool.name);
  if (added.length || removed.length) return [added.length ? `added ${list(added)}` : "", removed.length ? `removed ${list(removed)}` : ""].filter(Boolean).join(", ");
  const changed = after.filter((tool) => had.get(tool.name) !== tool.text).map((tool) => tool.name);
  return changed.length ? `the definition of ${list(changed)} changed` : "the order changed";
}

/// How much of the previous request this one repeats from its first byte.
/// `previous` null: nothing to compare with (the chat's first request, or
/// the first since Demesne started).
export function comparePrefix(previous: RequestShape | null, next: RequestShape): PrefixReport {
  const toolsText = (shape: RequestShape) => shape.tools.map((tool) => tool.text).join(",");
  const sentChars = next.instructions.length + toolsText(next).length + next.messages.reduce((total, message) => total + message.chars, 0);
  if (!previous) return { sentChars, previousChars: null, keptChars: null, brokeAt: null, idleMs: null };
  const previousTools = toolsText(previous), nextTools = toolsText(next);
  const previousChars = previous.instructions.length + previousTools.length + previous.messages.reduce((total, message) => total + message.chars, 0);
  const idleMs = Math.max(0, next.at - previous.at);
  if (previous.instructions !== next.instructions) {
    const at = sharedStart(previous.instructions, next.instructions);
    return { sentChars, previousChars, keptChars: at, brokeAt: "instructions", cause: `The instructions changed, ${changedLine(previous.instructions, next.instructions, at)}`, idleMs };
  }
  let keptChars = next.instructions.length;
  if (previousTools !== nextTools) {
    return { sentChars, previousChars, keptChars: keptChars + sharedStart(previousTools, nextTools), brokeAt: "tools", cause: `The tool list changed: ${toolsCause(previous.tools, next.tools)}`, idleMs };
  }
  keptChars += nextTools.length;
  for (const [index, before] of previous.messages.entries()) {
    const after = next.messages[index];
    if (after?.hash === before.hash) { keptChars += before.chars; continue; }
    const shorter = next.messages.length < previous.messages.length;
    const what = before.role === "tool" ? "a tool result" : before.role === "assistant" ? "an answer or tool call" : "a message";
    return { sentChars, previousChars, keptChars, brokeAt: "history", messageIndex: index,
      cause: after ? `Earlier history was rewritten: ${what}, message ${index + 1} of ${previous.messages.length}${shorter ? ", and the history got shorter" : ""}` : "The history got shorter", idleMs };
  }
  return { sentChars, previousChars, keptChars, brokeAt: null, idleMs };
}

/// Each chat's last request, kept in memory: the meter needs nothing stored
/// to compare with, and a restart only costs one "nothing to compare" call.
export class PrefixMeter {
  private readonly last = new Map<string, RequestShape>();
  constructor(private readonly limit = 64) {}

  measure(key: string, messages: readonly ProviderMessage[], tools: readonly ProviderToolDefinition[], at = Date.now()): PrefixReport {
    const shape = requestShape(messages, tools, at);
    const report = comparePrefix(this.last.get(key) ?? null, shape);
    this.last.delete(key);
    this.last.set(key, shape);
    for (const oldest of this.last.keys()) { if (this.last.size <= this.limit) break; this.last.delete(oldest); }
    return report;
  }

  forget(key: string): void { this.last.delete(key); }
}
