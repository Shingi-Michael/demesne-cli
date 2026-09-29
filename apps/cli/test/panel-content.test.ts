import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createPainter } from "@demesne/brand";
import { filePanelLines } from "../src/workbench/panel-content.ts";

test("file rows color git status by meaning and keep path and size", () => {
  const paint = createPainter(true);
  const lines = filePanelLines([
    { path: "src/changed.ts", byteLength: 2048, status: "M" },
    { path: "src/added.ts", byteLength: 10, status: "A" },
    { path: "src/new.ts", byteLength: null, status: "??" },
    { path: "src/removed.ts", byteLength: null, status: "D" },
    { path: "README.md", byteLength: 1_500_000, status: null },
  ], 40, paint);
  expect(lines[0]).toStartWith(paint.text("M", "thinking"));
  expect(lines[1]).toStartWith(paint.text("A", "citron"));
  expect(lines[2]).toStartWith(paint.text("??", "citron"));
  expect(lines[3]).toStartWith(paint.text("D", "signal"));
  const plain = lines.map(stripVTControlCharacters);
  expect(plain[0]).toContain("src/changed.ts");
  expect(plain[0]!.trimEnd()).toEndWith("2.0k");
  expect(plain[4]!.trimEnd()).toEndWith("1.5m");
});
