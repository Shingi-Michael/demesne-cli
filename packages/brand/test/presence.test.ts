import { describe, expect, test } from "bun:test";
import { createPainter } from "../src/index.ts";
import { presenceForTool, presenceLabel, renderPresence } from "../src/presence.ts";

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

  test("uses one light glyph family per state, never quadrant blocks", () => {
    // Quadrant blocks (▖ ▛ ▜ and friends) are heavy and asymmetric, so a frame
    // built from them jumps in weight against every other state. `writing` used
    // them and read as noise, so the whole family is off limits.
    const quadrantBlocks = /[\u2596-\u259f]/;
    const states = [
      "idle", "listening", "thinking", "reasoning", "working",
      "writing", "verifying", "waiting", "done", "stopped", "error",
    ] as const;
    for (const state of states) {
      const frames = new Set<string>();
      for (let step = 0; step < 24; step += 1) {
        const glyph = stripAnsi(renderPresence(state, step * 60, painter));
        frames.add(glyph);
        expect(glyph).not.toMatch(quadrantBlocks);
        // Every frame is one glyph, so the mark column never shifts.
        expect([...glyph]).toHaveLength(1);
      }
      expect(frames.size).toBeGreaterThan(0);
    }
  });

  test("the writing pulse is left-aligned bars, all the same height", () => {
    const frames = new Set<string>();
    for (let step = 0; step < 24; step += 1) {
      frames.add(stripAnsi(renderPresence("writing", step * 40, painter)));
    }
    expect(frames).toEqual(new Set(["▏", "▎", "▍", "▌"]));
  });
});

describe("presenceLabel", () => {
  test("names the state with the conventional word, not a narration of it", () => {
    expect(presenceLabel("thinking")).toBe("thinking");
    expect(presenceLabel("writing")).toBe("writing");
    expect(presenceLabel("verifying")).toBe("checking");
    expect(presenceLabel("waiting")).toBe("needs approval");
    expect(presenceLabel("idle")).toBe("ready");
    expect(presenceLabel("error")).toBe("failed");
  });

  test("never speaks in the first person", () => {
    const states = [
      "idle", "listening", "thinking", "reasoning", "working",
      "writing", "verifying", "waiting", "done", "stopped", "error",
    ] as const;
    for (const state of states) {
      const label = presenceLabel(state);
      expect(label).not.toMatch(/\bI\b|I’m|I'm|I’ll|I'll/);
      expect(label).not.toMatch(/your|our|my/i);
    }
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
