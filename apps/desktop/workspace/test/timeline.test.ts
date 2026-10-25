import { expect, test } from "bun:test";
import { markNear, timelineMarks, type TurnFacts } from "../timeline.ts";

const turn = (over: Partial<TurnFacts>): TurnFacts => ({ ask: "Fix the sidebar", time: "13:50", askTop: null, answerTop: null, stepsTop: null, receiptTop: null, edited: [], failed: null, ...over });

test("each turn marks your message, its edits, its answer and a failed check, in order", () => {
  const marks = timelineMarks([
    turn({ askTop: 0, stepsTop: 60, answerTop: 200, receiptTop: 380, edited: ["src/sidebar.ts", "src/sidebar.test.ts"], failed: { name: "bun test", at: "13:51" } }),
    turn({ ask: "  Now   the   rail, please ", askTop: 500, answerTop: 600 }),
  ], 1000);
  expect(marks.map((mark) => [mark.kind, mark.at, mark.label, mark.meta])).toEqual([
    ["you", 0, "Fix the sidebar", "13:50"],
    ["edit", 0.06, "Edited 2 files", "sidebar.ts, sidebar.test.ts"],
    ["answer", 0.2, "Answer", "13:50"],
    ["fail", 0.38, "Check failed", "bun test · 13:51"],
    ["you", 0.5, "Now the rail, please", "13:50"],
    ["answer", 0.6, "Answer", "13:50"],
  ]);
  expect(marks[3]!.top).toBe(380);
});

test("marks too close together give way to the more telling one", () => {
  const marks = timelineMarks([turn({ askTop: 0, stepsTop: 4, answerTop: 8, edited: ["a.ts"], failed: { name: "", at: "" }, receiptTop: 9 })], 1000);
  expect(marks.map((mark) => [mark.kind, mark.label, mark.meta])).toEqual([["fail", "Check failed", ""]]);
});

test("a long message is clipped and a single edit names its file", () => {
  const [ask, edit] = timelineMarks([turn({ ask: "x".repeat(80), askTop: 0, stepsTop: 100, edited: ["apps/desktop/live.ts"] })], 1000);
  expect(ask!.label.length).toBe(48);
  expect(ask!.label.endsWith("…")).toBe(true);
  expect(edit!.label).toBe("Edited live.ts");
});

test("the nearest mark within reach answers a pointer", () => {
  const marks = timelineMarks([turn({ askTop: 100, answerTop: 300 })], 1000);
  expect(markNear(marks, 0.29, 0.02)?.kind).toBe("answer");
  expect(markNear(marks, 0.2, 0.02)).toBeNull();
  expect(timelineMarks([turn({ askTop: 0 })], 0)).toEqual([]);
});
