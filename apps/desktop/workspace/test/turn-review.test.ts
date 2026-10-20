import { expect, test } from "bun:test";
import { codeDiff } from "@demesne/workbench/change-diff.ts";
import { notesMessage, reviewRows } from "../turn-review.ts";

test("review rows keep each change with its context and mark the gaps between", () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 3\n", "line three\n").replace("line 25\n", "line twenty-five\n");
  const rows = reviewRows(codeDiff(before, after).rows, 2);
  expect(rows.filter((row) => row.kind === "gap")).toHaveLength(1);
  expect(rows.filter((row) => row.kind === "added").map((row) => row.text)).toEqual(["line three", "line twenty-five"]);
  expect(rows[0]).toMatchObject({ kind: "context", text: "line 1" });
});

test("long diffs are folded after the limit", () => {
  const after = Array.from({ length: 50 }, (_, i) => `new ${i}`).join("\n");
  const rows = reviewRows(codeDiff("", after).rows, 3, 10);
  expect(rows).toHaveLength(11);
  expect(rows.at(-1)).toEqual({ kind: "gap", text: "longer diff folded" });
});

test("notes become one message in file and line order", () => {
  expect(notesMessage([])).toBe("");
  expect(notesMessage([
    { path: "b.ts", side: "new", line: 3, text: " ignore spaces " },
    { path: "a.ts", side: "old", line: 9, text: "keep this" },
    { path: "a.ts", side: "new", line: 2, text: "rename" },
  ])).toBe("Notes on the changes:\n- `a.ts` line 2: rename\n- `a.ts` removed line 9: keep this\n- `b.ts` line 3: ignore spaces");
});
