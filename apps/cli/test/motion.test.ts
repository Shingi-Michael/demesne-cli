import { describe, expect, test } from "bun:test";
import { reducedMotionEnabled } from "../src/motion.ts";

describe("reduced motion", () => {
  test("disables continuous beacon animation when explicitly requested", () => {
    expect(reducedMotionEnabled({ DEMESNE_REDUCED_MOTION: "1" })).toBe(true);
    expect(reducedMotionEnabled({ DEMESNE_REDUCED_MOTION: "true" })).toBe(true);
    expect(reducedMotionEnabled({ DEMESNE_REDUCED_MOTION: "0" })).toBe(false);
    expect(reducedMotionEnabled({})).toBe(false);
  });
});
