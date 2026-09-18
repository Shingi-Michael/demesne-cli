import { describe, expect, test } from "bun:test";
import { splitTerminalUnits, TerminalTextPacer } from "../src/terminal-text-pacer.ts";

describe("TerminalTextPacer", () => {
  test("preserves exact output while spreading a burst across frames", async () => {
    let now = 0;
    const writes: Array<{ at: number; text: string }> = [];
    const pacer = new TerminalTextPacer({
      sink: (text) => writes.push({ at: now, text }),
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      frameMilliseconds: 10,
      initialCharactersPerSecond: 100,
      maximumBacklogMilliseconds: 10_000,
    });

    pacer.write("smooth text");
    await pacer.drain();

    expect(writes.map((entry) => entry.text).join("")).toBe("smooth text");
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.at(-1)!.at).toBeGreaterThan(0);
  });

  test("emits ANSI sequences atomically and keeps grapheme clusters intact", () => {
    const units = splitTerminalUnits("\x1b[1mA👩🏽‍💻é\x1b[0m");
    expect(units).toEqual([
      { value: "\x1b[1m", visible: false },
      { value: "A", visible: true },
      { value: "👩🏽‍💻", visible: true },
      { value: "é", visible: true },
      { value: "\x1b[0m", visible: false },
    ]);
  });

  test("flushNow drains queued output without delayed writes", async () => {
    const writes: string[] = [];
    let releaseSleep: (() => void) | undefined;
    const pacer = new TerminalTextPacer({
      sink: (text) => writes.push(text),
      sleep: () => new Promise<void>((resolve) => { releaseSleep = resolve; }),
      frameMilliseconds: 16,
      initialCharactersPerSecond: 60,
      maximumBacklogMilliseconds: 10_000,
    });

    pacer.write("cancel-safe output");
    pacer.flushNow();
    releaseSleep?.();
    await pacer.drain();

    expect(writes.join("")).toBe("cancel-safe output");
  });

  test("observed burst cadence remains bounded", async () => {
    let now = 0;
    const writes: string[] = [];
    const pacer = new TerminalTextPacer({
      sink: (text) => writes.push(text),
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      frameMilliseconds: 20,
      initialCharactersPerSecond: 100,
      minimumCharactersPerSecond: 60,
      maximumCharactersPerSecond: 200,
      maximumBacklogMilliseconds: 500,
    });

    pacer.observe("a".repeat(100));
    now = 500;
    pacer.observe("b".repeat(100));
    pacer.write("x".repeat(200));
    await pacer.drain();

    expect(writes.join("")).toBe("x".repeat(200));
    expect(now).toBeLessThanOrEqual(500 + 500);
  });
});
