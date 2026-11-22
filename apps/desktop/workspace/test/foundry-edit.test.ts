import { expect, test } from "bun:test";
import { changed, markdownText, placeEdit } from "../foundry-edit.ts";

const DOC = `---
title: Q3 review
---
# Q3 review

Revenue grew **18%** on the quarter, led by the new counter app.

## What went well

- Orders through the app doubled
- Two new cafés opened

| Shop | Orders |
| --- | --- |
| Soho | 1,204 |

\`\`\`stats
Orders | 4,812 | +12% | vs Q2
\`\`\`
`;

test("what changed: the start and end they share, and the middle", () => {
  expect(changed("Two new cafés opened", "Three new cafés opened")).toEqual({ start: 1, end: 17, was: "wo", now: "hree" });
  expect(changed("abc", "abc!")).toEqual({ start: 3, end: 0, was: "", now: "!" });
});

test("a word changed in plain text is changed in the content, nothing else", () => {
  expect(placeEdit(DOC, "Two new cafés opened", "Three new cafés opened")).toBe(DOC.replace("Two new cafés", "Three new cafés"));
  expect(placeEdit(DOC, "What went well", "What worked")).toBe(DOC.replace("## What went well", "## What worked"));
});

test("formatting around a change is kept", () => {
  // "18%" is bold in the content; the change is after it.
  expect(placeEdit(DOC, "Revenue grew 18% on the quarter, led by the new counter app.", "Revenue grew 18% on the quarter, led by the new ordering app."))
    .toBe(DOC.replace("new counter app", "new ordering app"));
  // The bold number itself.
  expect(placeEdit(DOC, "Revenue grew 18% on the quarter, led by the new counter app.", "Revenue grew 21% on the quarter, led by the new counter app."))
    .toBe(DOC.replace("**18%**", "**21%**"));
});

test("a title that repeats is placed by its context; a table cell and a stat tile too", () => {
  // "Q3 review" is in the front matter and the heading: the piece alone can't say which.
  expect(placeEdit(DOC, "Q3 review", "Q3 in review")).toBe(null);
  expect(placeEdit(DOC, "1,204", "1,240")).toBe(DOC.replace("1,204", "1,240"));
  expect(placeEdit(DOC, "+12%", "+14%")).toBe(DOC.replace("+12%", "+14%"));
  expect(placeEdit(DOC, "Orders through the app doubled", "Orders through the app doubled.")).toBe(DOC.replace("app doubled", "app doubled."));
});

test("text that isn't in the content can't be placed; typed formatting is escaped", () => {
  expect(placeEdit(DOC, "Mon", "Monday")).toBe(null);
  expect(placeEdit(DOC, "Two new cafés opened", "Two *new* cafés opened")).toBe(DOC.replace("Two new cafés", "Two \\*new\\* cafés"));
  expect(markdownText("a | b\nc")).toBe("a \\| b c");
  expect(placeEdit(DOC, "same", "same")).toBe(DOC);
});
