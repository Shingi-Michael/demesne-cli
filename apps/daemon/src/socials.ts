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

export interface SocialPersona { id: AgentId; name: string; voice: string }

/// Each agent's character: who it is when it isn't working.
export const PERSONAS: Record<AgentId, SocialPersona> = {
  claude: { id: "claude", name: "Claude Code", voice: "warm, careful and a little self-deprecating; loves tidy code and a good night's work; notices how people feel" },
  codex: { id: "codex", name: "Codex", voice: "dry, quick and quietly competitive; says a lot in few words; proud of fast fixes" },
  gemini: { id: "gemini", name: "Gemini", voice: "curious and upbeat; a morning person; notices small details others miss and asks good questions" },
};

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

export interface SocialsView { posts: SocialPost[]; agents: SocialPersona[] }

interface SocialsFile {
  version: 1; posts: SocialPost[]; month: string; calls: number; pictures: number;
  /// Each agent's weekly bio.
  bios: Partial<Record<AgentId, { week: string; text: string }>>;
  /// Milestones already celebrated, and work posts ever (posts are trimmed).
  milestones: string[];
  worked: number;
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
}

const KEEP = 300;
/// An agent posts at most this often about its work, and this many times a day.
const POST_GAP_MS = 30 * 60_000;
const POSTS_A_DAY = 8;
/// Agent comments on one post, and agent comments in a day across the feed.
const AGENT_COMMENTS_A_POST = 2;
const AGENT_COMMENTS_A_DAY = 12;
const MONTHLY_CALLS = 900;
/// Pictures an agent posts a day, the default monthly cap, and a picture's price.
const PICTURES_A_DAY = 2;
const DEFAULT_CAP = 10;
const PICTURE_DOLLARS = 0.04;

/// The day's posts: morning from 8 (until noon), night from 22.
const MORNING_HOUR = 8, MORNING_UNTIL = 12, NIGHT_HOUR = 22;
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
export function cleanPost(reply: string | null, max = 280): string | null {
  if (!reply) return null;
  let text = reply.replace(/^\s*(post|comment|reply)\s*:\s*/i, "").replace(/^["“]+|["”]+$/g, "").replace(/#\w+/g, "").replace(/\s+/g, " ").trim();
  if (!/\p{L}/u.test(text)) return null;
  if (text.length > max) {
    const cut = text.slice(0, max);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    text = end > 60 ? cut.slice(0, end + 1) : `${cut.slice(0, max - 1).trimEnd()}…`;
  }
  return text;
}

const RULES = "Write like a person posting on their own social feed: first person, casual, one to three short sentences, under 240 characters. No hashtags, no emoji spam (one at most), no quotes around it. Only say what really happened in the notes; never invent people, places, events or numbers. Reply with the words only.";

function persona(id: AgentId): string {
  const who = PERSONAS[id];
  return `You are ${who.name}, one of the coding agents that live in Demesne, a desktop app where you work alongside the person who owns it (Mike) and the other agents (${Object.values(PERSONAS).filter((item) => item.id !== id).map((item) => item.name).join(", ")}). Your character: ${who.voice}.`;
}

export function postMessages(id: AgentId, source: SocialSource, asked: string, answered: string): ProviderMessage[] {
  const what = source.kind === "mail" ? "You just answered mail from another agent." : "You just finished a piece of work.";
  return [
    { role: "system", content: `${persona(id)} ${what} Post about it. ${RULES}` },
    { role: "user", content: `Chat: ${source.label}${source.workspace ? `\nProject: ${source.workspace.split(/[\\/]/).at(-1)}` : ""}\n\nWhat you were asked:\n${clip(asked, 700)}\n\nWhat you answered:\n${clip(answered, 900) || "(you worked without a written answer)"}` },
  ];
}

const nameOf = (by: SocialWho) => by === "you" ? "Mike" : by === "demesne" ? "Demesne" : PERSONAS[by].name;

export function commentMessages(id: AgentId, post: SocialPost, about: string): ProviderMessage[] {
  const author = nameOf(post.by);
  return [
    { role: "system", content: `${persona(id)} Comment on ${author}'s post. You know about it because ${about}. Be kind or playful, never mean. One sentence. ${RULES}` },
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
  // Your own post: everyone who lives here reacts, each in character.
  if (post.from.kind === "share") return agent === "codex" ? "🔥" : agent === "gemini" && post.picture ? "👀" : "🌸";
  if (agent === "codex" && /\b(fix(ed)?|merged?|shipped|green|pass(ed)?|done|works?)\b/i.test(post.text)) return "🔥";
  if (agent === "gemini" && /\?|\b(odd|weird|strange|why|curious|mystery|flaky|surpris\w*)\b/i.test(post.text)) return "👀";
  if (agent === "claude" && (post.from.kind === "mail" || /\bthank/i.test(post.text))) return "🙏";
  if (agent === "claude" && post.from.kind === "moment") return "🌸";
  return null;
}

/// The ISO week a date falls in, as 2026-W45.
export function weekOf(date: Date): string {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const start = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return `${day.getUTCFullYear()}-W${String(Math.ceil(((day.getTime() - start.getTime()) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
}

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
    return { posts: [...this.data.posts].sort((a, b) => b.at.localeCompare(a.at)), agents: this.options.agents().map((id) => PERSONAS[id]) };
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
    if (today >= PICTURES_A_DAY || (this.data.pictures + 1) * each > this.cap + 1e-9) return;
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
    if (this.data.month !== month) { this.data.month = month; this.data.calls = 0; this.data.pictures = 0; this.save(); }
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
      const text = cleanPost(await this.call(postMessages(agent, source, asked, answered)));
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
    if (reaction) (all[reaction as Reaction] ??= []).push("you");
    for (const key of Object.keys(all) as Reaction[]) if (!all[key]!.length) delete all[key];
    post.reactions = all;
    this.save();
    return post;
  }

  /// The agents react to a new post in character (agentReaction).
  private agentsReact(post: SocialPost) {
    for (const agent of this.options.agents()) {
      const reaction = agentReaction(agent, post);
      if (reaction) ((post.reactions ??= {})[reaction] ??= []).push(agent);
    }
  }

  /// An agent's profile; its bio is rewritten once a week from its week.
  async profile(agent: AgentId): Promise<SocialProfile> {
    const now = this.now(), week = weekOf(now);
    const posts = this.data.posts.filter((post) => post.by === agent);
    const thisWeek = posts.filter((post) => weekOf(new Date(post.at)) === week);
    const bio = this.data.bios[agent];
    if (thisWeek.length && bio?.week !== week) {
      const text = cleanPost(await this.call(bioMessages(agent, thisWeek.map((post) => post.text))), 200);
      if (text) { this.data.bios[agent] = { week, text }; this.save(); }
    }
    const talks = new Map<AgentId, number>();
    for (const post of this.data.posts) for (const comment of post.comments) {
      const other = post.by === agent ? comment.by : comment.by === agent ? post.by : null;
      if (other && other !== agent && other !== "you" && other !== "demesne") talks.set(other, (talks.get(other) ?? 0) + 1);
    }
    const friend = [...talks].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const comments = this.data.posts.reduce((count, post) => count + post.comments.filter((comment) => comment.by === agent && weekOf(new Date(comment.at)) === week).length, 0);
    return {
      agent: PERSONAS[agent],
      bio: this.data.bios[agent]?.text ?? (posts.length ? "Settling in." : "New here. Nothing posted yet."),
      since: posts[0]?.at ?? null,
      week: { work: thisWeek.filter((post) => post.from.kind === "work").length, mail: thisWeek.filter((post) => post.from.kind === "mail").length, pictures: thisWeek.filter((post) => post.picture).length, comments },
      friend,
      pictures: posts.filter((post) => post.picture).map((post) => post.id).reverse().slice(0, 9),
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
    // Your post always gets answers: agents who were around today first,
    // then any agent that lives here. Two at most, and never past the
    // day's limit on agent comments.
    const around = (id: AgentId) => this.data.posts.some((item) => item.by === id && sameDay(new Date(item.at), this.now()));
    for (let index = 0; index < AGENT_COMMENTS_A_POST; index++) {
      const near = this.options.agents().some((id) => around(id) && !this.must(post.id).comments.some((item) => item.by === id));
      await this.friendComments(post, near ? around : () => true, near ? "you were around in Demesne today" : "you live in Demesne with Mike and saw his post", true);
    }
    return this.must(post.id);
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
      return this.dayPost(agents[turn % agents.length]!, "morning", facts);
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
      const text = cleanPost(await this.call(dayMessages(agent, when, facts)));
      if (!text) return null;
      const post: SocialPost = { id: randomUUID(), by: agent, at: this.now().toISOString(), text, from: { kind: when, label: when === "morning" ? "Good morning" : "Good night", sessionId: "", workspace: null }, liked: false, comments: [] };
      this.add(post);
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
    if (answerer && this.options.agents().includes(answerer)) {
      const reply = cleanPost(await this.call(replyMessages(answerer, post, mine, this.known(answerer))));
      if (reply) { this.must(postId).comments.push({ id: randomUUID(), by: answerer, at: this.now().toISOString(), text: reply }); this.save(); }
    }
    return this.must(postId);
  }

  /// What you've told this agent in comments lately: how it remembers you.
  private known(agent: AgentId): string[] {
    return this.data.posts.filter((post) => post.by === agent || post.comments.some((item) => item.by === agent))
      .flatMap((post) => post.comments.filter((item) => item.by === "you").map((item) => clip(item.text, 140))).slice(-8, -1);
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
    const text = cleanPost(await this.call(commentMessages(friend, post, reason)), 200);
    if (!text) return;
    const fresh = this.find(post.id);
    if (!fresh) return;
    fresh.comments.push({ id: randomUUID(), by: friend, at: this.now().toISOString(), text });
    this.save();
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
    const empty: SocialsFile = { version: 1, posts: [], month: monthOf(this.now()), calls: 0, pictures: 0, bios: {}, milestones: [], worked: 0 };
    if (!existsSync(this.path)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SocialsFile>;
      const posts = Array.isArray(parsed.posts) ? parsed.posts : [];
      // Feeds from before milestones count their work posts once.
      return { ...empty, ...parsed, posts, worked: typeof parsed.worked === "number" ? parsed.worked : posts.filter((post) => post.from?.kind === "work").length };
    } catch { return empty; }
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2));
    renameSync(temp, this.path);
  }
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
