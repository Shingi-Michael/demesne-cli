import { describe, expect, test } from "bun:test";
import type { Deed, DeedPeek, DeedSentence, DeedValue } from "@demesne/protocol";
import { deedPage, editLine, findHits, liveLine, liveWords, numberOf, numberText, toCheck, weekDays, wordDiff } from "../deed-view.ts";

const sentence = (over: Partial<DeedSentence> = {}): DeedSentence => ({ id: "a", section: "Drive", text: "It starts after 20 quiet minutes.", anchors: [{ path: "src/auto.ts", line: 31, quote: "x" }], state: "true", updatedAt: "", ...over });
const deed = (sentences: DeedSentence[], over: Partial<Deed> = {}): Deed => ({ workspace: "/w", writtenAt: "2026-10-23", writing: null, sections: ["Drive"], sentences, ...over });

describe("the Deed page", () => {
  test("strikes the old words and writes in the new ones", () => {
    expect(wordDiff("It starts after 20 quiet minutes.", "It starts after 10 quiet minutes.")).toBe("It starts after <del>20</del><ins>10</ins> quiet minutes.");
    expect(wordDiff("a b", "a b c")).toBe("a b <ins>c</ins>");
    expect(wordDiff("<b>", "<i>")).toBe("<del>&lt;b&gt;</del><ins>&lt;i&gt;</ins>");
  });
  test("an edit says what Enter will do", () => {
    const one = sentence();
    expect(editLine(one, one.text)).toContain("Esc keeps the old words");
    expect(editLine(one, "It starts after 10 quiet minutes.")).toContain("Make it so");
    expect(editLine(one, "It starts after 10 quiet minutes.")).toContain("<b>auto.ts</b>");
    expect(editLine(one, "  ")).toContain("Remove it");
  });
  test("counts what needs you and says how much is true", () => {
    const page = deed([sentence(), sentence({ id: "b", state: "check" }), sentence({ id: "c", state: "false" }), sentence({ id: "d", state: "wish" })]);
    expect(toCheck(page)).toBe(2);
    const text = deedPage(page, { focus: null, editing: null }, "demo");
    expect(text).toContain("4 sentences, written from the code.");
    expect(text).toContain(">1 unproved<");
    expect(text).toContain(">2 to check<");
    expect(text).toContain(">1 wish<");
  });
  test("draws each state: the empty page, the drifted sentence, a wish", () => {
    expect(deedPage(deed([], { writtenAt: null }), { focus: null, editing: null }, "demo")).toContain("Write the deed");
    expect(deedPage(deed([], { writtenAt: null, writing: { sessionId: "s", status: "running" } }), { focus: null, editing: null }, "demo")).toContain("Reading the code");
    const drifted = deedPage(deed([sentence({ state: "false", why: "It waits 15 now.", words: "It starts after 15 quiet minutes." })]), { focus: null, editing: null }, "demo");
    expect(drifted).toContain("No longer true.");
    expect(drifted).toContain("Fix the code");
    expect(drifted).toContain("Fix the words");
    const wish = deedPage(deed([sentence({ state: "wish", anchors: [] })]), { focus: "a", editing: null }, "demo");
    expect(wish).toContain("Build it");
    expect(wish).toContain("Leave it as a wish");
    expect(deedPage(deed([sentence()]), { focus: "a", editing: "a" }, "demo")).toContain('class="dz-edit"');
  });

  const quiet: DeedValue = { id: "v1", text: "20", path: "src/auto.ts", line: 31, literal: "20", code: "const QUIET_MS = 20 * 60_000;", kind: "number" };
  const key: DeedValue = { id: "v2", text: "Enter", path: "src/keys.ts", line: 4, literal: "\"Enter\"", code: "const STEER = \"Enter\";", kind: "choice", choices: [{ word: "Enter", literal: "\"Enter\"" }, { word: "⌥↵", literal: "\"Alt+Enter\"" }] };
  test("says numbers the way the sentence does", () => {
    expect(numberOf("three")).toBe(3);
    expect(numberOf("20")).toBe(20);
    expect(numberText(5, "three")).toBe("five");
    expect(numberText(5, "Three")).toBe("Five");
    expect(numberText(40, "three")).toBe("40");
    expect(numberText(10, "20")).toBe("10");
  });
  test("marks the live words, and the one being changed", () => {
    const one = sentence({ values: [quiet], tests: ["test/auto.test.ts"] });
    expect(liveWords(one, { focus: null, editing: null })).toBe('It starts after <span class="lv num" data-sentence="a" data-value="v1" tabindex="0" title="Drag, or ↑↓ · src/auto.ts:31">20</span> quiet minutes.');
    expect(liveWords(one, { focus: null, editing: null, live: { sentence: "a", value: "v1", to: 10 } })).toContain('<i>‹</i>10<i>›</i>');
    expect(liveWords({ ...one, state: "check" }, { focus: null, editing: null })).toBe("It starts after 20 quiet minutes.");
    const keys = sentence({ text: "Enter steers it.", values: [key] });
    const picking = liveWords(keys, { focus: null, editing: null, live: { sentence: "a", value: "v2", to: "Enter" } });
    expect(picking).toContain("<b>Enter</b>");
    expect(picking).toContain("lv-alt");
    expect(picking).toContain("⌥↵");
  });
  test("the line under a changed value shows the line of code and its tests", () => {
    const one = sentence({ values: [quiet], tests: ["test/auto.test.ts"] });
    const line = liveLine(one, { focus: null, editing: null, live: { sentence: "a", value: "v1", to: 10 } });
    expect(line).toContain("Make it so");
    expect(line).toContain("<b>auto.test.ts</b>");
    expect(line).toContain("− const QUIET_MS = 20 * 60_000;");
    expect(line).toContain("+ const QUIET_MS = 10 * 60_000;");
    expect(liveLine(one, { focus: null, editing: null, live: { sentence: "a", value: "v1", to: 20 } })).not.toContain("Make it so");
  });
  test("draws a proof: running, passed with Undo, failed and put back", () => {
    const at = "2026-10-23T00:00:00Z", ui = { focus: null, editing: null };
    expect(deedPage(deed([sentence({ proof: { state: "running", at, files: ["t.test.ts"] } })]), ui, "demo")).toContain("Proving");
    const passed = deedPage(deed([sentence({ proof: { state: "passed", at, files: ["t.test.ts"], passed: 3, ms: 1400 }, undo: { path: "src/auto.ts", before: "", after: "", text: "", values: [] } })]), ui, "demo");
    expect(passed).toContain("✓ Proved");
    expect(passed).toContain("3 tests");
    expect(passed).toContain("1.4s");
    expect(passed).toContain("Undo");
    expect(passed.match(/<i><\/i>/g)?.length).toBe(3);
    const failed = deedPage(deed([sentence({ proof: { state: "failed", at, files: ["t.test.ts"], detail: "expected 20", putBack: true } })]), ui, "demo");
    expect(failed).toContain("Not proved, so it went back.");
    expect(failed).toContain("expected 20");
    expect(failed).toContain("Prove again");
  });
  test("Prove it runs every sentence, and Stop stops it", () => {
    const ui = { focus: null, editing: null };
    expect(deedPage(deed([sentence()]), ui, "demo")).not.toContain("Prove it");
    expect(deedPage(deed([sentence({ tests: ["t.test.ts"] })]), ui, "demo")).toContain("Prove it");
    const proving = deedPage(deed([sentence({ tests: ["t.test.ts"], proof: { state: "running", at: "", files: ["t.test.ts"] } })], { proving: { total: 4, done: 1, failed: 0, running: true, at: "" } }), ui, "demo");
    expect(proving).toContain("1 of 4");
    expect(proving).toContain("Stop");
    expect(proving).toContain("Drive · t.test.ts");
  });
  const noon = (day: number) => new Date(2026, 9, day, 12).getTime();
  const change = (day: number, over: object = {}) => ({ at: new Date(noon(day)).toISOString(), id: "a", section: "Drive", kind: "words" as const, who: "you" as const, was: "It starts after 20 quiet minutes.", text: "It starts after 10 quiet minutes.", ...over });
  test("a count filters the page, and says how many remain in each section", () => {
    const page = deed([sentence({ proof: { state: "passed", at: "", files: ["t"] } }), sentence({ id: "b" }), sentence({ id: "c", section: "Chats", state: "wish", anchors: [] })], { sections: ["Drive", "Chats"] });
    const only = deedPage(page, { focus: null, editing: null, filter: "unproved" }, "demo");
    expect(only).toContain("1 of 2");
    expect(only).not.toContain("Chats");
    expect(deedPage(page, { focus: null, editing: null, filter: "wish" }, "demo")).not.toContain("<h3>Drive");
    expect(deedPage(page, { focus: null, editing: null, filter: "unproved" }, "demo")).toContain('class="ct hol on"');
  });
  test("the week has a dot on the days the Deed changed", () => {
    const page = deed([sentence({ text: "It starts after 10 quiet minutes." })], { log: [change(21), change(22)] });
    const days = weekDays(page, noon(23));
    expect(days.map((day) => day.label).at(-1)).toBe("Today");
    expect(days.map((day) => day.changes.length)).toEqual([0, 0, 0, 1, 1, 0]);
    expect(deedPage(page, { focus: null, editing: null }, "demo", noon(23)).match(/<b><\/b>/g)?.length).toBe(2);
  });
  test("a day's page shows the changes since, and fades the rest", () => {
    const page = deed([sentence({ text: "It starts after 10 quiet minutes." }), sentence({ id: "b", text: "Other words." })], { log: [change(22), change(22, { id: "x", kind: "removed", was: "Gone words.", text: "Gone words." })] });
    const text = deedPage(page, { focus: null, editing: null, since: new Date(2026, 9, 22).getTime() }, "demo", noon(23));
    expect(text).toContain("<del>20</del><ins>10</ins>");
    expect(text).toContain("you · Thu");
    expect(text).toContain("<del>Gone words.</del>");
    expect(text).toContain('class="dz-s dim"');
    expect(text).toContain("Since");
  });
  test("typing finds the sentences that say every word, marked, and fades the rest", () => {
    const page = deed([sentence({ text: "It starts after 20 quiet minutes." }), sentence({ id: "b", text: "Enter steers a running turn." })]);
    expect(findHits(page, "QUIET start").map((hit) => hit.id)).toEqual(["a"]);
    expect(findHits(page, "  ")).toEqual([]);
    const text = deedPage(page, { focus: null, editing: null, find: "quiet" }, "demo");
    expect(text).toContain("<mark>quiet</mark>");
    expect(text).toContain("1 sentence says “quiet”");
    expect(text.match(/class="dz-s [^"]*dim/g)?.length).toBe(1);
    expect(deedPage(page, { focus: null, editing: null, find: "zebra" }, "demo")).toContain("No sentence says “zebra”");
  });
  test("Space unfolds the code under a sentence, its live value marked and following a drag", () => {
    const one = sentence({ values: [{ id: "v1", text: "20", path: "src/auto.ts", line: 30, literal: "20", code: "export const QUIET_MINUTES = 20;", kind: "number" }], tests: ["test/auto.test.ts"] });
    const data: DeedPeek = { id: "a", path: "src/auto.ts", line: 30, lines: [{ n: 29, text: "/// quiet" }, { n: 30, text: "export const QUIET_MINUTES = 20;" }] };
    const open = deedPage(deed([one]), { focus: "a", editing: null, peek: { id: "a", at: "", data } }, "demo");
    expect(open).toContain("src/auto.ts");
    expect(open).toContain("proved by auto.test.ts");
    expect(open).toContain('<span class="tok">20</span>');
    const dragging = deedPage(deed([one]), { focus: "a", editing: null, peek: { id: "a", at: "", data }, live: { sentence: "a", value: "v1", to: 10 } }, "demo");
    expect(dragging).toContain('<span class="tok on">‹ 10 ›</span>');
    expect(deedPage(deed([one]), { focus: "a", editing: null }, "demo")).not.toContain('class="peek"');
  });
  test("a sentence nothing tests offers Drive to prove it, and says when a chat could not", () => {
    const ui = { focus: "a", editing: null };
    const bare = deedPage(deed([sentence()]), ui, "demo");
    expect(bare).toContain("No test holds it yet.");
    expect(bare).toContain("Have Drive prove it");
    expect(deedPage(deed([sentence({ state: "working", covering: true })]), ui, "demo")).toContain("Writing a test that proves it");
    const failed = deedPage(deed([sentence({ proof: { state: "failed", at: "", files: [], putBack: true, detail: "It stopped." } })]), ui, "demo");
    expect(failed).toContain("No test yet.");
    expect(failed).toContain("Have Drive try again");
  });
});
