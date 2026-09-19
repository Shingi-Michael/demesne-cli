import { describe, expect, test } from "bun:test";
import { escapePresses, reduceInterruptKey } from "../src/interrupt-key.ts";

describe("turn interrupt keys", () => {
  test("interrupts on Ctrl-C or two standalone Escape keypresses", () => {
    expect(reduceInterruptKey(0, { name: "c", ctrl: true }, 1_000).interrupt).toBe(true);
    const first = reduceInterruptKey(0, { name: "escape", sequence: "\x1b" }, 1_000);
    expect(first).toEqual({ lastEscapeAt: 1_000, interrupt: false });
    expect(reduceInterruptKey(first.lastEscapeAt, { name: "escape", sequence: "\x1b" }, 2_000).interrupt).toBe(true);
  });

  test("interrupts when both escapes arrive in one read", () => {
    // This is how a terminal actually delivers two quick presses: one keypress
    // event carrying two ESC bytes. Rejecting `meta` here is why Esc Esc never
    // stopped a turn.
    const coalesced = { name: "escape", meta: true, sequence: "\x1b\x1b" };
    expect(reduceInterruptKey(0, coalesced, 1_000)).toEqual({ lastEscapeAt: 0, interrupt: true });
    // Even if a first press was already armed.
    expect(reduceInterruptKey(500, coalesced, 1_000).interrupt).toBe(true);
  });

  test("counts every escape in the sequence", () => {
    expect(escapePresses({ name: "escape", sequence: "\x1b" })).toBe(1);
    expect(escapePresses({ name: "escape", meta: true, sequence: "\x1b\x1b" })).toBe(2);
    expect(escapePresses({ name: "escape", meta: true, sequence: "\x1b\x1b\x1b" })).toBe(3);
    // No sequence to count: treat it as one press rather than none.
    expect(escapePresses({ name: "escape" })).toBe(1);
    expect(escapePresses({ name: "x" })).toBe(0);
  });

  test("three coalesced escapes still interrupt", () => {
    expect(reduceInterruptKey(0, { name: "escape", meta: true, sequence: "\x1b\x1b\x1b" }, 1_000).interrupt).toBe(true);
  });

  test("a single escape only arms the window", () => {
    const armed = reduceInterruptKey(0, { name: "escape", meta: true, sequence: "\x1b" }, 1_000);
    expect(armed).toEqual({ lastEscapeAt: 1_000, interrupt: false });
    // A second press within the window fires.
    expect(reduceInterruptKey(armed.lastEscapeAt, { name: "escape", sequence: "\x1b" }, 2_400).interrupt).toBe(true);
    // Outside the window it only re-arms.
    expect(reduceInterruptKey(armed.lastEscapeAt, { name: "escape", sequence: "\x1b" }, 9_000).interrupt).toBe(false);
  });

  test("does not interpret arrow or Alt key escape prefixes as cancellation", () => {
    expect(reduceInterruptKey(1_000, { name: "up" }, 1_200)).toEqual({ lastEscapeAt: 0, interrupt: false });
    expect(reduceInterruptKey(1_000, { name: "x", meta: true }, 1_200)).toEqual({ lastEscapeAt: 0, interrupt: false });
    expect(reduceInterruptKey(1_000, { name: "escape" }, 3_000).interrupt).toBe(false);
  });
});
