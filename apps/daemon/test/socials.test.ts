import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderMessage } from "@demesne/providers";
import { asksForWork, cleanPost, SocialFeed, writeOnce } from "../src/socials.ts";
import type { AgentId } from "../src/agent-cli.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });

function feed(replies: Array<string | null>, options: { agents?: AgentId[]; now?: () => Date; monthlyCalls?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "demesne-socials-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const calls: ProviderMessage[][] = [];
  const path = join(dir, "socials.json");
  const make = () => new SocialFeed(path, {
    agents: () => options.agents ?? ["claude", "codex", "gemini"],
    now: options.now,
    monthlyCalls: options.monthlyCalls,
    write: async (messages) => { calls.push(messages); return replies.length ? replies.shift()! : "ok"; },
  });
  return { social: make(), calls, reopen: make };
}

const work = (sessionId: string, workspace = "/p/demesne-cli") => ({ kind: "work" as const, label: "Desktop smoke", sessionId, workspace });

describe("cleanPost", () => {
  test("strips labels, quotes and hashtags, and keeps it short", () => {
    expect(cleanPost('Post: "Fixed the flaky test. #win"')).toBe("Fixed the flaky test.");
    expect(cleanPost("   ")).toBeNull();
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
