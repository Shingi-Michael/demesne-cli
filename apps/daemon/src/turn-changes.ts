import type { SnapshotFile } from "@demesne/storage";
import type { TurnChange } from "@demesne/protocol";

/// Builds the change review for one turn from its file snapshots.
///
/// The diff is plain text: the API stays renderer-neutral and the CLI applies
/// color. Output is bounded per file and per turn so a large refactor cannot
/// flood the response.

export interface TurnChangesOptions {
  readCurrent: (path: string) => string | null;
  maxFiles?: number;
  maxDiffLines?: number;
}

export function buildTurnChanges(
  files: readonly SnapshotFile[],
  options: TurnChangesOptions,
): TurnChange[] {
  const maxFiles = Math.max(1, options.maxFiles ?? 50);
  const maxDiffLines = Math.max(2, options.maxDiffLines ?? 60);
  const changes: TurnChange[] = [];
  for (const file of files.slice(0, maxFiles)) {
    const before = decodeText(file.data);
    const current = options.readCurrent(file.path);
    const currentIsBinary = current !== null && current.includes("\0");
    const existedAfter = file.postExisted === null || file.postExisted === undefined
      ? current !== null
      : file.postExisted;
    const after = existedAfter && !currentIsBinary ? current : null;
    const operation: TurnChange["operation"] = !file.existed && existedAfter
      ? "A"
      : file.existed && !existedAfter
        ? "D"
        : "M";
    const binary = before === null || (existedAfter && after === null);
    const change: TurnChange = {
      path: file.path,
      operation,
      reverted: Boolean(file.revertedAt),
      diff: binary ? [] : plainDiffLines(before ?? "", after ?? "", maxDiffLines),
      ...(binary ? { binary: true } : {}),
    };
    changes.push(change);
  }
  return changes;
}

/// Prefix-trimmed line diff with an explicit omission row. No line numbers or
/// hunk headers: the CLI pairs it with the file path and operation badge.
export function plainDiffLines(before: string, after: string, maxLines: number): string[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  if (removed.length === 0 && added.length === 0) return [];

  const lines = [
    ...removed.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`),
  ];
  if (lines.length <= maxLines) return lines;
  const headCount = Math.max(1, Math.ceil(maxLines / 2) - 1);
  const tailCount = Math.max(1, maxLines - headCount - 1);
  return [
    ...lines.slice(0, headCount),
    `… ${lines.length - headCount - tailCount} more lines`,
    ...lines.slice(lines.length - tailCount),
  ];
}

/// Splits text into lines without a phantom trailing empty line for content
/// that ends in a newline.
function splitLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

function decodeText(data: Uint8Array | null): string | null {
  if (!data) return "";
  if (data.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}
