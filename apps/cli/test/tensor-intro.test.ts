import { describe, expect, test } from "bun:test";
import { createPainter, TENSOR_INTRO_END_S, visibleLength } from "@demesne/brand";
import { composeIntroFrame } from "../src/tensor-intro.ts";

describe("composeIntroFrame", () => {
  test("settled frame fills the screen without reaching the final row", () => {
    const frame = composeIntroFrame(TENSOR_INTRO_END_S, 32, 110, createPainter(true));
    expect(frame).toHaveLength(31);
    for (const line of frame) {
      expect(visibleLength(line)).toBeLessThanOrEqual(110);
    }
    const joined = frame.join("\n");
    expect(joined).toContain("D E M E S N E");
    expect(joined).toContain("YOUR MODEL. ON YOUR HARDWARE.");
    expect(joined).toContain("PREPPRO LABS");
    expect(joined).toContain("▮");
  });

  test("opening frame hides the wordmark, tagline, and footer", () => {
    const joined = composeIntroFrame(0, 32, 110, createPainter(true)).join("\n");
    expect(joined).not.toContain("D E M E S N E");
    expect(joined).not.toContain("YOUR MODEL");
    expect(joined).not.toContain("PREPPRO LABS");
  });

  test("wordmark reveals left to right across its timeline window", () => {
    const partial = composeIntroFrame(0.45, 32, 110, createPainter(true)).join("\n");
    expect(partial).toContain("D E M");
    expect(partial).not.toContain("S N E");
    const complete = composeIntroFrame(0.8, 32, 110, createPainter(true)).join("\n");
    expect(complete).toContain("D E M E S N E");
  });

  test("frames are deterministic and survive tiny terminals by trimming rows", () => {
    const painter = createPainter(true);
    expect(composeIntroFrame(1.5, 32, 110, painter)).toEqual(composeIntroFrame(1.5, 32, 110, painter));
    const tiny = composeIntroFrame(TENSOR_INTRO_END_S, 21, 60, painter);
    expect(tiny.length).toBeLessThanOrEqual(20);
    for (const line of tiny) {
      expect(visibleLength(line)).toBeLessThanOrEqual(60);
    }
  });

  test("renders without ANSI escapes when paint is disabled", () => {
    const joined = composeIntroFrame(TENSOR_INTRO_END_S, 32, 110, createPainter(false)).join("\n");
    expect(joined).not.toContain("\x1b");
    expect(joined).toContain("D E M E S N E");
    expect(joined).toContain("▮▮▮");
  });
});
