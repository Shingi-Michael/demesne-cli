import { describe, expect, test } from "bun:test";
import { reduceInterruptKey } from "../src/interrupt-key.ts";

describe("turn interrupt keys", () => {
  test("interrupts on Ctrl-C or two standalone Escape keypresses", () => {
    expect(reduceInterruptKey(0, { name: "c", ctrl: true }, 1_000).interrupt).toBe(true);
    const first = reduceInterruptKey(0, { name: "escape" }, 1_000);
    expect(first).toEqual({ lastEscapeAt: 1_000, interrupt: false });
    expect(reduceInterruptKey(first.lastEscapeAt, { name: "escape" }, 2_000).interrupt).toBe(true);
  });

  test("does not interpret arrow or Alt key escape prefixes as cancellation", () => {
    expect(reduceInterruptKey(1_000, { name: "up" }, 1_200)).toEqual({ lastEscapeAt: 0, interrupt: false });
    expect(reduceInterruptKey(1_000, { name: "x", meta: true }, 1_200)).toEqual({ lastEscapeAt: 0, interrupt: false });
    expect(reduceInterruptKey(1_000, { name: "escape" }, 3_000).interrupt).toBe(false);
  });
});
