import { expect, test } from "bun:test";
import { fitSize } from "../fit-image.ts";

test("big pictures fit their long side and the 40 megapixel limit; small ones keep their size", () => {
  expect(fitSize(8000, 6000, 4096)).toEqual({ width: 4096, height: 3072 });
  expect(fitSize(1200, 800, 4096)).toEqual({ width: 1200, height: 800 });
  expect(fitSize(3000, 20000, 40000).width * fitSize(3000, 20000, 40000).height).toBeLessThanOrEqual(40_000_000);
});
