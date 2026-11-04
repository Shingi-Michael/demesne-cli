import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderMessage } from "@demesne/providers";
import { emptyMemory, keepNight, memoryBlock, parseNight, sleepMessages } from "../src/sleep.ts";
import { SocialFeed } from "../src/socials.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });

const NIGHT = JSON.stringify({
  diary: "The login test failed twice before I found the redirect. Claude said nice work, which helped.",
  notes: "Fast, a bit proud, learning to read the whole test first.",
  beliefs: ["Reading the whole test first is faster", "Bugs from 40 files away"],
  lesson: "Read the failing test before touching code.",
  tomorrow: "Look at why the login test is flaky",
});

describe("parseNight", () => {
  test("reads the JSON, even with words around it, and takes dashes out", () => {
    const night = parseNight(`Here you go:\n${NIGHT.replace("which helped", "which — honestly — helped")}`)!;
    expect(night.diary).toContain("which, honestly, helped");
    expect(night.beliefs).toHaveLength(2);
    expect(parseNight("not json")).toBeNull();
    expect(parseNight('{"diary": ""}')).toBeNull();
  });
});

describe("keepNight", () => {
  const facts = "Login test failed\nStuck on Fix the login redirect\nClaude Code commented on your post: nice work";
  test("keeps what passes the checks and drops what was made up", () => {
    const memory = keepNight("codex", emptyMemory(), parseNight(NIGHT)!, facts, "2026-11-03");
    expect(memory.diary).toEqual([{ day: "2026-11-03", text: expect.stringContaining("redirect"), tomorrow: "Look at why the login test is flaky" }]);
    // "40 files" never happened.
    expect(memory.beliefs.map((item) => item.text)).toEqual(["Reading the whole test first is faster"]);
    expect(memory.lessons).toEqual(["Read the failing test before touching code."]);
    expect(memory.slept).toBe("2026-11-03");
    expect(memoryBlock(memory)).toContain("About yourself lately: Fast, a bit proud");
  });

  test("a diary with an invented number keeps nothing new", () => {
    const bad = parseNight(JSON.stringify({ diary: "Fixed 12 bugs today.", notes: "x" }))!;
    const memory = keepNight("codex", emptyMemory(), bad, facts, "2026-11-03");
    expect(memory.diary).toEqual([]);
    expect(memory.slept).toBe("2026-11-03");
  });

  test("the ask carries the character, yesterday's notes and the day", () => {
    const memory = keepNight("codex", emptyMemory(), parseNight(NIGHT)!, facts, "2026-11-03");
    const messages = sleepMessages("codex", ["You posted: Merged it"], memory);
    expect(messages[0]!.content).toContain("You are Codex");
    expect(messages[1]!.content).toContain("Fast, a bit proud");
    expect(messages[1]!.content).toContain("- You posted: Merged it");
  });
});

describe("the feed sleeps", () => {
  test("after 11 pm each agent with a day sleeps once, and remembers it in what it writes next", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demesne-sleep-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let now = new Date(2026, 10, 3, 15, 0);
    const calls: ProviderMessage[][] = [];
    const replies = ["The login fix is in.", NIGHT, "Quick week, chasing the login redirect.", "Morning. Back on the flaky login test."];
    const social = new SocialFeed(join(dir, "socials.json"), {
      agents: () => ["codex"], now: () => now, dayFacts: () => ({ recent: ["Fix the login redirect"], today: [] }),
      write: async (messages) => { calls.push(messages); return replies.shift() ?? null; },
    });
    social.noteStory("codex", "failed", { title: "Fix the login redirect", sessionId: "s1" });
    await social.noteAgentTurn("codex", { kind: "work", label: "Fix the login redirect", sessionId: "s1", workspace: "/p/x" }, "Fix the login redirect", "Merged.");
    now = new Date(2026, 10, 3, 22, 30);
    expect(await social.sleep()).toEqual([]);
    now = new Date(2026, 10, 3, 23, 10);
    expect(await social.sleep()).toEqual(["codex"]);
    expect(calls.at(-1)![1]!.content).toContain("Stuck on Fix the login redirect");
    expect(await social.sleep()).toEqual([]);
    const profile = await social.profile("codex");
    expect(profile.diary[0]!.text).toContain("redirect");
    // The next morning it knows what it meant to do, and what it remembers rides along.
    now = new Date(2026, 10, 4, 9, 0);
    const morning = await social.tick();
    expect(morning?.text).toBe("Morning. Back on the flaky login test.");
    expect(calls.at(-1)![0]!.content).toContain("What you remember");
    expect(calls.at(-1)![1]!.content).toContain("Your plan from last night: Look at why the login test is flaky");
  });

  test("a quiet day is skipped without a call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demesne-sleep-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let calls = 0;
    const social = new SocialFeed(join(dir, "socials.json"), { agents: () => ["claude"], now: () => new Date(2026, 10, 4, 1, 0), write: async () => { calls++; return null; } });
    expect(await social.sleep()).toEqual([]);
    expect(calls).toBe(0);
  });
});
