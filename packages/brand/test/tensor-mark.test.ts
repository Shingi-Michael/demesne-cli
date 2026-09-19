import { describe, expect, test } from "bun:test";
import {
  activationPulse,
  createPainter,
  easedProgress,
  mixHex,
  renderTensorMark,
  settlingProgress,
  tensorCanvasBase,
  TENSOR_INTRO_END_S,
  TENSOR_MARK_COLS,
  TENSOR_MARK_ROWS,
  visibleLength,
} from "../src/index.ts";

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const inkedCells = (lines: string[]) =>
  lines.reduce((total, line) => total + stripAnsi(line).replace(/ /g, "").length, 0);

describe("tensor mark", () => {
  test("settled frame spans the full mark grid with uniform line widths", () => {
    const frame = renderTensorMark(TENSOR_INTRO_END_S, createPainter(true));
    expect(frame).toHaveLength(TENSOR_MARK_ROWS);
    for (const line of frame) {
      expect(visibleLength(line)).toBe(TENSOR_MARK_COLS);
    }
  });

  test("frames are deterministic for a given timeline position", () => {
    const painter = createPainter(true);
    expect(renderTensorMark(1.25, painter)).toEqual(renderTensorMark(1.25, painter));
  });

  test("mark builds up over the timeline instead of appearing at once", () => {
    const painter = createPainter(true);
    const early = inkedCells(renderTensorMark(0.03, painter));
    const midScan = inkedCells(renderTensorMark(0.4, painter));
    const settled = inkedCells(renderTensorMark(TENSOR_INTRO_END_S, painter));
    expect(early).toBe(0);
    expect(midScan).toBeGreaterThan(early);
    expect(settled).toBeGreaterThanOrEqual(midScan);
    expect(settled).toBeGreaterThan(200);
  });

  test("signal attention settles onto the focus band by the end of the timeline", () => {
    const redDominant = (frame: string[]) => [...frame.join("\n")
      .matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)]
      .filter((match) => {
        // The signal color comes from the theme's role now, so it is the muted
        // terminal red rather than the saturated canonical one; the ratio is
        // loosened to match while still excluding the neutral and accent cells.
        const r = Number(match[1]);
        const g = Number(match[2]);
        return r > 90 && r > g * 1.5;
      })
      .length;
    expect(redDominant(renderTensorMark(TENSOR_INTRO_END_S, createPainter(true)))).toBeGreaterThan(0);
    expect(redDominant(renderTensorMark(0.4, createPainter(true)))).toBe(0);
  });

  test("renders an ASCII ramp without ANSI when paint is disabled", () => {
    const frame = renderTensorMark(TENSOR_INTRO_END_S, createPainter(false));
    expect(frame).toHaveLength(TENSOR_MARK_ROWS);
    for (const line of frame) {
      expect(line).not.toContain("\x1b");
      expect(line.length).toBe(TENSOR_MARK_COLS);
      expect(line).toMatch(/^[ .,:~+#]+$/);
    }
    expect(inkedCells(frame)).toBeGreaterThan(100);
  });

  test("easing curves match the iOS motion definitions", () => {
    expect(easedProgress(-1, 0, 1)).toBe(0);
    expect(easedProgress(5, 0, 1)).toBe(1);
    expect(easedProgress(0.5, 0, 1)).toBeCloseTo(0.875, 5);

    expect(settlingProgress(-1, 0, 1)).toBe(0);
    expect(settlingProgress(100, 0, 1)).toBeCloseTo(1, 5);
    const mid = settlingProgress(0.5, 0, 1);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);

    expect(activationPulse(1.0, 1.0, 0.2)).toBeCloseTo(1, 5);
    expect(activationPulse(0.5, 1.0, 0.2)).toBe(0);
    expect(activationPulse(1.5, 1.0, 0.2)).toBeCloseTo(0, 5);
  });

  test("mixHex interpolates palette colors at the endpoints and midpoint", () => {
    expect(mixHex("#102030", "#305070", 0)).toBe("#102030");
    expect(mixHex("#102030", "#305070", 1)).toBe("#305070");
    expect(mixHex("#102030", "#305070", 0.5)).toBe("#203850");
    expect(tensorCanvasBase("dark")).toBe("#15151A");
    expect(tensorCanvasBase("light")).toBe("#EDE9E1");
  });
});
