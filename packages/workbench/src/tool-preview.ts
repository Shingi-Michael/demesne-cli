import type { ToolEntry, WorkbenchEntry } from "./entries.ts";

/// Display-only partial JSON. Never used for execution. Completed strings are
/// decoded normally; unfinished escapes wait for the next fragment. Objects and
/// arrays retain their completed fields, including multi-hunk edits.
export function partialToolArguments(raw: string): Record<string, unknown> {
  let at = 0;
  const space = () => { while (/\s/.test(raw[at] ?? "") && at < raw.length) at++; };
  const string = (): string => {
    at++;
    let value = "";
    while (at < raw.length) {
      const char = raw[at++]!;
      if (char === '"') break;
      if (char !== "\\") { value += char; continue; }
      const escaped = raw[at];
      if (!escaped) break;
      const length = escaped === "u" ? 5 : 1;
      if (at + length > raw.length) { at = raw.length; break; }
      try { value += JSON.parse(`"\\${raw.slice(at, at + length)}"`); } catch { at = raw.length; break; }
      at += length;
    }
    // A streamed surrogate pair must not briefly render as a replacement glyph.
    return value.replace(/[\uD800-\uDBFF]$/, "");
  };
  const value = (depth: number): unknown => {
    space();
    if (depth > 24 || at >= raw.length) return undefined;
    if (raw[at] === '"') return string();
    const array = raw[at] === "[";
    if (array || raw[at] === "{") {
      at++;
      const items: unknown[] = [];
      const fields: Record<string, unknown> = Object.create(null);
      while (at < raw.length) {
        space();
        if (raw[at] === (array ? "]" : "}")) { at++; break; }
        let key: string | undefined;
        if (!array) {
          if (raw[at] !== '"') break;
          key = string(); space();
          if (raw[at++] !== ":") break;
        }
        const start = at;
        const next = value(depth + 1);
        if (next !== undefined) { if (array) items.push(next); else fields[key!] = next; }
        if (at === start) break;
        space();
        if (raw[at] !== ",") { if (raw[at] === (array ? "]" : "}")) at++; break; }
        at++;
      }
      return array ? items : fields;
    }
    const token = raw.slice(at).match(/^(true|false|null|-?\d+(?:\.\d+)?)/)?.[0];
    if (token) { at += token.length; return JSON.parse(token); }
    return undefined;
  };
  const result = value(0);
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
}

export function proposedDiff(name: string, input: Record<string, unknown>): ToolEntry["diff"] {
  if (name === "write_file" && typeof input.content === "string") return { oldText: "", newText: input.content };
  if (name !== "edit_file") return undefined;
  if (Array.isArray(input.edits)) {
    const hunks = input.edits.filter((h): h is Record<string, unknown> => h !== null && typeof h === "object");
    return { oldText: hunks.map((h) => typeof h.oldText === "string" ? h.oldText : "").join("\n…\n"),
      newText: hunks.map((h) => typeof h.newText === "string" ? h.newText : "").join("\n…\n") };
  }
  if (typeof input.newText === "string" || typeof input.oldText === "string") return {
    oldText: typeof input.oldText === "string" ? input.oldText : "", newText: typeof input.newText === "string" ? input.newText : "" };
  return undefined;
}

export const FILE_CHANGE_TOOLS = ["edit_file", "write_file", "move_path", "delete_path"];

/// Grows the drafting card for a tool call the model is still writing, and
/// returns it. File tools also get their partial path and diff; other tools'
/// targets are set by the caller.
export function applyToolDraft(entries: WorkbenchEntry[], payload: Record<string, unknown>, nextId: () => number, at: number): ToolEntry | undefined {
  if (typeof payload.draftId !== "string" || typeof payload.delta !== "string" || typeof payload.name !== "string" || !payload.name) return;
  let tool = entries.findLast((entry): entry is ToolEntry => entry.type === "tool" && entry.draftId === payload.draftId);
  if (tool && !tool.drafting) return;
  if (!tool) {
    tool = { id: nextId(), type: "tool", toolCallId: payload.draftId, draftId: payload.draftId, name: payload.name,
      input: {}, drafting: true, state: "running", phase: "change", startedAt: at };
    entries.push(tool);
  }
  tool.draftArguments = ((tool.draftArguments ?? "") + payload.delta).slice(0, 128 * 1024);
  tool.input = partialToolArguments(tool.draftArguments);
  if (!FILE_CHANGE_TOOLS.includes(tool.name)) return tool;
  tool.detail = typeof tool.input.path === "string" ? tool.input.path
    : typeof tool.input.from === "string" ? `${tool.input.from} → ${tool.input.to ?? "…"}` : "Waiting for file path…";
  tool.diff = proposedDiff(tool.name, tool.input);
  return tool;
}
