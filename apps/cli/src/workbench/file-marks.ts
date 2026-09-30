import { codeDiff } from "./change-diff.ts";

/// Where a file differs from how it was before the session's first edit
/// (Figma 117:813): lines added or changed, the lines that removals now sit
/// before, and each contiguous edit as one change for `n`/`p` to step through.
export interface FileChangeMarks {
  added: Set<number>;
  /// A removal is marked on the line that now follows it.
  removedBefore: Set<number>;
  /// 1-based current line ranges, in file order.
  changes: { start: number; end: number }[];
}

export function fileChangeMarks(original: string, current: string): FileChangeMarks {
  const marks: FileChangeMarks = { added: new Set(), removedBefore: new Set(), changes: [] };
  if (original === current) return marks;
  const lineCount = current === "" ? 0 : (current.endsWith("\n") ? current.slice(0, -1) : current).split("\n").length;
  let next = 1;
  let block: { start: number; end: number } | null = null;
  const close = () => { if (block) marks.changes.push(block); block = null; };
  for (const row of codeDiff(original, current).rows) {
    if (row.kind === "context") { next = (row.next ?? next) + 1; close(); continue; }
    if (row.kind === "added") {
      const line = row.next ?? next;
      marks.added.add(line);
      block = block ? { start: block.start, end: line } : { start: line, end: line };
      next = line + 1;
    } else if (row.kind === "removed") {
      // Removed at the end of the file: mark the last line instead.
      const at = Math.min(next, Math.max(1, lineCount));
      marks.removedBefore.add(at);
      block ??= { start: at, end: at };
    }
  }
  close();
  return marks;
}
