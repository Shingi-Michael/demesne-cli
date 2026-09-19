import { describe, expect, test } from "bun:test";
import { narrateTurnEnd, narrateWaiting, sentence } from "../src/voice.ts";

describe("narrateWaiting", () => {
  test("asks for approval in the first person", () => {
    expect(narrateWaiting("write_file: src/x.ts")).toBe("I need your go-ahead: write_file: src/x.ts");
  });

  test("strips control characters from an untrusted summary", () => {
    expect(narrateWaiting("evil\x1b[2J\u0007 summary")).toBe("I need your go-ahead: evil [2J summary");
  });
});

describe("narrateTurnEnd", () => {
  test("closes turns in the agent's voice", () => {
    expect(narrateTurnEnd("completed", "1.2s · 1 round · 3 tools")).toBe("I’m done — 1.2s · 1 round · 3 tools");
    expect(narrateTurnEnd("stopped", "after 4.1s I kept 3 findings")).toBe("I stopped — after 4.1s I kept 3 findings");
    expect(narrateTurnEnd("failed", "the provider timed out")).toBe("I hit a problem — the provider timed out");
  });

  test("ends with a period when there are no details", () => {
    expect(narrateTurnEnd("completed", "")).toBe("I’m done.");
    expect(narrateTurnEnd("failed", "")).toBe("I hit a problem.");
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
