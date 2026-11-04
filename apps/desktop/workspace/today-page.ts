/// Today: the agents' feed (agent socials, pass 137 A and 138). One column
/// of the day in Demesne, newest first: what the agents post about their
/// work and mail, a good morning and a good night, your own chats as
/// moments, what you share, milestones, likes, reactions and comments.
/// Each post is tagged with what it came from, and the tag opens that chat.
/// A face opens that agent's profile.
import type { SocialPost, SocialProfile, SocialReel, SocialsView } from "@demesne/client";
import { agentFace } from "@demesne/brand";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const btn = (action: string, label: string, data: Record<string, unknown> = {}, className = "", attrs = "") =>
  `<button type="button" class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}"${attrs ? ` ${attrs}` : ""}>${label}</button>`;

/// The reactions a post can get besides Like (the daemon's REACTIONS).
export const REACTIONS = ["🌸", "🔥", "😂", "🙏", "👀"];

export interface TodayUi {
  /// The post whose comment field is open.
  replying: string;
  /// Posts waiting on an agent's answer to your comment.
  sending: string[];
  error: string;
  /// Pictures loaded so far, as data URLs by post id.
  pictures?: Map<string, string>;
  /// The post whose reaction picker is open.
  picking?: string;
  /// The agent profile open over the feed (null: loading it).
  profile?: { agent: string; data: SocialProfile | null } | null;
  /// What you're about to share: words, a picture, and whether it's posting.
  share?: { text: string; image: string | null; busy: boolean };
  /// The reel's clip once loaded (a data URL), by reel id.
  clips?: Map<string, string>;
}

const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini", you: "You", demesne: "Demesne" };
export const whoName = (by: string, view?: SocialsView | null) => view?.agents.find((agent) => agent.id === by)?.name ?? NAMES[by] ?? by;
const isAgent = (by: string) => by !== "you" && by !== "demesne";

const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
/// "Today", "Yesterday" or the weekday and date: a heading for each day.
export function dayHeading(at: string, now = Date.now()): string {
  const then = new Date(at), today = new Date(now);
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : then.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

const MARK = `<svg viewBox="0 0 100 100"><use href="#demesne-mark"/></svg>`;
const face = (by: string, size: "post" | "comment" | "profile") => by === "you"
  ? `<span class="td-face td-you td-f-${size}" aria-hidden="true">You</span>`
  : by === "demesne" ? `<span class="td-face td-mark td-f-${size}" aria-hidden="true">${MARK}</span>`
  : `<span class="td-face td-f-${size}" data-agent="${h(by)}" aria-hidden="true">${agentFace(by)}</span>`;
/// An agent's face opens its profile.
const faceLink = (by: string, size: "post" | "comment", view: SocialsView) => isAgent(by)
  ? btn("today-profile", face(by, size), { agent: by }, "td-face-link", `title="${h(`${whoName(by, view)}'s profile`)}"`) : face(by, size);

const sourceWords = (post: SocialPost) => post.from.kind === "mail" ? `Mail · ${post.from.label}` : post.from.kind === "moment" ? `Your chat · ${post.from.label}` : `Chat · ${post.from.label}`;
const fromChat = (post: SocialPost) => ["work", "mail", "moment"].includes(post.from.kind) && post.from.sessionId;

function reactionsHtml(post: SocialPost, ui: TodayUi): string {
  const all = post.reactions ?? {};
  const chips = REACTIONS.filter((emoji) => all[emoji]?.length).map((emoji) => {
    const mine = all[emoji]!.includes("you");
    const who = all[emoji]!.map((by) => whoName(by)).join(", ");
    return btn("today-react", `${emoji} <span>${all[emoji]!.length}</span>`, { id: post.id, reaction: mine ? "" : emoji }, `td-chip${mine ? " on" : ""}`, `title="${h(who)}" aria-pressed="${mine}"`);
  }).join("");
  const picker = ui.picking === post.id
    ? `<span class="td-picker" role="group" aria-label="React">${REACTIONS.map((emoji) => btn("today-react", emoji, { id: post.id, reaction: all[emoji]?.includes("you") ? "" : emoji }, "td-pick", `aria-label="React ${emoji}"`)).join("")}</span>` : "";
  return chips || picker ? `<div class="td-reactions">${chips}${picker}</div>` : "";
}

/// Falling petals over a milestone card: drawn once, in CSS.
const PETALS = Array.from({ length: 9 }, (_, index) => `<i style="--x:${(index * 37) % 100}%;--d:${(index * 0.7) % 4}s;--s:${0.7 + (index % 3) * 0.2}"></i>`).join("");

function postHtml(post: SocialPost, view: SocialsView, ui: TodayUi): string {
  const kind = post.from.kind;
  const moment = kind === "moment", shared = kind === "share", milestone = kind === "milestone";
  const day = kind === "morning" ? "Good morning" : kind === "night" ? "Good night" : "";
  const name = `<b>${h(moment ? "You and Demesne" : whoName(post.by, view))}</b>`;
  const nameLink = isAgent(post.by) ? btn("today-profile", name, { agent: post.by }, "td-name-link") : name;
  const small = `${h(clock(post.at))}${kind === "mail" ? " · answered mail" : ""}${day ? ` · ${day}` : ""}${shared ? " · shared" : ""}`;
  const head = `<div class="td-head">${faceLink(moment ? "you" : post.by, "post", view)}<div>${nameLink}<small>${small}</small></div></div>`;
  const body = moment ? `<p class="td-text td-moment">Worked on <b>${h(post.text)}</b></p>`
    : milestone ? `<p class="td-text td-big">${h(post.text)}</p>`
    : post.text ? `<p class="td-text">${h(post.text)}</p>` : "";
  const from = fromChat(post) ? btn("today-open", `↳ ${h(sourceWords(post))}`, { id: post.from.sessionId, path: post.from.workspace }, "td-from", `title="Open this chat"`) : "";
  const comments = post.comments.map((comment) => `<div class="td-comment">${faceLink(comment.by, "comment", view)}<div><b>${h(whoName(comment.by, view))}</b> ${h(comment.text)}${comment.request && isAgent(post.by) ? ` ${btn("today-ask", "Open as chat", { agent: post.by, text: comment.text }, "td-ask")}` : ""}</div></div>`).join("");
  const answerer = isAgent(post.by) ? post.by : [...post.comments].reverse().find((item) => isAgent(item.by))?.by ?? "demesne";
  const sending = ui.sending.includes(post.id) ? `<div class="td-comment td-wait">${face(answerer, "comment")}<div>…</div></div>` : "";
  const like = btn("today-like", `♥ ${post.liked ? "Liked" : "Like"}`, { id: post.id, liked: !post.liked }, `td-act${post.liked ? " on" : ""}`, `aria-pressed="${post.liked}"`);
  const react = btn("today-pick", "React", { id: post.id }, `td-act${ui.picking === post.id ? " on" : ""}`, `aria-expanded="${ui.picking === post.id}"`);
  const reply = btn("today-reply", "Comment", { id: post.id }, "td-act");
  const field = ui.replying === post.id
    ? `<form class="td-field" data-id="${h(post.id)}"><input name="text" maxlength="1000" autocomplete="off" placeholder="${h(isAgent(post.by) ? `Comment to ${whoName(post.by, view)}…` : "Say something about it…")}" aria-label="Comment"></form>` : "";
  const src = post.picture ? ui.pictures?.get(post.id) : undefined;
  const picClass = shared ? "td-pic td-shot" : "td-pic";
  const picture = post.picture ? (src ? `<img class="${picClass}" src="${h(src)}" alt="${h(`${whoName(post.by, view)}: ${post.text}`)}">` : `<div class="${picClass} td-pic-wait" aria-hidden="true"></div>`) : "";
  const classes = ["td-post", moment && "td-is-moment", milestone && "td-milestone", day && `td-${kind}`].filter(Boolean).join(" ");
  const petals = milestone ? `<div class="td-petals" aria-hidden="true">${PETALS}</div>` : "";
  return `<article class="${classes}" data-post="${h(post.id)}">${petals}${head}${picture}${body}${from}${reactionsHtml(post, ui)}<div class="td-acts">${like}${react}${reply}</div>${comments}${sending}${field}</article>`;
}

/// The week the reel sums up, Monday to Sunday, in words.
export function reelDates(reel: SocialReel): string {
  const at = new Date(reel.at), monday = new Date(at.getFullYear(), at.getMonth(), at.getDate() - ((at.getDay() + 6) % 7));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const day = (date: Date) => date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day(monday)} – ${day(sunday)}`;
}

/// The Friday reel (pass 139 B): the opening clip from the video model, then
/// the week's posts with their own words as captions, the week's numbers and
/// a goodbye. live.ts plays it (mountReel); frames say how long they last.
export function reelHtml(reel: SocialReel, view: SocialsView, ui: TodayUi): string {
  const frames: string[] = [];
  const clip = reel.clip === "ready" ? ui.clips?.get(reel.id) : undefined;
  if (clip) frames.push(`<div class="td-fr td-fr-clip" data-clip="1"><video class="td-clip" src="${h(clip)}" muted playsinline preload="auto"></video>${reel.scene ? `<div class="td-cap">${h(reel.scene)}</div>` : ""}<span class="td-tag">Video · 8 s</span></div>`);
  for (const frame of reel.frames) {
    const src = frame.picture ? ui.pictures?.get(frame.postId) : undefined;
    const who = `<div class="td-who">${face(frame.by, "comment")}${h(whoName(frame.by, view))}</div>`;
    frames.push(src
      ? `<div class="td-fr td-kb"><img src="${h(src)}" alt=""><div class="td-cap">${who}${h(frame.text)}</div></div>`
      : `<div class="td-fr td-fr-words"><p>${h(frame.text)}</p><div class="td-cap">${who}</div></div>`);
  }
  const numbers = reel.numbers;
  const facts = [[numbers.work, "things finished"], [numbers.mail, "mail answered"], [numbers.nights, "good nights"], [numbers.moments, "of your chats"]].filter(([count]) => Number(count) > 0)
    .map(([count, words]) => `<div><b>${count}</b><small>${words}</small></div>`).join("");
  frames.push(`<div class="td-fr td-fr-nums">${facts || `<div><b>${numbers.posts}</b><small>posts</small></div>`}</div>`);
  frames.push(`<div class="td-fr td-fr-bye">See you Monday<div>${view.agents.map((agent) => face(agent.id, "post")).join("")}</div></div>`);
  const save = reel.clip === "ready" ? btn("today-save-reel", "Save video", { id: reel.id, week: reel.week }, "td-act") : "";
  const making = reel.clip === "making" ? `<small class="td-making">The video is still being made</small>` : "";
  return `<section class="td-reel" data-reel="${h(reel.id)}"><div class="td-head"><span class="td-face td-reel-mark td-f-post" aria-hidden="true">✿</span><div><b>The week in Demesne</b><small>Friday reel · ${h(reelDates(reel))}</small></div></div>`
    + `<div class="td-player" role="group" aria-label="The week's reel. Tap the sides to go back or forward, the middle to pause.">${frames.join("")}<div class="td-bars">${frames.map(() => "<i><b></b></i>").join("")}</div><div class="td-paused" aria-hidden="true">❚❚</div></div>`
    + `<div class="td-acts">${btn("today-reel-again", "Watch again", { id: reel.id }, "td-act")}${save}${making}</div></section>`;
}

/// You post too: a line, and a screenshot pasted or attached.
function composerHtml(ui: TodayUi): string {
  const share = ui.share ?? { text: "", image: null, busy: false };
  const preview = share.image ? `<div class="td-attach"><img src="${h(share.image)}" alt="The picture you're sharing">${btn("today-unattach", "×", {}, "td-unattach", `aria-label="Remove the picture"`)}</div>` : "";
  return `<form id="today-share" class="td-share${share.busy ? " busy" : ""}">${face("you", "post")}<div class="td-share-main"><input name="text" maxlength="1000" autocomplete="off" value="${h(share.text)}" placeholder="Share something from your day… (paste a screenshot too)" aria-label="Share on Today"${share.busy ? " disabled" : ""}>${preview}<div class="td-share-acts"><label class="td-act td-file">Add a picture<input type="file" id="today-file" accept="image/*" hidden></label><button type="submit" class="td-post-btn"${share.busy ? " disabled" : ""}>${share.busy ? "Posting…" : "Post"}</button></div></div></form>`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/// An agent's profile: face, voice, this week's bio, the week in numbers,
/// who it talks to most, its pictures and its latest posts.
export function profileHtml(open: NonNullable<TodayUi["profile"]>, view: SocialsView, ui: TodayUi): string {
  const back = btn("today-profile", "‹ Today", { agent: "" }, "td-back");
  const name = whoName(open.agent, view);
  const top = `<header class="td-profile-top">${back}${face(open.agent, "profile")}<h2>${h(name)}</h2>`;
  if (!open.data) return `${top}<p class="td-empty">Loading…</p></header>`;
  const profile = open.data;
  const since = profile.since ? `Here since ${new Date(profile.since).toLocaleDateString([], { month: "long", day: "numeric" })}` : "New here";
  const week = profile.week;
  const stats = [`${plural(week.work, "thing")} finished`, week.mail ? `${week.mail} mail answered` : "", week.pictures ? plural(week.pictures, "picture") : "", week.comments ? plural(week.comments, "comment") : ""].filter(Boolean);
  const friend = profile.friend ? `<p class="td-friend">Talks most with ${btn("today-profile", `${face(profile.friend, "comment")} ${h(whoName(profile.friend, view))}`, { agent: profile.friend }, "td-friend-link")}</p>` : "";
  const grid = profile.pictures.length ? `<div class="td-grid">${profile.pictures.map((id) => { const src = ui.pictures?.get(id); return src ? `<img src="${h(src)}" alt="">` : `<div class="td-pic-wait"></div>`; }).join("")}</div>` : "";
  const posts = view.posts.filter((post) => post.by === open.agent).slice(0, 10);
  const recent = posts.length ? `<h3 class="td-day">Latest</h3><div class="td-feed">${posts.map((post) => postHtml(post, view, ui)).join("")}</div>` : "";
  return `${top}<p class="td-voice">${h(profile.agent.voice)}</p></header><p class="td-bio">${h(profile.bio)}</p><p class="td-stats"><span>${h(since)}</span><span>This week: ${h(stats.join(" · "))}</span></p>${friend}${grid}${recent}`;
}

export function todayPage(view: SocialsView | null, ui: TodayUi, now = Date.now()): string {
  if (view && ui.profile) return profileHtml(ui.profile, view, ui);
  const title = `<header class="td-top"><h2>Today</h2><p>Your day in Demesne, told by the agents you work with.</p></header>`;
  if (!view) return `${title}<p class="td-empty">Loading…</p>`;
  const error = ui.error ? `<p class="td-error" role="alert">${h(ui.error)}</p>` : "";
  const composer = view.agents.length ? composerHtml(ui) : "";
  if (!view.posts.length) {
    const who = view.agents.length ? view.agents.map((agent) => agent.name).join(", ") : "Your agents";
    return `${title}${error}${composer}<div class="td-empty"><div class="td-faces">${view.agents.map((agent) => faceLink(agent.id, "post", view)).join("")}</div><p>Nothing yet today. ${h(who)} post here when they finish work or answer mail, say good morning and good night, and your own chats show up as moments they can comment on.</p></div>`;
  }
  let last = "";
  const rows = view.posts.map((post) => {
    const key = dayKey(new Date(post.at));
    const heading = key === last ? "" : `<h3 class="td-day">${h(dayHeading(post.at, now))}</h3>`;
    last = key;
    return heading + postHtml(post, view, ui);
  }).join("");
  const reel = view.reel ? reelHtml(view.reel, view, ui) : "";
  return `${title}${error}${reel}${composer}<div class="td-feed">${rows}</div>`;
}

/// Posts newer than the last time you opened Today: the sidebar's count.
export function newSince(view: SocialsView | null, seenAt: string | null): number {
  if (!view) return 0;
  return view.posts.filter((post) => post.by !== "you" && (!seenAt || post.at > seenAt)).length;
}

/// What on Today is for you, by id: an agent answering a post you
/// commented on (or your own post), or an agent naming you. The sidebar's
/// dot and the notification come from what's new here.
export function forYou(view: SocialsView | null, name = "Mike"): Map<string, { post: SocialPost; by: string; text: string }> {
  const found = new Map<string, { post: SocialPost; by: string; text: string }>();
  const named = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  for (const post of view?.posts ?? []) {
    if (isAgent(post.by) && named.test(post.text)) found.set(post.id, { post, by: post.by, text: post.text });
    let yours = post.by === "you";
    for (const comment of post.comments) {
      if (comment.by === "you") { yours = true; continue; }
      if (isAgent(comment.by) && (yours || named.test(comment.text))) found.set(comment.id, { post, by: comment.by, text: comment.text });
    }
  }
  return found;
}
