import { describe, expect, test } from "bun:test";
import {
  createPainter,
  fileUrl,
  formatDiffPreview,
  formatHyperlink,
  formatToolResultLine,
  formatUnifiedDiff,
} from "../src/index.ts";

const painter = createPainter(false, "dark");

describe("formatUnifiedDiff", () => {
  test("renders a numbered hunk around the changed line", () => {
    const diff = formatUnifiedDiff("a\nb\nc\nd", "a\nb\nC\nd", { painter, context: 1 });
    expect(diff).toEqual([
      "@@ -3,1 +3,1 @@",
      "   2 │   b",
      "   3 │ - c",
      "   3 │ + C",
      "   4 │   d",
    ]);
  });

  test("renders compact rows without numbers or a header", () => {
    const diff = formatUnifiedDiff("a\nb\nc", "a\nB\nc", { painter, context: 1, compact: true });
    expect(diff).toEqual(["  a", "- b", "+ B", "  c"]);
  });

  test("reports no rows when nothing changed", () => {
    expect(formatUnifiedDiff("same\ntext", "same\ntext", { painter })).toEqual([]);
    expect(formatDiffPreview("same", "same", 6, painter)).toEqual(["(no textual change)"]);
  });

  test("handles pure additions and removals", () => {
    expect(formatUnifiedDiff("", "new line", { painter, compact: true })).toEqual(["+ new line"]);
    expect(formatUnifiedDiff("old line", "", { painter, compact: true })).toEqual(["- old line"]);
  });

  test("bounds output with an explicit omission row", () => {
    const oldText = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const newText = Array.from({ length: 40 }, (_, index) => `changed ${index}`).join("\n");
    const diff = formatUnifiedDiff(oldText, newText, { painter, maxLines: 8 });
    expect(diff.length).toBeLessThanOrEqual(8);
    expect(diff.some((line) => line.includes("more lines"))).toBe(true);
  });

  test("sanitizes control characters in diff content", () => {
    const diff = formatUnifiedDiff("safe", "spoof\u001b[2J", { painter, compact: true });
    expect(diff.join("\n")).not.toContain("\u001b");
  });
});

describe("formatHyperlink", () => {
  test("wraps text in an OSC 8 sequence when enabled", () => {
    expect(formatHyperlink("src/main.ts", "file:///w/src/main.ts")).toBe(
      "\x1b]8;;file:///w/src/main.ts\x07src/main.ts\x1b]8;;\x07",
    );
  });

  test("returns plain text when disabled", () => {
    expect(formatHyperlink("src/main.ts", "file:///w/src/main.ts", false)).toBe("src/main.ts");
  });

  test("builds encoded file URLs", () => {
    expect(fileUrl("/Users/me/my project/src/a.ts")).toBe("file:///Users/me/my%20project/src/a.ts");
  });
});

describe("formatToolResultLine links", () => {
  test("links path-like details and leaves commands alone", () => {
    const linkPath = (display: string, path: string) => `[${display}->${path}]`;
    const fileLine = formatToolResultLine("done", "read_file", "src/main.ts", 12, true, 80, painter, { linkPath });
    expect(fileLine).toContain("[src/main.ts->src/main.ts]");

    const commandLine = formatToolResultLine("done", "run_command", "$ bun test", 20, true, 80, painter, { linkPath });
    expect(commandLine).not.toContain("->");
  });

  test("does not link failed results", () => {
    const linkPath = (display: string) => `[${display}]`;
    const failed = formatToolResultLine("failed", "read_file", "src/main.ts", 12, true, 80, painter, { linkPath });
    expect(failed).not.toContain("[src/main.ts]");
  });
});
