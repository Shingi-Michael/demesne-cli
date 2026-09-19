import { describe, expect, test } from "bun:test";
import { createPainter, formatPulseLine, formatToolRow, formatTurnOpener, HARNESS, visibleLength } from "../src/index.ts";

const painter = createPainter(false, "dark");
const color = createPainter(true, "dark");

describe("formatToolRow", () => {
  test("aligns verb, target, and duration on the harness grid", () => {
    const row = formatToolRow("done", "read", "src/lexer.ts", "12ms", 80, painter);
    expect(row.indexOf("✓ read")).toBe(HARNESS.toolMark);
    expect(row.indexOf("src/lexer.ts")).toBe(HARNESS.toolTarget);
    expect(row.trimEnd().endsWith("12ms")).toBe(true);
    expect(visibleLength(row)).toBe(80);
  });

  test("keeps every state on the same columns", () => {
    const rows = (["done", "failed", "denied", "waiting", "running"] as const)
      .map((state) => formatToolRow(state, "edit", "src/a.ts", "8ms", 90, painter));
    for (const row of rows) {
      expect(row.indexOf("src/a.ts")).toBe(HARNESS.toolTarget);
      expect(visibleLength(row)).toBe(90);
    }
  });

  test("uses the caller's mark so running rows can animate", () => {
    const row = formatToolRow("running", "read", "src/a.ts", undefined, 60, painter, "@");
    expect(row).toStartWith(`${" ".repeat(HARNESS.toolMark)}@ read`);
    expect(row.indexOf("src/a.ts")).toBe(HARNESS.toolTarget);
  });

  test("truncates long targets and stays inside the width", () => {
    const row = formatToolRow("done", "read", "a/".repeat(80) + "deep.ts", "12ms", 60, painter);
    expect(visibleLength(row)).toBeLessThanOrEqual(60);
    expect(row).toContain("12ms");
  });

  test("renders without decoration when color is disabled", () => {
    expect(formatToolRow("done", "run", "bun test", "1.2s", 60, painter)).not.toContain("\x1b");
    expect(formatToolRow("done", "run", "bun test", "1.2s", 60, color)).toContain("\x1b");
  });
});

describe("formatTurnOpener", () => {
  test("labels a turn and right-aligns its timestamp", () => {
    const opener = formatTurnOpener("YOU", "21:03", 80, painter);
    expect(opener).toStartWith(`${" ".repeat(HARNESS.margin)}┌ you ─`);
    expect(opener).toEndWith("21:03");
    expect(visibleLength(opener)).toBe(80);
  });

  test("fills the rule when there is no timestamp", () => {
    const opener = formatTurnOpener("you", undefined, 40, painter);
    expect(visibleLength(opener)).toBe(40);
    expect(opener).not.toContain("undefined");
  });
});

describe("formatPulseLine", () => {
  test("is exactly the requested width", () => {
    for (const width of [40, 80, 120]) {
      expect(visibleLength(formatPulseLine(width, 0.5, 0.6, painter))).toBe(width);
    }
  });

  test("moves the light with progress", () => {
    const brightAt = (progress: number) => {
      const line = formatPulseLine(60, progress, 1, color);
      // The brightest cell is the one carrying electricBright.
      const index = line.indexOf("132;147;208");
      expect(index).toBeGreaterThan(0);
      return line.slice(0, index).split("─").length;
    };
    expect(brightAt(0.1)).toBeLessThan(brightAt(0.9));
  });

  test("dims toward a flat hairline at zero intensity", () => {
    const flat = formatPulseLine(40, 0.5, 0, color);
    expect(flat).not.toContain("132;147;208");
    expect(visibleLength(flat)).toBe(40);
  });

  test("stays plain without color", () => {
    expect(formatPulseLine(30, 0.5, 1, painter)).toBe("─".repeat(30));
  });
});
