/// Step 3 of pass 273 A: sheets, CSV the model writes and Demesne draws.
import { expect, test } from "bun:test";
import { cellNumber, numberColumns, parseCSV, parseSheet, sheetCSV, sheetProblem } from "../src/foundry-sheet.ts";

test("CSV: quotes, doubled quotes, commas and line breaks inside quotes, CRLF, blank lines dropped", () => {
  expect(parseCSV('Name,Note\r\n"Smith, Ann","said ""hi""\nthen left"\n\nBo,ok\n')).toEqual([["Name", "Note"], ["Smith, Ann", 'said "hi"\nthen left'], ["Bo", "ok"]]);
  expect(parseCSV("﻿a,b\n1,")).toEqual([["a", "b"], ["1", ""]]);
});

test("a sheet: the first row names the columns, each row as wide as the head", () => {
  expect(parseSheet("Plot, pH ,Nitrogen\nA1,6.4\nB2,7.1,22")).toEqual({ head: ["Plot", "pH", "Nitrogen"], rows: [["A1", "6.4", ""], ["B2", "7.1", "22"]] });
});

test("what a sheet can't be says why", () => {
  expect(sheetProblem("")).toContain("column names");
  expect(sheetProblem("Plot,,pH\nA,1,2")).toContain("Every column needs a name");
  expect(sheetProblem("Name,Age\nSmith, Ann,40")).toContain("Row 1 has 3 cells but there are 2 columns");
  expect(sheetProblem(Array.from({ length: 41 }, (_, at) => `c${at}`).join(","))).toContain("up to 40 columns");
  expect(sheetProblem("Plot,pH\nA1,6.4")).toBeNull();
});

test("numbers as people write them, and which columns are numbers", () => {
  expect(cellNumber("1,200")).toBe(1200);
  expect(cellNumber("$18.50")).toBe(18.5);
  expect(cellNumber("-$3")).toBe(-3);
  expect(cellNumber("(40)")).toBe(-40);
  expect(cellNumber("12%")).toBe(12);
  expect(cellNumber("7.4 km")).toBeNull();
  expect(cellNumber("")).toBeNull();
  expect(numberColumns(parseSheet("Plot,pH,Note\nA1,6.4,dry\nB2,,wet"))).toEqual([false, true, false]);
});

test("back to CSV, quoting only what needs it", () => {
  const sheet = parseSheet('Name,Note\n"Smith, Ann","said ""hi"""\nBo,ok');
  expect(sheetCSV(sheet)).toBe('Name,Note\n"Smith, Ann","said ""hi"""\nBo,ok\n');
  expect(parseSheet(sheetCSV(sheet))).toEqual(sheet);
});
