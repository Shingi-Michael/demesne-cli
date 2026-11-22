/// Edit in place (Foundry, step 3 after pass 262 C): a deck, a doc or a
/// dashboard you change where it sits. The frame tells what a piece of text
/// said and what it says now (foundry-kit/edit.js); this finds that text in
/// the content (Markdown) and changes only the part you changed, so its
/// formatting, charts and the rest stay as they were. Nothing is saved until
/// Done, which keeps all the changes as one new version, "Edited by you".

/// What changed between two texts: the common start and end, and the middle that differs.
export function changed(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { start, end, was: before.slice(start, before.length - end), now: after.slice(start, after.length - end) };
}

/// Typed text made safe in Markdown: what would turn into formatting is escaped.
export const markdownText = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/[\\`*_[\]<>|]/g, (char) => `\\${char}`);

const CONTEXT = [24, 12, 6, 3, 0];

/// The content with one piece's change made in it, or null when the old text
/// can't be found there exactly once (it was drawn from a chart, or the
/// change crosses formatting). Context around the change picks the right
/// place when the words repeat: the most that matches, on either side.
export function placeEdit(source: string, before: string, after: string): string | null {
  if (before === after) return source;
  const { start, end, was, now } = changed(before, after);
  const tries: [number, number][] = [];
  for (const left of CONTEXT) for (const right of CONTEXT) tries.push([Math.min(left, start), Math.min(right, end)]);
  tries.sort((a, b) => b[0] + b[1] - (a[0] + a[1]));
  const seen = new Set<string>();
  for (const [left, right] of tries) {
    const key = `${left}:${right}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const head = before.slice(start - left, start), tail = before.slice(before.length - end, before.length - end + right);
    const needle = head + was + tail;
    if (!needle.trim()) continue;
    const at = source.indexOf(needle);
    if (at < 0) continue;
    // More than one place: this context can't tell which; another side's might.
    if (source.indexOf(needle, at + 1) >= 0) continue;
    const from = at + head.length;
    return source.slice(0, from) + markdownText(now) + source.slice(from + was.length);
  }
  return null;
}
