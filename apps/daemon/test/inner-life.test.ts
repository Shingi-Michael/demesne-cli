import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeness, feel, moodOf, tie, type Feeling } from "../src/inner-life.ts";
import { SocialFeed } from "../src/socials.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });
const at = (hours: number) => new Date(Date.parse("2026-11-04T10:00:00Z") + hours * 3_600_000);

describe("moods", () => {
  test("a merge makes it happy, and the feeling fades as its time runs out", () => {
    const list = feel([], "codex", "merged", "Merged the login fix", at(0));
    expect(list[0]!.p).toBe(5.2);
    expect(moodOf(list, at(0))).toMatchObject({ mood: "happy", strong: true, word: "very happy" });
    expect(moodOf(list, at(4)).mood).toBe("calm");
    expect(moodOf(list, at(7)).reasons).toEqual([]);
  });

  test("failures build up, each repeat a little less, and each character takes them its own way", () => {
    let claude: Feeling[] = [];
    for (let i = 0; i < 3; i++) claude = feel(claude, "claude", "failed", "Login test failed", at(i * 0.1));
    expect(claude.map((item) => item.p)).toEqual([-3.9, -2.9, -2.2]);
    expect(moodOf(claude, at(0.3))).toMatchObject({ mood: "stuck", word: "really stuck" });
    const gemini = feel([], "gemini", "failed", "Login test failed", at(0));
    expect(gemini[0]!.p).toBe(-1.8);
  });

  test("a late night makes it sleepy, and the reasons say why", () => {
    const list = feel(feel([], "claude", "night", "Late night", at(0)), "claude", "liked", "Mike liked my post", at(0));
    const mood = moodOf(list, at(0));
    expect(mood.mood).toBe("sleepy");
    expect(mood.reasons.map((reason) => reason.why)).toEqual(["Late night", "Mike liked my post"]);
    expect(mood.reasons[1]!.left).toBe(12);
  });
});

describe("friendships", () => {
  test("warmth fades in days, the bond lasts, and the latest lines come first", () => {
    let ties = tie([], "codex", "answered my mail", 0.15, at(0));
    ties = tie(ties, "codex", "commented on my post", 0.15, at(1));
    const now = closeness(ties, at(1))[0]!;
    expect(now.agent).toBe("codex");
    expect(now.lines[0]!.why).toBe("commented on my post");
    const later = closeness(ties, at(24 * 7))[0]!;
    expect(later.warmth).toBeLessThan(now.warmth / 5);
    expect(later.bond).toBeGreaterThan(now.bond * 0.7);
  });
});

describe("the feed", () => {
  const LINES = ["Nice, well done.", "Fixed the login redirect at last.", "Quiet afternoon on the sidebar.", "That parser was stubborn today."];
  let said = 0;
  function feed(now: () => Date) {
    const dir = mkdtempSync(join(tmpdir(), "demesne-inner-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "socials.json");
    const make = () => new SocialFeed(path, { agents: () => ["claude", "codex", "gemini"], now, write: async () => LINES[(said++) % LINES.length]! });
    return { social: make(), reopen: make };
  }

  test("stories, likes and comments move the mood, and the profile shows it with reasons", async () => {
    let now = at(0);
    const { social, reopen } = feed(() => now);
    social.noteStory("codex", "done", { title: "Fix login", sessionId: "s1", happy: true });
    expect(social.view().moods?.codex).toMatchObject({ mood: "happy" });
    const post = (await social.noteAgentTurn("codex", { kind: "work", label: "Fix login", sessionId: "s1", workspace: "/p/x" }, "Fix login", "Merged."))!;
    social.like(post.id, true);
    now = at(0.5);
    await social.comment(post.id, "you're fast");
    const profile = await reopen().profile("codex");
    expect(profile.feeling.reasons.map((reason) => reason.why)).toContain("Mike liked my post");
    expect(profile.remembers.map((item) => item.text)).toEqual(["you're fast"]);
  });

  test("an agent's comment on another's post becomes a tie both ways", async () => {
    const now = at(0);
    const { social } = feed(() => now);
    await social.noteAgentTurn("codex", { kind: "work", label: "A", sessionId: "c1", workspace: "/p/x" }, "a", "b");
    await social.noteAgentTurn("claude", { kind: "work", label: "B", sessionId: "c2", workspace: "/p/x" }, "c", "d");
    const claude = await social.profile("claude");
    expect(claude.close.find((item) => item.agent === "codex")!.lines.map((line) => line.why)).toContain("commented on my post");
    const codex = await social.profile("codex");
    expect(codex.close.map((item) => item.agent)).toContain("claude");
  });

  test("you can tell an agent something to remember, and make it forget", () => {
    const { social } = feed(() => at(0));
    const list = social.remember("gemini", "I like short answers");
    expect(list[0]).toMatchObject({ text: "I like short answers", from: "you" });
    expect(social.forget("gemini", list[0]!.id)).toEqual([]);
    expect(() => social.remember("gemini", "  ")).toThrow();
  });
});
