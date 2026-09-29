import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createPainter, languageForPath, visibleLength } from "@demesne/brand";
import { codeDiff } from "../src/workbench/change-diff.ts";
import { diffSyntax } from "../src/workbench/diff-syntax.ts";
import { DiffPanel } from "../src/workbench/diff-panel.ts";
import { planRuns } from "../src/workbench/session.ts";
import type { ToolEntry } from "../src/workbench/entries.ts";

const paint = createPainter(true, "demesne");
const highlighted = (path: string, before: string, after: string) => {
  const rows = codeDiff(before, after).rows;
  return [...diffSyntax(path, before, after, rows, paint)].map(([row, text]) => ({ ...row, styled: text }));
};

test("file previews select existing grammars, including module/declaration extensions and shell dotfiles", () => {
  for (const [path, language] of Object.entries({ "src/view.tsx": "typescript", "src/api.d.mts": "typescript", "index.cjs": "javascript",
    "types.pyi": "python", "C:\\project\\app.PY": "python", "src/lib.rs": "rust", "go.mod.go": "go", "package.json": "json",
    "ci.yml": "yaml", ".zshrc": "bash", "scripts/build.sh": "bash" })) expect(languageForPath(path)).toBe(language);
  expect(languageForPath("README.md")).toBeUndefined(); expect(languageForPath("notes.txt")).toBeUndefined();
});

test("hidden context establishes multiline comments and old/new lexical states remain independent", () => {
  const header = "/*\n" + " * documentation\n".repeat(12);
  const before = header + "const oldValue = 1;\n*/\n", after = header + "const newValue = 2;\n*/\n";
  const rows = highlighted("src/parser.ts", before, after);
  expect(rows.find((row) => row.kind === "added")?.styled).toBe(paint.text("const newValue = 2;", "syntaxComment"));
  expect(rows.find((row) => row.kind === "removed")?.styled).toBe(paint.text("const oldValue = 1;", "syntaxComment"));
  const independent = highlighted("src/parser.ts", "/* unfinished old comment\nconst obsolete = 1;\n", "export const count = 42;\n");
  expect(independent.find((row) => row.kind === "added")?.styled).toContain(paint.text("export", "syntaxKeyword"));
  expect(independent.find((row) => row.kind === "added")?.styled).toContain(paint.text("42", "syntaxNumber"));
});

test("multiline template strings and Python docstrings carry through hidden hunk context", () => {
  for (const [path, opener, closer] of [["src/message.ts", "const message = `", "`;"], ["src/message.py", 'message = """', '"""']]) {
    const prefix = opener + "\n" + "literal text\n".repeat(12);
    const rows = highlighted(path!, prefix + "old const text\n" + closer, prefix + "new const text\n" + closer);
    expect(rows.find((row) => row.kind === "added")?.styled).toBe(paint.text("new const text", "syntaxString"));
  }
  const rows = highlighted("src/message.ts", "", "const message = `one\ntwo`; const answer = 42;\n");
  expect(rows.find((row) => row.next === 2)?.styled).toContain(paint.text("two`", "syntaxString"));
  expect(rows.find((row) => row.next === 2)?.styled).toContain(paint.text("const", "syntaxKeyword"));
});

test("syntax color is separate from diff markers, survives cell wrapping and theme swaps, and stays plain under NO_COLOR", () => {
  const before = 'export const label = "before";\n';
  const after = 'export const label = "界 👩‍💻 this is a long string that wraps across the narrow diff panel"; // note\n';
  const tool: ToolEntry = { id: 2, type: "tool", toolCallId: "write", name: "write_file", input: { path: "src/app.ts" }, phase: "change", state: "done", startedAt: 0,
    changes: [{ path: "src/app.ts", before, after, beforeExists: true, afterExists: true }] };
  const panel = new DiffPanel(); panel.open(planRuns([{ id: 1, type: "user", text: "Edit", at: "12:00" }, tool]), 1);
  const painter = createPainter(true, "demesne");
  for (const theme of ["demesne", "demesne-light", "dracula"]) {
    painter.setTheme(theme);
    const frame = panel.render(40, 48, painter);
    const output = frame.rows.join("\n"), plain = stripVTControlCharacters(output);
    expect(output).toContain(painter.text("export", "syntaxKeyword"));
    expect(output).toContain(painter.text("− ", "signal"));
    expect(output).toContain(painter.text("+ ", "citron"));
    expect(output).toContain(painter.text('"before"', "syntaxString"));
    expect(plain).toContain("↪"); expect(plain).toContain("界 👩‍💻");
    expect(frame.rows.every((row) => visibleLength(row) === 40)).toBe(true);
    const background = (hex: string) => `48;2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}`;
    expect(output).toContain(background(painter.colors.diffAddedSurface));
    expect(output).toContain(background(painter.colors.diffRemovedSurface));
    // Foreground syntax remains visible after Canvas reapplies the panel surface.
    const added = frame.rows.find((row) => stripVTControlCharacters(row).includes("+ export"))!;
    expect(added).toContain(painter.text("const", "syntaxKeyword"));
  }
  const plain = panel.render(40, 48, createPainter(false)).rows.join("\n");
  expect(plain).not.toContain("\x1b"); expect(plain).toContain("+ export"); expect(plain).toContain("− export");
});

test("unknown file contents stay neutral and source control sequences never become terminal instructions", () => {
  const before = "", after = 'const text = "hi";\x1b]52;c;payload\x07\n';
  const rows = codeDiff(before, after).rows;
  const colored = diffSyntax("src/file.ts", before, after, rows, paint);
  const neutral = diffSyntax("notes.txt", before, after, rows, paint);
  expect([...colored.values()].join("")).not.toContain("\x1b]");
  expect([...neutral.values()].join("")).not.toContain("\x1b");
  for (const row of rows.filter((row) => row.kind !== "gap")) expect(stripVTControlCharacters(colored.get(row)!)).toBe(neutral.get(row)!);
});
