import { expect, test } from "bun:test";
import type { SocialsView } from "@demesne/client";
import { agentMood, dayHeading, forYou, moodTitle, newSince, postMood, storyAgents, todayPage, unseenStories, weekHtml } from "../today-page.ts";
import { agentFace, FACE_MOODS } from "@demesne/brand";

const now = new Date("2026-11-03T22:00:00").getTime();
const view: SocialsView = {
  agents: [{ id: "claude", name: "Claude Code", voice: "" }, { id: "codex", name: "Codex", voice: "" }],
  posts: [
    { id: "p2", by: "claude", at: new Date("2026-11-03T21:00:00").toISOString(), text: "We shipped it <3", from: { kind: "work", label: "Desktop smoke", sessionId: "s1", workspace: "/p/demesne-cli" }, liked: true,
      comments: [{ id: "c1", by: "codex", at: new Date("2026-11-03T21:05:00").toISOString(), text: "Best kind of Tuesday." }, { id: "c2", by: "you", at: new Date("2026-11-03T21:06:00").toISOString(), text: "can you fix the tabs?", request: true }] },
    { id: "p1", by: "you", at: new Date("2026-11-02T10:00:00").toISOString(), text: "Tab names", from: { kind: "moment", label: "Tab names", sessionId: "s2", workspace: "/p/demesne-cli" }, liked: false, comments: [] },
  ],
};

test("the feed shows posts by day, escapes words, tags the source and offers the chat for a request", () => {
  const html = todayPage(view, { replying: "p2", sending: [], error: "" }, now);
  expect(html).toContain("Today");
  expect(html).toContain("Yesterday");
  expect(html).toContain("We shipped it &lt;3");
  expect(html).toContain("Chat · Desktop smoke");
  expect(html).toContain("Your chat · Tab names");
  expect(html).toContain('data-action="today-ask"');
  expect(html).toContain('class="td-field" data-id="p2"');
  expect(html).toContain('aria-pressed="true"');
});

test("an empty feed says what will show up there", () => {
  expect(todayPage({ posts: [], agents: view.agents }, { replying: "", sending: [], error: "" }, now)).toContain("Nothing yet today");
  expect(todayPage(null, { replying: "", sending: [], error: "" }, now)).toContain("Loading");
});

test("new posts are agents' posts since you last looked", () => {
  expect(newSince(view, null)).toBe(1);
  expect(newSince(view, new Date("2026-11-03T21:30:00").toISOString())).toBe(0);
});

test("day headings and faces", () => {
  expect(dayHeading(new Date(now).toISOString(), now)).toBe("Today");
  expect(agentFace("claude")).toContain("#e8a37c");
  expect(agentFace("someone")).toContain("<svg");
});

test("each agent is its own character, and every mood draws", () => {
  expect(agentFace("claude")).toContain("#f7a9c0"); // the sakura clip
  expect(agentFace("codex")).toContain("#2b2b33"); // glasses and headphones
  expect(agentFace("gemini")).toContain("#f6d36b"); // the star pin
  for (const mood of FACE_MOODS) for (const id of ["claude", "codex", "gemini", "someone"]) {
    const svg = agentFace(id, mood);
    expect(svg).toContain(`data-mood="${mood}"`);
    expect(svg).not.toContain("<text"); // shapes only: the PNG references have no fonts
  }
  expect(new Set(FACE_MOODS.map((mood) => agentFace("claude", mood))).size).toBe(FACE_MOODS.length);
});

test("faces are grown-up and grouped so a story can move them", () => {
  for (const id of ["claude", "codex", "gemini", "someone"]) {
    const svg = agentFace(id);
    for (const part of ["face-body", "face-head", "face-hair", "face-eyes"]) expect(svg).toContain(`class="${part}"`);
    expect(svg).toContain("C52.8 79.8 47.2 79.8 44 78"); // the chin
  }
  // Ids belong to the character, so many copies on one page agree.
  expect(agentFace("codex")).toContain('id="af-tile-codex"');
  expect(agentFace("someone")).toContain('id="af-face-grey"');
});

test("moods come only from what really happened", () => {
  const base = view.posts[0]!;
  const post = (over: Partial<typeof base>) => ({ ...base, liked: false, reactions: {}, ...over });
  expect(postMood(post({ from: { kind: "morning", label: "", sessionId: "", workspace: null } }))).toBe("wave");
  expect(postMood(post({ from: { kind: "night", label: "", sessionId: "", workspace: null } }))).toBe("sleepy");
  expect(postMood(post({ liked: true }))).toBe("happy");
  expect(postMood(post({ reactions: { "🔥": ["you"] } }))).toBe("happy");
  expect(postMood(post({ reactions: { "🔥": ["codex"] } }))).toBe("calm");
  expect(postMood(post({ text: "Merged the login fix." }))).toBe("happy");
  expect(postMood(post({}))).toBe("calm");
  expect(agentMood("claude", "working", view.posts, now)).toBe("focus");
  expect(agentMood("claude", "bad", view.posts, now)).toBe("stuck");
  expect(agentMood("claude", "", view.posts, now)).toBe("happy"); // you liked its post an hour ago
  expect(agentMood("claude", "", view.posts, now + 3 * 3_600_000)).toBe("calm");
  expect(agentMood("codex", "", view.posts, now)).toBe("calm");
  expect(todayPage(view, { replying: "", sending: [], error: "" }, now)).toContain('data-mood="happy"');
});

test("a post's picture shows once loaded, and Today never shows what pictures cost", () => {
  const withPicture: SocialsView = { ...view, posts: [{ ...view.posts[0]!, picture: true }] };
  const waiting = todayPage(withPicture, { replying: "", sending: [], error: "", pictures: new Map() }, now);
  expect(waiting).toContain("td-pic-wait");
  const shown = todayPage(withPicture, { replying: "", sending: [], error: "", pictures: new Map([["p2", "data:image/webp;base64,AA=="]]) }, now);
  expect(shown).toContain('<img class="td-pic" src="data:image/webp;base64,AA=="');
  expect(shown).not.toContain("$");
});

const ui = { replying: "", sending: [], error: "" };

test("reactions show who reacted, the picker offers five, and faces open profiles", () => {
  const reacted: SocialsView = { ...view, posts: [{ ...view.posts[0]!, reactions: { "🔥": ["codex", "you"] } }] };
  const html = todayPage(reacted, { ...ui, picking: "p2" }, now);
  expect(html).toContain('class="td-chip on"');
  expect(html).toContain('title="Codex, You"');
  expect(html.match(/class="td-pick"/g)).toHaveLength(5);
  expect(html).toContain('data-action="today-profile"');
});

test("good morning, good night, a share and a milestone each look like what they are", () => {
  const day = (kind: "morning" | "night" | "share" | "milestone", by: string) => ({ id: kind, by, at: new Date("2026-11-03T09:00:00").toISOString(), text: `${kind} words`, from: { kind, label: "", sessionId: "", workspace: null }, liked: false, comments: [] });
  const html = todayPage({ ...view, posts: [day("milestone", "demesne"), day("night", "codex"), day("share", "you"), day("morning", "claude")] }, ui, now);
  expect(html).toContain("td-post td-milestone");
  expect(html).toContain("td-petals");
  expect(html).toContain("td-post td-night");
  expect(html).toContain("Good morning");
  expect(html).toContain("#demesne-mark");
  expect(html).not.toContain("↳ Chat ·");
  expect(html).toContain('id="today-share"');
});

test("a profile shows the bio, the week and who it talks to", () => {
  const profile = { agent: { id: "claude", name: "Claude Code", voice: "Warm and careful." }, bio: "A week of tabs.", since: new Date("2026-10-20").toISOString(), week: { work: 3, mail: 1, pictures: 0, comments: 2 }, friend: "codex", pictures: ["p2"] };
  const html = todayPage(view, { ...ui, profile: { agent: "claude", data: profile }, pictures: new Map([["p2", "data:image/webp;base64,AA=="]]) }, now);
  expect(html).toContain("A week of tabs.");
  expect(html).toContain("3 things finished");
  expect(html).toContain("Talks most with");
  expect(html).toContain("‹ Today");
  expect(html).toContain("We shipped it &lt;3");
  expect(todayPage(view, { ...ui, profile: { agent: "claude", data: null } }, now)).toContain("Loading");
});

test("what's for you: an agent answering after your comment, or naming you", () => {
  const answered: SocialsView = { ...view, posts: [{ ...view.posts[0]!, comments: [...view.posts[0]!.comments, { id: "c3", by: "claude", at: now.toString(), text: "On it in a chat!" }] }, { ...view.posts[1]!, id: "p3", by: "gemini", text: "Mike had a long day." }] };
  const found = forYou(answered);
  expect([...found.keys()].sort()).toEqual(["c3", "p3"]);
  expect(found.has("c1")).toBe(false);
});

test("the Friday reel opens with its clip, then the week's posts in their own words, the numbers and a goodbye", () => {
  const reel = { id: "r1", week: "2026-W45", at: new Date("2026-11-06T17:00:00").toISOString(), frames: [{ postId: "p2", by: "claude", text: "We shipped it <3", picture: true }, { postId: "x", by: "codex", text: "Words only", picture: false }],
    numbers: { posts: 9, work: 6, mail: 2, nights: 1, moments: 0 }, scene: "A walk under the blossom.", clip: "ready" as const };
  const html = todayPage({ ...view, reel }, { ...ui, pictures: new Map([["p2", "data:image/webp;base64,AA=="]]), clips: new Map([["r1", "data:video/mp4;base64,AA=="]]) }, now);
  expect(html.indexOf("td-reel")).toBeLessThan(html.indexOf("td-feed"));
  expect(html.match(/class="td-fr[ "]/g)).toHaveLength(5);
  expect(html).toContain('<video class="td-clip"');
  expect(html).toContain("We shipped it &lt;3");
  expect(html).toContain("6</b><small>things finished");
  expect(html).not.toContain("of your chats");
  expect(html).toContain("Save video");
  expect(html).toContain("Nov 2 – Nov 8");
  const waiting = todayPage({ ...view, reel: { ...reel, clip: "making" as const } }, ui, now);
  expect(waiting).not.toContain("<video");
  expect(waiting).toContain("still being made");
});

test("a past week shows its line, what the agent did, its friend and its picture", () => {
  const ui = { replying: "", sending: [], error: "", pictures: new Map([["pic1", "data:image/webp;base64,AAAA"]]) };
  const html = weekHtml({ week: "2026-W44", start: "2026-10-26", line: "Calm week of tab fixes.", posts: 4, work: 2, mail: 1, friend: "codex", picture: "pic1" }, view, ui);
  expect(html).toContain("Week of");
  expect(html).toContain("Calm week of tab fixes.");
  expect(html).toContain("4 posts · 2 finished · 1 mail");
  expect(html).toContain("talked most with");
  expect(html).toContain("data:image/webp;base64,AAAA");
  const quiet = weekHtml({ week: "2026-W43", start: "2026-10-19", line: null, posts: 1, work: 0, mail: 0, friend: null, picture: null }, view, ui);
  expect(quiet).toContain("1 post");
  expect(quiet).not.toContain("<p>");
  expect(quiet).toContain("td-week-none");
});

test("stories: a row atop Today, new ones first with a ring, and a player", () => {
  const story = (by: string, at: string, text: string, mood: "focus" | "happy" = "focus") => ({ id: `${by}-${at}`, by, at: new Date(at).toISOString(), kind: "start", text, label: "Chat · demesne-cli", mood, sessionId: "s1" });
  const withStories: SocialsView = { ...view, stories: [story("claude", "2026-11-03T20:00:00", "Started on tabs"), story("codex", "2026-11-03T21:00:00", "Merged it: login", "happy")] };
  const seen = { codex: new Date("2026-11-03T21:00:00").toISOString() };
  expect([...unseenStories(withStories, seen)]).toEqual(["claude"]);
  expect(storyAgents(withStories, seen)).toEqual(["claude", "codex"]);
  const ui = { replying: "", sending: [], error: "", storySeen: seen };
  const page = todayPage(withStories, ui, now);
  expect(page).toContain('class="td-stories"');
  expect(page.indexOf("td-stories")).toBeLessThan(page.indexOf("td-feed"));
  expect(page.match(/class="td-ring"/g)).toHaveLength(1);
  expect(page.match(/class="td-ring seen"/g)).toHaveLength(1);
  expect(page).not.toContain('class="td-story"');
  const playing = todayPage(withStories, { ...ui, story: { agent: "codex", index: 0 } }, now);
  expect(playing).toContain('class="td-story"');
  expect(playing).toContain("Merged it: login");
  expect(playing).toContain('data-mood="happy"');
  expect(todayPage(view, ui, now)).not.toContain("td-stories");
});

test("pass 142 B: the face follows the mood, and the profile says why, who it's close to and what it remembers", () => {
  const happy = { mood: "happy" as const, strong: false, word: "happy", reasons: [{ why: "Merged the login fix", p: 3.1, e: 1, left: 5 }, { why: "Login test failed", p: -1.2, e: 0.5, left: 1 }] };
  expect(agentMood("claude", "", [], now, { claude: happy })).toBe("happy");
  expect(agentMood("claude", "working", [], now, { claude: happy })).toBe("focus");
  expect(moodTitle("Claude Code", happy)).toBe("Claude Code is happy\nMerged the login fix (5h left)\nLogin test failed (1h left)");
  const data = {
    agent: { id: "claude", name: "Claude Code", voice: "warm" }, bio: "Settling in.", since: null, week: { work: 1, mail: 0, pictures: 0, comments: 0 }, friend: "codex", pictures: [], weeks: [],
    feeling: happy,
    close: [{ agent: "codex", warmth: 0.4, bond: 0.2, lines: [{ why: "commented on my post", at: "2026-11-03T21:05:00Z" }] }],
    remembers: [{ id: "m1", text: "You like <short> answers", from: "comment" as const, at: "2026-11-03T21:06:00Z" }],
  };
  const html = todayPage(view, { replying: "", sending: [], error: "", profile: { agent: "claude", data } }, now);
  expect(html).toContain("Feeling happy");
  expect(html).toContain("Merged the login fix");
  expect(html).toContain('class="down">-1.2');
  expect(html).toContain("commented on my post");
  expect(html).toContain('style="width:40%"');
  expect(html).toContain("You like &lt;short&gt; answers");
  expect(html).toContain('data-action="today-forget"');
  expect(html).toContain('class="td-remember" data-agent="claude"');
});

test("stage 4: the profile shows last night's diary, the plan and what it lately thinks", () => {
  const today = new Date(now), yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  const data = {
    agent: { id: "codex", name: "Codex", voice: "dry" }, bio: "Fast.", since: null, week: { work: 1, mail: 0, pictures: 0, comments: 0 }, friend: null, pictures: [], weeks: [],
    feeling: { mood: "calm" as const, strong: false, word: "calm", reasons: [] }, close: [], remembers: [],
    diary: [{ day, text: "Found the redirect after two failures.", tomorrow: "Look at the flaky test" }],
    beliefs: [{ text: "Read the whole test first", since: day }],
  };
  const html = todayPage(view, { replying: "", sending: [], error: "", profile: { agent: "codex", data } }, now);
  expect(html).toContain("Found the redirect after two failures.");
  expect(html).toContain("Next: Look at the flaky test");
  expect(html).toContain("Lately thinks");
  expect(html).toContain("Read the whole test first");
});

test("pass 143 B: the profile says what the agent runs on, and Change opens its models in place", () => {
  const runs = { model: null, effort: "high" as const, toolModel: "gpt-6-astra", toolEffort: "medium", label: "gpt-6-astra · High",
    options: [{ id: "", label: "Tool default", note: "gpt-6-astra, from your Codex config" }, { id: "gpt-6.1-sol", label: "gpt-6.1-sol", note: "on your Codex plan" }], efforts: ["low" as const, "medium" as const, "high" as const] };
  const data = { agent: { id: "codex", name: "Codex", voice: "Dry." }, bio: "Quiet week.", since: null, week: { work: 0, mail: 0, pictures: 0, comments: 0 }, friend: null, pictures: [], runs };
  const closed = todayPage(view, { ...ui, profile: { agent: "codex", data } }, now);
  expect(closed).toContain("Runs on <b>gpt-6-astra · High</b>");
  expect(closed).toContain('data-action="today-model-open"');
  expect(closed).not.toContain("td-mp-row");
  const open = todayPage(view, { ...ui, modelOpen: true, profile: { agent: "codex", data } }, now);
  expect(open.match(/td-mp-row/g)?.length).toBe(2);
  // Nothing picked: the tool's default is the checked row; the High stop is lit.
  expect(open).toMatch(/td-mp-row on"[^>]*>[^]*?Tool default/);
  expect(open).toContain(">Thinking</span><span>High</span>");
  expect(open).toMatch(/class="on" data-action="today-model"[^>]*>High</);
  // Claude and Gemini take no thinking level here.
  const claude = todayPage(view, { ...ui, modelOpen: true, profile: { agent: "claude", data: { ...data, agent: { id: "claude", name: "Claude Code", voice: "" }, runs: { ...runs, efforts: null } } } }, now);
  expect(claude).not.toContain("Thinking");
});

test("pass 144 A: a desktop feed with cards beside it, words before pictures, pictures open full size", () => {
  const withPic = { ...view, runs: { claude: "Sonnet", codex: "gpt-6-astra · Medium" }, posts: [{ ...view.posts[0]!, picture: true, comments: [...view.posts[0]!.comments, { id: "c3", by: "codex", at: new Date("2026-11-03T21:07:00").toISOString(), text: "On it after lunch." }] }, view.posts[1]!] };
  const pictures = new Map([["p2", "data:image/webp;base64,AA=="]]);
  const html = todayPage(withPic, { replying: "", sending: [], error: "", pictures }, now);
  expect(html).toContain('<div class="td-layout"><div class="td-main">');
  expect(html).toContain('<aside class="td-side"');
  // This week, each agent with what it runs on, and replies to you.
  expect(html).toContain(">This week</h3>");
  expect(html).toContain("gpt-6-astra · Medium");
  expect(html).toMatch(/For you<\/h3>[^]*Codex<\/b> On it after lunch/);
  expect(html).toContain('data-action="today-jump"');
  // The words come before the picture, and the picture is a button that opens it.
  const post = html.slice(html.indexOf('data-post="p2"'));
  expect(post.indexOf("We shipped it")).toBeLessThan(post.indexOf("td-pic-open"));
  expect(html).not.toContain('class="td-zoom"');
  const zoomed = todayPage(withPic, { replying: "", sending: [], error: "", pictures, zoom: "p2" }, now);
  expect(zoomed).toContain('class="td-zoom"');
  // A profile stays one readable column.
  expect(todayPage(withPic, { replying: "", sending: [], error: "", profile: { agent: "claude", data: null } }, now)).toStartWith('<div class="td-solo">');
});
