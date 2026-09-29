import { highlightCode, languageForPath, sanitizeTerminalLine, type CodeHighlightState, type Painter } from "@demesne/brand";
import type { CodeDiffRow } from "./change-diff.ts";

/// Lex the original sides independently, including hidden context. A removed
/// comment opener must never recolor added code, and a hunk inside a multiline
/// comment/string still needs the state established before its visible rows.
export function diffSyntax(path: string, before: string, after: string, rows: readonly CodeDiffRow[], paint: Painter): Map<CodeDiffRow, string> {
  const language = languageForPath(path);
  const output = new Map<CodeDiffRow, string>();
  const clean = (line: string) => sanitizeTerminalLine(line.replaceAll("\t", "  "));
  if (!paint.enabled || !language) {
    for (const row of rows) if (row.kind !== "gap") output.set(row, clean(row.text));
    return output;
  }
  for (const side of ["old", "next"] as const) {
    const wanted = new Map<number, CodeDiffRow>();
    for (const row of rows) if ((side === "old" ? row.kind === "removed" : row.kind === "added" || row.kind === "context") && row[side] !== undefined) wanted.set(row[side]!, row);
    if (!wanted.size) continue;
    let last = 0;
    for (const number of wanted.keys()) last = Math.max(last, number);
    const lines = (side === "old" ? before : after).split("\n");
    const state: CodeHighlightState = { inBlockComment: false };
    for (let line = 1; line <= last && line <= lines.length; line++) {
      const styled = highlightCode(clean(lines[line - 1]!), language, paint, state);
      const row = wanted.get(line);
      if (row) output.set(row, styled);
    }
  }
  return output;
}
