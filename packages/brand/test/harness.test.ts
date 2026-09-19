import { describe, expect, test } from "bun:test";
import { createPainter, formatApprovalAsk, formatToolRow, formatTurnCloser, formatTurnOpener, HARNESS, toolPhaseColor, turnRail, visibleLength } from "../src/index.ts";

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
    const row = formatToolRow("running", "read", "src/a.ts", undefined, 60, painter, { mark: "@" });
    expect(row).toStartWith(`${" ".repeat(HARNESS.rail)}│ @ read`);
    expect(row.indexOf("src/a.ts")).toBe(HARNESS.toolTarget);
  });

  test("drops the rail without shifting the target column", () => {
    const withRail = formatToolRow("done", "read", "src/a.ts", "1ms", 60, painter);
    const without = formatToolRow("done", "read", "src/a.ts", "1ms", 60, painter, { rail: false });
    expect(withRail.indexOf("src/a.ts")).toBe(HARNESS.toolTarget);
    expect(without.indexOf("src/a.ts")).toBe(HARNESS.toolTarget);
    expect(without).not.toContain("│");
  });

  test("colors the verb by phase so a turn's shape is readable", () => {
    const inspect = formatToolRow("done", "read", "src/a.ts", "1ms", 60, color, { phase: "inspect" });
    const change = formatToolRow("done", "edit", "src/a.ts", "1ms", 60, color, { phase: "change" });
    const verify = formatToolRow("done", "run", "bun test", "1ms", 60, color, { phase: "verify" });
    expect(inspect).not.toBe(change);
    expect(change).not.toBe(verify);
    expect(toolPhaseColor("inspect")).toBe("secondary");
    expect(toolPhaseColor("change")).toBe("electric");
    expect(toolPhaseColor("verify")).toBe("electricBright");
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

describe("formatApprovalAsk", () => {
  test("stays on the harness grid and speaks in the agent's voice", () => {
    const rows = formatApprovalAsk({
      ask: "I need your go-ahead: edit_file: src/lexer.ts",
      toolName: "edit_file",
      previewRows: ["- old", "+ new"],
      width: 80,
      painter,
      waitingMark: "◆",
    });
    expect(rows[0]).toStartWith(`${" ".repeat(HARNESS.rail)}│ ◆ I need your go-ahead: edit_file: src/lexer.ts`);
    expect(rows[0]).toContain("file edit");
    // Preview rows align under the tool target column.
    expect(rows[1]!.indexOf("- old")).toBe(HARNESS.toolTarget);
    expect(rows.every((row) => visibleLength(row) <= 120)).toBe(true);
  });

  test("bounds a hostile ask without leaking control characters", () => {
    const rows = formatApprovalAsk({
      ask: `evil\x1b[2J${"x".repeat(400)}`,
      width: 60,
      painter,
      waitingMark: "◆",
    });
    expect(rows[0]).not.toContain("\x1b[2J");
    expect(visibleLength(rows[0]!)).toBeLessThanOrEqual(120);
  });

  test("renders without a tool name or preview", () => {
    const rows = formatApprovalAsk({ ask: "I need your go-ahead: something", width: 80, painter, waitingMark: "◇" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("I need your go-ahead: something");
  });
});

describe("turn structure", () => {
  test("the rail binds a turn's lines at a fixed column", () => {
    expect(turnRail(painter)).toBe(`${" ".repeat(HARNESS.rail)}│ `);
    expect(visibleLength(turnRail(painter))).toBe(HARNESS.content - 2);
  });

  test("the closer bends the rail into the summary", () => {
    const closer = formatTurnCloser("I’m done — 7.4s · 3 tools", 80, painter);
    expect(closer).toStartWith(`${" ".repeat(HARNESS.rail)}└─ ✓ I’m done`);
    expect(visibleLength(closer)).toBeLessThanOrEqual(80);
  });

  test("opener and closer share the rail column so a turn reads as one unit", () => {
    const opener = formatTurnOpener("you", "21:03", 80, painter);
    const closer = formatTurnCloser("done", 80, painter);
    expect(opener.indexOf("┌")).toBe(HARNESS.rail);
    expect(closer.indexOf("└")).toBe(HARNESS.rail);
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
