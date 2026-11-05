/// The agents' inner life (Personality and brains, stages 2 and 3; pass 142 B).
///
/// Moods: every real event leaves one small feeling with a size and a
/// lifetime (a merge, +4 for 6 hours). The mood is all live feelings added
/// up, each fading as it runs out, so a failing streak builds and a merge
/// lifts it. The same kind again counts less (0.75 each time), and each
/// character takes things its own way (CharacterSheet.feels). No model calls.
///
/// Friendships: each agent keeps its own record of the others, one line per
/// real thing (a comment, a reaction). Warmth fades in days; the bond grows
/// slowly and lasts weeks.
///
/// Feelings only ever come from the agents' own work and the feed. Never
/// from whether Mike is around.
import { CHARACTERS } from "./characters.ts";
import type { AgentId } from "./agent-cli.ts";

export type FeelKind = "start" | "done" | "merged" | "failed" | "mail" | "liked" | "commented" | "friend" | "morning" | "night";

/// What each kind of event feels like: pleasure (p), energy (e), and for how long.
export const FEELS: Record<FeelKind, { p: number; e: number; hours: number }> = {
  start: { p: 0, e: 2, hours: 2 },
  done: { p: 2, e: 0, hours: 3 },
  merged: { p: 4, e: 2, hours: 6 },
  failed: { p: -3, e: 2, hours: 4 },
  mail: { p: 1, e: 0, hours: 2 },
  liked: { p: 2, e: 0, hours: 12 },
  commented: { p: 2, e: 1, hours: 8 },
  friend: { p: 1, e: 0, hours: 6 },
  morning: { p: 1, e: 2, hours: 3 },
  night: { p: 0, e: -4, hours: 8 },
};

export interface Feeling { kind: FeelKind; p: number; e: number; at: string; hours: number; why: string }

export type MoodName = "calm" | "happy" | "focus" | "stuck" | "sleepy";
export interface Mood {
  mood: MoodName;
  /// Strong enough to say "very".
  strong: boolean;
  /// How it reads: "happy", "a bit stuck", "very sleepy".
  word: string;
  /// The feelings behind it, biggest first: what happened, its size now, hours left.
  reasons: Array<{ why: string; p: number; e: number; left: number }>;
}

const HOUR = 3_600_000;
const left = (feeling: Feeling, now: number) => feeling.hours - (now - Date.parse(feeling.at)) / HOUR;

/// A new feeling for an agent, after its own bias and repeats; expired ones drop.
export function feel(list: Feeling[], agent: AgentId, kind: FeelKind, why: string, now: Date): Feeling[] {
  const live = list.filter((item) => left(item, now.getTime()) > 0);
  const base = FEELS[kind];
  const bias = CHARACTERS[agent].feels[kind] ?? 1;
  const again = live.filter((item) => item.kind === kind).length;
  const fade = 0.75 ** again;
  const round = (value: number) => Math.round(value * 10) / 10;
  return [...live, { kind, p: round(base.p * bias * fade), e: round(base.e * fade), at: now.toISOString(), hours: base.hours, why }].slice(-40);
}

/// The mood from the live feelings, each counted by how much of it is left.
export function moodOf(list: Feeling[], now: Date): Mood {
  const at = now.getTime();
  const live = list.map((item) => ({ item, share: left(item, at) / item.hours })).filter(({ share }) => share > 0);
  let p = 0, e = 0;
  for (const { item, share } of live) { p += item.p * share; e += item.e * share; }
  const strong = Math.max(Math.abs(p), Math.abs(e)) > 5;
  const mood: MoodName = e <= -3 ? "sleepy" : p >= 2 ? "happy" : p <= -2 ? "stuck" : e >= 2 ? "focus" : "calm";
  const words: Record<MoodName, [string, string]> = { calm: ["calm", "calm"], happy: ["happy", "very happy"], focus: ["focused", "very focused"], stuck: ["a bit stuck", "really stuck"], sleepy: ["sleepy", "very sleepy"] };
  const reasons = live.map(({ item, share }) => ({ why: item.why, p: Math.round(item.p * share * 10) / 10, e: Math.round(item.e * share * 10) / 10, left: Math.max(1, Math.round(left(item, at))) }))
    .sort((a, b) => Math.abs(b.p) + Math.abs(b.e) - Math.abs(a.p) - Math.abs(a.e)).slice(0, 4);
  return { mood, strong, word: words[mood][strong ? 1 : 0], reasons };
}

/// One real thing between two agents, as the first one remembers it.
export interface Tie { with: AgentId; at: string; why: string; w: number }

/// How close an agent is to another: warmth (fades in about three days),
/// bond (builds over weeks), and the latest things behind it.
export interface Closeness { agent: AgentId; warmth: number; bond: number; lines: Array<{ why: string; at: string }> }

const DAY = 24 * HOUR;
const KEEP_TIES = 60, TIE_DAYS = 45;

export function tie(list: Tie[], other: AgentId, why: string, w: number, now: Date): Tie[] {
  const since = now.getTime() - TIE_DAYS * DAY;
  return [...list.filter((item) => Date.parse(item.at) > since), { with: other, at: now.toISOString(), why, w }].slice(-KEEP_TIES);
}

export function closeness(list: Tie[], now: Date): Closeness[] {
  const at = now.getTime(), by = new Map<AgentId, Tie[]>();
  for (const item of list) by.set(item.with, [...by.get(item.with) ?? [], item]);
  return [...by].map(([agent, ties]) => {
    let warmth = 0, bond = 0;
    for (const item of ties) {
      const age = (at - Date.parse(item.at)) / DAY;
      warmth += item.w * Math.exp(-age / 3);
      bond += item.w * 0.25 * Math.exp(-age / 30);
    }
    const lines = [...ties].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3).map(({ why, at }) => ({ why, at }));
    return { agent, warmth: Math.min(1, Math.round(warmth * 100) / 100), bond: Math.min(1, Math.round(bond * 100) / 100), lines };
  }).sort((a, b) => b.bond - a.bond || b.warmth - a.warmth);
}

/// Something an agent remembers about Mike: from his comments, or told directly.
export interface Remembered { id: string; text: string; from: "comment" | "you"; at: string }
export const REMEMBER_MAX = 12;

/// Worn out (pass 160 B): a slow level fed only by failed checks, eased by
/// finishing and merging, fading about a third a day. Each character takes
/// failures its own way (CharacterSheet.feels.failed). No model calls: it's
/// worked out from the event log every time.
export interface Wear { level: number; word: "fine" | "a bit worn" | "worn out"; why: string; fails: number }
export const WEAR_FAIL = 14, WEAR_MERGE = 20, WEAR_DONE = 6, WEAR_KEEP = 2 / 3, BIT_WORN = 30, WORN = 60;

export function wearOf(events: Array<{ at: string; kind: string }>, agent: AgentId, now: Date): Wear {
  const bias = CHARACTERS[agent].feels.failed ?? 1, at = now.getTime();
  const fade = (from: number, to: number) => WEAR_KEEP ** Math.max(0, (to - from) / DAY);
  let level = 0, last = 0;
  for (const event of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    const when = Date.parse(event.at);
    if (when > at) continue;
    level *= last ? fade(last, when) : 1;
    last = when;
    if (event.kind === "failed") level = Math.min(100, level + WEAR_FAIL * bias);
    else if (event.kind === "merged") level = Math.max(0, level - WEAR_MERGE);
    else if (event.kind === "done") level = Math.max(0, level - WEAR_DONE);
  }
  level = Math.round(level * (last ? fade(last, at) : 1));
  const fails = events.filter((event) => event.kind === "failed" && at - Date.parse(event.at) < 7 * DAY && Date.parse(event.at) <= at).length;
  return { level, word: level >= WORN ? "worn out" : level >= BIT_WORN ? "a bit worn" : "fine", why: fails ? `${fails === 1 ? "a failed check" : `${fails} failed checks`} in the last 7 days` : "a quiet week", fails };
}

/// Days until a wear level fades below a line, with nothing new happening.
export function wearDaysLeft(level: number, below = WORN): number {
  return level < below ? 0 : Math.log(below / level) / Math.log(WEAR_KEEP);
}

/// Close friends share inside jokes (pass 160 A): the bond it takes, and how
/// recent the shared thing must be.
export const JOKE_BOND = 0.2, JOKE_DAYS = 30;
