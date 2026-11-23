import { expect, test } from "bun:test";
import { keptLines, listHTML, pillHTML, pillTurn, pillWords, type PillRun } from "../memory-pill.ts";

// Pass 255: the silver pill above the composer when a turn kept something.

const tool = (input: Record<string, unknown>, state = "done") => ({ type: "tool", name: "remember", state, input });
const run = (id: string, entries: PillRun["entries"], status = "completed", completedAt: string | null = new Date().toISOString()): PillRun => ({ id, status, completedAt, entries });

test("only what the turn learned counts: not rules said in words, design rules, forgets or failures", () => {
  const turn = run("t1", [
    tool({ rule: "Uses bun, not npm", learned: "project" }),
    tool({ rule: "Skip the summary at the end", learned: "you" }),
    tool({ rule: "uses bun, not npm", learned: "project" }),
    tool({ rule: "Always run the tests" }),
    tool({ rule: "Serif headings", design: true, learned: "you" }),
    tool({ rule: "old line", learned: "you", forget: true }),
    tool({ rule: "Never", learned: "you" }, "failed"),
    { type: "assistant" },
  ]);
  expect(keptLines(turn)).toEqual([{ scope: "project", text: "Uses bun, not npm" }, { scope: "you", text: "Skip the summary at the end" }]);
  expect(pillWords(1)).toBe("Demesne will remember this");
  expect(pillWords(3)).toBe("Demesne will remember 3 things");
});

test("a pill once, for a turn that just finished, never for a chat opened again", () => {
  const seen = new Map<string, Set<string>>(), now = Date.now();
  const kept = [tool({ rule: "Uses bun", learned: "project" })];
  // Opening a chat whose last turn kept something shows nothing.
  expect(pillTurn("s", [run("old", kept)], seen, now)).toBeNull();
  expect(pillTurn("s", [run("old", kept)], seen, now)).toBeNull();
  // Running: not yet. Finished: once.
  expect(pillTurn("s", [run("old", kept), run("new", kept, "running", null)], seen, now)).toBeNull();
  expect(pillTurn("s", [run("old", kept), run("new", kept)], seen, now)?.lines).toEqual([{ scope: "project", text: "Uses bun" }]);
  expect(pillTurn("s", [run("old", kept), run("new", kept)], seen, now)).toBeNull();
  // A turn that kept nothing, or finished long ago, gets none.
  expect(pillTurn("s", [run("plain", [])], seen, now)).toBeNull();
  expect(pillTurn("s", [run("late", kept, "completed", new Date(now - 10 * 60_000).toISOString())], seen, now)).toBeNull();
});

test("the pill says how many in one line; the list escapes text and says who each is for", () => {
  const lines = [{ scope: "you" as const, text: "Skip <b>summaries</b>" }, { scope: "project" as const, text: "Uses bun" }];
  const pill = pillHTML(lines);
  expect(pill).toContain("Demesne will remember 2 things");
  expect(pill).toContain('aria-expanded="false"');
  const list = listHTML(lines);
  expect(list).toContain("Skip &lt;b&gt;summaries&lt;/b&gt;");
  expect(list).toContain('title="About you, every project"');
  expect(list).toContain('title="This project"');
  expect(list).toContain("Undo all");
  expect(listHTML([lines[1]!])).toContain(">Undo<");
});
