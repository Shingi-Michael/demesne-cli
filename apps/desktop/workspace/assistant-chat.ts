/// The assistant's one chat reads as days: the first turn of each day
/// carries a quiet line saying which day it was.

const DAY = 86_400_000;
const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/// "Today", "Yesterday", a weekday within the week, then the date.
export function dayWords(at: string, now = new Date()): string {
  const then = new Date(at), days = Math.round((midnight(now) - midnight(then)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString([], { weekday: "long" });
  return then.toLocaleDateString([], { day: "numeric", month: "long", ...(then.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

/// The day line over a turn, or "" when the turn before it was the same day.
export function dayLine(at: string, before: string | undefined, now = new Date()): string {
  if (before && midnight(new Date(before)) === midnight(new Date(at))) return "";
  return dayWords(at, now);
}
