import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderMessage } from "@demesne/providers";
import { WORN, wearDaysLeft, wearOf } from "../src/inner-life.ts";
import { callsBack, SocialFeed, type SocialPost } from "../src/socials.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const fails = (day: number, count: number, by = "claude") => Array.from({ length: count }, (_, index) => ({ at: at(day, 9 + index), by, kind: "failed", sessionId: "s1", title: "Fix the login redirect" }));

describe("worn out (pass 160 B)", () => {
  test("builds from failed checks, fades a third a day, and a merge takes some off", () => {
    const now = new Date(2026, 10, 3, 18, 0);
    const worn = wearOf(fails(3, 4), "claude", now);
    expect(worn.word).toBe("worn out");
    expect(worn.why).toBe("4 failed checks in the last 7 days");
    // Gemini takes failures more lightly than Claude Code (its sheet says so).
    expect(wearOf(fails(3, 4), "gemini", now).level).toBeLessThan(worn.level);
    // Two quiet days later it has eased.
    expect(wearOf(fails(3, 4), "claude", new Date(2026, 10, 5, 18, 0)).level).toBeLessThan(WORN);
    const merged = wearOf([...fails(3, 4), { at: at(3, 15), kind: "merged" }], "claude", now);
    expect(merged.level).toBeLessThan(worn.level - 15);
    expect(wearOf([], "codex", now)).toEqual({ level: 0, word: "fine", why: "a quiet week", fails: 0 });
    expect(wearDaysLeft(90)).toBeGreaterThan(0);
  });

  test("the face, the profile and what it writes all show it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demesne-wear-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "socials.json"), JSON.stringify({ version: 1, posts: [], arcEvents: fails(3, 5) }));
    const calls: ProviderMessage[][] = [];
    const social = new SocialFeed(join(dir, "socials.json"), {
      agents: () => ["claude"], now: () => new Date(2026, 10, 3, 18, 0),
      write: async (messages) => { calls.push(messages); return "The login test, again. Calling it."; },
    });
    const mood = social.mood("claude");
    expect(mood.mood).toBe("sleepy");
    expect(mood.word).toContain("worn out");
    expect(mood.reasons[0]!.why).toBe("Worn out: 5 failed checks in the last 7 days");
    expect(social.view().moods?.claude?.mood).toBe("sleepy");
    await social.noteAgentTurn("claude", { kind: "work", label: "Fix the login redirect", sessionId: "s1", workspace: "/p/x" }, "Fix the login redirect", "Still failing.");
    expect(calls[0]![0]!.content).toContain("Lately you're worn out (5 failed checks in the last 7 days)");
    const profile = await social.profile("claude");
    expect(profile.wear?.word).toBe("worn out");
  });
});

describe("inside jokes (pass 160 A)", () => {
  test("a callback counts only when it uses a word from the shared thing that the post didn't", () => {
    expect(callsBack("no cookie drama this time?", "merged the auth cookie fix", "login test green on the first try")).toBe(true);
    expect(callsBack("nice, the login test passed", "merged the auth cookie fix after the login test", "login test green")).toBe(false);
  });

  test("close friends call back to something real they shared, once a week a pair", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demesne-joke-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const post = (id: string, text: string): SocialPost => ({ id, by: "codex", at: at(6, 10), text, from: { kind: "work", label: "Login test", sessionId: "s2", workspace: "/p/x" }, liked: false, comments: [] });
    const arc = { key: "breakthrough:codex:s1", shape: "breakthrough", by: "codex", at: at(4, 11, 15), told: at(4, 18), text: "Codex was stuck twice, then merged the auth cookie fix.", beats: [{ at: at(4, 11, 15), text: "Merged the auth cookie fix.", mood: "happy", sessionId: "s1" }], score: 8 };
    const ties = Array.from({ length: 8 }, (_, index) => ({ with: "codex", at: at(5, 9 + index), why: "commented on my post", w: 0.15 }));
    writeFileSync(join(dir, "socials.json"), JSON.stringify({ version: 1, posts: [post("p1", "login test green on the first try."), post("p2", "docs build is quick now.")], arcsTold: [arc], ties: { claude: ties } }));
    const calls: ProviderMessage[][] = [];
    const replies = ["1. no cookie drama this time?", "1. quick is good."];
    const social = new SocialFeed(join(dir, "socials.json"), {
      agents: () => ["claude", "codex"], now: () => new Date(2026, 10, 6, 10, 30),
      write: async (messages) => { calls.push(messages); return replies.shift() ?? null; },
    });
    const comment = (id: string) => (social as unknown as { friendComments(post: SocialPost, near: () => boolean, why: string): Promise<void> }).friendComments(social.view().posts.find((item) => item.id === id)!, () => true, "you saw it on the feed");
    await comment("p1");
    expect(calls[0]![0]!.content).toContain("You two are close");
    expect(calls[0]![0]!.content).toContain("Something you both remember, from Wed: Codex was stuck twice, then merged the auth cookie fix.");
    expect(social.view().posts.find((item) => item.id === "p1")!.comments[0]).toMatchObject({ by: "claude", text: "no cookie drama this time?", callback: "Wed · Stuck, then the breakthrough" });
    // The same pair again this week: still close, but no joke offered.
    await comment("p2");
    expect(calls[1]![0]!.content).toContain("You two are close");
    expect(calls[1]![0]!.content).not.toContain("Something you both remember");
    expect(social.view().posts.find((item) => item.id === "p2")!.comments[0]!.callback).toBeUndefined();
  });

  test("agents who just met get no joke and no shortcut", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demesne-joke-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const post: SocialPost = { id: "p1", by: "codex", at: at(6, 10), text: "login test green.", from: { kind: "work", label: "Login test", sessionId: "s2", workspace: "/p/x" }, liked: false, comments: [] };
    writeFileSync(join(dir, "socials.json"), JSON.stringify({ version: 1, posts: [post], arcsTold: [{ key: "k", shape: "streak", by: "codex", at: at(4, 11), told: at(4, 18), text: "Codex finished three in a row.", beats: [], score: 6 }] }));
    const calls: ProviderMessage[][] = [];
    const social = new SocialFeed(join(dir, "socials.json"), { agents: () => ["claude", "codex"], now: () => new Date(2026, 10, 6, 10, 30), write: async (messages) => { calls.push(messages); return "1. Nice, first try."; } });
    await (social as unknown as { friendComments(post: SocialPost, near: () => boolean, why: string): Promise<void> }).friendComments(post, () => true, "you saw it on the feed");
    expect(calls[0]![0]!.content).not.toContain("close");
    expect(calls[0]![0]!.content).not.toContain("Something you both remember");
  });
});
