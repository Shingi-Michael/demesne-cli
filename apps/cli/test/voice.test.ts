import { describe, expect, test } from "bun:test";
import { narrateTurnEnd, narrateWaiting, sentence } from "../src/voice.ts";

describe("narrateWaiting", () => {
  test("states the status without speaking in the first person", () => {
    expect(narrateWaiting("write_file: src/x.ts")).toBe("needs approval: write_file: src/x.ts");
  });

  test("strips control characters from an untrusted summary", () => {
    expect(narrateWaiting("evil\x1b[2J\u0007 summary")).toBe("needs approval: evil [2J summary");
  });
});

describe("narrateTurnEnd", () => {
  test("closes a turn with its status", () => {
    expect(narrateTurnEnd("completed", "1.2s · 1 round · 3 tools")).toBe("done — 1.2s · 1 round · 3 tools");
    expect(narrateTurnEnd("stopped", "after 4.1s, 3 findings kept")).toBe("stopped — after 4.1s, 3 findings kept");
    expect(narrateTurnEnd("failed", "the provider timed out")).toBe("failed — the provider timed out");
  });

  test("is just the status when there are no details", () => {
    expect(narrateTurnEnd("completed", "")).toBe("done");
    expect(narrateTurnEnd("failed", "")).toBe("failed");
  });

  test("never speaks in the first person", () => {
    for (const kind of ["completed", "stopped", "failed"] as const) {
      const line = narrateTurnEnd(kind, "1.2s · 3 tools");
      expect(line).not.toMatch(/\bI\b|I’m|I'm|I’ll|I'll/);
      expect(line).not.toMatch(/your|our|my/i);
    }
    expect(narrateWaiting("edit_file: src/a.ts")).not.toMatch(/\bI\b|your|our|my/i);
  });
});

describe("sentence", () => {
  test("collapses whitespace and drops trailing punctuation", () => {
    expect(sentence("  a   b\n c!! ")).toBe("a b c");
  });

  test("bounds very long input", () => {
    const bounded = sentence("x".repeat(400));
    expect(bounded.length).toBeLessThanOrEqual(200);
    expect(bounded).toEndWith("…");
  });

  test("removes control characters", () => {
    expect(sentence("a\x00b\x1bc")).toBe("a b c");
  });
});
