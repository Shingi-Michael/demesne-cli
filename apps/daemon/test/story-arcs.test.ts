import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../src/agent-cli.ts";
import { arcScene, arcToTell, findArcs, parseChapter, type ArcEvent, type ToldArc } from "../src/story-arcs.ts";
import { SocialFeed } from "../src/socials.ts";

const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" };
const nameOf = (id: AgentId) => NAMES[id]!;
const at = (time: string) => new Date(`2026-11-04T${time}:00`).toISOString();
const event = (time: string, by: AgentId, kind: ArcEvent["kind"], title: string, sessionId = "s1", extra: Partial<ArcEvent> = {}): ArcEvent => ({ at: at(time), by, kind, sessionId, title, ...extra });
const evening = new Date("2026-11-04T19:00:00");

describe("finding arcs", () => {
  test("stuck twice then merged in the same chat is a breakthrough, in three real beats", () => {
    const arcs = findArcs([
      event("09:20", "codex", "start", "Fix the login redirect"),
      event("09:48", "codex", "failed", "Fix the login redirect"),
      event("10:31", "codex", "failed", "Fix the login redirect"),
      event("11:15", "codex", "merged", "Fix the login redirect"),
    ], evening, nameOf);
    const arc = arcs.find((item) => item.shape === "breakthrough")!;
    expect(arc.by).toBe("codex");
    expect(arc.text).toBe("Codex got stuck on Fix the login redirect 2 times, then merged it 87 minutes later.");
    expect(arc.beats.map((beat) => [beat.at, beat.mood])).toEqual([[at("09:48"), "stuck"], [at("10:31"), "stuck"], [at("11:15"), "happy"]]);
    expect(arc.beats[2]!.text).toBe("Got it. Merged Fix the login redirect.");
  });

  test("one stuck, or the fix in another chat, is not a breakthrough", () => {
    expect(findArcs([event("09:48", "codex", "failed", "a"), event("11:15", "codex", "done", "a")], evening, nameOf).some((arc) => arc.shape === "breakthrough")).toBe(false);
    expect(findArcs([event("09:48", "codex", "failed", "a"), event("10:00", "codex", "failed", "a"), event("11:15", "codex", "done", "b", "s2")], evening, nameOf).some((arc) => arc.shape === "breakthrough")).toBe(false);
  });

  test("three finished in a row is a streak; a stuck one breaks it", () => {
    const streak = findArcs([
      event("13:40", "claude", "done", "Settings page", "a"), event("14:30", "claude", "done", "Settings tables", "b"), event("15:20", "claude", "done", "Rule chips", "c"),
    ], evening, nameOf).find((arc) => arc.shape === "streak")!;
    expect(streak.beats.at(-1)!.text).toBe("Rule chips. That's 3 in a row.");
    expect(findArcs([
      event("13:40", "claude", "done", "a", "a"), event("14:00", "claude", "failed", "b", "b"), event("14:30", "claude", "done", "c", "c"), event("15:20", "claude", "done", "d", "d"),
    ], evening, nameOf).some((arc) => arc.shape === "streak")).toBe(false);
  });

  test("two agents in one file the same day", () => {
    const arc = findArcs([event("12:10", "claude", "file", "apps/desktop/workspace/live.ts", "a"), event("13:02", "codex", "file", "apps/desktop/workspace/live.ts", "b")], evening, nameOf)
      .find((item) => item.shape === "same-file")!;
    expect(arc.text).toBe("Claude Code and Codex both changed live.ts today, 52 minutes apart.");
    expect(arc.with).toBe("codex");
  });

  test("a helping hand needs the other agent to finish soon after the mail", () => {
    const arcs = findArcs([
      event("10:40", "gemini", "mail", "the auth cookie", "m", { with: "codex" }),
      event("11:15", "codex", "merged", "Fix the login redirect", "s1"),
    ], evening, nameOf);
    const arc = arcs.find((item) => item.shape === "helping-hand")!;
    expect(arc.by).toBe("gemini");
    expect(arc.beats.map((beat) => beat.text)).toEqual(["Codex asked about the auth cookie.", "Codex merged Fix the login redirect right after. Glad I could help."]);
    expect(findArcs([event("06:00", "gemini", "mail", "x", "m", { with: "codex" }), event("11:15", "codex", "done", "y")], evening, nameOf).some((item) => item.shape === "helping-hand")).toBe(false);
  });

  test("back at a chat after two quiet days", () => {
    const arc = findArcs([
      { at: new Date("2026-11-01T10:00:00").toISOString(), by: "claude", kind: "done", sessionId: "s9", title: "Tidy the settings page" },
      event("11:30", "claude", "start", "Tidy the settings page", "s9"),
    ], evening, nameOf).find((item) => item.shape === "back-at-it")!;
    expect(arc.beats[0]!.text).toBe("Back on Tidy the settings page after 3 quiet days.");
  });

  test("only arcs that end in the last day count, best first", () => {
    const old = findArcs([event("09:48", "codex", "failed", "a"), event("10:31", "codex", "failed", "a"), event("11:15", "codex", "merged", "a")], new Date("2026-11-06T12:00:00"), nameOf);
    expect(old).toEqual([]);
    const both = findArcs([
      event("09:48", "codex", "failed", "a"), event("10:31", "codex", "failed", "a"), event("11:15", "codex", "merged", "a"),
      { at: new Date("2026-11-01T10:00:00").toISOString(), by: "claude", kind: "done", sessionId: "s9", title: "b" }, event("11:30", "claude", "start", "b", "s9"),
    ], evening, nameOf);
    expect(both[0]!.shape).toBe("breakthrough");
  });
});

describe("telling arcs", () => {
  const arcs = findArcs([event("09:48", "codex", "failed", "a"), event("10:31", "codex", "failed", "a"), event("11:15", "codex", "merged", "a")], new Date("2026-11-04T12:00:00"), nameOf);
  const told = (arc: typeof arcs[number], when: string): ToldArc => ({ key: arc.key, shape: arc.shape, by: arc.by, at: arc.at, told: when, text: arc.text, beats: arc.beats });

  test("a good arc is told once; the same shape for the same agent rests two days", () => {
    expect(arcToTell(arcs, [], new Date("2026-11-04T12:00:00"))?.key).toBe(arcs[0]!.key);
    expect(arcToTell(arcs, [told(arcs[0]!, at("12:00"))], new Date("2026-11-04T12:01:00"))).toBeNull();
    const other = { ...arcs[0]!, key: "breakthrough:s2:x" };
    expect(arcToTell([other], [told(arcs[0]!, new Date("2026-11-03T12:00:00").toISOString())], new Date("2026-11-04T12:00:00"))).toBeNull();
  });

  test("at most two a day, and a small arc waits for the evening", () => {
    const small = { ...arcs[0]!, key: "back-at-it:x", shape: "back-at-it" as const, score: 3 };
    expect(arcToTell([small], [], new Date("2026-11-04T12:00:00"))).toBeNull();
    expect(arcToTell([small], [], new Date("2026-11-04T18:30:00"))?.key).toBe("back-at-it:x");
    const two = [told({ ...arcs[0]!, key: "1", shape: "streak" }, at("09:00")), told({ ...arcs[0]!, key: "2", shape: "same-file" }, at("10:00"))];
    expect(arcToTell(arcs, two, new Date("2026-11-04T12:00:00"))).toBeNull();
  });

  test("the reel's scene comes from the arc, with grown adults and no screens", () => {
    const scene = arcScene({ shape: "helping-hand", by: "gemini", with: "codex" }, nameOf);
    expect(scene).toContain("Gemini leans over to help Codex");
    expect(scene).toContain("adult");
    expect(scene).not.toMatch(/\b(screens?|code|young|child)\b/i);
  });

  test("a chapter reads back from the writer's JSON, without dashes", () => {
    expect(parseChapter('{"title": "The week of the login redirect.", "text": "Two days on one test — then it was the cookie."}'))
      .toEqual({ title: "The week of the login redirect", text: "Two days on one test, then it was the cookie." });
    expect(parseChapter("no json")).toBeNull();
    expect(parseChapter('{"title": "", "text": "x"}')).toBeNull();
  });
});

describe("arcs in the feed", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });
  function feed(now: () => Date, replies: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), "demesne-arcs-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const calls: string[] = [];
    const social = new SocialFeed(join(dir, "socials.json"), {
      agents: () => ["claude", "codex", "gemini"], now,
      write: async (messages) => { calls.push(String(messages.at(-1)?.content ?? "")); return replies.shift() ?? null; },
    });
    return { social, calls };
  }

  test("real stories become a breakthrough told in beats, once", () => {
    let now = new Date("2026-11-04T09:48:00");
    const { social } = feed(() => now);
    social.noteStory("codex", "failed", { title: "Fix the login redirect", sessionId: "s1" });
    now = new Date("2026-11-04T10:31:00");
    social.noteStory("codex", "failed", { title: "Fix the login redirect", sessionId: "s1" });
    now = new Date("2026-11-04T11:15:00");
    social.noteStory("codex", "done", { title: "Fix the login redirect", sessionId: "s1", happy: true, files: ["src/auth.ts"] });
    const beats = social.tellArc();
    expect(beats.map((story) => story.text)).toEqual(["Stuck on Fix the login redirect.", "Still stuck. Same chat, same problem.", "Got it. Merged Fix the login redirect."]);
    expect(beats[0]!.label).toBe("Stuck, then the breakthrough · 09:48");
    expect(beats.every((story) => story.kind === "arc" && story.by === "codex")).toBe(true);
    expect(social.view().stories!.filter((story) => story.kind === "arc").length).toBe(3);
    expect(social.tellArc()).toEqual([]);
  });

  test("Friday: a chapter from the week's arcs, checked, on the profile and opening the reel", async () => {
    let now = new Date("2026-11-04T09:48:00");
    const { social, calls } = feed(() => now, ['{"title": "The week of the login redirect", "text": "Stuck twice on the login redirect, then merged it. That one felt good."}']);
    social.noteStory("codex", "failed", { title: "Fix the login redirect", sessionId: "s1" });
    now = new Date("2026-11-04T10:31:00");
    social.noteStory("codex", "failed", { title: "Fix the login redirect", sessionId: "s1" });
    now = new Date("2026-11-04T11:15:00");
    social.noteStory("codex", "done", { title: "Fix the login redirect", sessionId: "s1", happy: true });
    social.tellArc();
    now = new Date("2026-11-06T17:10:00");
    expect(await social.chapters()).toEqual(["codex"]);
    expect(calls[0]).toContain("Codex got stuck on Fix the login redirect 2 times");
    const profile = await social.profile("codex");
    expect(profile.chapters[0]!.title).toBe("The week of the login redirect");
    expect(profile.chapters[0]!.shapes).toEqual(["breakthrough"]);
    expect(await social.chapters()).toEqual([]);
  });

  test("a chapter with a made up number is not kept", async () => {
    let now = new Date("2026-11-04T09:48:00");
    const { social } = feed(() => now, ['{"title": "Busy", "text": "I fixed 14 bugs this week."}']);
    for (const time of ["09:48", "10:31"]) { now = new Date(`2026-11-04T${time}:00`); social.noteStory("codex", "failed", { title: "a", sessionId: "s1" }); }
    now = new Date("2026-11-04T11:15:00");
    social.noteStory("codex", "done", { title: "a", sessionId: "s1" });
    social.tellArc();
    now = new Date("2026-11-06T17:10:00");
    expect(await social.chapters()).toEqual([]);
    expect((await social.profile("codex")).chapters).toEqual([]);
  });
});
