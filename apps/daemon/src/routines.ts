import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Routine } from "@demesne/protocol";

/// Routines: chats that start on their own. Each is one sentence, "Every
/// weekday at 8:30, summarize what Drive finished overnight": when, then
/// what. At its time the daemon opens a chat in the routine's project with
/// the what as its first message, whether or not a window is open.

/// A slot missed while the computer slept still runs when it wakes, within
/// this long; older ones wait for the next.
const LATE_HOURS = 12;
const RUNS_KEPT = 20;
const DAY_NAMES = ["sun", "mon", "tues", "wednes", "thurs", "fri", "satur"];
const DAY_WORDS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_WORDS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

export interface RoutineWhen { days: number[]; at: string }

/// The when and the what of a routine sentence, or why it couldn't be read.
export function parseRoutine(sentence: string): (RoutineWhen & { prompt: string }) | { error: string } {
  // When comes first: with a comma, only the words before it are read for
  // the time, so the task itself can say "on Fridays" freely.
  const whole = sentence.trim().replace(/\s+/g, " "), comma = whole.indexOf(",");
  let text = ` ${comma > 0 ? whole.slice(0, comma) : whole} `;
  const rest = comma > 0 ? whole.slice(comma + 1) : "";
  const take = (pattern: RegExp) => {
    const match = text.match(pattern);
    if (match) text = text.replace(match[0], " ");
    return match;
  };
  let days: number[] | null = null;
  let fallbackHour: number | null = null;
  const day = `(?:${DAY_NAMES.join("|")})days?`;
  const named = take(new RegExp(`\\b(?:every|each|on)?\\s*(${day}(?:\\s*(?:,|and|&)\\s*${day})*)\\b`, "i"));
  if (named) days = [...new Set(named[1]!.toLowerCase().match(new RegExp(day, "g"))!.map((word) => DAY_NAMES.findIndex((name) => word.startsWith(name))))].sort();
  else if (take(/\b(?:every|on)?\s*weekdays?\b/i)) days = [1, 2, 3, 4, 5];
  else if (take(/\b(?:every|on)?\s*weekends?\b/i)) days = [0, 6];
  else {
    const daily = take(/\b(?:every|each) (day|morning|evening|night)\b|\bdaily\b|\bnightly\b/i);
    if (daily) {
      days = [0, 1, 2, 3, 4, 5, 6];
      const part = (daily[1] ?? daily[0]).toLowerCase();
      fallbackHour = part === "morning" ? 9 : part === "evening" ? 18 : part === "night" || part === "nightly" ? 22 : null;
    }
  }
  let at: string | null = null;
  const noon = take(/\b(?:at )?(noon|midnight)\b/i);
  if (noon) at = noon[1]!.toLowerCase() === "noon" ? "12:00" : "00:00";
  else {
    const time = take(/\b(?:at )(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=[\s,.;:!?])/i) ?? take(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?=[\s,.;:!?])/i);
    if (time) {
      let hour = Number(time[1]), minute = Number(time[2] ?? 0);
      const half = time[3]?.toLowerCase().replace(/\./g, "");
      if (half === "pm" && hour < 12) hour += 12;
      else if (half === "am" && hour === 12) hour = 0;
      // A bare 1 to 6 is the afternoon: nobody schedules work for 5 a.m. by saying "at 5".
      else if (!half && hour >= 1 && hour <= 6) hour += 12;
      if (hour > 23 || minute > 59) return { error: "That time doesn't exist. Try “at 9” or “at 17:30”." };
      at = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }
  if (!days && !at) return { error: "Say when first, like “Every weekday at 9, …” or “Every Monday at 17:00, …”." };
  const prompt = `${text} ${rest}`.replace(/\s+/g, " ").replace(/^[\s,.;:–—-]+|[\s,;:–—-]+$/g, "").replace(/^(?:then|and)\s+/i, "");
  if (!prompt) return { error: "Say what to do after when, like “Every weekday at 9, list the PRs waiting on me”." };
  return { days: days ?? [0, 1, 2, 3, 4, 5, 6], at: at ?? `${String(fallbackHour ?? 9).padStart(2, "0")}:00`, prompt: prompt[0]!.toUpperCase() + prompt.slice(1) };
}

/// "Weekdays · 8:30", "Every day · 9:00", "Mon, Thu · 17:00".
export function whenWords(when: RoutineWhen) {
  const days = [...when.days].sort().join(",");
  const word = days === "0,1,2,3,4,5,6" ? "Every day" : days === "1,2,3,4,5" ? "Weekdays" : days === "0,6" ? "Weekends"
    : when.days.length === 1 ? DAYS_WORDS[when.days[0]!]
    : [...when.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((index) => DAY_WORDS[index]).join(", ");
  return `${word} · ${when.at.replace(/^0(\d)/, "$1")}`;
}

/// The latest time this routine was due at or before `now`, in local time.
export function lastSlot(when: RoutineWhen, now: Date): Date | null {
  const [hour, minute] = when.at.split(":").map(Number) as [number, number];
  for (let back = 0; back < 8; back++) {
    const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, hour, minute);
    if (slot.getTime() <= now.getTime() && when.days.includes(slot.getDay())) return slot;
  }
  return null;
}

export function nextSlot(when: RoutineWhen, now: Date): Date | null {
  const [hour, minute] = when.at.split(":").map(Number) as [number, number];
  for (let ahead = 0; ahead < 8; ahead++) {
    const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead, hour, minute);
    if (slot.getTime() > now.getTime() && when.days.includes(slot.getDay())) return slot;
  }
  return null;
}

export interface RoutinesHost {
  trusted(workspace: string): boolean;
  /// Opens the routine's chat with its first message; returns the chat's id.
  start(routine: Routine): string;
}

export class Routines {
  private items: Routine[];
  constructor(private readonly file: string, private readonly host: RoutinesHost, private readonly now = () => Date.now()) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { routines?: Routine[] };
      this.items = Array.isArray(saved.routines) ? saved.routines : [];
    } catch { this.items = []; }
  }

  list(): Routine[] {
    const now = new Date(this.now());
    return this.items.map((routine) => ({ ...routine, when: whenWords(routine), next: nextSlot(routine, now)?.toISOString() ?? null }));
  }

  add(text: string, workspace: string | null): Routine | { error: string } {
    const parsed = parseRoutine(text);
    if ("error" in parsed) return parsed;
    if (workspace && !this.host.trusted(workspace)) return { error: "Trust this folder before giving it routines." };
    const routine: Routine = { id: crypto.randomUUID(), text: text.trim(), prompt: parsed.prompt, days: parsed.days, at: parsed.at, workspace, on: true, createdAt: new Date(this.now()).toISOString(), runs: [] };
    this.items.push(routine);
    this.save();
    return this.list().find((item) => item.id === routine.id)!;
  }

  set(id: string, on: boolean): Routine | null {
    const routine = this.items.find((item) => item.id === id);
    if (!routine) return null;
    routine.on = on;
    // Turning one back on starts from now, not from the slots it was off for.
    if (on) routine.resumedAt = new Date(this.now()).toISOString();
    this.save();
    return this.list().find((item) => item.id === id)!;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  /// Starts every routine whose time has come since it last ran. Returns their ids.
  tick(): string[] {
    const now = new Date(this.now()), started: string[] = [];
    for (const routine of this.items) {
      if (!routine.on || (routine.workspace && !this.host.trusted(routine.workspace))) continue;
      const slot = lastSlot(routine, now);
      if (!slot || now.getTime() - slot.getTime() > LATE_HOURS * 3_600_000) continue;
      const since = Math.max(...[routine.createdAt, routine.resumedAt, routine.runs.at(-1)?.at].filter((at): at is string => Boolean(at)).map(Date.parse));
      if (slot.getTime() <= since) continue;
      let sessionId: string;
      try { sessionId = this.host.start(routine); } catch { continue; }
      routine.runs = [...routine.runs, { at: now.toISOString(), sessionId }].slice(-RUNS_KEPT);
      started.push(routine.id);
    }
    if (started.length) this.save();
    return started;
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ routines: this.items }, null, 2));
    renameSync(temporary, this.file);
  }
}
