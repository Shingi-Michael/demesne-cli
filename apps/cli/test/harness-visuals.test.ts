import { describe, expect, test } from "bun:test";
import {
  createPainter,
  formatMentionMenu,
  formatSlashCommandMenu,
  formatSparkline,
  SLASH_COMMANDS,
  slashMenuLineCommands,
} from "@demesne/brand";

const paint = createPainter(true);
const plain = createPainter(false);

/// A filled selection surface encodes its background as `48;2`, its text as
/// `38;2` — both must appear, and the selection must still be visible under
/// NO_COLOR as the marker alone.
describe("menu selection washes", () => {
  test("the selected slash command is a filled surface", () => {
    const menu = formatSlashCommandMenu(SLASH_COMMANDS, 2, 80, paint);
    const selected = menu.split("\n").filter((line) => line.includes("\x1b[48;2;"));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain("›");
    expect(selected[0]).toContain("\x1b[38;2;");
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
