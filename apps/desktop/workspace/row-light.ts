/// A chat's own row says its news (pass 260 A). When a chat you are not
/// looking at finishes, or starts asking you something, its row in the
/// sidebar takes the pill's glass and silver light for a few seconds. The
/// news is that chat's, so it shows on that chat: the row already says
/// "finished" or "asks you" where its time was, and clicking it opens it.
///
/// Read more: https://lawsofux.com/law-of-proximity/ (news sits on the thing
/// it is about) and https://www.nngroup.com/articles/change-blindness-definition/
/// (a change away from where you look needs a little motion to be seen).

export const ROW_LIGHT_MS = 6000;
/// The states that are news: a reply you haven't seen, and a chat that asks.
const NEWS = new Set(["acc", "warn"]);

/// Which rows light up now. `before` is each chat's state at the last draw
/// (empty on the first one, when nothing is news yet); a row lights when its
/// state turns into news while you are elsewhere. Returns the lit rows with
/// when each goes dark, old ones dropped.
export function lightRows(before: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>, selected: string | null, lit: ReadonlyMap<string, number>, at: number): Map<string, number> {
  const next = new Map<string, number>();
  for (const [id, until] of lit) if (until > at && id !== selected && NEWS.has(now.get(id) ?? "")) next.set(id, until);
  if (!before.size) return next;
  for (const [id, tone] of now) {
    if (id === selected || !NEWS.has(tone) || before.get(id) === tone || !before.has(id)) continue;
    next.set(id, at + ROW_LIGHT_MS);
  }
  return next;
}
