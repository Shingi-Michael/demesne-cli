export interface CodeDiffRow { kind: "context" | "added" | "removed" | "gap"; text: string; old?: number; next?: number }
export interface CodeDiff { rows: CodeDiffRow[]; added: number; removed: number }

const lines = (text: string): string[] => text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

/// Patience anchors keep distant edits separate. Small ambiguous blocks use
/// LCS; large ambiguous blocks fall back to an exact replacement, bounding work
/// even for generated files with thousands of identical lines.
export function codeDiff(before: string, after: string): CodeDiff {
  const a = lines(before), b = lines(after);
  const rows: CodeDiffRow[] = [];
  let added = 0, removed = 0;
  const same = (x: number, y: number) => rows.push({ kind: "context", text: a[x]!, old: x + 1, next: y + 1 });
  const del = (x: number) => { removed++; rows.push({ kind: "removed", text: a[x]!, old: x + 1 }); };
  const ins = (y: number) => { added++; rows.push({ kind: "added", text: b[y]!, next: y + 1 }); };
  const walk = (x: number, endX: number, y: number, endY: number, depth: number): void => {
    while (x < endX && y < endY && a[x] === b[y]) same(x++, y++);
    let suffix = 0;
    while (x < endX - suffix && y < endY - suffix && a[endX - suffix - 1] === b[endY - suffix - 1]) suffix++;
    const ax = endX - suffix, by = endY - suffix;
    if (x < ax && y < by && depth < 24) {
      const unique = (source: string[], start: number, end: number) => {
        const map = new Map<string, number>();
        for (let i = start; i < end; i++) map.set(source[i]!, map.has(source[i]!) ? -1 : i);
        return map;
      };
      const left = unique(a, x, ax), right = unique(b, y, by);
      const pairs = [...left].filter(([text, index]) => index >= 0 && (right.get(text) ?? -1) >= 0).map(([text, index]) => [index, right.get(text)!] as const);
      const tails: number[] = [], previous: number[] = [];
      for (let i = 0; i < pairs.length; i++) {
        let low = 0, high = tails.length;
        while (low < high) { const mid = (low + high) >>> 1; if (pairs[tails[mid]!]![1] < pairs[i]![1]) low = mid + 1; else high = mid; }
        previous[i] = low ? tails[low - 1]! : -1; tails[low] = i;
      }
      const anchors: (readonly [number, number])[] = [];
      for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]!) anchors.push(pairs[i]!);
      if (anchors.length) {
        for (const [xx, yy] of anchors.reverse()) { walk(x, xx, y, yy, depth + 1); same(xx, yy); x = xx + 1; y = yy + 1; }
        walk(x, ax, y, by, depth + 1); x = ax; y = by;
      } else if ((ax - x) * (by - y) <= 40_000) {
        const w = by - y + 1, h = ax - x + 1;
        const table = new Uint32Array(w * h);
        for (let i = h - 2; i >= 0; i--) for (let j = w - 2; j >= 0; j--)
          table[i * w + j] = a[x + i] === b[y + j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
        let i = 0, j = 0;
        while (i < h - 1 && j < w - 1) {
          if (a[x + i] === b[y + j]) same(x + i++, y + j++);
          else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) del(x + i++); else ins(y + j++);
        }
        x += i; y += j;
      }
    }
    while (x < ax) del(x++);
    while (y < by) ins(y++);
    for (let i = 0; i < suffix; i++) same(ax + i, by + i);
  };
  walk(0, a.length, 0, b.length, 0);
  // Keep newline-only changes visible too.
  if (before !== after && before.endsWith("\n") !== after.endsWith("\n")) rows.push({ kind: "gap", text: after.endsWith("\n") ? "Final newline added" : "No newline at end of file" });
  const visible: CodeDiffRow[] = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i]!.kind !== "context") { visible.push(rows[i++]!); continue; }
    let end = i;
    while (end < rows.length && rows[end]!.kind === "context") end++;
    const head = i > 0 ? Math.min(3, end - i) : 0;
    const tail = end < rows.length ? Math.min(3, end - i - head) : 0;
    if (end - i <= head + tail + 1) visible.push(...rows.slice(i, end));
    else { visible.push(...rows.slice(i, i + head)); visible.push({ kind: "gap", text: `… ${end - i - head - tail} unchanged lines` }); visible.push(...rows.slice(end - tail, end)); }
    i = end;
  }
  return { rows: before === after ? [] : visible, added, removed };
}
