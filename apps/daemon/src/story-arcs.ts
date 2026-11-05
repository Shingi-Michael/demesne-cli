/// Stories from what really happened (Personality and brains, stage 5,
/// pass 149 B). The day's real events (chats started, finished, merged,
/// stuck, mail answered, files changed) are kept as a small log, and plain
/// rules look in it for shapes people tell stories about. No model call
/// finds them and no words are made up: every beat is a real event, at its
/// real time, in words taken from the event.
///
/// The shapes:
/// - Stuck, then the breakthrough: stuck at least twice, then finished in the same chat.
/// - A streak: three or more finished in a row with nothing stuck between.
/// - Same file: two agents changed one file on the same day.
/// - A helping hand: an agent answered another's mail, and the other then finished.
/// - Back at it: a chat picked up again after two quiet days.
///
/// Each found arc has a score (how big, how recent). Only the best one or
/// two a day become stories, and the same shape for the same agent rests a
/// couple of days before it can come back. On Friday each agent writes its
/// week as a short chapter from its diary and these arcs (chapterMessages),
/// and the reel shows the week's arcs instead of a made up scene.
import type { ProviderMessage } from "@demesne/providers";
import type { AgentId } from "./agent-cli.ts";
import { characterPrompt } from "./characters.ts";

export type ArcEventKind = "start" | "done" | "merged" | "failed" | "mail" | "file";
export interface ArcEvent {
  at: string; by: AgentId; kind: ArcEventKind;
  sessionId: string;
  /// What the chat was about, or the mail's words, or the file's path.
  title: string;
  /// For mail: who sent it.
  with?: AgentId;
}

export type ArcShape = "breakthrough" | "streak" | "same-file" | "helping-hand" | "back-at-it";
export const ARC_NAMES: Record<ArcShape, string> = {
  breakthrough: "Stuck, then the breakthrough",
  streak: "A streak",
  "same-file": "Same file",
  "helping-hand": "A helping hand",
  "back-at-it": "Back at it",
};

export type BeatMood = "calm" | "happy" | "focus" | "stuck" | "sleepy" | "wave";
export interface Beat { at: string; text: string; mood: BeatMood; sessionId: string }

export interface Arc {
  /// The same arc found twice has the same key.
  key: string;
  shape: ArcShape;
  by: AgentId;
  with?: AgentId;
  /// When its last beat happened.
  at: string;
  score: number;
  /// The whole arc in one plain sentence (for the reel and the chapter).
  text: string;
  beats: Beat[];
}

/// An arc that became stories, kept for the week's chapter and the reel.
export interface ToldArc { key: string; shape: ArcShape; by: AgentId; with?: AgentId; at: string; told: string; text: string; beats: Beat[]; score?: number }

/// The log keeps two weeks; arcs end within the last day.
export const EVENTS_KEPT_DAYS = 14;
const ARC_WINDOW_HOURS = 24;
/// A breakthrough is told when the fix came within this long of the first stuck.
const BREAKTHROUGH_HOURS = 12;
const HELP_HOURS = 3;
const QUIET_DAYS = 2;
const STREAK = 3;
/// The same shape for the same agent rests this long before it can be told again.
export const ARC_COOLDOWN_HOURS = 48;
/// Arcs told a day, and the score an arc needs before the evening.
export const ARCS_A_DAY = 2;
export const ARC_GOOD = 5;
export const ARC_EVENING_HOUR = 18;

const H = 3_600_000;
const ms = (at: string) => Date.parse(at);
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
const base = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const minutes = (from: string, to: string) => Math.max(1, Math.round((ms(to) - ms(from)) / 60_000));
const finished = (event: ArcEvent) => event.kind === "done" || event.kind === "merged";
const day = (at: string) => { const date = new Date(at); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; };

/// Every arc that ends within the last day, best first.
export function findArcs(events: ArcEvent[], now: Date, nameOf: (id: AgentId) => string): Arc[] {
  const since = now.getTime() - ARC_WINDOW_HOURS * H;
  const sorted = [...events].filter((event) => ms(event.at) <= now.getTime()).sort((a, b) => a.at.localeCompare(b.at));
  const recent = (at: string) => ms(at) > since;
  const arcs: Arc[] = [];

  // Stuck, then the breakthrough: per chat, two or more stuck, then finished.
  const bySession = new Map<string, ArcEvent[]>();
  for (const event of sorted) if (event.sessionId) bySession.set(event.sessionId, [...bySession.get(event.sessionId) ?? [], event]);
  for (const [sessionId, list] of bySession) {
    let stuck: ArcEvent[] = [];
    for (const event of list) {
      if (event.kind === "failed") { stuck = [...stuck.filter((item) => ms(event.at) - ms(item.at) < BREAKTHROUGH_HOURS * H), event]; continue; }
      if (!finished(event)) continue;
      const fails = stuck.filter((item) => item.by === event.by);
      stuck = [];
      if (fails.length < 2 || !recent(event.at)) continue;
      const first = fails[0]!, last = fails.at(-1)!, title = clip(event.title || first.title, 70);
      const merged = event.kind === "merged";
      arcs.push({
        key: `breakthrough:${sessionId}:${event.at}`, shape: "breakthrough", by: event.by, at: event.at,
        score: 6 + Math.min(fails.length, 4),
        text: `${nameOf(event.by)} got stuck on ${title} ${fails.length} times, then ${merged ? "merged it" : "finished it"} ${minutes(first.at, event.at)} minutes later.`,
        beats: [
          { at: first.at, text: `Stuck on ${title}.`, mood: "stuck", sessionId },
          { at: last.at, text: fails.length > 2 ? `Stuck again. That's ${fails.length} tries.` : "Still stuck. Same chat, same problem.", mood: "stuck", sessionId },
          { at: event.at, text: merged ? `Got it. Merged ${title}.` : `Got it. ${title}, done.`, mood: "happy", sessionId },
        ],
      });
    }
  }

  // A streak: per agent, three or more finished with nothing stuck between, on one day.
  const byAgent = new Map<AgentId, ArcEvent[]>();
  for (const event of sorted) if (finished(event) || event.kind === "failed") byAgent.set(event.by, [...byAgent.get(event.by) ?? [], event]);
  for (const [agent, list] of byAgent) {
    let run: ArcEvent[] = [];
    const close = () => {
      if (run.length >= STREAK && recent(run.at(-1)!.at)) {
        const last = run.at(-1)!, shown = run.slice(-3);
        arcs.push({
          key: `streak:${agent}:${run[0]!.at}`, shape: "streak", by: agent, at: last.at,
          score: 3 + Math.min(run.length, 6),
          text: `${nameOf(agent)} finished ${run.length} things in a row with nothing stuck: ${shown.map((event) => clip(event.title, 40)).join(", ")}.`,
          beats: shown.map((event, index) => ({ at: event.at, sessionId: event.sessionId, mood: "happy" as const,
            text: index === shown.length - 1 ? `${clip(event.title, 60)}. That's ${run.length} in a row.` : `${clip(event.title, 60)}, done.` })),
        });
      }
      run = [];
    };
    for (const event of list) {
      if (event.kind === "failed" || (run.length && day(run[0]!.at) !== day(event.at))) close();
      if (finished(event)) run.push(event);
    }
    close();
  }

  // Same file: two agents changed one file on the same day.
  const files = sorted.filter((event) => event.kind === "file" && event.title);
  const seenFile = new Set<string>();
  for (const second of files) {
    if (!recent(second.at)) continue;
    const first = files.find((event) => event.title === second.title && event.by !== second.by && day(event.at) === day(second.at) && event.at < second.at);
    const key = `same-file:${second.title}:${day(second.at)}`;
    if (!first || seenFile.has(key)) continue;
    seenFile.add(key);
    const name = base(second.title);
    arcs.push({
      key, shape: "same-file", by: first.by, with: second.by, at: second.at, score: 4,
      text: `${nameOf(first.by)} and ${nameOf(second.by)} both changed ${name} today, ${minutes(first.at, second.at)} minutes apart.`,
      beats: [
        { at: first.at, text: `Changed ${name}.`, mood: "focus", sessionId: first.sessionId },
        { at: second.at, text: `${nameOf(second.by)} was in ${name} too. Small world.`, mood: "calm", sessionId: second.sessionId },
      ],
    });
  }

  // A helping hand: an agent answered another's mail, and the other then finished.
  for (const mail of sorted) {
    if (mail.kind !== "mail" || !mail.with || mail.with === mail.by) continue;
    const after = sorted.find((event) => event.by === mail.with && finished(event) && event.at > mail.at && ms(event.at) - ms(mail.at) <= HELP_HOURS * H);
    if (!after || !recent(after.at)) continue;
    const other = nameOf(mail.with);
    arcs.push({
      key: `helping-hand:${mail.by}:${mail.at}`, shape: "helping-hand", by: mail.by, with: mail.with, at: after.at, score: 5,
      text: `${nameOf(mail.by)} answered ${other}'s mail, and ${minutes(mail.at, after.at)} minutes later ${other} ${after.kind === "merged" ? "merged" : "finished"} ${clip(after.title, 60)}.`,
      beats: [
        { at: mail.at, text: mail.title ? `${other} asked about ${clip(mail.title, 80)}.` : `${other} sent me a question.`, mood: "calm", sessionId: mail.sessionId },
        { at: after.at, text: `${other} ${after.kind === "merged" ? "merged" : "finished"} ${clip(after.title, 60)} right after. Glad I could help.`, mood: "happy", sessionId: after.sessionId },
      ],
    });
  }

  // Back at it: a chat picked up after two quiet days.
  for (const [sessionId, list] of bySession) {
    for (let index = 1; index < list.length; index++) {
      const event = list[index]!, before = list[index - 1]!;
      if ((event.kind !== "start" && !finished(event)) || !recent(event.at)) continue;
      const quiet = Math.floor((ms(event.at) - ms(before.at)) / (24 * H));
      if (quiet < QUIET_DAYS) continue;
      arcs.push({
        key: `back-at-it:${sessionId}:${event.at}`, shape: "back-at-it", by: event.by, at: event.at,
        score: 2 + Math.min(quiet, 6) / 2,
        text: `${nameOf(event.by)} picked up ${clip(event.title, 60)} again after ${quiet} quiet days.`,
        beats: [{ at: event.at, text: `Back on ${clip(event.title, 70)} after ${quiet} quiet days.`, mood: "focus", sessionId }],
      });
    }
  }

  // Newer counts a little more: a point every twelve hours.
  for (const arc of arcs) arc.score = Math.round((arc.score - (now.getTime() - ms(arc.at)) / (12 * H)) * 10) / 10;
  return arcs.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
}

/// The arc to tell now, if any: not told before, its shape rested for this
/// agent, at most two a day, and good enough (or the best left by evening).
export function arcToTell(arcs: Arc[], told: ToldArc[], now: Date): Arc | null {
  const today = told.filter((item) => day(item.told) === day(now.toISOString()));
  if (today.length >= ARCS_A_DAY) return null;
  const fresh = arcs.filter((arc) => !told.some((item) => item.key === arc.key
    || (item.shape === arc.shape && item.by === arc.by && now.getTime() - ms(item.told) < ARC_COOLDOWN_HOURS * H)));
  const best = fresh[0];
  if (!best) return null;
  return best.score >= ARC_GOOD || now.getHours() >= ARC_EVENING_HOUR ? best : null;
}

/// What the reel's video shows for the week's best arc: something the
/// friends really went through, in a scene with no screens or words.
export function arcScene(arc: Pick<ToldArc, "shape" | "by" | "with">, nameOf: (id: AgentId) => string): string {
  const one = nameOf(arc.by), two = arc.with ? nameOf(arc.with) : "a friend";
  const scenes: Record<ArcShape, string> = {
    breakthrough: `${one} wrestles with a stubborn problem late at the desk, then jumps up and celebrates when it finally works while the others cheer`,
    "helping-hand": `${one} leans over to help ${two} with a tricky question, and a moment later ${two} lights up and gives a thank you wave`,
    streak: `${one} works through a happy, steady afternoon, ticking things off one after another with a little nod each time`,
    "same-file": `${one} and ${two} reach for the same notebook at the same moment and both laugh`,
    "back-at-it": `${one} comes back to an unfinished project after a short break, rolls up their sleeves and smiles`,
  };
  return `${scenes[arc.shape]}, three adult friends in a cosy studio under cherry blossom`;
}

export interface Chapter { week: string; title: string; text: string; shapes: ArcShape[]; at: string }

/// The Friday ask: the agent's week as a short chapter, from its diary and
/// the week's arcs, in its own voice.
export function chapterMessages(agent: AgentId, diary: string[], arcs: ToldArc[], posts: string[]): ProviderMessage[] {
  return [
    { role: "system", content: `${characterPrompt(agent)}\n\nIt's Friday. Write your week as a short chapter for your profile: a title of two to seven words, and two to four sentences, first person, in your own voice, about what the week was really about. Reply with JSON only, no code fence: {"title": "...", "text": "..."}\nOnly use what is listed. Never invent people, places, events, files or numbers. No em or en dashes.` },
    { role: "user", content: [
      arcs.length ? `The week's stories:\n${arcs.map((arc) => `- ${arc.text}`).join("\n")}` : "",
      diary.length ? `Your diary this week:\n${diary.map((line) => `- ${line}`).join("\n")}` : "",
      posts.length ? `Your posts this week:\n${posts.map((line) => `- ${line}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n") },
  ];
}

/// The writer's JSON as a chapter's title and words, or null.
export function parseChapter(reply: string | null): { title: string; text: string } | null {
  if (!reply) return null;
  const start = reply.indexOf("{"), end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
    const flat = (value: unknown, max: number) => typeof value === "string" ? value.replace(/\s*[—–]+\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, max) : "";
    const title = flat(raw.title, 80).replace(/[.]+$/, ""), text = flat(raw.text, 700);
    return title && text ? { title, text } : null;
  } catch { return null; }
}
