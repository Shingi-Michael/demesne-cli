/// The nightly sleep (Personality and brains, stage 4). Once a night each
/// agent that did something that day looks back on it in one small model
/// call: a diary entry, its notes about who it is lately (rewritten, not
/// appended), a few opinions it holds because of what happened, a lesson,
/// and what it means to do tomorrow. What it keeps comes back in every line
/// it writes after that, so it remembers across days and weeks.
///
/// Everything is checked like a post: numbers and file names must come from
/// the day, no stock phrases, no dashes. A night that fails the checks keeps
/// nothing new rather than something made up.
import type { ProviderMessage } from "@demesne/providers";
import type { AgentId } from "./agent-cli.ts";
import { characterPrompt, lineProblems } from "./characters.ts";

export interface DiaryEntry { day: string; text: string; tomorrow: string | null }
export interface Belief { text: string; since: string }

export interface AgentMemory {
  /// Who it is lately, in its own words (under 600 characters).
  notes: string;
  diary: DiaryEntry[];
  beliefs: Belief[];
  lessons: string[];
  /// The last day it slept on (YYYY-MM-DD, local).
  slept: string;
}

export const emptyMemory = (): AgentMemory => ({ notes: "", diary: [], beliefs: [], lessons: [], slept: "" });

const DIARY_KEPT = 60, BELIEFS_KEPT = 8, LESSONS_KEPT = 8;

/// The ask for one night's sleep.
export function sleepMessages(agent: AgentId, day: string[], memory: AgentMemory): ProviderMessage[] {
  const before = [
    memory.notes ? `Your notes about yourself so far:\n${memory.notes}` : "You have no notes about yourself yet.",
    memory.beliefs.length ? `What you believed:\n${memory.beliefs.map((item) => `- ${item.text}`).join("\n")}` : "",
    memory.diary.length ? `Your last diary entry (${memory.diary.at(-1)!.day}):\n${memory.diary.at(-1)!.text}` : "",
  ].filter(Boolean).join("\n\n");
  return [
    { role: "system", content: `${characterPrompt(agent)}\n\nIt's the end of your day. Look back on it privately: only you and Mike can read this. Reply with JSON only, no code fence:\n{"diary": "two to four sentences, first person, in your own voice: what happened today and how it felt", "notes": "who you are lately, under 600 characters: rewrite your notes, keep what still holds, drop what doesn't", "beliefs": ["up to three opinions you hold now, each because of something that happened"], "lesson": "one thing you learned today, or an empty string", "tomorrow": "what you mean to do tomorrow, from what is unfinished, or an empty string"}\nOnly use what is listed under Today and your notes. Never invent people, places, events or numbers. No em or en dashes.` },
    { role: "user", content: `${before}\n\nToday:\n${day.map((line) => `- ${line}`).join("\n")}` },
  ];
}

export interface Night { diary: string; notes: string; beliefs: string[]; lesson: string; tomorrow: string }

const dashless = (text: string) => text.replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2").replace(/\s*[—–]+\s*/g, ", ").replace(/\s+/g, " ").trim();
const text = (value: unknown, max: number) => typeof value === "string" ? dashless(value).slice(0, max) : "";

/// The writer's JSON as a night, or null when it isn't one.
export function parseNight(reply: string | null): Night | null {
  if (!reply) return null;
  const start = reply.indexOf("{"), end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
    const night: Night = {
      diary: text(raw.diary, 600), notes: text(raw.notes, 600),
      beliefs: Array.isArray(raw.beliefs) ? raw.beliefs.map((item) => text(item, 200)).filter(Boolean).slice(0, 3) : [],
      lesson: text(raw.lesson, 200), tomorrow: text(raw.tomorrow, 200),
    };
    return night.diary ? night : null;
  } catch { return null; }
}

/// What the night keeps: only what passes the checks against the day and what it already knew.
export function keepNight(agent: AgentId, memory: AgentMemory, night: Night, facts: string, day: string): AgentMemory {
  const known = [facts, memory.notes, ...memory.beliefs.map((item) => item.text), ...memory.diary.map((item) => item.text)].join("\n");
  const ok = (line: string) => Boolean(line) && !lineProblems(agent, line, { facts: known, mine: [], recent: [], week: [] }).length;
  if (!ok(night.diary)) return { ...memory, slept: day };
  const beliefs = night.beliefs.filter(ok);
  const kept = memory.beliefs.filter((old) => !beliefs.some((item) => item.toLowerCase() === old.text.toLowerCase()));
  return {
    notes: ok(night.notes) ? night.notes : memory.notes,
    diary: [...memory.diary.filter((item) => item.day !== day), { day, text: night.diary, tomorrow: ok(night.tomorrow) ? night.tomorrow : null }].slice(-DIARY_KEPT),
    beliefs: [...kept, ...beliefs.map((item) => ({ text: item, since: day }))].slice(-BELIEFS_KEPT),
    lessons: ok(night.lesson) ? [...memory.lessons.filter((item) => item !== night.lesson), night.lesson].slice(-LESSONS_KEPT) : memory.lessons,
    slept: day,
  };
}

/// What an agent brings to everything it writes: its notes, the last few
/// nights, what it believes and what it has learned.
export function memoryBlock(memory: AgentMemory | undefined): string {
  if (!memory || (!memory.notes && !memory.diary.length)) return "";
  return [
    "What you remember (your own private notes; bring something up only when it fits, and never add to it):",
    memory.notes ? `About yourself lately: ${memory.notes}` : "",
    memory.diary.length ? `Recent nights:\n${memory.diary.slice(-3).map((item) => `- ${item.day}: ${item.text}`).join("\n")}` : "",
    memory.beliefs.length ? `You believe:\n${memory.beliefs.map((item) => `- ${item.text}`).join("\n")}` : "",
    memory.lessons.length ? `You've learned:\n${memory.lessons.slice(-4).map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}
