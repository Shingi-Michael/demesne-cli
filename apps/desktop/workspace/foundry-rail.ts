/// Snap to past mockups (pass 209 A). Foundry's long page gets a column of
/// small ticks on its right edge, one per mockup, the one on screen lit in
/// pink. Pointing there opens the ticks into names grouped by day; a click
/// snaps the page to that mockup. ↑ and ↓ step from mockup to mockup, and
/// typing a name narrows the list (Enter snaps to the first match). The
/// rail is the only thing it adds, and nothing on a mockup is pressable.

export interface RailMark {
  /// The artifact, and the version the page shows first for it.
  id: string;
  version: number;
  title: string;
  day: string;
  versions: number;
}

/// One mark per mockup, in page order (its first place on the page is its
/// newest version), each with how many versions the page holds of it.
export function railMarks(order: readonly { id: string; version: number; title: string; day: string }[]): RailMark[] {
  const marks = new Map<string, RailMark>();
  for (const item of order) {
    const mark = marks.get(item.id);
    if (mark) mark.versions++;
    else marks.set(item.id, { ...item, versions: 1 });
  }
  return [...marks.values()];
}

/// Names that match what was typed: every word somewhere in the name.
export function railMatches(marks: readonly RailMark[], query: string): RailMark[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...marks];
  return marks.filter((mark) => { const name = mark.title.toLowerCase(); return words.every((word) => name.includes(word)); });
}

/// The mark after or before the one on screen; stays put at either end.
export function railStep(marks: readonly RailMark[], current: string | null, by: 1 | -1): RailMark | null {
  if (!marks.length) return null;
  const at = marks.findIndex((mark) => mark.id === current);
  if (at < 0) return marks[by > 0 ? 0 : marks.length - 1]!;
  return marks[Math.max(0, Math.min(marks.length - 1, at + by))]!;
}

const h = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/// The rail's inside: a day line where the day changes, then a row per
/// mockup (its name, how many versions, and the tick).
export function railHTML(marks: readonly RailMark[], current: string | null, query = ""): string {
  const shown = railMatches(marks, query);
  let day = "";
  const rows = shown.map((mark) => {
    const head = !query && mark.day !== day ? `<div class="fr-day"><span>${h(mark.day)}</span></div>` : "";
    day = mark.day;
    return `${head}<button type="button" class="fr-tk${mark.id === current ? " on" : ""}" data-rail="${h(mark.id)}" aria-label="${h(`${mark.title}, ${mark.day}`)}"${mark.id === current ? ' aria-current="true"' : ""}>`
      + `<span class="fr-name">${h(mark.title)}<small>${mark.versions} version${mark.versions === 1 ? "" : "s"}</small></span><i aria-hidden="true"></i></button>`;
  }).join("");
  const find = query ? `<div class="fr-find"><span>${h(query)}</span><small>${shown.length ? "Enter to go" : "No mockup by that name"}</small></div>` : "";
  return find + rows;
}
