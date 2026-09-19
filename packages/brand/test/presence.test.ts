import { describe, expect, test } from "bun:test";
import { createPainter } from "../src/index.ts";
import { presenceForTool, presenceLabel, renderPresence, renderRailCell } from "../src/presence.ts";

const painter = createPainter(true, "dark");
const plain = createPainter(false, "dark");

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderPresence", () => {
  test("cycles frames deterministically over time", () => {
    const frames = new Set<string>();
    for (let step = 0; step < 10; step += 1) {
      frames.add(stripAnsi(renderPresence("thinking", step * 120, painter)));
    }
    expect(frames.size).toBeGreaterThan(3);
    expect(renderPresence("thinking", 0, painter)).toBe(renderPresence("thinking", 0, painter));
  });

  test("terminal states are a single stable glyph", () => {
    expect(stripAnsi(renderPresence("done", 0, painter))).toBe("✓");
    expect(stripAnsi(renderPresence("done", 10_000, painter))).toBe("✓");
    expect(stripAnsi(renderPresence("stopped", 0, painter))).toBe("×");
  });

  test("returns plain glyphs without a painter", () => {
    expect(renderPresence("thinking", 0, plain)).toBe("⠋");
    expect(renderPresence("idle", 0, plain)).toBe("◇");
    expect(renderPresence("thinking", 0, plain)).not.toContain("\x1b");
  });
});

describe("presenceLabel", () => {
  test("describes the state in present tense", () => {
    expect(presenceLabel("thinking")).toBe("considering");
    expect(presenceLabel("writing")).toBe("writing");
    expect(presenceLabel("verifying")).toBe("checking");
    expect(presenceLabel("waiting")).toBe("needs your go-ahead");
    expect(presenceLabel("idle")).toBe("ready");
  });
});

describe("presenceForTool", () => {
  test("maps tools to their activity", () => {
    expect(presenceForTool("edit_file", false)).toBe("writing");
    expect(presenceForTool("write_file", false)).toBe("writing");
    expect(presenceForTool("run_command", true)).toBe("verifying");
    expect(presenceForTool("run_command", false)).toBe("working");
    expect(presenceForTool("read_file", false)).toBe("working");
  });
});

describe("renderRailCell", () => {
  test("shimmers only while streaming with a painter", () => {
    const cells = new Set<string>();
    for (let step = 0; step < 12; step += 1) {
      cells.add(stripAnsi(renderRailCell(0, step * 200, painter, true)));
    }
    expect(cells.size).toBeGreaterThan(1);
    expect(renderRailCell(0, 0, plain, true)).toBe("│");
    expect(renderRailCell(0, 0, painter, false)).toBe(painter.text("│", "rule"));
  });
});
