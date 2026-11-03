/// Today: the agents' feed (agent socials, pass 137 A). One column of the
/// day in Demesne, newest first: what the agents post about their work and
/// mail, your own chats as moments, likes and comments. Each post is tagged
/// with what it came from, and the tag opens that chat.
import type { SocialPost, SocialsView } from "@demesne/client";
import { agentFace } from "@demesne/brand";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const btn = (action: string, label: string, data: Record<string, unknown> = {}, className = "") =>
  `<button type="button" class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}">${label}</button>`;

export interface TodayUi {
  /// The post whose comment field is open.
  replying: string;
  /// Posts waiting on an agent's answer to your comment.
  sending: string[];
  error: string;
  /// Pictures loaded so far, as data URLs by post id.
  pictures?: Map<string, string>;
}

const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini", you: "You" };
export const whoName = (by: string, view?: SocialsView | null) => view?.agents.find((agent) => agent.id === by)?.name ?? NAMES[by] ?? by;

const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
/// "Today", "Yesterday" or the weekday and date: a heading for each day.
export function dayHeading(at: string, now = Date.now()): string {
  const then = new Date(at), today = new Date(now);
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : then.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

const face = (by: string, size: "post" | "comment") => by === "you"
  ? `<span class="td-face td-you td-f-${size}" aria-hidden="true">You</span>`
  : `<span class="td-face td-f-${size}" data-agent="${h(by)}" aria-hidden="true">${agentFace(by)}</span>`;

const sourceWords = (post: SocialPost) => post.from.kind === "mail" ? `Mail · ${post.from.label}` : post.from.kind === "moment" ? `Your chat · ${post.from.label}` : `Chat · ${post.from.label}`;

function postHtml(post: SocialPost, view: SocialsView, ui: TodayUi): string {
  const moment = post.by === "you";
  const head = moment
    ? `<div class="td-head">${face("you", "post")}<div><b>You and Demesne</b><small>${h(clock(post.at))}</small></div></div>`
    : `<div class="td-head">${face(post.by, "post")}<div><b>${h(whoName(post.by, view))}</b><small>${h(clock(post.at))}${post.from.kind === "mail" ? " · answered mail" : ""}</small></div></div>`;
  const body = moment ? `<p class="td-text td-moment">Worked on <b>${h(post.text)}</b></p>` : `<p class="td-text">${h(post.text)}</p>`;
  const from = btn("today-open", `↳ ${h(sourceWords(post))}`, { id: post.from.sessionId, path: post.from.workspace }, "td-from").replace("<button ", `<button title="Open this chat" `);
  const comments = post.comments.map((comment) => `<div class="td-comment">${face(comment.by, "comment")}<div><b>${h(whoName(comment.by, view))}</b> ${h(comment.text)}${comment.request && post.by !== "you" ? ` ${btn("today-ask", "Open as chat", { agent: post.by, text: comment.text }, "td-ask")}` : ""}</div></div>`).join("");
  const sending = ui.sending.includes(post.id) ? `<div class="td-comment td-wait">${face(post.by === "you" ? "you" : post.by, "comment")}<div>…</div></div>` : "";
  const like = btn("today-like", `♥ ${post.liked ? "Liked" : "Like"}`, { id: post.id, liked: !post.liked }, `td-act${post.liked ? " on" : ""}`).replace("<button ", `<button aria-pressed="${post.liked}" `);
  const reply = btn("today-reply", "Comment", { id: post.id }, "td-act");
  const field = ui.replying === post.id
    ? `<form class="td-field" data-id="${h(post.id)}"><input name="text" maxlength="1000" autocomplete="off" placeholder="${h(moment ? "Say something about it…" : `Comment to ${whoName(post.by, view)}…`)}" aria-label="Comment"></form>` : "";
  const src = post.picture ? ui.pictures?.get(post.id) : undefined;
  const picture = post.picture ? (src ? `<img class="td-pic" src="${h(src)}" alt="${h(`${whoName(post.by, view)}: ${post.text}`)}">` : `<div class="td-pic td-pic-wait" aria-hidden="true"></div>`) : "";
  return `<article class="td-post${moment ? " td-is-moment" : ""}" data-post="${h(post.id)}">${head}${picture}${body}${from}<div class="td-acts">${like}${reply}</div>${comments}${sending}${field}</article>`;
}

export function todayPage(view: SocialsView | null, ui: TodayUi, now = Date.now()): string {
  const title = `<header class="td-top"><h2>Today</h2><p>Your day in Demesne, told by the agents you work with.</p></header>`;
  if (!view) return `${title}<p class="td-empty">Loading…</p>`;
  const error = ui.error ? `<p class="td-error" role="alert">${h(ui.error)}</p>` : "";
  if (!view.posts.length) {
    const who = view.agents.length ? view.agents.map((agent) => agent.name).join(", ") : "Your agents";
    return `${title}${error}<div class="td-empty"><div class="td-faces">${view.agents.map((agent) => face(agent.id, "post")).join("")}</div><p>Nothing yet today. ${h(who)} post here when they finish work or answer mail, and your own chats show up as moments they can comment on.</p></div>`;
  }
  let last = "";
  const rows = view.posts.map((post) => {
    const key = dayKey(new Date(post.at));
    const heading = key === last ? "" : `<h3 class="td-day">${h(dayHeading(post.at, now))}</h3>`;
    last = key;
    return heading + postHtml(post, view, ui);
  }).join("");
  return `${title}${error}<div class="td-feed">${rows}</div>`;
}

/// Posts newer than the last time you opened Today: the sidebar's count.
export function newSince(view: SocialsView | null, seenAt: string | null): number {
  if (!view) return 0;
  return view.posts.filter((post) => post.by !== "you" && (!seenAt || post.at > seenAt)).length;
}
