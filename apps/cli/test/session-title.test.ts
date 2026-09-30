import { describe, expect, test } from "bun:test";
import { isPlaceholderTitle, titleFromRequest } from "../src/session-title.ts";

describe("session titles from the first request", () => {
  test("recognizes the time placeholder only", () => {
    for (const title of ["Session 10:00:04 AM", "Session 9:29:58 AM", "Session 22:01:07", "Session 5:53 p.m."]) expect(isPlaceholderTitle(title)).toBe(true);
    for (const title of ["Session planning", "Fix the lexer", "New session", "Session 10:00:04 AM notes"]) expect(isPlaceholderTitle(title)).toBe(false);
  });
  test("uses the first line, shortens mentions to file names, and cuts long requests on a word", () => {
    expect(titleFromRequest("\n  Why does @src/lexer.ts reject café?\nmore detail")).toBe("Why does lexer.ts reject café?");
    const long = titleFromRequest("Refactor the context planner so reserved output tokens are counted before tool schemas are packed into the window");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toBe("Refactor the context planner so reserved output tokens are…");
  });
});
