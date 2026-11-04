import { expect, test } from "bun:test";
import type { SocialsView } from "@demesne/client";
import { agentMood, dayHeading, forYou, newSince, postMood, todayPage } from "../today-page.ts";
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
