import { describe, expect, test } from "bun:test";
import type { Deed, DeedSentence } from "@demesne/protocol";
import { deedPage, deedSummary, editLine, toCheck, wordDiff } from "../deed-view.ts";

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
    expect(deedSummary(page)).toBe("3 sentences · 1 true · 1 wish");
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
});
