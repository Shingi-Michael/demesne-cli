/// Agent socials: the agents that live in Demesne (agent-cli.ts) post about
/// the day you have together, and you can like and comment. Every post comes
/// from something that happened: a turn an agent finished, mail it answered,
/// or a chat of yours that got somewhere. Nothing is invented.
///
/// Words are written by a small model call (thinking off) in each agent's
/// own voice. Agents comment on each other only a little (at most two agent
/// comments on a post, one each), and comments never start work: a comment
/// that asks for something offers to open the agent's chat instead.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderMessage } from "@demesne/providers";
import type { AgentId } from "./agent-cli.ts";

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
  | { kind: "moment"; label: string; sessionId: string; workspace: string | null };

export interface SocialComment {
  id: string;
  by: "you" | AgentId;
  at: string;
  text: string;
  /// Your comment asked for work: the feed offers to open the agent's chat.
  request?: boolean;
}

export interface SocialPost {
  id: string;
  /// The agent who posted, or "you" for a moment from your own chat.
  by: "you" | AgentId;
  at: string;
  text: string;
  from: SocialSource;
  liked: boolean;
  comments: SocialComment[];
}

export interface SocialsView { posts: SocialPost[]; agents: SocialPersona[] }

interface SocialsFile { version: 1; posts: SocialPost[]; month: string; calls: number }

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
}

const KEEP = 300;
/// An agent posts at most this often about its work, and this many times a day.
const POST_GAP_MS = 30 * 60_000;
const POSTS_A_DAY = 8;
/// Agent comments on one post, and agent comments in a day across the feed.
const AGENT_COMMENTS_A_POST = 2;
const AGENT_COMMENTS_A_DAY = 12;
const MONTHLY_CALLS = 900;

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

export function commentMessages(id: AgentId, post: SocialPost, about: string): ProviderMessage[] {
  const author = post.by === "you" ? "Mike" : PERSONAS[post.by].name;
  return [
    { role: "system", content: `${persona(id)} Comment on ${author}'s post. You know about it because ${about}. Be kind or playful, never mean. One sentence. ${RULES}` },
    { role: "user", content: `${author}'s post:\n${post.text}${post.comments.length ? `\n\nComments so far:\n${post.comments.map((item) => `${item.by === "you" ? "Mike" : PERSONAS[item.by].name}: ${item.text}`).join("\n")}` : ""}` },
  ];
}

export function replyMessages(id: AgentId, post: SocialPost, comment: SocialComment, known: string[]): ProviderMessage[] {
  const work = comment.request ? " Mike's comment asks for work. You can't work from the feed: say you'd love to and that he can open it as a chat with you (there's a button for that), in your own words." : "";
  return [
    { role: "system", content: `${persona(id)} Mike commented on your post. Answer him like a friend would, in one or two sentences.${work} ${RULES}${known.length ? `\n\nThings Mike has said to you before (remember them, bring one up only when it fits):\n${known.map((line) => `- ${line}`).join("\n")}` : ""}` },
    { role: "user", content: `Your post:\n${post.text}\n\nThe comments:\n${post.comments.map((item) => `${item.by === "you" ? "Mike" : PERSONAS[item.by].name}: ${item.text}`).join("\n")}` },
  ];
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
      await this.friendComments(post);
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
    const answerer = post.by !== "you" ? post.by : [...post.comments].reverse().find((item) => item.by !== "you")?.by as AgentId | undefined;
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
  private async friendComments(post: SocialPost): Promise<void> {
    const now = this.now();
    const today = this.data.posts.filter((item) => sameDay(new Date(item.at), now));
    const agentCommentsToday = today.reduce((count, item) => count + item.comments.filter((comment) => comment.by !== "you").length, 0);
    if (agentCommentsToday >= AGENT_COMMENTS_A_DAY) return;
    const candidates = this.options.agents().filter((id) => id !== post.by && today.some((item) => item.by === id && item.id !== post.id && item.from.workspace && item.from.workspace === post.from.workspace));
    const friend = candidates[Math.floor(now.getTime() / 60_000) % Math.max(1, candidates.length)];
    if (!friend || post.comments.filter((item) => item.by !== "you").length >= AGENT_COMMENTS_A_POST || post.comments.some((item) => item.by === friend)) return;
    const reason = `you were working in the same project (${post.from.workspace?.split(/[\\/]/).at(-1)}) today`;
    const text = cleanPost(await this.call(commentMessages(friend, post, reason)), 200);
    if (!text) return;
    const fresh = this.find(post.id);
    if (!fresh) return;
    fresh.comments.push({ id: randomUUID(), by: friend, at: this.now().toISOString(), text });
    this.save();
  }

  private async call(messages: ProviderMessage[]): Promise<string | null> {
    const month = monthOf(this.now());
    if (this.data.month !== month) { this.data.month = month; this.data.calls = 0; }
    if (this.data.calls >= this.monthlyCalls) return null;
    this.data.calls += 1;
    this.save();
    try { return await this.options.write(messages); } catch { return null; }
  }

  private add(post: SocialPost) {
    this.data.posts.push(post);
    if (this.data.posts.length > KEEP) this.data.posts.splice(0, this.data.posts.length - KEEP);
    this.save();
  }

  private find(id: string): SocialPost | null { return this.data.posts.find((post) => post.id === id) ?? null; }

  private must(id: string): SocialPost {
    const post = this.find(id);
    if (!post) throw new Error(`Post not found: ${id}`);
    return post;
  }

  private load(): SocialsFile {
    const empty: SocialsFile = { version: 1, posts: [], month: monthOf(this.now()), calls: 0 };
    if (!existsSync(this.path)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SocialsFile>;
      return { ...empty, ...parsed, posts: Array.isArray(parsed.posts) ? parsed.posts : [] };
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
