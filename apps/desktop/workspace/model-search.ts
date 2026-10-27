/// The model picker's search. People type a model the way they say it
/// ("codex gpt 6.1 sol"), while the catalog writes it "GPT-6.1-Sol" under
/// Codex with the id "codex/gpt-6.1-sol". So hyphens, slashes, underscores
/// and colons count as spaces, and every word typed has to appear somewhere
/// in the model's name, provider or id, in any order.

const SPLIT = /[\s\-_/:]+/;

/** The words of a search, lowercased, without separators. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(SPLIT).filter(Boolean);
}

/** Whether every word of the search appears in the text. */
export function matchesWords(text: string, query: string): boolean {
  const words = searchWords(query);
  if (!words.length) return true;
  const hay = text.toLowerCase().split(SPLIT).join(" ");
  return words.every((word) => hay.includes(word));
}

/** The stretches of `text` the search's words cover, as [from, to) pairs
 *  in order and merged, for drawing them in bold. */
export function matchedRanges(text: string, query: string): Array<[number, number]> {
  const lower = text.toLowerCase(), ranges: Array<[number, number]> = [];
  for (const word of searchWords(query))
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) ranges.push([at, at + word.length]);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
