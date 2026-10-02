import { expect, test } from "bun:test";
import { displayScale, parseDisplayScale } from "../display-scale.ts";

test("matching terminal rows preserve apparent text size across pixel densities", () => {
  for (const density of [1, 1.5, 2, 3, 4]) {
    const cell = { width: 8 * density, height: 18 * density };
    const scale = displayScale(cell);
    // A 14px design glyph and the CSS viewport retain the same size in cells.
    expect((14 * scale) / cell.height).toBeCloseTo(14 / 18);
    expect((150 * cell.width) / scale).toBeCloseTo(1200);
    expect((40 * cell.height) / scale).toBeCloseTo(720);
  }
});
test("automatic scaling follows terminal zoom while an explicit override is stable", () => {
  expect(parseDisplayScale(undefined)).toBeUndefined();
  expect(parseDisplayScale("auto")).toBeUndefined();
  expect(displayScale({ width: 16, height: 36 })).toBe(2);
  expect(displayScale({ width: 20, height: 45 })).toBe(2.5);
  expect(
    displayScale({ width: 20, height: 45 }, parseDisplayScale("1.5")),
  ).toBe(1.5);
  expect(() => parseDisplayScale("tiny")).toThrow();
  expect(() => parseDisplayScale("0")).toThrow();
  expect(() => displayScale({ width: 8, height: 0 })).toThrow();
});
