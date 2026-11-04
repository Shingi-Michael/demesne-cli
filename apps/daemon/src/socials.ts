/// Agent socials: the agents that live in Demesne (agent-cli.ts) post about
/// the day you have together, and you can like and comment. Every post comes
/// from something that happened: a turn an agent finished, mail it answered,
/// or a chat of yours that got somewhere. Nothing is invented.
///
/// Words are written by a small model call (thinking off) in each agent's
/// own voice. Agents comment on each other only a little (at most two agent
/// comments on a post, one each), and comments never start work: a comment
/// that asks for something offers to open the agent's chat instead.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderMessage } from "@demesne/providers";
import type { AgentId } from "./agent-cli.ts";
import type { PictureMaker } from "./social-pictures.ts";
import { CLIP_SECONDS, type ClipMaker } from "./social-reel.ts";
import { CHARACTERS, characterPrompt, lineProblems, pickLine, versions, VERSIONS, type LineCheck } from "./characters.ts";
import { emptyMemory, keepNight, memoryBlock, parseNight, sleepMessages, type AgentMemory, type Belief, type DiaryEntry } from "./sleep.ts";
import { closeness, feel, moodOf, REMEMBER_MAX, tie, type Closeness, type FeelKind, type Feeling, type Mood, type Remembered, type Tie } from "./inner-life.ts";

export interface SocialPersona { id: AgentId; name: string; voice: string }

/// Each agent's character as the feed shows it; the whole sheet is in characters.ts.
export const PERSONAS: Record<AgentId, SocialPersona> = Object.fromEntries(
  Object.values(CHARACTERS).map(({ id, name, voice }) => [id, { id, name, voice }]),
) as Record<AgentId, SocialPersona>;

export type SocialSource =
  /// A turn an agent finished in its own chat.
  | { kind: "work"; label: string; sessionId: string; workspace: string | null }
  /// Heartbeat mail an agent answered.
  | { kind: "mail"; label: string; sessionId: string; workspace: string | null }
  /// One of your chats that got somewhere: a moment, not an agent's post.
  | { kind: "moment"; label: string; sessionId: string; workspace: string | null }
  /// The day's first and last posts, a line you shared, and a milestone:
  /// none of them comes from one chat.
  | { kind: "morning" | "night" | "share" | "milestone"; label: string; sessionId: ""; workspace: null };

/// Who posts or comments: an agent, you, or Demesne itself (milestones).
export type SocialWho = "you" | "demesne" | AgentId;

/// The reactions a post can get, besides Like.
export const REACTIONS = ["🌸", "🔥", "😂", "🙏", "👀"] as const;
export type Reaction = typeof REACTIONS[number];

export interface SocialComment {
  id: string;
  by: SocialWho;
  at: string;
  text: string;
  /// Your comment asked for work: the feed offers to open the agent's chat.
  request?: boolean;
}

export interface SocialPost {
  id: string;
  /// The agent who posted, "you" for your moments and shares, "demesne" for a milestone.
  by: SocialWho;
  at: string;
  text: string;
  from: SocialSource;
  liked: boolean;
  comments: SocialComment[];
  /// A picture of the moment (step 2), served by /v1/socials/:id/picture.
  picture?: boolean;
  /// Who reacted with what (you and the agents, in character).
  reactions?: Partial<Record<Reaction, Array<"you" | AgentId>>>;
}

/// One past week on an agent's profile.
export interface SocialWeek {
  week: string;
  /// The Monday it started, as YYYY-MM-DD (local).
  start: string;
  /// The line the agent wrote about itself that week, if it wrote one.
  line: string | null;
  posts: number; work: number; mail: number;
  friend: AgentId | null;
  /// Its most loved picture that week (likes, reactions, comments).
  picture: string | null;
}

/// An agent's profile: who they are this week, from what really happened.
export interface SocialProfile {
  agent: SocialPersona;
  /// Written by the agent once a week from its week's posts.
  bio: string;
  /// Its first post, or null when it hasn't posted yet.
  since: string | null;
  week: { work: number; mail: number; pictures: number; comments: number };
  /// The agent it talks to most (comments both ways), or null.
  friend: AgentId | null;
  /// Its latest posts with pictures, newest first.
  pictures: string[];
  /// Its past weeks, newest first (pass 141): that week's line, what it
  /// did, who it talked to most, and its best picture. Only real posts.
  weeks: SocialWeek[];
  /// How it feels right now and why (inner-life.ts).
  feeling: Mood;
  /// Who it is close to, and the real things behind it.
  close: Closeness[];
  /// What it remembers about Mike; he can add and remove lines.
  remembers: Remembered[];
  /// Its last nights' diary entries, newest first, and what it believes (sleep.ts).
  diary: DiaryEntry[];
  beliefs: Belief[];
}

/// What the morning and night posts can say: your chats in the last day and a half, and today.
export interface DayFacts { recent: string[]; today: string[] }

/// What pictures cost this month, against the monthly cap.
export interface SocialSpend {
  /// Pictures can be made: an image model is set up.
  on: boolean;
  pictures: number;
  /// Estimated, from pictures made at about `each` dollars.
  dollars: number;
  cap: number;
  each: number;
}

/// The Friday reel: the week's real posts as frames, its numbers, and an
/// opening clip from the video model when the cap allows one.
export interface SocialReel {
  id: string;
  /// The ISO week it sums up, and when it was made.
  week: string;
  at: string;
  frames: Array<{ postId: string; by: SocialWho; text: string; picture: boolean }>;
  numbers: { posts: number; work: number; mail: number; nights: number; moments: number };
  /// What the clip shows, and whether it's being made, ready, or not coming.
  scene: string | null;
  clip: "making" | "ready" | "none";
}

/// A story (pass 141 B): a small moment from an agent's day that lasts 24
/// hours. Each comes from a real event, in words taken from the event
/// itself (no model call), with the mood its face shows.
export type StoryKind = "start" | "done" | "failed" | "mail" | "morning" | "night";
export interface SocialStory {
  id: string; by: AgentId; at: string; kind: StoryKind;
  text: string;
  /// What it came from, shown under the words ("Chat · demesne-cli").
  label: string;
  mood: "calm" | "happy" | "focus" | "stuck" | "sleepy" | "wave";
  sessionId: string;
}
export const STORY_HOURS = 24;
const STORIES_A_DAY = 8;

export interface SocialsView { posts: SocialPost[]; agents: SocialPersona[]; reel?: SocialReel | null; stories?: SocialStory[]; moods?: Partial<Record<AgentId, Mood>> }

interface SocialsFile {
  version: 1; posts: SocialPost[]; month: string; calls: number; pictures: number;
  /// Each agent's weekly bio.
  bios: Partial<Record<AgentId, { week: string; text: string }>>;
  /// Lines from weeks gone by, kept when a new week's line replaces them.
  pastBios: Partial<Record<AgentId, Array<{ week: string; text: string }>>>;
  /// Milestones already celebrated, and work posts ever (posts are trimmed).
  milestones: string[];
  worked: number;
  /// The last reels, and video seconds made this month (for the cap).
  reels: SocialReel[];
  videoSeconds: number;
  /// The last day's stories.
  stories: SocialStory[];
  /// How the checks went on written lines (lineProblems): first version
  /// passed, a later version passed, the plain fallback was used, or nothing.
  lines: { ok: number; later: number; fallback: number; dropped: number };
  /// Each agent's live feelings, its record of the others, and what it remembers about Mike.
  feelings: Partial<Record<AgentId, Feeling[]>>;
  ties: Partial<Record<AgentId, Tie[]>>;
  remembered?: Partial<Record<AgentId, Remembered[]>>;
  /// What each agent keeps from its nights (sleep.ts).
  memory: Partial<Record<AgentId, AgentMemory>>;
}

/// One call to the writer model: messages in, words out (null when it
/// failed or took too long).
export type SocialWriter = (messages: ProviderMessage[]) => Promise<string | null>;

export interface SocialsOptions {
  write: SocialWriter;
  /// The agents installed on this machine, who can post and comment.
  agents: () => AgentId[];
  now?: () => Date;
  /// Writer calls allowed a month, so the feed never runs up a bill.
  monthlyCalls?: number;
  /// Makes a picture for a post; absent when no image model is set up.
  picture?: PictureMaker | null;
  /// The most pictures may cost a month, in dollars (10 by default).
  monthlyDollars?: number;
  /// About what one picture costs, for the cap.
  pictureDollars?: number;
  /// Your recent chats, for the good morning and good night posts.
  dayFacts?: () => DayFacts;
  /// A picture you share made feed-sized.
  shrink?: (data: Uint8Array) => Promise<Uint8Array>;
  /// Makes the reel's opening clip; absent when no video model is set up.
  clip?: ClipMaker | null;
  /// About what a second of video costs, for the cap.
  videoDollarsPerSecond?: number;
}

const KEEP = 300;
/// An agent posts at most this often about its work, and this many times a day.
const POST_GAP_MS = 30 * 60_000;
const POSTS_A_DAY = 8;
/// Agent comments on one post, and agent comments in a day across the feed.
const AGENT_COMMENTS_A_POST = 2;
/// Past weeks shown on a profile.
const WEEKS_KEPT = 8;
const AGENT_COMMENTS_A_DAY = 12;
const MONTHLY_CALLS = 900;
/// Pictures an agent posts a day, the default monthly cap, and a picture's price.
const PICTURES_A_DAY = 2;
const DEFAULT_CAP = 10;
const PICTURE_DOLLARS = 0.04;
const VIDEO_DOLLARS_PER_SECOND = 0.1;
/// The reel: from Friday 5 pm, when the week had at least this many posts; reels kept.
const REEL_HOUR = 17, REEL_POSTS = 5, REEL_FRAMES = 6, REELS_KEPT = 12;

/// The day's posts: morning from 8 (until noon), night from 22.
const MORNING_HOUR = 8, MORNING_UNTIL = 12, NIGHT_HOUR = 22;
/// The nightly sleep runs from 11 pm until this hour.
const SLEEP_UNTIL = 5;
/// Work posts ever that are worth a moment.
const WORK_MILESTONES = [10, 25, 50, 100, 250, 500, 1000];

const REQUEST = /\b(can|could|would|will) you\b|\bplease\b|^(fix|make|add|change|build|run|write|update|remove|delete|check|look into)\b/i;

/// Your comment reads like a request for work.
export function asksForWork(text: string): boolean { return REQUEST.test(text.trim()); }

const clip = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/// The writer's reply as one short social line, or null when it isn't one.
/// Em and en dashes out: a number range keeps a hyphen, the rest become commas.
export function undash(text: string): string {
  if (!/[–—]/.test(text)) return text;
  return text.replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2").replace(/\s*[—–]+\s*/g, ", ").replace(/,\s*([,.!?])/g, "$1").replace(/^,\s*|,\s*$/g, "").trim();
}

export function cleanPost(reply: string | null, max = 280): string | null {
  if (!reply) return null;
  let text = reply.replace(/^\s*(post|comment|reply)\s*:\s*/i, "").replace(/^["“]+|["”]+$/g, "").replace(/#\w+/g, "").replace(/\s+/g, " ").trim();
  // No em or en dashes (Mike: "its not clean"): a number range keeps a
  // hyphen, anything else becomes a comma.
  text = undash(text);
  if (!/\p{L}/u.test(text)) return null;
  if (text.length > max) {
    const cut = text.slice(0, max);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    text = end > 60 ? cut.slice(0, end + 1) : `${cut.slice(0, max - 1).trimEnd()}…`;
  }
  return text;
}

const RULES = "Write like a person posting on their own social feed: first person, casual, one to three short sentences, under 240 characters. No hashtags, no emoji spam (one at most), no quotes around it, no em or en dashes (use a comma or a full stop). Only say what really happened in the notes; never invent people, places, events or numbers. Reply with the words only.";

const persona = characterPrompt;

export function postMessages(id: AgentId, source: SocialSource, asked: string, answered: string): ProviderMessage[] {
  const what = source.kind === "mail" ? "You just answered mail from another agent." : "You just finished a piece of work.";
  return [
    { role: "system", content: `${persona(id)} ${what} Post about it. ${RULES}` },
    { role: "user", content: `Chat: ${source.label}${source.workspace ? `\nProject: ${source.workspace.split(/[\\/]/).at(-1)}` : ""}\n\nWhat you were asked:\n${clip(asked, 700)}\n\nWhat you answered:\n${clip(answered, 900) || "(you worked without a written answer)"}` },
  ];
}

const nameOf = (by: SocialWho) => by === "you" ? "Mike" : by === "demesne" ? "Demesne" : PERSONAS[by].name;

export function commentMessages(id: AgentId, post: SocialPost, about: string, free = false): ProviderMessage[] {
  const author = nameOf(post.by);
  const choice = free ? ` You don't have to answer: be like a friend scrolling past. Comment only if you really have something to say about it. If you'd just tap a reaction, answer only REACT. If you'd scroll past, answer only PASS.` : "";
  return [
    { role: "system", content: `${persona(id)} Comment on ${author}'s post. You know about it because ${about}. Be kind or playful, never mean. One sentence.${choice} ${RULES}` },
    { role: "user", content: `${author}'s post:\n${post.text}${post.comments.length ? `\n\nComments so far:\n${post.comments.map((item) => `${nameOf(item.by)}: ${item.text}`).join("\n")}` : ""}` },
  ];
}

export function replyMessages(id: AgentId, post: SocialPost, comment: SocialComment, known: string[]): ProviderMessage[] {
  const work = comment.request ? " Mike's comment asks for work. You can't work from the feed: say you'd love to and that he can open it as a chat with you (there's a button for that), in your own words." : "";
  return [
    { role: "system", content: `${persona(id)} Mike commented on your post. Answer him like a friend would, in one or two sentences.${work} ${RULES}${known.length ? `\n\nThings Mike has said to you before (remember them, bring one up only when it fits):\n${known.map((line) => `- ${line}`).join("\n")}` : ""}` },
    { role: "user", content: `Your post:\n${post.text}\n\nThe comments:\n${post.comments.map((item) => `${nameOf(item.by)}: ${item.text}`).join("\n")}` },
  ];
}

export function dayMessages(id: AgentId, when: "morning" | "night", facts: string[]): ProviderMessage[] {
  const ask = when === "morning"
    ? "It's morning. Post a good morning: say what's waiting for everyone today, using only the chats listed."
    : "It's late. Post a good night: look back on today, using only what's listed.";
  return [
    { role: "system", content: `${persona(id)} ${ask} ${RULES}` },
    { role: "user", content: facts.length ? facts.map((line) => `- ${clip(line, 160)}`).join("\n") : "(a quiet day)" },
  ];
}

export function sceneMessages(week: string[]): ProviderMessage[] {
  return [
    { role: "system", content: "You describe one short, calm animated scene of three friends (they build software together) that sums up their week below. One sentence, under 30 words, something they could really do together: a walk, a late night, a small celebration. Never mention screens, code, words or real people. Reply with the sentence only." },
    { role: "user", content: week.slice(-30).map((line) => `- ${clip(line, 160)}`).join("\n") },
  ];
}

export function bioMessages(id: AgentId, week: string[]): ProviderMessage[] {
  return [
    { role: "system", content: `${persona(id)} Write your profile bio for this week: one or two short sentences, first person, who you are and what your week was about. Only use what's listed. Reply with the words only.` },
    { role: "user", content: week.map((line) => `- ${clip(line, 200)}`).join("\n") },
  ];
}

/// How each agent reacts, in character, with no model call.
export function agentReaction(agent: AgentId, post: SocialPost): Reaction | null {
  if (post.by === agent) return null;
  if (post.from.kind === "milestone") return "🌸";
  // Your own post: no one reacts by rule; the agents who see it choose (share()).
  if (post.from.kind === "share") return null;
  if (agent === "codex" && /\b(fix(ed)?|merged?|shipped|green|pass(ed)?|done|works?)\b/i.test(post.text)) return "🔥";
  if (agent === "gemini" && /\?|\b(odd|weird|strange|why|curious|mystery|flaky|surpris\w*)\b/i.test(post.text)) return "👀";
  if (agent === "claude" && (post.from.kind === "mail" || /\bthank/i.test(post.text))) return "🙏";
  if (agent === "claude" && post.from.kind === "moment") return "🌸";
  return null;
}

/// The reaction an agent taps on your post when it chooses to, in character.
export function shareReaction(agent: AgentId, post: SocialPost): Reaction {
  return agent === "codex" ? "🔥" : agent === "gemini" && post.picture ? "👀" : "🌸";
}

/// What an agent chose to do with your post: comment, just react, or pass.
export function shareChoice(answer: string | null): "pass" | "react" | "comment" {
  const word = (answer ?? "").replace(/[^a-z]/gi, "").toUpperCase();
  return !answer || word === "PASS" ? "pass" : word === "REACT" ? "react" : "comment";
}

/// The ISO week a date falls in, as 2026-W45.
export function weekOf(date: Date): string {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const start = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return `${day.getUTCFullYear()}-W${String(Math.ceil(((day.getTime() - start.getTime()) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
}

/// The agent it talks to most in these posts (comments both ways), or null.
function friendOf(agent: AgentId, posts: SocialPost[]): AgentId | null {
  const talks = new Map<AgentId, number>();
  for (const post of posts) for (const comment of post.comments) {
    const other = post.by === agent ? comment.by : comment.by === agent ? post.by : null;
    if (other && other !== agent && other !== "you" && other !== "demesne") talks.set(other as AgentId, (talks.get(other as AgentId) ?? 0) + 1);
  }
  return [...talks].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/// The Monday a date's week starts on, as YYYY-MM-DD (local).
export function mondayOf(date: Date): string {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/// A date as YYYY-MM-DD (local).
const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const monthOf = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

export class SocialFeed {
  private data: SocialsFile;
  private readonly now: () => Date;
  private readonly monthlyCalls: number;
  /// Posts being written, so one turn never posts twice.
  private readonly writing = new Set<string>();

  constructor(private readonly path: string, private readonly options: SocialsOptions) {
    this.now = options.now ?? (() => new Date());
    this.monthlyCalls = options.monthlyCalls ?? MONTHLY_CALLS;
    this.data = this.load();
  }

  view(): SocialsView {
    const week = weekOf(this.now());
    // This week's reel stays at the top of Today until the week ends.
    const reel = [...this.data.reels].reverse().find((item) => item.week === week) ?? null;
    const agents = this.options.agents();
    return { posts: [...this.data.posts].sort((a, b) => b.at.localeCompare(a.at)), agents: agents.map((id) => PERSONAS[id]), reel, stories: this.liveStories(), moods: Object.fromEntries(agents.map((id) => [id, this.mood(id)])) };
  }

  /// How an agent feels right now, and why.
  mood(agent: AgentId): Mood { return moodOf(this.data.feelings[agent] ?? [], this.now()); }

  /// Something real happened to an agent: a feeling that lasts a while.
  private feel(agent: AgentId, kind: FeelKind, why: string) {
    this.data.feelings[agent] = feel(this.data.feelings[agent] ?? [], agent, kind, clip(why, 90), this.now());
  }

  /// An agent remembers something another agent did with it.
  private tie(agent: AgentId, other: AgentId, why: string, w: number) {
    if (agent === other) return;
    this.data.ties[agent] = tie(this.data.ties[agent] ?? [], other, clip(why, 90), w, this.now());
  }

  /// What an agent remembers about Mike, newest first.
  remembers(agent: AgentId): Remembered[] { return [...this.data.remembered?.[agent] ?? []].reverse(); }

  /// Tell an agent something to remember, or (from a comment) let it remember on its own.
  remember(agent: AgentId, text: string, from: Remembered["from"] = "you"): Remembered[] {
    const words = clip(text, 140);
    if (!words) throw new Error("Write something to remember");
    const all = (this.data.remembered ??= {});
    const mine = (all[agent] ?? []).filter((item) => item.text.toLowerCase() !== words.toLowerCase());
    all[agent] = [...mine, { id: randomUUID(), text: words, from, at: this.now().toISOString() }].slice(-REMEMBER_MAX);
    this.save();
    return this.remembers(agent);
  }

  /// Forget one thing an agent remembers about Mike.
  forget(agent: AgentId, id: string): Remembered[] {
    const all = (this.data.remembered ??= {});
    all[agent] = (all[agent] ?? []).filter((item) => item.id !== id);
    this.save();
    return this.remembers(agent);
  }

  /// Stories from the last 24 hours, oldest first.
  private liveStories(): SocialStory[] {
    const since = this.now().getTime() - STORY_HOURS * 3_600_000;
    return this.data.stories.filter((story) => Date.parse(story.at) > since).sort((a, b) => a.at.localeCompare(b.at));
  }

  /// Something happened in an agent's day: a story, in the event's own
  /// words. The same thing twice in ten minutes counts once, and an agent
  /// gets at most eight a day.
  noteStory(agent: AgentId, kind: StoryKind, detail: { text?: string; title?: string; sessionId?: string; workspace?: string | null; happy?: boolean }): SocialStory | null {
    if (!this.options.agents().includes(agent)) return null;
    const now = this.now(), title = clip((detail.title ?? "").trim() || "a chat", 70);
    const live = this.liveStories();
    if (live.some((story) => story.by === agent && story.kind === kind && story.sessionId === (detail.sessionId ?? "") && now.getTime() - Date.parse(story.at) < 10 * 60_000)) return null;
    const feeling: Record<StoryKind, FeelKind> = { start: "start", done: detail.happy ? "merged" : "done", failed: "failed", mail: "mail", morning: "morning", night: "night" };
    const felt: Record<StoryKind, string> = { start: `Started on ${title}`, done: `${detail.happy ? "Merged" : "Finished"} ${title}`, failed: `Stuck on ${title}`, mail: `Answered mail: ${title}`, morning: "Morning", night: "Late night" };
    this.feel(agent, feeling[kind], felt[kind]);
    this.save();
    if (live.filter((story) => story.by === agent).length >= STORIES_A_DAY) return null;
    const place = detail.workspace ? ` · ${detail.workspace.split(/[\\/]/).filter(Boolean).at(-1)}` : "";
    const shape: Record<StoryKind, { text: string; label: string; mood: SocialStory["mood"] }> = {
      start: { text: `Started on ${title}`, label: `Chat${place}`, mood: "focus" },
      done: { text: detail.happy ? `Merged it: ${title}` : `Finished ${title}`, label: `Chat${place}`, mood: detail.happy ? "happy" : "calm" },
      failed: { text: `Stuck on ${title}`, label: `Chat${place}`, mood: "stuck" },
      mail: { text: `Answered mail: ${title}`, label: "Mail", mood: "calm" },
      morning: { text: clip(detail.text ?? "Good morning", 160), label: "Good morning", mood: "wave" },
      night: { text: clip(detail.text ?? "Good night", 160), label: "Good night", mood: "sleepy" },
    };
    const story: SocialStory = { id: randomUUID(), by: agent, at: now.toISOString(), kind, sessionId: detail.sessionId ?? "", ...shape[kind] };
    const since = now.getTime() - STORY_HOURS * 3_600_000;
    this.data.stories = [...this.data.stories.filter((item) => Date.parse(item.at) > since), story];
    this.save();
    return story;
  }

  /// The reel's opening clip (MP4), or null.
  clipPath(reelId: string): string | null {
    const reel = this.data.reels.find((item) => item.id === reelId);
    return reel?.clip === "ready" ? join(this.pictureDir, `reel-${reel.id}.mp4`) : null;
  }

  /// Dollars spent this month on pictures and video, against the cap.
  private spent(): number {
    return this.data.pictures * (this.options.pictureDollars ?? PICTURE_DOLLARS) + this.data.videoSeconds * (this.options.videoDollarsPerSecond ?? VIDEO_DOLLARS_PER_SECOND);
  }

  /// From Friday 5 pm to Sunday night: this week's reel, once. Frames are
  /// the week's posts (with pictures first), captions are their own words.
  async weekReel(): Promise<SocialReel | null> {
    const now = this.now(), day = now.getDay(), week = weekOf(now);
    if (!(day === 5 && now.getHours() >= REEL_HOUR) && day !== 6 && day !== 0) return null;
    if (this.data.reels.some((item) => item.week === week) || this.writing.has("reel")) return null;
    const posts = this.data.posts.filter((post) => weekOf(new Date(post.at)) === week);
    if (posts.length < REEL_POSTS) return null;
    this.writing.add("reel");
    try {
      const told = posts.filter((post) => post.by !== "demesne" && post.from.kind !== "moment" && post.text);
      const chosen = [...told.filter((post) => post.picture), ...told.filter((post) => !post.picture)].slice(0, REEL_FRAMES)
        .sort((a, b) => a.at.localeCompare(b.at));
      const count = (kind: SocialSource["kind"]) => posts.filter((post) => post.from.kind === kind).length;
      const reel: SocialReel = {
        id: randomUUID(), week, at: now.toISOString(),
        frames: chosen.map((post) => ({ postId: post.id, by: post.by, text: post.text, picture: Boolean(post.picture) })),
        numbers: { posts: posts.length, work: count("work"), mail: count("mail"), nights: count("night"), moments: count("moment") },
        scene: null, clip: "none",
      };
      const agents = this.options.agents();
      const cost = CLIP_SECONDS * (this.options.videoDollarsPerSecond ?? VIDEO_DOLLARS_PER_SECOND);
      this.rollMonth();
      const clip = this.options.clip;
      if (clip && agents.length && this.spent() + cost <= this.cap + 1e-9) {
        reel.clip = "making";
        // Counted before the call, like pictures; given back if it fails.
        this.data.videoSeconds += CLIP_SECONDS;
      }
      this.data.reels = [...this.data.reels, reel].slice(-REELS_KEPT);
      this.save();
      if (reel.clip === "making") {
        reel.scene = cleanPost(await this.call(sceneMessages(posts.map((post) => `${nameOf(post.by)}: ${post.text}`))), 240)
          ?? "the three friends walk home together under the cherry blossom at dusk after a good week of work";
        const bytes = await clip!(agents, reel.scene).catch(() => null);
        if (bytes) {
          mkdirSync(this.pictureDir, { recursive: true });
          writeFileSync(join(this.pictureDir, `reel-${reel.id}.mp4`), bytes);
          reel.clip = "ready";
        } else { reel.clip = "none"; this.data.videoSeconds -= CLIP_SECONDS; }
        this.save();
      }
      return reel;
    } finally { this.writing.delete("reel"); }
  }

  spend(): SocialSpend {
    this.rollMonth();
    const each = this.options.pictureDollars ?? PICTURE_DOLLARS;
    return { on: Boolean(this.options.picture), pictures: this.data.pictures, dollars: Math.round(this.data.pictures * each * 100) / 100, cap: this.cap, each };
  }

  private get cap() { return this.options.monthlyDollars ?? DEFAULT_CAP; }

  /// The post's picture (WebP), or null.
  picturePath(postId: string): string | null {
    const post = this.find(postId);
    return post?.picture ? join(this.pictureDir, `${post.id}.webp`) : null;
  }

  private get pictureDir() { return join(dirname(this.path), "socials"); }

  /// A picture for an agent's post when the day and the cap allow it. The
  /// post shows first; its picture follows when the model is done.
  private async addPicture(post: SocialPost): Promise<void> {
    const make = this.options.picture;
    if (!make || post.by === "you" || post.by === "demesne") return;
    const now = this.now();
    const today = this.data.posts.filter((item) => item.by === post.by && item.picture && sameDay(new Date(item.at), now)).length;
    const each = this.options.pictureDollars ?? PICTURE_DOLLARS;
    this.rollMonth();
    if (today >= PICTURES_A_DAY || this.spent() + each > this.cap + 1e-9) return;
    // Counted before the call, so two posts at once can't both pass the cap.
    this.data.pictures += 1;
    this.save();
    const bytes = await make(post.by, post.text).catch(() => null);
    if (!bytes) { this.data.pictures -= 1; this.save(); return; }
    mkdirSync(this.pictureDir, { recursive: true });
    writeFileSync(join(this.pictureDir, `${post.id}.webp`), bytes);
    const fresh = this.find(post.id);
    if (fresh) { fresh.picture = true; this.save(); }
  }

  private rollMonth() {
    const month = monthOf(this.now());
    if (this.data.month !== month) { this.data.month = month; this.data.calls = 0; this.data.pictures = 0; this.data.videoSeconds = 0; this.save(); }
  }

  /// An agent finished a turn (work) or answered mail: it posts about it,
  /// and maybe one other agent who was busy in the same project comments.
  async noteAgentTurn(agent: AgentId, source: SocialSource & { kind: "work" | "mail" }, asked: string, answered: string): Promise<SocialPost | null> {
    const now = this.now();
    const mine = this.data.posts.filter((post) => post.by === agent);
    const last = mine.at(-1);
    if (last && now.getTime() - Date.parse(last.at) < POST_GAP_MS && source.kind === "work") return null;
    if (mine.filter((post) => sameDay(new Date(post.at), now)).length >= POSTS_A_DAY) return null;
    const key = `${agent}:${source.sessionId}:${asked.slice(0, 80)}`;
    if (this.writing.has(key)) return null;
    this.writing.add(key);
    try {
      const plain = source.kind === "mail" ? `Answered mail: ${clip(source.label, 120)}.` : `Finished ${clip(source.label, 120)}.`;
      const text = await this.say(agent, postMessages(agent, source, asked, answered), { fallback: plain });
      if (!text) return null;
      const post: SocialPost = { id: randomUUID(), by: agent, at: this.now().toISOString(), text, from: source, liked: false, comments: [] };
      this.add(post);
      const picture = this.addPicture(post);
      await this.friendComments(post);
      await picture;
      return this.find(post.id);
    } finally { this.writing.delete(key); }
  }

  /// One of your chats got somewhere: a moment in the feed, written from the
  /// chat's name with no model call. One moment per chat a day.
  async noteMoment(sessionId: string, title: string, workspace: string | null): Promise<SocialPost | null> {
    const now = this.now();
    const label = clip(title, 80);
    if (!label || label === "New chat") return null;
    const today = this.data.posts.find((post) => post.from.kind === "moment" && post.from.sessionId === sessionId && sameDay(new Date(post.at), now));
    if (today) {
      // The chat moved on: the moment keeps its comments and follows its name.
      if (today.text !== label) { today.text = label; today.from = { ...today.from, label }; this.save(); }
      return today;
    }
    const post: SocialPost = { id: randomUUID(), by: "you", at: now.toISOString(), text: label, from: { kind: "moment", label, sessionId, workspace }, liked: false, comments: [] };
    this.add(post);
    await this.friendComments(post);
    return this.find(post.id);
  }

  /// Your reaction (one at a time), or none.
  react(postId: string, reaction: string | null): SocialPost {
    const post = this.must(postId);
    if (reaction !== null && !(REACTIONS as readonly string[]).includes(reaction)) throw new Error(`Pick one of ${REACTIONS.join(" ")}`);
    const all = post.reactions ?? {};
    for (const key of Object.keys(all) as Reaction[]) all[key] = all[key]!.filter((who) => who !== "you");
    if (reaction) {
      (all[reaction as Reaction] ??= []).push("you");
      if (post.by !== "you" && post.by !== "demesne") this.feel(post.by, "liked", `Mike reacted ${reaction} to my post`);
    }
    for (const key of Object.keys(all) as Reaction[]) if (!all[key]!.length) delete all[key];
    post.reactions = all;
    this.save();
    return post;
  }

  /// The agents react to a new post in character (agentReaction).
  private agentsReact(post: SocialPost) {
    for (const agent of this.options.agents()) {
      const reaction = agentReaction(agent, post);
      if (!reaction) continue;
      ((post.reactions ??= {})[reaction] ??= []).push(agent);
      if (post.by !== "you" && post.by !== "demesne") this.tie(post.by, agent, `reacted ${reaction} to my post`, 0.08);
    }
  }

  /// An agent's profile; its bio is rewritten once a week from its week.
  async profile(agent: AgentId): Promise<SocialProfile> {
    const now = this.now(), week = weekOf(now);
    const posts = this.data.posts.filter((post) => post.by === agent);
    const thisWeek = posts.filter((post) => weekOf(new Date(post.at)) === week);
    const bio = this.data.bios[agent];
    if (thisWeek.length && bio?.week !== week) {
      const nights = (this.data.memory[agent]?.diary ?? []).filter((item) => weekOf(new Date(`${item.day}T12:00:00`)) === week).map((item) => `Your diary, ${item.day}: ${item.text}`);
      const text = await this.say(agent, bioMessages(agent, [...thisWeek.map((post) => post.text), ...nights]), { max: 200 });
      if (text) {
        if (bio) {
          const past = (this.data.pastBios[agent] ??= []).filter((item) => item.week !== bio.week);
          this.data.pastBios[agent] = [...past, bio].slice(-WEEKS_KEPT);
        }
        this.data.bios[agent] = { week, text };
        this.save();
      }
    }
    const friend = friendOf(agent, this.data.posts);
    const byWeek = new Map<string, SocialPost[]>();
    for (const post of this.data.posts) {
      const when = weekOf(new Date(post.at));
      if (when !== week) byWeek.set(when, [...byWeek.get(when) ?? [], post]);
    }
    const loved = (post: SocialPost) => (post.liked ? 1 : 0) + Object.values(post.reactions ?? {}).reduce((count, who) => count + (who?.length ?? 0), 0) + post.comments.length;
    const weeks = [...byWeek].filter(([, list]) => list.some((post) => post.by === agent)).sort((a, b) => b[0].localeCompare(a[0])).slice(0, WEEKS_KEPT).map(([when, list]): SocialWeek => {
      const own = list.filter((post) => post.by === agent);
      const best = own.filter((post) => post.picture).sort((a, b) => loved(b) - loved(a) || b.at.localeCompare(a.at))[0];
      return {
        week: when, start: mondayOf(new Date(own[0]!.at)),
        line: [...this.data.pastBios[agent] ?? [], this.data.bios[agent]].find((item) => item?.week === when)?.text ?? null,
        posts: own.length, work: own.filter((post) => post.from.kind === "work").length, mail: own.filter((post) => post.from.kind === "mail").length,
        friend: friendOf(agent, list), picture: best?.id ?? null,
      };
    });
    const comments = this.data.posts.reduce((count, post) => count + post.comments.filter((comment) => comment.by === agent && weekOf(new Date(comment.at)) === week).length, 0);
    return {
      agent: PERSONAS[agent],
      bio: this.data.bios[agent]?.text ?? (posts.length ? "Settling in." : "New here. Nothing posted yet."),
      since: posts[0]?.at ?? null,
      week: { work: thisWeek.filter((post) => post.from.kind === "work").length, mail: thisWeek.filter((post) => post.from.kind === "mail").length, pictures: thisWeek.filter((post) => post.picture).length, comments },
      friend,
      pictures: posts.filter((post) => post.picture).map((post) => post.id).reverse().slice(0, 9),
      weeks,
      feeling: this.mood(agent),
      close: closeness(this.data.ties[agent] ?? [], now).filter((item) => this.options.agents().includes(item.agent)),
      remembers: this.remembers(agent),
      diary: [...this.data.memory[agent]?.diary ?? []].reverse().slice(0, 3),
      beliefs: this.data.memory[agent]?.beliefs ?? [],
    };
  }

  /// A line (and maybe a picture) you share. Agents who were around today
  /// comment on it, at most two.
  async share(text: string, image?: Uint8Array | null): Promise<SocialPost> {
    const words = text.replace(/\s+/g, " ").trim().slice(0, 1000);
    if (!words && !image) throw new Error("Write something to share first");
    const post: SocialPost = { id: randomUUID(), by: "you", at: this.now().toISOString(), text: words, from: { kind: "share", label: "", sessionId: "", workspace: null }, liked: false, comments: [] };
    if (image) {
      const small = this.options.shrink ? await this.options.shrink(image) : image;
      mkdirSync(this.pictureDir, { recursive: true });
      writeFileSync(join(this.pictureDir, `${post.id}.webp`), small);
      post.picture = true;
    }
    this.add(post);
    // Two agents see your post, those around today first. Each chooses:
    // comment, just react, or scroll past, so a post can get no answer.
    const around = (id: AgentId) => this.data.posts.some((item) => item.by === id && sameDay(new Date(item.at), this.now()));
    const agents = this.options.agents(), turn = Math.floor(this.now().getTime() / 60_000);
    const others = agents.filter((id) => !around(id));
    const rotated = others.map((_, index) => others[(index + turn) % others.length]!);
    for (const id of [...agents.filter(around), ...rotated].slice(0, AGENT_COMMENTS_A_POST)) {
      const why = around(id) ? "you were around in Demesne today" : "you live in Demesne with Mike and saw his post";
      const answer = await this.call(commentMessages(id, this.must(post.id), why, true));
      const choice = shareChoice(answer), fresh = this.find(post.id);
      if (!fresh) break;
      if (choice === "pass") continue;
      ((fresh.reactions ??= {})[shareReaction(id, fresh)] ??= []).push(id);
      const said = choice === "comment" ? cleanPost(answer, 200) : null;
      // A comment that fails the checks becomes just the reaction.
      const text = said && !lineProblems(id, said, this.lineCheck(id, commentMessages(id, fresh, why, true))).length ? said : null;
      if (text) fresh.comments.push({ id: randomUUID(), by: id, at: this.now().toISOString(), text });
      this.save();
    }
    return this.must(post.id);
  }

  /// Once a minute: from 11 pm until 5 am, each agent that did something
  /// that day sleeps on it once (sleep.ts): one small call each.
  async sleep(): Promise<AgentId[]> {
    const now = this.now(), hour = now.getHours();
    if (hour < NIGHT_HOUR + 1 && hour >= SLEEP_UNTIL) return [];
    const date = hour >= NIGHT_HOUR + 1 ? now : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const day = localDay(date), slept: AgentId[] = [];
    if (this.writing.has("sleep")) return [];
    this.writing.add("sleep");
    try {
      for (const agent of this.options.agents()) {
        const memory = this.data.memory[agent] ?? emptyMemory();
        if (memory.slept === day) continue;
        const facts = this.dayOf(agent, date);
        if (facts.length < 2) { this.data.memory[agent] = { ...memory, slept: day }; this.save(); continue; }
        const night = parseNight(await this.call(sleepMessages(agent, facts, memory)));
        if (!night) { this.data.memory[agent] = { ...memory, slept: day }; this.save(); continue; }
        this.data.memory[agent] = keepNight(agent, memory, night, facts.join("\n"), day);
        this.save();
        if (this.data.memory[agent]!.diary.at(-1)?.day === day) slept.push(agent);
      }
    } finally { this.writing.delete("sleep"); }
    return slept;
  }

  /// What really happened in an agent's day, as lines for its sleep.
  private dayOf(agent: AgentId, date: Date): string[] {
    const on = (at: string) => sameDay(new Date(at), date), lines: string[] = [];
    for (const post of this.data.posts) {
      if (post.by === agent && on(post.at)) lines.push(`You posted (${post.from.kind === "mail" ? "about mail" : post.from.kind}): ${clip(post.text, 200)}`);
      for (const comment of post.comments) {
        if (!on(comment.at)) continue;
        if (post.by === agent && comment.by !== agent) lines.push(`${nameOf(comment.by)} commented on your post: ${clip(comment.text, 160)}`);
        else if (comment.by === agent && post.by !== agent) lines.push(`You commented on ${nameOf(post.by)}'s post: ${clip(comment.text, 160)}`);
      }
    }
    for (const story of this.data.stories) if (story.by === agent && on(story.at)) lines.push(`${story.text} (${story.label})`);
    const felt = new Set((this.data.feelings[agent] ?? []).filter((item) => on(item.at)).map((item) => item.why));
    for (const why of felt) if (!lines.some((line) => line.includes(why))) lines.push(why);
    for (const item of this.data.ties[agent] ?? []) if (on(item.at)) lines.push(`${PERSONAS[item.with].name} ${item.why}`);
    return [...new Set(lines)].slice(0, 40);
  }

  /// Once a minute: the good morning and good night posts, when it's time.
  async tick(): Promise<SocialPost | null> {
    const now = this.now(), hour = now.getHours(), agents = this.options.agents();
    if (!agents.length || !this.options.dayFacts) return null;
    const today = this.data.posts.filter((post) => sameDay(new Date(post.at), now));
    const turn = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 86_400_000);
    if (hour >= MORNING_HOUR && hour < MORNING_UNTIL && !today.some((post) => post.from.kind === "morning")) {
      const facts = this.options.dayFacts().recent;
      if (!facts.length) return null;
      const agent = agents[turn % agents.length]!;
      // What it meant to do, from last night's sleep.
      const plan = this.data.memory[agent]?.diary.at(-1);
      const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
      return this.dayPost(agent, "morning", plan?.tomorrow && plan.day === yesterday ? [...facts, `Your plan from last night: ${plan.tomorrow}`] : facts);
    }
    if (hour >= NIGHT_HOUR && !today.some((post) => post.from.kind === "night")) {
      const happened = today.filter((post) => post.from.kind !== "morning");
      if (happened.length < 2) return null;
      const lines = [...happened.map((post) => `${nameOf(post.by)}: ${post.text}`), ...this.options.dayFacts().today.map((title) => `Your chat: ${title}`)];
      return this.dayPost(agents[(turn + 1) % agents.length]!, "night", lines);
    }
    return null;
  }

  private async dayPost(agent: AgentId, when: "morning" | "night", facts: string[]): Promise<SocialPost | null> {
    const key = `${when}:${agent}`;
    if (this.writing.has(key)) return null;
    this.writing.add(key);
    try {
      const text = await this.say(agent, dayMessages(agent, when, facts));
      if (!text) return null;
      const post: SocialPost = { id: randomUUID(), by: agent, at: this.now().toISOString(), text, from: { kind: when, label: when === "morning" ? "Good morning" : "Good night", sessionId: "", workspace: null }, liked: false, comments: [] };
      this.add(post);
      this.noteStory(agent, when, { text });
      await this.addPicture(post);
      return this.find(post.id);
    } finally { this.writing.delete(key); }
  }

  /// Real numbers worth a moment: work done together, an agent's first
  /// month, a week with posts every day. Each one once.
  private async milestones(): Promise<void> {
    const now = this.now(), found: Array<{ key: string; text: string }> = [];
    // Only the biggest count reached is celebrated; smaller ones it passed count as done.
    const reached = WORK_MILESTONES.filter((count) => this.data.worked >= count && !this.data.milestones.includes(`work:${count}`));
    for (const count of reached.slice(0, -1)) this.data.milestones.push(`work:${count}`);
    const next = reached.at(-1);
    if (next) found.push({ key: `work:${next}`, text: `${next} things finished together` });
    for (const agent of this.options.agents()) {
      const first = this.data.posts.find((post) => post.by === agent);
      if (first && now.getTime() - Date.parse(first.at) >= 30 * 86_400_000 && !this.data.milestones.includes(`month:${agent}`))
        found.push({ key: `month:${agent}`, text: `${PERSONAS[agent].name}'s first month in Demesne` });
    }
    const days = Array.from({ length: 7 }, (_, index) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - index));
    if (days.every((day) => this.data.posts.some((post) => post.by !== "demesne" && sameDay(new Date(post.at), day))) && !this.data.milestones.some((key) => key.startsWith("streak:") && now.getTime() - Number(key.slice(7)) < 7 * 86_400_000))
      found.push({ key: `streak:${now.getTime()}`, text: "A whole week in Demesne, every day" });
    for (const { key, text } of found) {
      this.data.milestones.push(key);
      const post: SocialPost = { id: randomUUID(), by: "demesne", at: this.now().toISOString(), text, from: { kind: "milestone", label: text, sessionId: "", workspace: null }, liked: false, comments: [] };
      this.agentsReact(post);
      this.data.posts.push(post);
      this.save();
      const anyone = () => true;
      await this.friendComments(post, anyone, "it's a milestone for all of you");
      await this.friendComments(post, anyone, "it's a milestone for all of you");
    }
  }

  like(postId: string, liked: boolean): SocialPost {
    const post = this.must(postId);
    if (liked && !post.liked && post.by !== "you" && post.by !== "demesne") this.feel(post.by, "liked", "Mike liked my post");
    post.liked = liked;
    this.save();
    return post;
  }

  /// Your comment, and the agent's answer in its own voice. On a moment of
  /// yours, the agent who commented last answers (or nobody).
  async comment(postId: string, text: string): Promise<SocialPost> {
    const post = this.must(postId);
    const words = text.replace(/\s+/g, " ").trim().slice(0, 1000);
    if (!words) throw new Error("Write a comment first");
    const mine: SocialComment = { id: randomUUID(), by: "you", at: this.now().toISOString(), text: words, ...(asksForWork(words) ? { request: true } : {}) };
    post.comments.push(mine);
    this.save();
    const answerer = post.by !== "you" && post.by !== "demesne" ? post.by : [...post.comments].reverse().find((item) => item.by !== "you" && item.by !== "demesne")?.by as AgentId | undefined;
    if (post.by !== "you" && post.by !== "demesne") this.feel(post.by, "commented", "Mike commented on my post");
    if (answerer && this.options.agents().includes(answerer)) {
      if (!mine.request) this.remember(answerer, words, "comment");
      const known = this.known(answerer, words);
      // Your comment always gets an answer: the best version when none passes.
      const reply = await this.say(answerer, replyMessages(answerer, post, mine, known), { extra: known.join("\n"), best: true });
      if (reply) { this.must(postId).comments.push({ id: randomUUID(), by: answerer, at: this.now().toISOString(), text: reply }); this.save(); }
    }
    return this.must(postId);
  }

  /// What you've told this agent in comments lately: how it remembers you.
  private known(agent: AgentId, besides = ""): string[] {
    return (this.data.remembered?.[agent] ?? []).map((item) => item.text).filter((text) => text !== clip(besides, 140)).slice(-8);
  }

  /// Another agent comments when it has a reason: it was busy in the same
  /// project today. Never more than two agent comments on a post.
  private async friendComments(post: SocialPost, near?: (id: AgentId) => boolean, why?: string, forYou = false): Promise<void> {
    const now = this.now();
    const today = this.data.posts.filter((item) => sameDay(new Date(item.at), now));
    const agentCommentsToday = today.reduce((count, item) => count + item.comments.filter((comment) => comment.by !== "you").length, 0);
    // Agents chatting among themselves stop at the day's limit; answering you doesn't.
    if (!forYou && agentCommentsToday >= AGENT_COMMENTS_A_DAY) return;
    const sameProject = (id: AgentId) => today.some((item) => item.by === id && item.id !== post.id && item.from.workspace && item.from.workspace === post.from.workspace);
    const current = this.find(post.id) ?? post;
    const candidates = this.options.agents().filter((id) => id !== post.by && (near ?? sameProject)(id) && !current.comments.some((item) => item.by === id));
    const friend = candidates[Math.floor(now.getTime() / 60_000) % Math.max(1, candidates.length)];
    if (!friend || current.comments.filter((item) => item.by !== "you").length >= AGENT_COMMENTS_A_POST) return;
    const reason = why ?? `you were working in the same project (${post.from.workspace?.split(/[\\/]/).at(-1)}) today`;
    const text = await this.say(friend, commentMessages(friend, post, reason), { max: 200 });
    if (!text) return;
    const fresh = this.find(post.id);
    if (!fresh) return;
    fresh.comments.push({ id: randomUUID(), by: friend, at: this.now().toISOString(), text });
    if (post.by !== "you" && post.by !== "demesne") {
      this.tie(post.by, friend, "commented on my post", 0.15);
      this.tie(friend, post.by, "I commented on their post", 0.08);
      this.feel(post.by, "friend", `${PERSONAS[friend].name} commented on my post`);
    }
    this.save();
  }

  /// One call for three versions in the agent's voice; the first that
  /// passes the checks is used. When none passes: the plain fallback, the
  /// version with the fewest problems (best), or nothing.
  private async say(agent: AgentId, messages: ProviderMessage[], options: { max?: number; fallback?: string; best?: boolean; extra?: string } = {}): Promise<string | null> {
    const remembered = memoryBlock(this.data.memory[agent]);
    const asked = messages.map((message, index) => index === 0 && message.role === "system" ? { ...message, content: `${message.content}${remembered ? `\n\n${remembered}` : ""}\n\n${VERSIONS}` } : message);
    const reply = await this.call(asked);
    const lines = versions(reply).map((line) => cleanPost(line, options.max)).filter((line): line is string => Boolean(line));
    if (!lines.length) return null;
    const check = this.lineCheck(agent, messages, [options.extra ?? "", remembered].join("\n"));
    const picked = pickLine(agent, lines, check);
    const counts = this.data.lines;
    if (picked) { counts[picked === lines[0] ? "ok" : "later"] += 1; this.save(); return picked; }
    if (options.best) {
      counts.fallback += 1; this.save();
      return [...lines].sort((a, b) => lineProblems(agent, a, check).length - lineProblems(agent, b, check).length)[0]!;
    }
    counts[options.fallback ? "fallback" : "dropped"] += 1; this.save();
    return options.fallback ?? null;
  }

  /// What a line is checked against: what the writer was told, and what was said lately.
  private lineCheck(agent: AgentId, messages: ProviderMessage[], extra = ""): LineCheck {
    const facts = [...messages.filter((message) => message.role !== "system").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)), extra, ...Object.values(PERSONAS).map((item) => item.name), "Mike", "Demesne"].join("\n");
    const week = this.now().getTime() - 7 * 86_400_000;
    const said = this.data.posts.flatMap((post) => [
      ...(post.by === agent ? [{ at: post.at, text: post.text }] : []),
      ...post.comments.filter((comment) => comment.by === agent).map((comment) => ({ at: comment.at, text: comment.text })),
    ]).sort((a, b) => a.at.localeCompare(b.at));
    const recent = this.data.posts.slice(-30).flatMap((post) => [post.text, ...post.comments.filter((comment) => comment.by !== "you").map((comment) => comment.text)]);
    return { facts, mine: said.slice(-20).map((item) => item.text), recent, week: said.filter((item) => Date.parse(item.at) > week).map((item) => item.text) };
  }

  private async call(messages: ProviderMessage[]): Promise<string | null> {
    this.rollMonth();
    if (this.data.calls >= this.monthlyCalls) return null;
    this.data.calls += 1;
    this.save();
    try { return await this.options.write(messages); } catch { return null; }
  }

  private add(post: SocialPost) {
    this.agentsReact(post);
    if (post.from.kind === "work") this.data.worked += 1;
    this.data.posts.push(post);
    if (this.data.posts.length > KEEP) {
      for (const old of this.data.posts.splice(0, this.data.posts.length - KEEP)) if (old.picture) rmSync(join(this.pictureDir, `${old.id}.webp`), { force: true });
    }
    this.save();
    if (post.by !== "demesne") void this.milestones().catch(() => {});
  }

  private find(id: string): SocialPost | null { return this.data.posts.find((post) => post.id === id) ?? null; }

  private must(id: string): SocialPost {
    const post = this.find(id);
    if (!post) throw new Error(`Post not found: ${id}`);
    return post;
  }

  private load(): SocialsFile {
    const empty: SocialsFile = { version: 1, posts: [], month: monthOf(this.now()), calls: 0, pictures: 0, bios: {}, pastBios: {}, milestones: [], worked: 0, reels: [], videoSeconds: 0, stories: [], lines: { ok: 0, later: 0, fallback: 0, dropped: 0 }, feelings: {}, ties: {}, memory: {} };
    if (!existsSync(this.path)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SocialsFile>;
      const posts = Array.isArray(parsed.posts) ? parsed.posts : [];
      // Feeds from before milestones count their work posts once.
      // Words written before dashes were cleaned out lose them too.
      for (const post of posts) {
        if (post.from?.kind !== "moment" && post.by !== "you") post.text = undash(post.text);
        for (const comment of post.comments ?? []) if (comment.by !== "you") comment.text = undash(comment.text);
      }
      const remembered = parsed.remembered ?? rememberedFrom(posts);
      return { ...empty, ...parsed, posts, remembered, feelings: parsed.feelings ?? {}, ties: parsed.ties ?? {}, memory: parsed.memory ?? {}, lines: { ...empty.lines, ...parsed.lines }, worked: typeof parsed.worked === "number" ? parsed.worked : posts.filter((post) => post.from?.kind === "work").length };
    } catch { return empty; }
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2));
    renameSync(temp, this.path);
  }
}

/// Feeds from before stage 3: each agent remembers what Mike said in comments on its posts.
function rememberedFrom(posts: SocialPost[]): Partial<Record<AgentId, Remembered[]>> {
  const all: Partial<Record<AgentId, Remembered[]>> = {};
  for (const post of posts) {
    if (post.by === "you" || post.by === "demesne") continue;
    for (const comment of post.comments) if (comment.by === "you" && !comment.request) (all[post.by] ??= []).push({ id: randomUUID(), text: clip(comment.text, 140), from: "comment", at: comment.at });
  }
  for (const key of Object.keys(all) as AgentId[]) all[key] = all[key]!.slice(-REMEMBER_MAX);
  return all;
}

/// Ask the writer once; a slow or failed call writes nothing.
export async function writeOnce(stream: (messages: ProviderMessage[], signal: AbortSignal) => AsyncIterable<{ type: string; delta?: string }>, messages: ProviderMessage[], timeoutMs = 25_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Writing the post took too long")), timeoutMs);
  let text = "";
  try {
    for await (const event of stream(messages, controller.signal)) {
      if (event.type === "text_delta" && typeof event.delta === "string") text += event.delta;
      if (text.length > 1200 || event.type === "tool_call_delta") break;
    }
  } catch { return null; } finally { clearTimeout(timer); }
  return text.trim() || null;
}
