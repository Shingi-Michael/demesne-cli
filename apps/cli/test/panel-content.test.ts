import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createPainter } from "@demesne/brand";
import { fileListLines, readingTrail } from "../src/workbench/file-list.ts";
import type { SessionRun } from "../src/workbench/session.ts";

const tool = (id: number, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id, type: "tool", toolCallId: String(id), name, input, state: "done", startedAt: 0, phase: name.includes("edit") ? "change" : "inspect", ...extra });
const runs = [{ tools: [
  tool(1, "read_file", { path: "src/lexer.ts" }),
  tool(2, "read_files", { files: [{ path: "src/lexer.ts" }, { path: "tests/parser.test.ts" }] }),
  tool(3, "edit_file", { path: "src/lexer.ts" }, { changes: [{ path: "src/lexer.ts", before: "a\nb\n", after: "a\nB\nc\n", beforeExists: true, afterExists: true }] }),
] }] as unknown as SessionRun[];

test("the reading trail records what the agent edited and read, with net lines", () => {
  const trail = readingTrail(runs);
  expect(trail.get("src/lexer.ts")).toMatchObject({ edited: true, reads: 2, added: 2, removed: 1 });
  expect(trail.get("tests/parser.test.ts")).toMatchObject({ edited: false, reads: 1 });
});

test("the Files list shows this session first, then git changes, then everything else, narrowed by the filter", () => {
  const paint = createPainter(false);
  const files = [
    { path: "src/lexer.ts", byteLength: 2048, status: "M" },
    { path: "tests/new.test.ts", byteLength: 10, status: "??" },
    { path: "README.md", byteLength: 1_500_000, status: null },
    { path: "tests/parser.test.ts", byteLength: 300, status: null },
  ];
  const lines = fileListLines(files, readingTrail(runs), "", 60, paint).map((line) => stripVTControlCharacters(line.text));
  expect(lines[0]).toMatch(/^THIS SESSION +2$/);
  expect(lines[1]).toMatch(/^✎ src\/lexer\.ts +edited {2}\+2 −1$/);
  expect(lines[2]).toMatch(/^◉ tests\/parser\.test\.ts +read$/);
  expect(lines).toContain("");
  expect(lines.find((line) => line.startsWith("GIT CHANGES"))).toMatch(/GIT CHANGES +2/);
  expect(lines.some((line) => /^\? tests\/new\.test\.ts +untracked$/.test(line))).toBe(true);
  // ALL FILES lists only what is not already above.
  expect(lines.find((line) => line.startsWith("ALL FILES"))).toMatch(/ALL FILES +1/);
  expect(lines.at(-1)).toMatch(/README\.md +1\.5m$/);
  const filtered = fileListLines(files, readingTrail(runs), "parser", 60, paint);
  expect(filtered.flatMap((line) => line.path ? [line.path] : [])).toEqual(["tests/parser.test.ts"]);
  expect(stripVTControlCharacters(fileListLines(files, readingTrail(runs), "zzz", 60, paint)[0]!.text)).toBe('No files match "zzz".');
});
