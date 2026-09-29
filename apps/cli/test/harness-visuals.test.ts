import { describe, expect, test } from "bun:test";
import {
  createPainter,
  formatMentionMenu,
  formatSlashCommandMenu,
  formatSparkline,
  layoutCommandMenu,
  SLASH_COMMANDS,
  slashMenuLineCommands,
} from "@demesne/brand";

const paint = createPainter(true);
const plain = createPainter(false);

/// A filled selection surface encodes its background as `48;2`, its text as
/// `38;2` — both must appear, and the selection must still be visible under
/// NO_COLOR as the marker alone.
describe("menu selection washes", () => {
  test("the selected slash command is a filled surface spanning the row", () => {
    const menu = formatSlashCommandMenu(SLASH_COMMANDS, 2, 80, paint);
    const selected = menu.split("\n").filter((line) => line.includes("\x1b[48;2;"));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain("›");
    expect(selected[0]).toContain("\x1b[38;2;");
    // The surface is the row, not the name column: it must reach the right
    // edge of the menu, with the description painted inside it.
    expect(selected[0]).toContain("Switch to a session");
    expect(selected[0].replace(/\x1b\[[0-9;]*m/g, "").length).toBe(78);
  });

  test("selection survives NO_COLOR as the marker without escape codes", () => {
    const menu = formatSlashCommandMenu(SLASH_COMMANDS, 2, 80, plain);
    expect(menu).not.toContain("\x1b[");
    const lines = menu.split("\n");
    const selected = lines.findIndex((line) => line.includes("›"));
    expect(lines[selected]).toContain("/resume");
    expect(lines[selected]!.startsWith("    ")).toBe(false);
    expect(lines[selected + 1]!.startsWith("    ")).toBe(true);
  });

  test("the selected mention is a filled surface aligned with the rest", () => {
    const files = ["src/lexer.ts", "src/parser.ts", "README.md"];
    const menu = formatMentionMenu(files, 1, 80, paint);
    const lines = menu.split("\n");
    expect(lines[1]).toContain("\x1b[48;2;");
    // The selected label starts on the same column as the unselected ones.
    const columnOf = (line: string, text: string) => line.replace(/\x1b\[[0-9;]*m/g, "").indexOf(text);
    expect(columnOf(lines[1]!, "src/parser.ts")).toBe(columnOf(lines[0]!, "src/lexer.ts"));
  });
});

describe("command menu layout", () => {
  test("a bounded window fills its rows and marks omitted items", () => {
    const rows = layoutCommandMenu(SLASH_COMMANDS, 7, 0);
    expect(rows).toHaveLength(7);
    expect(rows[0]!.kind).toBe("section");
    expect(rows[0]!.section).toBe("session");
    expect(rows.filter((row) => row.kind === "command").map((row) => row.index)).toEqual([0, 1, 2, 3, 4]);
    expect(rows[rows.length - 1]!.kind).toBe("more");
    // The window must be contiguous in the full list.
    const full = layoutCommandMenu(SLASH_COMMANDS, Number.POSITIVE_INFINITY);
    const indices = rows.map((row) => full.indexOf(row)).filter((index) => index >= 0);
    for (let index = 1; index < indices.length; index += 1) expect(indices[index]).toBe(indices[index - 1]! + 1);
  });

  test("the window opens on a section label without losing the selection", () => {
    // /plan is the first control command: its label fits a seven-row window
    // that keeps the selection, so the label leads the window.
    const rows = layoutCommandMenu(SLASH_COMMANDS, 7, 11);
    expect(rows).toHaveLength(7);
    expect(rows[0]!.kind).toBe("more");
    expect(rows[1]!.kind).toBe("section");
    expect(rows[1]!.section).toBe("control");
    expect(rows.filter((row) => row.kind === "command").map((row) => row.index)).toEqual([11, 12, 13, 14]);
    expect(rows[rows.length - 1]!.kind).toBe("more");
  });

  test("the window keeps the selection when a section boundary would not fit", () => {
    // /help sits near the end of the control section: opening on its label
    // would overflow a seven-row window, so the window leads with `…` and
    // keeps the selection with the rest of the section around it.
    const rows = layoutCommandMenu(SLASH_COMMANDS, 7, 15);
    expect(rows).toHaveLength(7);
    expect(rows[0]!.kind).toBe("more");
    expect(rows[1]!.kind).toBe("command");
    expect(rows.filter((row) => row.kind === "command").map((row) => row.index)).toEqual([11, 12, 13, 14, 15]);
    expect(rows[rows.length - 1]!.kind).toBe("more");
  });

  test("a tiny window keeps the selected row with a single more marker", () => {
    const rows = layoutCommandMenu(SLASH_COMMANDS, 4, 15);
    expect(rows).toHaveLength(4);
    expect(rows[0]!.kind).toBe("more");
    expect(rows.filter((row) => row.kind === "command").map((row) => row.index)).toEqual([14, 15]);
    expect(rows[rows.length - 1]!.kind).toBe("more");
  });

  test("a one-row window shows only the selected command", () => {
    const rows = layoutCommandMenu(SLASH_COMMANDS, 1, 3);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("command");
    expect(rows[0]!.index).toBe(3);
  });

  test("an unbounded layout lists every command with section labels", () => {
    const rows = layoutCommandMenu(SLASH_COMMANDS, Number.POSITIVE_INFINITY);
    expect(rows.filter((row) => row.kind === "command").map((row) => row.index)).toEqual(SLASH_COMMANDS.map((_, index) => index));
    expect(rows.filter((row) => row.kind === "section").map((row) => row.section)).toEqual(["session", "inspect", "control"]);
    expect(rows.filter((row) => row.kind === "spacer")).toHaveLength(2);
    expect(rows.filter((row) => row.kind === "more")).toHaveLength(0);
  });

  test("a short list has no labels or more markers", () => {
    const rows = layoutCommandMenu(SLASH_COMMANDS.slice(0, 3), Number.POSITIVE_INFINITY);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.kind === "command")).toBe(true);
  });
});

describe("slash menu line map", () => {
  test("every command line maps to its command, headings map to null", () => {
    const map = slashMenuLineCommands(SLASH_COMMANDS);
    const rendered = formatSlashCommandMenu(SLASH_COMMANDS, 0, 80, plain).split("\n");
    expect(map).toHaveLength(rendered.length);
    const commandLines = map.filter((index) => index !== null);
    expect(commandLines).toHaveLength(SLASH_COMMANDS.length);
    // Sections appear only once the list is long enough to need them.
    expect(map).toContain(null);
  });

  test("a short list has no heading lines", () => {
    const map = slashMenuLineCommands(SLASH_COMMANDS.slice(0, 3));
    expect(map).toEqual([0, 1, 2]);
  });
});

describe("throughput sparkline", () => {
  test("renders one cell per recent sample and colors it electric", () => {
    const bar = formatSparkline([10, 40, 90, 30], paint);
    expect(bar.replace(/\x1b\[[0-9;]*m/g, "")).toHaveLength(4);
    expect(bar).toContain("\x1b[38;2;");
  });

  test("a flat history draws as a full bar", () => {
    const bar = formatSparkline([5, 5, 5], plain);
    expect(bar.split("")[0]).toBe("█");
  });

  test("ignores non-finite samples and caps the width", () => {
    expect(formatSparkline([1, Number.NaN, 3], plain)).toHaveLength(2);
    expect(formatSparkline(Array.from({ length: 40 }, (_, i) => i + 1), plain)).toHaveLength(24);
    expect(formatSparkline([], plain)).toBe("");
  });
});
