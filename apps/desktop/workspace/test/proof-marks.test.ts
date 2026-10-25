import { expect, test } from "bun:test";
import { claimTitle, locate, lookedAt, proofLine } from "../proof-marks.ts";

test("a claim's words are found across the rendered text's nodes, without code ticks or emphasis", () => {
  // <p>Fixed. <code>projectFor</code> returned nothing, so <b>all 1198 tests pass</b>.</p>
  const segments = ["Fixed. ", "projectFor", " returned nothing, so ", "all 1198 tests pass", "."];
  expect(locate(segments, "`projectFor` returned nothing")).toEqual([
    { segment: 1, start: 0, end: 10 },
    { segment: 2, start: 0, end: 17 },
  ]);
  expect(locate(segments, "**all 1198 tests pass**")).toEqual([{ segment: 3, start: 0, end: 19 }]);
  expect(locate(segments, "returned nothing,  so all")).toEqual([
    { segment: 2, start: 1, end: 22 },
    { segment: 3, start: 0, end: 3 },
  ]);
  expect(locate(segments, "nothing here")).toBeNull();
  expect(locate(segments, "  ")).toBeNull();
});

test("wrapped whitespace in the page still matches one space in the claim", () => {
  expect(locate(["The row\n  stays and says", " the folder is missing"], "The row stays and says the folder")).toEqual([
    { segment: 0, start: 0, end: 24 },
    { segment: 1, start: 0, end: 11 },
  ]);
});

test("the count line and the words under a mark", () => {
  expect(proofLine([])).toBeNull();
  expect(proofLine([{ id: "a", text: "x", state: "proved" }, { id: "b", text: "y", state: "unchecked" }, { id: "c", text: "z", state: "dropped" }]))
    .toEqual({ proved: "1 proved", unchecked: "1 not checked", wrong: "", checking: "" });
  expect(proofLine([{ id: "a", text: "x", state: "proved" }, { id: "b", text: "y", state: "proved" }])!.proved).toBe("All 2 proved");
  expect(proofLine([{ id: "a", text: "x", state: "false" }, { id: "b", text: "y", state: "checking" }])).toEqual({ proved: "", unchecked: "", wrong: "1 not true", checking: "checking 1" });
  expect(claimTitle({ id: "a", text: "x", state: "proved", toolCallId: "t" }, { words: "Ran bun test", number: 4 })).toBe("Ran bun test · step 4");
  expect(claimTitle({ id: "a", text: "x", state: "proved", step: "read sidebar.ts" }, null)).toBe("Checked · read sidebar.ts");
  expect(claimTitle({ id: "a", text: "x", state: "false", why: "Two callers." }, null)).toBe("Not true: Two callers.");
  expect(claimTitle({ id: "a", text: "x", state: "checking", step: "rg projectFor" }, null)).toBe("Checking · rg projectFor");
  expect(lookedAt([{ words: "Read sidebar.ts" }, { words: "Edited sidebar.ts" }, { words: "Read sidebar.ts" }, { words: "Ran bun test" }]))
    .toBe("This turn only read sidebar.ts, edited sidebar.ts and ran bun test.");
  expect(lookedAt([])).toBe("");
});
