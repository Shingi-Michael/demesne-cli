import { describe, expect, test } from "bun:test";
import { createPainter } from "../src/index.ts";
import { highlightCode, normalizeLanguage, type CodeHighlightState } from "../src/highlight.ts";

const painter = createPainter(true, "dark");
const plain = createPainter(false, "dark");

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("normalizeLanguage", () => {
  test("resolves common aliases", () => {
    expect(normalizeLanguage("ts")).toBe("typescript");
    expect(normalizeLanguage("TSX")).toBe("typescript");
    expect(normalizeLanguage("js")).toBe("javascript");
    expect(normalizeLanguage("zsh")).toBe("bash");
    expect(normalizeLanguage("sh")).toBe("bash");
    expect(normalizeLanguage("yml")).toBe("yaml");
    expect(normalizeLanguage("py")).toBe("python");
    expect(normalizeLanguage("rs")).toBe("rust");
    expect(normalizeLanguage("go")).toBe("go");
    expect(normalizeLanguage("jsonc")).toBe("json");
    expect(normalizeLanguage("")).toBe("");
  });
});

describe("highlightCode", () => {
  test("returns the input unchanged when color is disabled", () => {
    const code = "const s = \"hi\"; // note";
    expect(highlightCode(code, "ts", plain)).toBe(code);
  });

  test("is lossless for every supported language", () => {
    const samples: Array<[string, string]> = [
      ["ts", "const s = \"hi\"; // note\n/* block */"],
      ["json", "{\"key\": \"value\", \"n\": 12, \"ok\": true}"],
      ["bash", "if [ -f \"$HOME/x\" ]; then # comment\n  echo hi\nfi"],
      ["yaml", "name: demo # comment\ncount: 3"],
      ["python", "@decorator\ndef f(x): # note\n  return \"s\""],
      ["diff", "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new"],
      ["unknown-lang", "const x = 1;"],
    ];
    for (const [language, code] of samples) {
      expect(stripAnsi(highlightCode(code, language, painter))).toBe(code);
    }
  });

  test("styles TypeScript keywords, strings, and comments", () => {
    const highlighted = highlightCode("const s = \"hi\"; // note", "ts", painter);
    expect(highlighted).toContain(painter.bold("const", "electric"));
    expect(highlighted).toContain(painter.text("\"hi\"", "citron"));
    expect(highlighted).toContain(painter.dim("// note"));
  });

  test("tracks block comments across lines", () => {
    const state: CodeHighlightState = { inBlockComment: false };
    const first = highlightCode("/* start", "ts", painter, state);
    expect(state.inBlockComment).toBe(true);
    expect(first).toBe(painter.dim("/* start"));

    const second = highlightCode("end */ const x", "ts", painter, state);
    expect(state.inBlockComment).toBe(false);
    expect(second).toContain(painter.dim("end */"));
    expect(second).toContain(painter.bold("const", "electric"));
  });

  test("styles Python decorators, Bash variables, and JSON keys", () => {
    expect(highlightCode("@route", "python", painter)).toContain(painter.text("@route", "electric"));
    expect(highlightCode("echo $HOME", "bash", painter)).toContain(painter.text("$HOME", "electricBright"));
    expect(highlightCode("\"model\": \"local\"", "json", painter))
      .toContain(painter.text("\"model\"", "electric"));
    expect(highlightCode("\"model\": \"local\"", "json", painter))
      .toContain(painter.text("\"local\"", "citron"));
  });

  test("styles YAML keys and diff lines", () => {
    expect(highlightCode("name: demo", "yaml", painter)).toContain(painter.text("name", "electric"));
    expect(highlightCode("+ added", "diff", painter)).toBe(painter.text("+ added", "citron"));
    expect(highlightCode("- removed", "diff", painter)).toBe(painter.text("- removed", "signal"));
    expect(highlightCode("@@ -1 +1 @@", "diff", painter)).toBe(painter.text("@@ -1 +1 @@", "electric"));
  });

  test("falls back to a generic keyword set for unknown languages", () => {
    const highlighted = highlightCode("function f() { return 1 }", "zig", painter);
    expect(highlighted).toContain(painter.bold("function", "electric"));
    expect(highlighted).toContain(painter.bold("return", "electric"));
  });
});
