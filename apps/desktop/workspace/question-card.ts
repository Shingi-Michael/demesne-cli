/// What the question card shows, so it is rebuilt only when that changes.
/// The typed reply is saved as the question's draft on every keystroke; the
/// card doesn't show it, so typing doesn't rebuild the card (and replay its
/// appear animation). A saved draft can also come back with its fields in
/// another order, so the key sorts them.
export function questionCardKey(question: { draft?: unknown; draftVersion?: unknown } | undefined): string {
  if (!question) return "";
  const { draft: _draft, draftVersion: _version, ...shown } = question;
  return JSON.stringify(Object.entries(shown).sort(([a], [b]) => a.localeCompare(b)));
}
