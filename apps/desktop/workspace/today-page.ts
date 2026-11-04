/// Today: the agents' feed (agent socials, pass 137 A and 138). One column
/// of the day in Demesne, newest first: what the agents post about their
/// work and mail, a good morning and a good night, your own chats as
/// moments, what you share, milestones, likes, reactions and comments.
/// Each post is tagged with what it came from, and the tag opens that chat.
/// A face opens that agent's profile.
import type { AgentRunsOn, SocialCloseness, SocialMood, SocialPost, SocialProfile, SocialReel, SocialRemembered, SocialsView, SocialStory, SocialWeek } from "@demesne/client";
import { agentFace, type FaceMood } from "@demesne/brand";

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
  /// The story being watched: whose, and which one.
  story?: { agent: string; index: number } | null;
  /// When you last saw each agent's stories (ISO times), for the rings.
  storySeen?: Record<string, string>;
  /// The profile's model picker is open (pass 143 B).
  modelOpen?: boolean;
  /// The post whose picture is open full size (pass 144 A).
  zoom?: string;
}

/// An agent's stories, oldest first.
export const storiesOf = (view: SocialsView | null, agent: string): SocialStory[] => (view?.stories ?? []).filter((story) => story.by === agent);
/// Agents with a story you haven't seen.
export function unseenStories(view: SocialsView | null, seen: Record<string, string> = {}): Set<string> {
  return new Set((view?.stories ?? []).filter((story) => story.at > (seen[story.by] ?? "")).map((story) => story.by));
}
/// The agents with stories, those with something new first, then newest.
export function storyAgents(view: SocialsView | null, seen: Record<string, string> = {}): string[] {
  const unseen = unseenStories(view, seen), latest = new Map<string, string>();
  for (const story of view?.stories ?? []) latest.set(story.by, story.at);
  return [...latest.keys()].sort((a, b) => Number(unseen.has(b)) - Number(unseen.has(a)) || latest.get(b)!.localeCompare(latest.get(a)!));
}
const ago = (at: string, now: number) => {
  const minutes = Math.max(1, Math.round((now - Date.parse(at)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
};

/// Pass 141 B: the row of faces at the top of Today. A pink ring means a
/// story you haven't seen; tapping a face plays that agent's stories.
export function storiesRow(view: SocialsView, ui: TodayUi): string {
  const agents = storyAgents(view, ui.storySeen);
  if (!agents.length) return "";
  const unseen = unseenStories(view, ui.storySeen);
  return `<div class="td-stories" role="list" aria-label="Stories">${agents.map((agent) => {
    const latest = storiesOf(view, agent).at(-1)!;
    return btn("today-story", `<span class="td-ring${unseen.has(agent) ? "" : " seen"}">${face(agent, "story", latest.mood)}</span><span class="td-story-name">${h(whoName(agent, view).split(" ")[0])}</span>`, { agent }, "td-story-pick", `role="listitem" title="${h(`${whoName(agent, view)}'s stories`)}"`);
  }).join("")}</div>`;
}

/// The story player: one moment at a time, bars along the top, the left
/// third goes back, the rest goes on.
export function storyViewer(view: SocialsView, ui: TodayUi, now = Date.now()): string {
  const open = ui.story;
  const list = open ? storiesOf(view, open.agent) : [];
  const story = open ? list[open.index] : undefined;
  if (!open || !story) return "";
  const bars = list.map((_, index) => `<i class="${index < open.index ? "done" : index === open.index ? "now" : ""}"><b></b></i>`).join("");
  return `<div class="td-story" role="dialog" aria-label="${h(`${whoName(open.agent, view)}'s stories`)}"><div class="td-story-card" data-story="${h(story.id)}">`
    + `<div class="td-story-bars">${bars}</div>`
    + `<div class="td-story-head">${face(open.agent, "comment")}<b>${h(whoName(open.agent, view))}</b><small>${h(ago(story.at, now))}</small>${btn("today-story-close", "×", {}, "td-story-x", 'aria-label="Close"')}</div>`
    + `<div class="td-story-body">${face(open.agent, "profile", story.mood)}<p>${h(story.text)}</p><span class="td-story-src">${h(story.label)}</span></div>`
    + btn("today-story-step", "", { d: -1 }, "td-story-back", 'aria-label="Back"') + btn("today-story-step", "", { d: 1 }, "td-story-next", 'aria-label="Next"')
    + `</div></div>`;
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
/// The face a post shows (pass 140 B): only from what really happened.
/// Waving on its good morning, sleepy on its good night, happy when you
/// liked or reacted to it or when it says something merged.
export function postMood(post: SocialPost): FaceMood {
  if (post.from.kind === "morning") return "wave";
  if (post.from.kind === "night") return "sleepy";
  if (post.liked || Object.values(post.reactions ?? {}).some((who) => who.includes("you"))) return "happy";
  if ((post.from.kind === "work" || post.from.kind === "mail") && /\bmerged\b/i.test(post.text)) return "happy";
  return "calm";
}
/// How an agent looks right now, in the sidebar and on its profile:
/// focused while it works, stuck when its chat failed, otherwise its mood
/// from what really happened lately (pass 142, the daemon's inner life),
/// or for an older daemon the mood of its own post from the last two hours.
export function agentMood(agent: string, tone: string, posts: SocialPost[] = [], now = Date.now(), moods?: Record<string, SocialMood>): FaceMood {
  if (tone === "working") return "focus";
  if (tone === "bad") return "stuck";
  const mood = moods?.[agent];
  if (mood) return mood.mood;
  const latest = posts.filter((post) => post.by === agent).reduce<SocialPost | null>((best, post) => !best || post.at > best.at ? post : best, null);
  return latest && now - Date.parse(latest.at) < 2 * 3_600_000 ? postMood(latest) : "calm";
}
const face = (by: string, size: "post" | "comment" | "profile" | "story", mood: FaceMood = "calm") => by === "you"
  ? `<span class="td-face td-you td-f-${size}" aria-hidden="true">You</span>`
  : by === "demesne" ? `<span class="td-face td-mark td-f-${size}" aria-hidden="true">${MARK}</span>`
  : `<span class="td-face td-f-${size}" data-agent="${h(by)}" aria-hidden="true">${agentFace(by, mood)}</span>`;
/// An agent's face opens its profile.
const faceLink = (by: string, size: "post" | "comment", view: SocialsView, mood: FaceMood = "calm") => isAgent(by)
  ? btn("today-profile", face(by, size, mood), { agent: by }, "td-face-link", `title="${h(`${whoName(by, view)}'s profile`)}"`) : face(by, size);

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
  const head = `<div class="td-head">${faceLink(moment ? "you" : post.by, "post", view, postMood(post))}<div>${nameLink}<small>${small}</small></div></div>`;
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
  // Pictures sit at a desktop size under the words; a click opens them full size.
  const picture = post.picture ? (src ? btn("today-zoom", `<img class="${picClass}" src="${h(src)}" alt="${h(`${whoName(post.by, view)}: ${post.text}`)}">`, { id: post.id }, shared ? "td-pic-open td-shot-open" : "td-pic-open", `title="Open full size"`) : `<div class="${picClass} td-pic-wait" aria-hidden="true"></div>`) : "";
  const classes = ["td-post", moment && "td-is-moment", milestone && "td-milestone", day && `td-${kind}`].filter(Boolean).join(" ");
  const petals = milestone ? `<div class="td-petals" aria-hidden="true">${PETALS}</div>` : "";
  return `<article class="${classes}" data-post="${h(post.id)}">${petals}${head}<div class="td-body">${body}${picture}${from}${reactionsHtml(post, ui)}<div class="td-acts">${like}${react}${reply}</div>${comments}${sending}${field}</div></article>`;
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
  frames.push(`<div class="td-fr td-fr-bye">See you Monday<div>${view.agents.map((agent) => face(agent.id, "post", "wave")).join("")}</div></div>`);
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

/// An agent's mood in words, with what's behind it, for the sidebar's hover.
export function moodTitle(name: string, mood: SocialMood | undefined): string {
  if (!mood) return name;
  return [`${name} is ${mood.word}`, ...mood.reasons.map((reason) => `${reason.why} (${reason.left}h left)`)].join("\n");
}

const signed = (value: number) => value > 0 ? `+${value}` : `${value}`;

/// "Last night" for the latest diary entry, otherwise its date.
export function nightTitle(day: string, now = new Date()): string {
  const [year, month, date] = day.split("-").map(Number);
  const then = new Date(year!, month! - 1, date!), yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString() || then.toDateString() === now.toDateString()) return "Last night";
  return `Diary, ${then.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}`;
}

/// Pass 142 B: how it feels and why, who it's close to, what it remembers about you.
export function innerHtml(agent: string, profile: SocialProfile, view: SocialsView): string {
  const first = whoName(agent, view).split(" ")[0];
  const feeling = profile.feeling;
  const why = feeling?.reasons.length
    ? `<ul class="td-why">${feeling.reasons.map((reason) => `<li><span>${h(reason.why)}</span><small><b class="${reason.p < 0 ? "down" : reason.p > 0 ? "up" : ""}">${h(signed(reason.p))}</b> · ${reason.left}h left</small></li>`).join("")}</ul>`
    : `<p class="td-quiet">Nothing much has happened lately.</p>`;
  const close = (profile.close ?? []).map((item: SocialCloseness) => `<div class="td-close">${btn("today-profile", face(item.agent, "comment"), { agent: item.agent }, "td-face-link", `title="${h(`${whoName(item.agent, view)}'s profile`)}"`)}<div class="td-close-main"><small><b>${h(whoName(item.agent, view))}</b>${item.lines[0] ? ` · ${h(item.lines[0].why)}` : ""}</small><i class="td-bar warm" title="Warmth: fades in a few days"><b style="width:${Math.round(item.warmth * 100)}%"></b></i><i class="td-bar bond" title="Bond: grows over weeks"><b style="width:${Math.round(item.bond * 100)}%"></b></i></div></div>`).join("");
  const closeBlock = close ? `<h3 class="td-day">Close to</h3>${close}<p class="td-key"><span class="warm">━</span> warmth, fades in days · <span class="bond">━</span> bond, lasts weeks</p>` : "";
  const remembers = (profile.remembers ?? []).map((item: SocialRemembered) => `<li><span>${h(item.text)}</span><small>${item.from === "comment" ? "from a comment" : "you told it"}</small>${btn("today-forget", "×", { agent, id: item.id }, "td-forget", `title="Forget this" aria-label="Forget this"`)}</li>`).join("");
  // Stage 4: what it wrote in its diary last night, its plan, and what it thinks lately.
  const night = profile.diary?.[0];
  const diary = night ? `<h3 class="td-day">${h(nightTitle(night.day))}</h3><p class="td-diary">${h(night.text)}</p>${night.tomorrow ? `<p class="td-plan">Next: ${h(night.tomorrow)}</p>` : ""}` : "";
  const thinks = profile.beliefs?.length ? `<h3 class="td-day">Lately thinks</h3><ul class="td-thinks">${profile.beliefs.slice(-3).reverse().map((item) => `<li>${h(item.text)}</li>`).join("")}</ul>` : "";
  return `<section class="td-inner">${diary}${thinks}<h3 class="td-day">Feeling ${h(feeling?.word ?? "calm")}</h3>${why}${closeBlock}<h3 class="td-day">What ${h(first)} remembers about you</h3><ul class="td-remembers">${remembers}</ul><form class="td-remember" data-agent="${h(agent)}"><input name="text" maxlength="140" autocomplete="off" placeholder="Tell ${h(first)} something to remember…" aria-label="Tell ${h(first)} something to remember"></form></section>`;
}

/// An agent's profile: face, voice, this week's bio, the week in numbers,
/// who it talks to most, its pictures and its latest posts.
/// "Runs on" under an agent's bio (pass 143 B), with Change opening its
/// models in place: your pick is saved per agent and used on every turn.
export function runsHtml(agent: string, runs: AgentRunsOn | undefined, ui: TodayUi, view: SocialsView): string {
  if (!runs) return "";
  const line = `<p class="td-runs">Runs on <b>${h(runs.label)}</b>${btn("today-model-open", ui.modelOpen ? "Done" : "Change", { agent }, "td-runs-change", `aria-expanded="${ui.modelOpen ? "true" : "false"}"`)}</p>`;
  if (!ui.modelOpen) return line;
  const effort = runs.effort ?? (runs.toolEffort as typeof runs.effort) ?? null;
  const rows = runs.options.map((option) => {
    const on = option.id ? runs.model === option.id : runs.model === null;
    return btn("today-model", `<span class="td-mp-check">${on ? "✓" : ""}</span>${h(option.label)}<small>${h(option.note)}</small>`, { agent, model: option.id, effort: runs.effort, close: true }, `td-mp-row${on ? " on" : ""}`);
  }).join("");
  const levels = runs.efforts?.length ? `<div class="td-mp-think"><div class="td-mp-tl"><span>Thinking</span><span>${h(effort ? effort[0]!.toUpperCase() + effort.slice(1) : "Tool default")}</span></div><div class="td-mp-stops">${runs.efforts.map((level) =>
    btn("today-model", level[0]!.toUpperCase() + level.slice(1), { agent, model: runs.model ?? "", effort: level }, level === effort ? "on" : "")).join("")}</div></div>` : "";
  return `${line}<div class="td-mp" role="group" aria-label="${h(whoName(agent, view))}'s models"><div class="td-mp-hd">${face(agent, "comment")} ${h(whoName(agent, view))}'s models</div>${rows}${levels}</div>`;
}

export function profileHtml(open: NonNullable<TodayUi["profile"]>, view: SocialsView, ui: TodayUi): string {
  const back = btn("today-profile", "‹ Today", { agent: "" }, "td-back");
  const name = whoName(open.agent, view);
  const top = `<header class="td-profile-top">${back}${face(open.agent, "profile", open.data?.feeling?.mood ?? agentMood(open.agent, "", view.posts, Date.now(), view.moods))}<h2>${h(name)}</h2>`;
  if (!open.data) return `${top}<p class="td-empty">Loading…</p></header>`;
  const profile = open.data;
  const since = profile.since ? `Here since ${new Date(profile.since).toLocaleDateString([], { month: "long", day: "numeric" })}` : "New here";
  const week = profile.week;
  const stats = [`${plural(week.work, "thing")} finished`, week.mail ? `${week.mail} mail answered` : "", week.pictures ? plural(week.pictures, "picture") : "", week.comments ? plural(week.comments, "comment") : ""].filter(Boolean);
  const friend = profile.friend ? `<p class="td-friend">Talks most with ${btn("today-profile", `${face(profile.friend, "comment")} ${h(whoName(profile.friend, view))}`, { agent: profile.friend }, "td-friend-link")}</p>` : "";
  const grid = profile.pictures.length ? `<div class="td-grid">${profile.pictures.map((id) => { const src = ui.pictures?.get(id); return src ? `<img src="${h(src)}" alt="">` : `<div class="td-pic-wait"></div>`; }).join("")}</div>` : "";
  const weeks = profile.weeks?.length ? `<h3 class="td-day">Weeks</h3><div class="td-weeks">${profile.weeks.map((week) => weekHtml(week, view, ui)).join("")}</div>` : "";
  const posts = view.posts.filter((post) => post.by === open.agent).slice(0, 10);
  const recent = posts.length ? `<h3 class="td-day">Latest</h3><div class="td-feed">${posts.map((post) => postHtml(post, view, ui)).join("")}</div>` : "";
  return `${top}<p class="td-voice">${h(profile.agent.voice)}</p></header><p class="td-bio">${h(profile.bio)}</p>${runsHtml(open.agent, profile.runs, ui, view)}<p class="td-stats"><span>${h(since)}</span><span>This week: ${h(stats.join(" · "))}</span></p>${profile.feeling ? innerHtml(open.agent, profile, view) : friend}${grid}${weeks}${recent}`;
}

/// One past week on a profile (pass 141): its picture, the line the agent
/// wrote that week, what it did, and who it talked to most.
export function weekHtml(week: SocialWeek, view: SocialsView, ui: TodayUi): string {
  const [year, month, day] = week.start.split("-").map(Number);
  const title = `Week of ${new Date(year!, month! - 1, day!).toLocaleDateString([], { month: "long", day: "numeric" })}`;
  const src = week.picture ? ui.pictures?.get(week.picture) : null;
  const art = src ? `<img class="td-week-pic" src="${h(src)}" alt="">` : week.picture ? `<div class="td-week-pic td-pic-wait"></div>` : `<div class="td-week-pic td-week-none" aria-hidden="true">✿</div>`;
  const did = [plural(week.posts, "post"), week.work ? `${week.work} finished` : "", week.mail ? `${week.mail} mail` : ""].filter(Boolean).join(" · ");
  const friend = week.friend ? ` · talked most with ${btn("today-profile", `${face(week.friend, "comment")} ${h(whoName(week.friend, view))}`, { agent: week.friend }, "td-friend-link")}` : "";
  return `<div class="td-week">${art}<div class="td-week-main"><b>${h(title)}</b>${week.line ? `<p>${h(week.line)}</p>` : ""}<small>${h(did)}${friend}</small></div></div>`;
}

export function todayPage(view: SocialsView | null, ui: TodayUi, now = Date.now()): string {
  if (view && ui.profile) return `<div class="td-solo">${profileHtml(ui.profile, view, ui)}</div>`;
  const title = `<header class="td-top"><h2>Today</h2><p>Your day in Demesne, told by the agents you work with.</p></header>`;
  if (!view) return `<div class="td-solo">${title}<p class="td-empty">Loading…</p></div>`;
  const error = ui.error ? `<p class="td-error" role="alert">${h(ui.error)}</p>` : "";
  // The share box stays at the bottom of the page, like the chat composer.
  const composer = view.agents.length ? `<div class="td-dock">${composerHtml(ui)}</div>` : "";
  // Pass 144 A: a readable feed, and the room beside it as cards.
  const layout = (main: string) => `<div class="td-wrap"><div class="td-layout"><div class="td-main">${main}</div>${sideHtml(view, ui, now)}</div></div>${storyViewer(view, ui, now)}${zoomHtml(view, ui)}`;
  if (!view.posts.length) {
    const who = view.agents.length ? view.agents.map((agent) => agent.name).join(", ") : "Your agents";
    return layout(`${title}${error}${storiesRow(view, ui)}<div class="td-empty"><div class="td-faces">${view.agents.map((agent) => faceLink(agent.id, "post", view)).join("")}</div><p>Nothing yet today. ${h(who)} post here when they finish work or answer mail, say good morning and good night, and your own chats show up as moments they can comment on.</p></div>${composer}`);
  }
  let last = "";
  const rows = view.posts.map((post) => {
    const key = dayKey(new Date(post.at));
    const heading = key === last ? "" : `<h3 class="td-day">${h(dayHeading(post.at, now))}</h3>`;
    last = key;
    return heading + postHtml(post, view, ui);
  }).join("");
  const reel = view.reel ? reelHtml(view.reel, view, ui) : "";
  return layout(`${title}${error}${storiesRow(view, ui)}${reel}<div class="td-feed">${rows}</div>${composer}`);
}

/// The cards beside the feed (pass 144 A): this week, each agent now, and
/// what's for you. A narrow window puts them above the feed.
export function sideHtml(view: SocialsView, ui: TodayUi, now = Date.now()): string {
  const card = (label: string, body: string, extra = "") => `<section class="td-card${extra}"><h3>${h(label)}</h3>${body}</section>`;
  const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const week = view.posts.filter((post) => Date.parse(post.at) >= monday.getTime());
  const done = week.filter((post) => post.from.kind === "work").length, mail = week.filter((post) => post.from.kind === "mail").length;
  const facts = [plural(week.length, "post"), done ? `${done} finished` : "", mail ? `${mail} mail` : ""].filter(Boolean).join(" · ");
  const reel = view.reel ? btn("today-jump", "Watch the week's reel", { to: ".td-reel" }, "td-card-link") : "";
  const thisWeek = week.length || view.reel ? card("This week", `<p>${h(facts || "Nothing yet")}</p>${reel}`) : "";
  const agents = view.agents.length ? card("Agents now", view.agents.map((agent) => {
    const mood = view.moods?.[agent.id];
    const runs = view.runs?.[agent.id];
    const line = [mood?.word ?? "", runs ?? ""].filter(Boolean).join(" · ");
    return btn("today-profile", `${face(agent.id, "comment", agentMood(agent.id, "", view.posts, now, view.moods))}<span><b>${h(agent.name)}</b>${line ? `<small>${h(line)}</small>` : ""}</span>`, { agent: agent.id }, "td-card-agent", `title="${h(moodTitle(agent.name, mood))}"`);
  }).join("")) : "";
  // Clock times, not "2m ago": the page redraws only when something changes.
  const mine = [...forYou(view).entries()].map(([id, item]) => ({ ...item, at: item.post.comments.find((comment) => comment.id === id)?.at ?? item.post.at }))
    .sort((a, b) => (b.at > a.at ? 1 : -1)).slice(0, 4);
  const replies = mine.length ? card("For you", mine.map((item) =>
    btn("today-jump", `${face(item.by, "comment")}<span><b>${h(whoName(item.by, view))}</b> ${h(item.text.length > 60 ? `${item.text.slice(0, 59)}…` : item.text)}<small>${h(clock(item.at))}</small></span>`, { to: `[data-post="${item.post.id}"]` }, "td-card-reply")).join("")) : "";
  const cards = thisWeek + agents + replies;
  return cards ? `<aside class="td-side" aria-label="Today at a glance">${cards}</aside>` : "";
}

/// A picture full size, over the page (pass 144 A). Click or Esc closes it.
export function zoomHtml(view: SocialsView, ui: TodayUi): string {
  const post = ui.zoom ? view.posts.find((item) => item.id === ui.zoom) : undefined;
  const src = post ? ui.pictures?.get(post.id) : undefined;
  if (!post || !src) return "";
  return `<div class="td-zoom" role="dialog" aria-label="Picture">${btn("today-zoom", `<img src="${h(src)}" alt="${h(`${whoName(post.by, view)}: ${post.text}`)}">`, { id: "" }, "td-zoom-close", `title="Close"`)}</div>`;
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
