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
  // Figma 51:638: CHANGED first with its count, then ALL FILES.
  const plain = lines.map(stripVTControlCharacters);
  expect(plain[0]).toMatch(/^CHANGED +4$/);
  expect(lines[1]).toStartWith(paint.text("M", "thinking"));
  expect(lines[2]).toStartWith(paint.text("A", "citron"));
  expect(lines[3]).toStartWith(paint.text("?", "citron"));
  expect(lines[4]).toStartWith(paint.text("D", "signal"));
  expect(plain[1]).toContain("src/changed.ts");
  expect(plain[1]!.trimEnd()).toEndWith("2.0k");
  expect(plain[6]).toMatch(/^ALL FILES +1$/);
  expect(plain[7]!.trimEnd()).toEndWith("1.5m");
  // The folder is dim and the filename bright.
  expect(lines[1]).toContain(paint.text("src/", "muted") + paint.text("changed.ts", "paper"));
});
