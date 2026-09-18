export type EditStrategy = "exact" | "lines" | "whitespace";

export interface EditHunk {
  oldText: string;
  newText: string;
  all?: boolean;
}

export interface ApplyEditsRequest {
  current: string;
  hunks: EditHunk[];
}

export interface AppliedEdit {
  content: string;
  strategy: EditStrategy;
  replacements: number;
}

export class EditApplyError extends Error {
  constructor(
    message: string,
    readonly hunkIndex: number,
    readonly strategyAttempted: EditStrategy[],
  ) {
    super(message);
    this.name = "EditApplyError";
  }
}

const STRATEGIES: EditStrategy[] = ["exact", "lines", "whitespace"];

/// Applies ordered hunks to the file contents using progressively tolerant
/// matching: exact substring, trimmed-line window, then whitespace-run folding.
/// Each hunk must resolve unambiguously unless `all` requests every match.
export function applyEdits({ current, hunks }: ApplyEditsRequest): AppliedEdit {
  let working = current;
  let lastStrategy: EditStrategy = "exact";
  let replacements = 0;

  for (const [hunkIndex, hunk] of hunks.entries()) {
    const outcome = applyHunk(working, hunk, hunkIndex);
    working = outcome.content;
    replacements += outcome.replacements;
    lastStrategy = outcome.strategy;
  }

  return { content: working, strategy: lastStrategy, replacements };
}

function applyHunk(
  current: string,
  hunk: EditHunk,
  hunkIndex: number,
): { content: string; strategy: EditStrategy; replacements: number } {
  const exact = findExactMatches(current, hunk.oldText);
  if (exact.count > 0) return replaceByIndices(current, exact.indices, hunk, "exact", hunkIndex);

  const window = findTrimmedLineWindows(current, hunk.oldText);
  if (window.total > 0) return replaceLineWindows(current, window, hunk, "lines", hunkIndex);

  const tolerant = findTolerantRegexMatches(current, hunk.oldText);
  if (tolerant.count > 0) {
    return replaceBySpans(current, tolerant.spans, hunk, "whitespace", hunkIndex);
  }

  throw new EditApplyError("oldText was not found", hunkIndex, STRATEGIES);
}

interface ExactMatch { count: number; indices: number[] }

function findExactMatches(current: string, oldText: string): ExactMatch {
  const indices: number[] = [];
  let index = current.indexOf(oldText);
  while (index !== -1) {
    indices.push(index);
    index = current.indexOf(oldText, index + Math.max(1, oldText.length));
  }
  return { count: indices.length, indices };
}

interface LineWindowMatch {
  total: number;
  windows: Array<{ startLine: number; endLine: number }>;
}

function findTrimmedLineWindows(current: string, oldText: string): LineWindowMatch {
  const contentLines = current.split("\n");
  const pattern = oldText.split("\n").map((line) => line.trim());
  while (pattern.length > 0 && pattern[0] === "") pattern.shift();
  while (pattern.length > 0 && pattern[pattern.length - 1] === "") pattern.pop();
  if (pattern.length === 0 || pattern.length > contentLines.length) {
    return { total: 0, windows: [] };
  }

  const normalizedPattern = pattern.map((line) => line.replace(/\s+/g, " "));
  const windows: Array<{ startLine: number; endLine: number }> = [];
  const upperBound = contentLines.length - pattern.length;
  for (let start = 0; start <= upperBound; start += 1) {
    let matched = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      const candidate = contentLines[start + offset]!.trim().replace(/\s+/g, " ");
      if (candidate !== normalizedPattern[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      windows.push({ startLine: start, endLine: start + pattern.length });
    }
  }
  return { total: windows.length, windows };
}

interface TolerantMatch { count: number; spans: Array<{ start: number; end: number }> }

/// Final fallback: ignore all whitespace on both sides and locate the ordered
/// character sequence, mapping back to the original span it covers. Handles
/// any spacing difference (extra, missing, or reformatted) as a last resort.
function findTolerantRegexMatches(current: string, oldText: string): TolerantMatch {
  if (!oldText.trim()) return { count: 0, spans: [] };

  const strip = (value: string): { text: string; points: Array<{ start: number; end: number }> } => {
    let text = "";
    const points: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < value.length; index += 1) {
      if (/\s/.test(value[index]!)) continue;
      text += value[index];
      points.push({ start: index, end: index + 1 });
    }
    return { text, points };
  };

  const haystack = strip(current);
  const needle = strip(oldText);
  const spans: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (true) {
    const found = haystack.text.indexOf(needle.text, from);
    if (found === -1) break;
    spans.push({
      start: haystack.points[found]!.start,
      end: haystack.points[found + needle.text.length - 1]!.end,
    });
    from = found + Math.max(1, needle.text.length);
  }
  return { count: spans.length, spans };
}

function replaceByIndices(
  current: string,
  indices: number[],
  hunk: EditHunk,
  strategy: EditStrategy,
  hunkIndex: number,
): { content: string; strategy: EditStrategy; replacements: number } {
  if (indices.length > 1 && !hunk.all) {
    throw ambiguity(hunkIndex, strategy, indices.length);
  }
  let content = "";
  let cursor = 0;
  for (const index of indices) {
    content += current.slice(cursor, index) + hunk.newText;
    cursor = index + hunk.oldText.length;
  }
  content += current.slice(cursor);
  return { content, strategy, replacements: indices.length };
}

function replaceLineWindows(
  current: string,
  match: LineWindowMatch,
  hunk: EditHunk,
  strategy: EditStrategy,
  hunkIndex: number,
): { content: string; strategy: EditStrategy; replacements: number } {
  if (match.windows.length > 1 && !hunk.all) {
    throw ambiguity(hunkIndex, strategy, match.windows.length);
  }
  const selected = hunk.all ? match.windows : [match.windows[0]!];
  const lines = current.split("\n");
  for (const window of [...selected].sort((left, right) => right.startLine - left.startLine)) {
    lines.splice(window.startLine, window.endLine - window.startLine, ...hunk.newText.split("\n"));
  }
  return { content: lines.join("\n"), strategy, replacements: selected.length };
}

function replaceBySpans(
  current: string,
  spans: Array<{ start: number; end: number }>,
  hunk: EditHunk,
  strategy: EditStrategy,
  hunkIndex: number,
): { content: string; strategy: EditStrategy; replacements: number } {
  if (spans.length > 1 && !hunk.all) {
    throw ambiguity(hunkIndex, strategy, spans.length);
  }
  let content = "";
  let cursor = 0;
  for (const span of spans) {
    content += current.slice(cursor, span.start) + hunk.newText;
    cursor = span.end;
  }
  content += current.slice(cursor);
  return { content, strategy, replacements: spans.length };
}

function ambiguity(hunkIndex: number, strategy: EditStrategy, occurrences: number): EditApplyError {
  return new EditApplyError(
    `oldText matched ${occurrences} locations; include more surrounding context or set "all": true`,
    hunkIndex,
    [strategy],
  );
}
