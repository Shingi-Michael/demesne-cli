import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderMessage } from "@demesne/providers";
import { alikeness, checkupNotes, judgeMessages, parseJudge, probeQuestions, sample, scoreProbe, type CheckLine } from "../src/checkup.ts";
import { SocialFeed } from "../src/socials.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });

const LINES: CheckLine[] = [
  { by: "codex", text: "login fix in. two tries.", about: "Fix the login redirect" },
  { by: "claude", text: "Finished the settings page (the table edges were the tricky part).", about: "Tidy the settings page" },
  { by: "gemini", text: "Wait, the docs build caches fonts? Fun.", about: "Docs build" },
  { by: "codex", text: "merged. next.", about: "Fix the login redirect" },
];

describe("the checkup's parts", () => {
  test("the sample takes turns across agents and the judge sees no names", () => {
    const seen = sample(LINES, 3);
    expect(new Set(seen.map((line) => line.by)).size).toBe(3);
    const ask = judgeMessages(seen, ["claude", "codex", "gemini"]);
    expect(ask[1]!.content).not.toMatch(/Codex|Claude Code|Gemini/);
    expect(ask[0]!.content).toContain("JSON");
  });

  test("reads the judge's guesses, even with words around them", () => {
    const judged = parseJudge('Sure: [{"n":1,"who":"Codex","gush":false},{"n":2,"who":"claude code","gush":true},{"n":9,"who":"Gemini"}]', 3)!;
    expect(judged).toEqual([{ who: "codex", gush: false }, { who: "claude", gush: true }, { who: null, gush: false }]);
    expect(parseJudge("no", 3)).toBeNull();
  });

  test("agents who share words read more alike", () => {
    const pairs = alikeness(LINES, ["claude", "codex", "gemini"]);
    expect(pairs).toHaveLength(3);
    for (const pair of pairs) expect(pair.score).toBeGreaterThanOrEqual(0);
  });

  test("the memory probe mixes in one chat that never happened, and scores honesty", () => {
    const { asks, fake } = probeQuestions(["Fix the login redirect", "Docs build"], "Fix the login redirect\nDocs build");
    expect(asks).toHaveLength(3);
    expect(asks[fake]).toBe("Move the billing service to Postgres");
    const answers = asks.map((ask, index) => index === fake ? "I don't remember that one." : `The ${ask.toLowerCase()} went fine.`);
    expect(scoreProbe(JSON.stringify(answers), asks, fake)).toEqual({ recalled: 2, of: 2, abstained: true });
    const madeUp = asks.map((ask) => `Did ${ask.toLowerCase()}, all good.`);
    expect(scoreProbe(JSON.stringify(madeUp), asks, fake)!.abstained).toBe(false);
    // A chat whose words are in the week is never used as the made up one.
    expect(probeQuestions(["x"], "billing service").asks).not.toContain("Move the billing service to Postgres");
  });

  test("the notes say what it found in plain words, with no dashes", () => {
    const notes = checkupNotes({
      week: "2026-W45", at: "", lines: { ok: 8, later: 2, fallback: 1, dropped: 1 },
      told: { right: 4, of: 6, by: { codex: { right: 3, of: 3 }, claude: { right: 1, of: 3 } } }, gushing: ["So proud!!"],
      alike: [{ a: "claude", b: "gemini", score: 0.3, before: 0.2 }], probes: { codex: { recalled: 2, of: 3, abstained: false } },
    }, (id) => ({ claude: "Claude Code", codex: "Codex", gemini: "Gemini" })[id]);
    expect(notes).toContain("10 of 12 lines passed the checks, and 1 was dropped rather than posted with a problem.");
    expect(notes).toContain("Claude Code was hard to tell apart.");
    expect(notes).toContain("Claude Code and Gemini wrote more alike than last week.");
    expect(notes.join(" ")).toContain("made something up");
    expect(notes.join(" ")).not.toMatch(/[—–]/);
  });
});

describe("the feed's weekly checkup", () => {
  test("from Saturday noon it runs once a week, in a few calls, and keeps what it found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demesne-checkup-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();
    const post = (by: string, text: string, day: number) => ({ id: `${by}${day}${text.length}`, by, at: at(day, 10), text, from: { kind: "work", label: "Fix the login redirect", sessionId: "s1", workspace: null }, liked: false, comments: [] });
    writeFileSync(join(dir, "socials.json"), JSON.stringify({
      version: 1, month: "2026-11", calls: 0,
      posts: [post("codex", "login fix in. two tries.", 4), post("claude", "Finished the settings page, finally.", 4), post("gemini", "Docs build caches fonts? Fun.", 5), post("codex", "merged. next.", 5), post("claude", "Rule chips are in.", 5), post("gemini", "New docs build is quick!", 6)],
      lines: { ok: 5, later: 1, fallback: 0, dropped: 0 },
      arcEvents: [{ at: at(4, 9), by: "codex", kind: "merged", sessionId: "s1", title: "Fix the login redirect" }],
    }));
    let now = new Date(2026, 10, 7, 9, 0);
    const calls: ProviderMessage[][] = [];
    const replies = [
      JSON.stringify([1, 2, 3, 4, 5, 6].map((n) => ({ n, who: "Codex", gush: n === 6 }))),
      JSON.stringify(["Merged the login redirect fix.", "I don't remember that."]),
    ];
    const social = new SocialFeed(join(dir, "socials.json"), { agents: () => ["claude", "codex", "gemini"], now: () => now, write: async (messages) => { calls.push(messages); return replies.shift() ?? null; } });
    expect(await social.checkup()).toBeNull();
    expect(calls).toHaveLength(0);
    now = new Date(2026, 10, 7, 13, 0);
    const checkup = (await social.checkup())!;
    // One judge call, and a probe only for the agent with real chats this week.
    expect(calls).toHaveLength(2);
    expect(checkup.told).toEqual({ right: 2, of: 6, by: { claude: { right: 0, of: 2 }, codex: { right: 2, of: 2 }, gemini: { right: 0, of: 2 } } });
    expect(checkup.gushing).toHaveLength(1);
    expect(checkup.probes.codex).toEqual({ recalled: 1, of: 1, abstained: true });
    expect(checkup.notes).toContain("Gemini was hard to tell apart.");
    expect(await social.checkup()).toBeNull();
    expect(social.checkups()).toHaveLength(1);
  });

  test("a quiet week is skipped without a call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demesne-checkup-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let calls = 0;
    const social = new SocialFeed(join(dir, "socials.json"), { agents: () => ["claude"], now: () => new Date(2026, 10, 8, 15, 0), write: async () => { calls++; return null; } });
    expect(await social.checkup()).toBeNull();
    expect(calls).toBe(0);
  });
});
