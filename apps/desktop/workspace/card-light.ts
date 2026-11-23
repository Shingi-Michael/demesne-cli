/// The cards in the pill's glass (pass 271 A). At rest a card is one quiet
/// line, as before: the cards are never the focus of the chat. The card you
/// open lifts into the pill's silver glass with a still edge. When what a
/// card says changes (another file changed, an agent arrived), that card
/// takes the glass for one lap of silver light, the way a sidebar row does
/// when its chat finishes, then settles back to its line.
///
/// Read more: https://www.nngroup.com/articles/progressive-disclosure/ (the
/// detail shows when you reach for it) and
/// https://www.nngroup.com/articles/change-blindness-definition/ (a change at
/// the edge of the screen needs a little motion to be seen).

export const CARD_LAP_MS = 6000;
/// Cards whose words change all the time (the context meter while the chat
/// streams) or only echo the others (Where's "N uncommitted" moves with
/// Changes) never light.
const QUIET = new Set(["where", "context"]);

/// The words on a card's line: what the card says when it is folded.
export const cardWords = (head: Element | null | undefined) => (head?.textContent ?? "").replace(/\s+/g, " ").trim();

/// Whether a card's news is worth one lap: it was already on screen, it says
/// something new, and it isn't a quiet card.
export function cardNews(key: string, before: string | undefined, now: string): boolean {
  return before !== undefined && before !== "" && now !== "" && before !== now && !QUIET.has(key);
}
