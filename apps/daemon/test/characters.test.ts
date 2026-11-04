import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHARACTERS, characterPrompt, likeness, lineProblems, pickLine, versions, type LineCheck } from "../src/characters.ts";
import { PERSONAS, SocialFeed } from "../src/socials.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });

const check = (facts: string, more: Partial<LineCheck> = {}): LineCheck => ({ facts, mine: [], recent: [], week: [], ...more });

describe("character sheets", () => {
  test("each agent's prompt carries its sheet and how it differs from the others", () => {
    const prompt = characterPrompt("codex");
    expect(prompt).toContain("You are Codex");
    expect(prompt).toContain(CHARACTERS.codex.core);
    expect(prompt).toContain("Unlike you, Claude Code is");
    expect(prompt).toContain("never pretend otherwise");
    expect(prompt).toContain("Green. Four lines.");
    expect(PERSONAS.gemini.voice).toBe(CHARACTERS.gemini.voice);
  });

  test("the sheets have no em or en dashes", () => {
    expect(JSON.stringify(CHARACTERS)).not.toMatch(/[–—]/);
  });
});

describe("versions", () => {
  test("numbered lines are versions; a plain reply is one", () => {
    expect(versions("1. Short.\n2. A bit longer.\n3) The long one.")).toEqual(["Short.", "A bit longer.", "The long one."]);
    expect(versions("Just this.")).toEqual(["Just this."]);
    expect(versions(null)).toEqual([]);
  });
});

describe("lineProblems", () => {
  test("numbers and file names must come from what happened", () => {
    const facts = "Chat: Fix sidebar\nWhat you answered: changed live.ts, 3 tests pass";
    expect(lineProblems("codex", "Green. 3 tests, live.ts.", check(facts))).toEqual([]);
    expect(lineProblems("codex", "Green in 40 minutes.", check(facts))).toEqual(["number 40 is not in what happened"]);
    expect(lineProblems("codex", "Rewrote sidebar.ts.", check(facts))[0]).toContain("sidebar.ts");
  });

  test("stock model phrases are out", () => {
    expect(lineProblems("claude", "What a journey this bug was.", check(""))).toHaveLength(1);
    expect(lineProblems("claude", "Here's to small wins!", check(""))).toHaveLength(2);
  });

  test("a pet phrase only once a week, and no echoes of recent posts", () => {
    expect(lineProblems("codex", "Done. Next.", check("", { week: ["Done before lunch."] }))).toEqual(['"done" again this week']);
    const recent = ["Took three tries to find the sidebar bug, but it is fixed now."];
    expect(lineProblems("claude", "Took three tries to find the sidebar bug, and it is fixed now!", check("", { recent }))).toContain("too close to a recent post");
    expect(lineProblems("claude", "Took three tries again on the parser today.", check("", { mine: recent }))).toContain("opens like a recent post");
  });

  test("likeness is shared words over all words", () => {
    expect(likeness("the tabs are fixed", "the tabs are fixed")).toBe(1);
    expect(likeness("tabs fixed", "parser broken")).toBe(0);
  });

  test("the first version that passes wins", () => {
    expect(pickLine("gemini", ["A real journey.", "Wait, why does width matter?"], check(""))).toBe("Wait, why does width matter?");
    expect(pickLine("gemini", ["A real journey."], check(""))).toBeNull();
  });
});

describe("the feed uses the checks", () => {
  function feed(replies: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "demesne-characters-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return new SocialFeed(join(dir, "socials.json"), { agents: () => ["claude", "codex", "gemini"], write: async () => replies.shift() ?? null });
  }
  const work = { kind: "work" as const, label: "Fix the tabs", sessionId: "s1", workspace: "/p/demesne-cli" };

  test("a made up number falls through to the next version", async () => {
    const social = feed(["1. Fixed it in 12 minutes.\n2. Tabs behave now. Took a while to see why.\n3. Longer one."]);
    const post = await social.noteAgentTurn("claude", work, "Fix the tabs", "Moved the close button.");
    expect(post?.text).toBe("Tabs behave now. Took a while to see why.");
  });

  test("when no version passes, the post says plainly what happened", async () => {
    const social = feed(["1. 12 minutes.\n2. What a journey.\n3. 99 problems."]);
    const post = await social.noteAgentTurn("codex", work, "Fix the tabs", "Moved the close button.");
    expect(post?.text).toBe("Finished Fix the tabs.");
  });
});
