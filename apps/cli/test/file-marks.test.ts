import { describe, expect, test } from "bun:test";
import { fileChangeMarks } from "../src/workbench/file-marks.ts";

describe("fileChangeMarks", () => {
  test("marks added and changed lines, removals on the following line, and groups each edit", () => {
    const original = "a\nb\nc\nd\ne\nf\n";
    const current = "a\nB\nc\nd\nnew1\nnew2\ne\n";
    const marks = fileChangeMarks(original, current);
    expect([...marks.added].sort()).toEqual([2, 5, 6]);
    // `f` was removed after `e` (line 7): marked on the last line.
    expect([...marks.removedBefore]).toEqual([2, 7]);
    expect(marks.changes).toEqual([{ start: 2, end: 2 }, { start: 5, end: 6 }, { start: 7, end: 7 }]);
  });
  test("a new file is one change covering every line; an unchanged file has none", () => {
    expect(fileChangeMarks("", "x\ny\n").changes).toEqual([{ start: 1, end: 2 }]);
    expect(fileChangeMarks("same\n", "same\n").changes).toEqual([]);
  });
});
