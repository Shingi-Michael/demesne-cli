import { expect, test } from "bun:test";
import { dayLine, dayWords } from "../assistant-chat.ts";

const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).toISOString();
const now = new Date(2026, 9, 29, 10, 0);

test("names the day in words", () => {
  expect(dayWords(at(29, 8), now)).toBe("Today");
  expect(dayWords(at(28, 23), now)).toBe("Yesterday");
  expect(dayWords(at(26, 9), now)).toBe(new Date(2026, 9, 26).toLocaleDateString([], { weekday: "long" }));
  expect(dayWords(at(14, 9), now)).toBe(new Date(2026, 9, 14).toLocaleDateString([], { day: "numeric", month: "long" }));
});

test("draws a day line only where the day changes", () => {
  expect(dayLine(at(28, 9), undefined, now)).toBe("Yesterday");
  expect(dayLine(at(28, 21), at(28, 9), now)).toBe("");
  expect(dayLine(at(29, 8), at(28, 21), now)).toBe("Today");
});
