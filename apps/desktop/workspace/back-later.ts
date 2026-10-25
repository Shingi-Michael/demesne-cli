/// Bring it back later (pass 76 E): the times a chat can leave the list
/// until. A few plain words, not a date picker.

export interface BackChoice { label: string; at: string }

const at = (day: Date, hour: number) => { const date = new Date(day); date.setHours(hour, 0, 0, 0); return date; };

/// `pr` is the chat's open pull request number, for "when #N merges".
export function backChoices(now = new Date(), pr?: number): BackChoice[] {
  const choices: BackChoice[] = [{ label: "in an hour", at: new Date(now.getTime() + 3_600_000).toISOString() }];
  if (now.getHours() < 19) choices.push({ label: "tonight", at: at(now, 20).toISOString() });
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  choices.push({ label: "tomorrow 9:00", at: at(tomorrow, 9).toISOString() });
  // Next Monday, unless that is tomorrow.
  const monday = new Date(now); monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  if (monday.toDateString() !== tomorrow.toDateString()) choices.push({ label: "Monday", at: at(monday, 9).toISOString() });
  if (pr) choices.push({ label: `when #${pr} merges`, at: "merge" });
  return choices;
}

/// A chat waiting to come back stays off the list; one that is due leads it.
/// "merge" waits for the chat's pull request to merge.
export function backState(backAt: string | null | undefined, now = Date.now(), merged = false): "away" | "back" | null {
  if (!backAt) return null;
  if (backAt === "merge") return merged ? "back" : "away";
  return Date.parse(backAt) > now ? "away" : "back";
}
