import { expect, test } from "bun:test";
import { advance, BEAT_MS, cubeSvg, moving, restingCube } from "../working-cube.ts";

test("at rest the cube shows three faces of each visible cubelet, lit from one side", () => {
  const svg = cubeSvg(restingCube(0), 0, true);
  const polygons = svg.match(/<polygon /g)!.length;
  expect(polygons).toBe(8 * 3);
  expect(new Set(svg.match(/var\(--t1\) \d+%/g)).size).toBe(3);
});

test("each beat settles a quarter turn into the base and rests before the next", () => {
  let picks = [0.1, 0.9, 0.5, 0.2];
  const random = () => picks.shift() ?? 0.5;
  const start = restingCube(0);
  expect(moving(start, 500)).toBe(true);
  expect(moving(start, BEAT_MS - 50)).toBe(false);
  const next = advance(start, BEAT_MS + 10, random);
  expect(next.beatAt).toBe(BEAT_MS);
  expect(next.axis).toBe(0);
  expect(next.sign).toBe(1);
  // A quarter turn about y leaves an axis-aligned orientation.
  expect(next.base.every((value) => [-1, 0, 1].includes(value))).toBe(true);
  expect(advance(next, BEAT_MS + 20, random)).toBe(next);
  // Mid-turn the cube is drawn turned, and parted.
  expect(cubeSvg(next, BEAT_MS + 500)).not.toBe(cubeSvg(next, BEAT_MS));
  // After a long pause it starts again from now instead of replaying beats.
  expect(advance(next, BEAT_MS * 50, random).beatAt).toBe(BEAT_MS * 50);
});
