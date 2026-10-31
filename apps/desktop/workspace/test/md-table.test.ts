import { expect, test } from "bun:test";
import { columnAligns, numericColumns, tableCsv, tableMarkdown } from "../md-table.ts";

test("number columns line up on the right, even when the model forgot the colon", () => {
  const rows = [["GPT-6.1 Sol", "281", "96%", "$0.002", "0.8 s", "today"], ["Qwen", "1,206", "90%", "—", "12 ms", "Oct 27"]];
  expect(numericColumns(rows)).toEqual([false, true, true, true, true, false]);
  // What the Markdown asked for wins.
  expect(columnAligns(["center", null, "left", null, null, null], rows)).toEqual(["center", "right", "left", "right", "right", "left"]);
  // A column of dashes alone is not a number column.
  expect(numericColumns([["—"], [""]])).toEqual([false]);
  expect(numericColumns([["v1.2.3"], ["2"]])).toEqual([false]);
});

test("Copy gives Markdown with alignment; CSV quotes what needs it", () => {
  const head = ["Option", "Cost", "Notes"], rows = [["Quiet | notes", "0", "No model call"], ["Full", "$0.03", 'Says "hi", twice']];
  expect(tableMarkdown(head, rows, ["left", "right", "center"])).toBe("| Option | Cost | Notes |\n| --- | ---: | :---: |\n| Quiet \\| notes | 0 | No model call |\n| Full | $0.03 | Says \"hi\", twice |");
  expect(tableCsv(head, rows)).toBe('Option,Cost,Notes\nQuiet | notes,0,No model call\nFull,$0.03,"Says ""hi"", twice"');
});
