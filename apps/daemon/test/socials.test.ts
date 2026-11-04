import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderMessage } from "@demesne/providers";
import { agentReaction, asksForWork, cleanPost, mondayOf, shareChoice, SocialFeed, weekOf, writeOnce, type DayFacts } from "../src/socials.ts";
import type { AgentId } from "../src/agent-cli.ts";
import { existsSync, readFileSync } from "node:fs";
import { picturePrompt, pictureMaker, type PictureMaker } from "../src/social-pictures.ts";
import { clipMaker, referenceSvg, videoModel, type ClipMaker } from "../src/social-reel.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });

function feed(replies: Array<string | null>, options: { agents?: AgentId[]; now?: () => Date; monthlyCalls?: number; picture?: PictureMaker | null; monthlyDollars?: number; dayFacts?: () => DayFacts; clip?: ClipMaker | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "demesne-socials-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const calls: ProviderMessage[][] = [];
  const path = join(dir, "socials.json");
  const make = () => new SocialFeed(path, {
    agents: () => options.agents ?? ["claude", "codex", "gemini"],
    now: options.now,
    monthlyCalls: options.monthlyCalls,
    picture: options.picture,
    monthlyDollars: options.monthlyDollars,
    dayFacts: options.dayFacts,
    clip: options.clip,
    write: async (messages) => { calls.push(messages); return replies.length ? replies.shift()! : "ok"; },
  });
  return { social: make(), calls, reopen: make };
}

const work = (sessionId: string, workspace = "/p/demesne-cli") => ({ kind: "work" as const, label: "Desktop smoke", sessionId, workspace });

describe("cleanPost", () => {
  test("strips labels, quotes and hashtags, and keeps it short", () => {
    expect(cleanPost('Post: "Fixed the flaky test. #win"')).toBe("Fixed the flaky test.");
    expect(cleanPost("   ")).toBeNull();
    expect(cleanPost("Fixed the tabs — finally. Took 3–4 tries — worth it")).toBe("Fixed the tabs, finally. Took 3-4 tries, worth it");
    expect(cleanPost("Done—")).toBe("Done");
    expect(cleanPost(null)).toBeNull();
    const long = cleanPost(`${"Long day. ".repeat(40)}`, 100)!;
    expect(long.length).toBeLessThanOrEqual(100);
  });
});

describe("asksForWork", () => {
  test("a request offers the chat; a friendly word doesn't", () => {
    expect(asksForWork("can you fix the sidebar too?")).toBe(true);
    expect(asksForWork("Fix the build next")).toBe(true);
    expect(asksForWork("nice one, that was a nasty bug")).toBe(false);
  });
});

describe("SocialFeed", () => {
  test("an agent's finished turn becomes its post, written in its voice from what happened", async () => {
    const { social, calls } = feed(["Two hours on one flaky test. Worth it."]);
    const post = await social.noteAgentTurn("claude", work("s1"), "Why does the smoke fail?", "The sidebar waits for a Linux-only animation.");
    expect(post?.text).toBe("Two hours on one flaky test. Worth it.");
    expect(post?.by).toBe("claude");
    expect(calls[0]![0]!.content).toContain("You are Claude Code");
    expect(calls[0]![1]!.content).toContain("Linux-only animation");
    expect(social.view().posts).toHaveLength(1);
  });

  test("posts survive a restart", async () => {
    const { social, reopen } = feed(["Shipped."]);
    await social.noteAgentTurn("codex", work("s1"), "a", "b");
    expect(reopen().view().posts[0]!.text).toBe("Shipped.");
  });

  test("an agent posts about work at most every half hour, but mail always gets a post", async () => {
    let now = new Date("2026-11-03T10:00:00");
    const { social } = feed([], { now: () => now });
    expect(await social.noteAgentTurn("claude", work("s1"), "a", "b")).not.toBeNull();
    now = new Date("2026-11-03T10:10:00");
    expect(await social.noteAgentTurn("claude", work("s1"), "c", "d")).toBeNull();
    expect(await social.noteAgentTurn("claude", { ...work("s1"), kind: "mail" }, "mail", "answer")).not.toBeNull();
    now = new Date("2026-11-03T10:45:00");
    expect(await social.noteAgentTurn("claude", work("s1"), "e", "f")).not.toBeNull();
  });

  test("another agent comments only when it worked in the same project today, and never more than twice", async () => {
    let now = new Date("2026-11-03T09:00:00");
    const { social } = feed([], { now: () => now });
    await social.noteAgentTurn("codex", work("x1", "/p/other"), "a", "b");
    now = new Date("2026-11-03T10:00:00");
    const lonely = await social.noteAgentTurn("claude", work("c1"), "a", "b");
    expect(lonely!.comments).toHaveLength(0);
    now = new Date("2026-11-03T11:00:00");
    await social.noteAgentTurn("gemini", work("g1"), "a", "b");
    const latest = social.view().posts.find((post) => post.by === "gemini")!;
    expect(latest.comments.map((comment) => comment.by)).toEqual(["claude"]);
  });

  test("your comment gets the agent's answer; one asking for work is marked so the feed offers the chat", async () => {
    const { social, calls } = feed(["Posted.", "Ha, thank you!", "I'd love to. Open it as a chat with me."]);
    const post = (await social.noteAgentTurn("claude", work("s1"), "a", "b"))!;
    const after = await social.comment(post.id, "nice one");
    expect(after.comments.map((comment) => [comment.by, comment.text])).toEqual([["you", "nice one"], ["claude", "Ha, thank you!"]]);
    const asked = await social.comment(post.id, "can you also fix the tabs?");
    expect(asked.comments[2]).toMatchObject({ by: "you", request: true });
    expect(calls.at(-1)![0]!.content).toContain("can't work from the feed");
    // It remembers what you said before.
    expect(calls.at(-1)![0]!.content).toContain("nice one");
  });

  test("your own chat is a moment, one a day per chat, and follows the chat's name", async () => {
    const { social, calls } = feed([]);
    const first = (await social.noteMoment("s9", "Tab names", "/p/demesne-cli"))!;
    const again = (await social.noteMoment("s9", "Tab names and order", "/p/demesne-cli"))!;
    expect(again.id).toBe(first.id);
    expect(again.text).toBe("Tab names and order");
    expect(await social.noteMoment("s10", "New chat", "/p/demesne-cli")).toBeNull();
    expect(calls).toHaveLength(0);
    expect(social.like(first.id, true).liked).toBe(true);
  });

  test("the monthly allowance stops the writing, not the feed", async () => {
    const { social } = feed([], { monthlyCalls: 1 });
    expect(await social.noteAgentTurn("claude", work("s1"), "a", "b")).not.toBeNull();
    expect(await social.noteAgentTurn("codex", work("s2"), "a", "b")).toBeNull();
  });

  test("a writer that fails posts nothing", async () => {
    const { social } = feed([null]);
    expect(await social.noteAgentTurn("claude", work("s1"), "a", "b")).toBeNull();
    expect(social.view().posts).toHaveLength(0);
  });
});

describe("writeOnce", () => {
  test("joins the streamed words", async () => {
    async function* stream() { yield { type: "text_delta", delta: "Hello " }; yield { type: "text_delta", delta: "there" }; }
    expect(await writeOnce(() => stream(), [])).toBe("Hello there");
  });
});

describe("pictures", () => {
  test("an agent's post gets a picture of the moment, at most two a day, counted against the cap", async () => {
    let now = new Date("2026-11-03T09:00:00");
    const made: string[] = [];
    const { social } = feed([], { now: () => now, picture: async (agent, post) => { made.push(`${agent}:${post}`); return new Uint8Array([1, 2, 3]); } });
    const first = (await social.noteAgentTurn("claude", work("s1"), "a", "b"))!;
    expect(first.picture).toBe(true);
    expect(existsSync(social.picturePath(first.id)!)).toBe(true);
    expect([...readFileSync(social.picturePath(first.id)!)]).toEqual([1, 2, 3]);
    now = new Date("2026-11-03T10:00:00");
    await social.noteAgentTurn("claude", work("s1"), "c", "d");
    now = new Date("2026-11-03T11:00:00");
    const third = (await social.noteAgentTurn("claude", work("s1"), "e", "f"))!;
    expect(third.picture).toBeUndefined();
    expect(made).toHaveLength(2);
    expect(social.spend()).toMatchObject({ on: true, pictures: 2, dollars: 0.08, cap: 10 });
    // Moments of yours never cost a picture.
    expect((await social.noteMoment("s9", "Tab names", "/p/demesne-cli"))!.picture).toBeUndefined();
  });

  test("the monthly cap stops pictures before it is passed, and a failed picture isn't counted", async () => {
    let now = new Date("2026-11-03T09:00:00");
    let fail = true;
    const { social } = feed([], { now: () => now, monthlyDollars: 0.05, picture: async () => fail ? null : new Uint8Array([9]) });
    expect((await social.noteAgentTurn("claude", work("s1"), "a", "b"))!.picture).toBeUndefined();
    expect(social.spend().pictures).toBe(0);
    fail = false;
    expect((await social.noteAgentTurn("codex", work("s2"), "a", "b"))!.picture).toBe(true);
    expect((await social.noteAgentTurn("gemini", work("s3"), "a", "b"))!.picture).toBeUndefined();
    // A new month starts the count again.
    now = new Date("2026-12-01T09:00:00");
    expect(social.spend().pictures).toBe(0);
  });

  test("without an image model there are no pictures", () => {
    expect(feed([]).social.spend().on).toBe(false);
  });

  test("the picture model gets the agent's face as the reference and a safe, drawn prompt", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const make = pictureMaker({ url: "https://images.example/v1/", model: "img-1", apiKey: "k" }, {
      facePng: async () => new Uint8Array([7]),
      shrink: async (data) => new Uint8Array([...data, 0]),
      request: (async (url: string, init: RequestInit) => {
        seen.push({ url: String(url), body: init.body });
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([4, 5]).toString("base64") }] }), { status: 200 });
      }) as unknown as typeof fetch,
    })!;
    expect([...(await make("claude", "Fixed the flaky test"))!]).toEqual([4, 5, 0]);
    expect(seen[0]!.url).toBe("https://images.example/v1/images/edits");
    expect((seen[0]!.body as FormData).get("prompt")).toContain("Fixed the flaky test");
    // Only gpt-image models are asked for medium quality, which the cap's price assumes.
    expect((seen[0]!.body as FormData).get("quality")).toBeNull();
    const asked: unknown[] = [];
    const gpt = pictureMaker({ url: "https://i.example", model: "gpt-image-1" }, { facePng: async () => new Uint8Array([1]), shrink: async (data) => data,
      request: (async (_url: string, init: RequestInit) => { asked.push((init.body as FormData).get("quality")); return new Response(JSON.stringify({ data: [{ b64_json: "AQ==" }] })); }) as unknown as typeof fetch })!;
    await gpt("claude", "x");
    expect(asked).toEqual(["medium"]);
    expect(picturePrompt("codex", "x")).toContain("mint-green");
    expect(picturePrompt("codex", "x")).toContain("no real people");
    for (const agent of ["claude", "codex", "gemini"] as const) {
      const prompt = picturePrompt(agent, "x");
      expect(prompt).toContain("grown adult");
      expect(prompt).toContain("Never a child");
      expect(prompt).not.toMatch(/young|rosy/i);
    }
  });

  test("a provider without edits gets a plain generation; one that refuses both makes nothing", async () => {
    const urls: string[] = [];
    const ok = pictureMaker({ url: "https://i.example", model: "m" }, { facePng: async () => new Uint8Array([1]), shrink: async (data) => data,
      request: (async (url: string) => { urls.push(String(url)); return String(url).endsWith("/edits") ? new Response("no", { status: 404 }) : new Response(JSON.stringify({ data: [{ b64_json: "AQ==" }] })); }) as unknown as typeof fetch })!;
    expect([...(await ok("gemini", "x"))!]).toEqual([1]);
    expect(urls).toEqual(["https://i.example/images/edits", "https://i.example/images/generations"]);
    const no = pictureMaker({ url: "https://i.example", model: "m" }, { facePng: async () => new Uint8Array([1]), shrink: async (data) => data,
      request: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch })!;
    expect(await no("gemini", "x")).toBeNull();
    expect(pictureMaker({}, { facePng: async () => new Uint8Array(), shrink: async (data) => data })).toBeNull();
  });
});

describe("pass 138", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  test("agents react in character, and your reaction is one at a time", async () => {
    let at = new Date("2026-11-03T10:00:00");
    const { social } = feed(["Fixed the flaky smoke test, merged."], { now: () => at });
    const post = (await social.noteAgentTurn("claude", work("s1"), "fix it", "fixed"))!;
    expect(post.reactions?.["🔥"]).toEqual(["codex"]);
    expect(social.react(post.id, "🌸").reactions?.["🌸"]).toEqual(["you"]);
    const moved = social.react(post.id, "😂");
    expect(moved.reactions?.["🌸"]).toBeUndefined();
    expect(moved.reactions?.["😂"]).toEqual(["you"]);
    expect(social.react(post.id, null).reactions?.["😂"]).toBeUndefined();
    expect(() => social.react(post.id, "💩")).toThrow();
    at = new Date(at.getTime() + 1);
    expect(agentReaction("gemini", { ...post, by: "codex", text: "Why is this flaky?" })).toBe("👀");
    expect(agentReaction("claude", { ...post, by: "codex" })).toBeNull();
  });

  test("a profile's bio is written once a week, from that week, with a friend and week numbers", async () => {
    let at = new Date("2026-11-03T10:00:00");
    const { social, calls } = feed(["Codex was here.", "Shipped the tabs.", "Nice work.", "Careful week of tab fixes."], { now: () => at, agents: ["claude", "codex"] });
    await social.noteAgentTurn("codex", work("s0"), "tests", "done");
    at = new Date("2026-11-03T10:40:00");
    await social.noteAgentTurn("claude", work("s1"), "tabs", "done");
    at = new Date("2026-11-03T11:00:00");
    await settle();
    const first = await social.profile("claude");
    expect(first.bio).toBe("Careful week of tab fixes.");
    expect(first.friend).toBe("codex");
    expect(first.week.work).toBe(1);
    const asked = calls.length;
    await social.profile("claude");
    expect(calls.length).toBe(asked);
    expect((await social.profile("gemini")).bio).toContain("Nothing posted");
    expect(weekOf(new Date("2026-11-03T10:00:00"))).toBe("2026-W45");
  });

  test("a profile looks back on past weeks with only what really happened", async () => {
    let at = new Date("2026-10-27T10:00:00"); // Tuesday of week 44
    const { social } = feed(["Tabs post", "Nice tabs!", "Calm week of tab fixes.", "Mail post", "Busy mail week."], { now: () => at, agents: ["claude", "codex"] });
    await social.noteAgentTurn("claude", work("s1"), "tabs", "done");
    at = new Date("2026-10-27T10:40:00");
    await social.noteAgentTurn("codex", work("s1"), "tabs", "done");
    await settle();
    at = new Date("2026-10-28T09:00:00");
    expect((await social.profile("claude")).weeks).toEqual([]); // this week is the top of the profile, not a past week
    at = new Date("2026-11-04T09:00:00"); // week 45
    const profile = await social.profile("claude");
    const past = profile.weeks[0]!;
    expect(profile.weeks).toHaveLength(1);
    expect(past.week).toBe("2026-W44");
    expect(past.start).toBe("2026-10-26");
    expect(past.posts).toBeGreaterThan(0);
    expect(past.work).toBe(1);
    expect(past.picture).toBeNull();
    expect(past.line).toBeTruthy(); // the line it wrote that week, kept when this week's replaced it
    expect(mondayOf(new Date("2026-11-08T23:00:00"))).toBe("2026-11-02");
  });

  test("stories come from real events in their own words, last a day, and never repeat", async () => {
    let at = new Date("2026-11-03T10:00:00");
    const { social, calls } = feed([], { now: () => at, agents: ["claude", "codex"] });
    const started = social.noteStory("codex", "start", { title: "Fix the login redirect", sessionId: "s1", workspace: "/p/demesne-cli" });
    expect(started).toMatchObject({ by: "codex", kind: "start", text: "Started on Fix the login redirect", label: "Chat · demesne-cli", mood: "focus" });
    expect(social.noteStory("codex", "start", { title: "Fix the login redirect", sessionId: "s1" })).toBeNull(); // the same thing twice
    expect(social.noteStory("codex", "failed", { title: "Fix the login redirect", sessionId: "s1" })?.mood).toBe("stuck");
    expect(social.noteStory("codex", "done", { title: "Fix the login redirect", sessionId: "s1", happy: true })).toMatchObject({ text: "Merged it: Fix the login redirect", mood: "happy" });
    expect(social.noteStory("gemini", "start", { title: "x" })).toBeNull(); // not installed here
    expect(calls).toHaveLength(0); // stories never call the model
    expect(social.view().stories?.map((story) => story.kind)).toEqual(["start", "failed", "done"]);
    at = new Date("2026-11-04T10:30:00");
    expect(social.view().stories).toEqual([]);
    for (let index = 0; index < 10; index++) social.noteStory("claude", "start", { title: `job ${index}`, sessionId: `s${index}` });
    expect(social.view().stories).toHaveLength(8);
  });

  test("you share a line: agents who were around today see it first, and each chooses to comment, react or pass", async () => {
    let at = new Date("2026-11-03T10:00:00");
    const { social, calls } = feed(["Long day.", "Looks great, Mike!", "REACT"], { now: () => at, agents: ["claude", "codex", "gemini"] });
    await social.noteAgentTurn("claude", work("s1"), "a", "b");
    at = new Date("2026-11-03T12:00:00");
    const before = calls.length;
    const post = await social.share("Finally got the tabs right", null);
    expect(calls.length - before).toBe(2); // two agents see it, never all of them
    expect(calls.at(-2)![0]!.content).toContain("answer only PASS");
    expect(post.by).toBe("you");
    expect(post.from.kind).toBe("share");
    expect(post.comments.map((comment) => comment.by)).toEqual(["claude"]);
    expect(Object.values(post.reactions ?? {}).flat().sort()).toHaveLength(2);
    await expect(social.share("   ")).rejects.toThrow();
  });

  test("agents can scroll past your post", async () => {
    const at = new Date("2026-11-03T09:00:00");
    const { social } = feed(["PASS", "pass."], { now: () => at, agents: ["claude", "gemini"] });
    const post = await social.share("First post of the day", null);
    expect(post.comments).toEqual([]);
    expect(post.reactions ?? {}).toEqual({});
    expect(shareChoice("Nice one!")).toBe("comment");
    expect(shareChoice("REACT")).toBe("react");
    expect(shareChoice(null)).toBe("pass");
  });

  test("your post can be answered on a quiet day too, even past the agents' daily comment limit", async () => {
    const at = new Date("2026-11-03T09:00:00");
    const { social } = feed(["Nice!", "Love it."], { now: () => at, agents: ["claude", "gemini"] });
    const post = await social.share("First post of the day", null);
    expect(post.comments.map((comment) => comment.text)).toEqual(["Nice!", "Love it."]);
  });

  test("good morning and good night come once a day, from real chats", async () => {
    let at = new Date("2026-11-03T07:00:00");
    const facts: DayFacts = { recent: ["Fix tabs (demesne-cli)"], today: ["Fix tabs (demesne-cli)"] };
    const { social, calls } = feed(["Morning! Tabs today.", "Post one", "Post two", "Night all."], { now: () => at, agents: ["claude", "codex"], dayFacts: () => facts });
    expect(await social.tick()).toBeNull();
    at = new Date("2026-11-03T08:30:00");
    const morning = await social.tick();
    expect(morning?.from.kind).toBe("morning");
    expect(calls.at(-1)![1]!.content).toContain("Fix tabs");
    expect(await social.tick()).toBeNull();
    at = new Date("2026-11-03T22:10:00");
    expect(await social.tick()).toBeNull();
    at = new Date("2026-11-03T12:00:00");
    await social.noteAgentTurn("claude", work("s1"), "a", "b");
    at = new Date("2026-11-03T13:00:00");
    await social.noteAgentTurn("codex", work("s2", "/p/other"), "a", "b");
    at = new Date("2026-11-03T22:10:00");
    const night = await social.tick();
    expect(night?.from.kind).toBe("night");
    expect(night?.by).not.toBe(morning?.by);
    expect(await social.tick()).toBeNull();
  });

  test("milestones celebrate only the biggest count reached, once", async () => {
    let at = new Date("2026-11-03T00:00:00");
    const { social } = feed([], { now: () => at, agents: ["claude"] });
    for (let index = 0; index < 26; index++) {
      at = new Date(Date.parse("2026-11-03T00:00:00") + index * 8 * 3_600_000);
      await social.noteAgentTurn("claude", work(`s${index}`), "a", "b");
    }
    await settle();
    const milestones = social.view().posts.filter((post) => post.from.kind === "milestone" && !post.text.startsWith("A whole week"));
    expect(milestones.map((post) => post.text)).toEqual(["25 things finished together", "10 things finished together"]);
    expect(milestones.every((post) => post.by === "demesne" && post.reactions?.["🌸"]?.includes("claude"))).toBe(true);
  });
});

describe("the Friday reel", () => {
  // Friday 2026-11-06; the week's posts go in from Monday on.
  async function week(clip: ClipMaker | null, monthlyDollars?: number) {
    let at = new Date("2026-11-02T10:00:00");
    const made = feed([], { now: () => at, agents: ["claude", "codex"], clip, monthlyDollars });
    for (let index = 0; index < 6; index++) {
      at = new Date(Date.parse("2026-11-02T10:00:00") + index * 13 * 3_600_000);
      await made.social.noteAgentTurn(index % 2 ? "codex" : "claude", work(`s${index}`), "a", `b${index}`);
    }
    return { ...made, at: (value: string) => { at = new Date(value); } };
  }

  test("comes from Friday 5 pm, once, from the week's real posts, with a clip when there's a video model", async () => {
    const scenes: string[] = [];
    const { social, at } = await week(async (agents, scene) => { scenes.push(`${agents.join("+")}: ${scene}`); return new Uint8Array([1, 2, 3]); });
    at("2026-11-06T16:00:00");
    expect(await social.weekReel()).toBeNull();
    at("2026-11-06T17:05:00");
    const reel = (await social.weekReel())!;
    expect(reel.week).toBe("2026-W45");
    expect(reel.frames.length).toBe(6);
    expect(reel.numbers.work).toBe(6);
    expect(reel.clip).toBe("ready");
    expect(scenes[0]).toStartWith("claude+codex: ");
    expect(existsSync(social.clipPath(reel.id)!)).toBe(true);
    expect(social.view().reel?.id).toBe(reel.id);
    expect(await social.weekReel()).toBeNull();
    at("2026-11-09T09:00:00");
    expect(social.view().reel).toBeNull();
  });

  test("a failed clip is given back to the cap, and a full cap means no clip", async () => {
    const failed = await week(async () => null);
    failed.at("2026-11-07T12:00:00");
    expect((await failed.social.weekReel())!.clip).toBe("none");
    let asked = 0;
    const full = await week(async () => { asked++; return new Uint8Array([1]); }, 0.5);
    full.at("2026-11-07T12:00:00");
    expect((await full.social.weekReel())!.clip).toBe("none");
    expect(asked).toBe(0);
  });

  test("a quiet week has no reel", async () => {
    let at = new Date("2026-11-06T18:00:00");
    const { social } = feed([], { now: () => at, clip: async () => new Uint8Array([1]) });
    await social.noteAgentTurn("claude", work("s1"), "a", "b");
    at = new Date("2026-11-06T19:00:00");
    expect(await social.weekReel()).toBeNull();
  });
});

describe("the clip maker", () => {
  test("sora-2 on OpenAI unless set; none turns it off", () => {
    expect(videoModel({ url: "https://api.openai.com/v1" })).toBe("sora-2");
    expect(videoModel({ url: "https://other.example/v1" })).toBeNull();
    expect(videoModel({ url: "https://api.openai.com/v1", videoModel: "none" })).toBeNull();
    expect(videoModel({ url: "https://other.example/v1", videoModel: "veo" })).toBe("veo");
  });

  test("starts a job with the faces as reference, waits for it, and downloads the video", async () => {
    const calls: string[] = [];
    let polls = 0;
    const request = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace("https://api.openai.com/v1", "");
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/videos") {
        const form = init!.body as FormData;
        expect(form.get("model")).toBe("sora-2");
        expect(form.get("seconds")).toBe("8");
        expect(form.get("size")).toBe("720x1280");
        expect(form.get("input_reference")).toBeInstanceOf(Blob);
        return Response.json({ id: "video_1", status: "queued" });
      }
      if (path === "/videos/video_1") return Response.json({ status: ++polls < 2 ? "in_progress" : "completed" });
      return new Response(new Uint8Array([9, 9]));
    }) as typeof fetch;
    const make = clipMaker({ url: "https://api.openai.com/v1", apiKey: "k" }, { png: async () => new Uint8Array([1]), request, sleep: async () => {}, pollMs: 1 })!;
    expect(await make(["claude", "codex"], "a walk")).toEqual(new Uint8Array([9, 9]));
    expect(calls).toEqual(["POST /videos", "GET /videos/video_1", "GET /videos/video_1", "GET /videos/video_1/content"]);
    expect(referenceSvg(["claude", "codex", "gemini"]).match(/<svg x=/g)).toHaveLength(3);
  });

  test("a failed job is null", async () => {
    const request = (async (url: string | URL) => String(url).endsWith("/videos") ? Response.json({ id: "v", status: "queued" }) : Response.json({ status: "failed" })) as typeof fetch;
    const make = clipMaker({ url: "https://api.openai.com/v1" }, { png: async () => new Uint8Array([1]), request, sleep: async () => {} })!;
    expect(await make(["claude"], "x")).toBeNull();
  });
});
