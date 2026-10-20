import type { CodeDiffRow } from "@demesne/workbench/change-diff.ts";

/// A note left on one line of a turn's diff. Removed lines are addressed by
/// their old line number, everything else by the new one.
export interface DiffNote { path: string; side: "old" | "new"; line: number; text: string }
export type ReviewRow = CodeDiffRow | { kind: "gap"; text: string };

export const noteKey = (path: string, side: "old" | "new", line: number) => `${path}\u0000${side}\u0000${line}`;

/// The rows a review shows: each change with `context` lines around it, a
/// gap row between distant changes, and at most `limit` rows per file.
export function reviewRows(rows: CodeDiffRow[], context = 3, limit = 400): ReviewRow[] {
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.kind === "added" || row.kind === "removed")
      for (let i = Math.max(0, index - context); i <= Math.min(rows.length - 1, index + context); i++) keep.add(i);
  });
  const out: ReviewRow[] = [];
  let last = -1, shown = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!keep.has(i)) continue;
    if (shown >= limit) {
      out.push({ kind: "gap", text: "longer diff folded" });
      break;
    }
    if (last >= 0 && i !== last + 1) out.push({ kind: "gap", text: "⋯" });
    out.push(rows[i]!);
    last = i;
    shown++;
  }
  return out;
}

/// The notes as the start of the next message: one line per note, in file
/// and line order.
export function notesMessage(notes: DiffNote[]): string {
  if (!notes.length) return "";
  const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.side.localeCompare(b.side));
  const lines = sorted.map((note) => `- \`${note.path}\` ${note.side === "old" ? "removed line" : "line"} ${note.line}: ${note.text.trim()}`);
  return `Notes on the changes:\n${lines.join("\n")}`;
}
