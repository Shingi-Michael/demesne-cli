import { expect, test } from "bun:test";
import { backChoices, backState } from "../back-later.ts";

test("an afternoon offers an hour, tonight, tomorrow and Monday", () => {
  const wednesday = new Date(2026, 9, 21, 15, 10);
  expect(backChoices(wednesday).map((choice) => [choice.label, new Date(choice.at).toString().slice(0, 21)])).toEqual([
    ["in an hour", "Wed Oct 21 2026 16:10"], ["tonight", "Wed Oct 21 2026 20:00"], ["tomorrow 9:00", "Thu Oct 22 2026 09:00"], ["Monday", "Mon Oct 26 2026 09:00"],
  ]);
});

test("late evening drops tonight, and Sunday drops Monday (that's tomorrow)", () => {
  expect(backChoices(new Date(2026, 9, 25, 21, 0)).map((choice) => choice.label)).toEqual(["in an hour", "tomorrow 9:00"]);
  expect(backChoices(new Date(2026, 9, 26, 10, 0)).at(-1)).toMatchObject({ label: "Monday" });
  expect(new Date(backChoices(new Date(2026, 9, 26, 10, 0)).at(-1)!.at).getDate()).toBe(2);
});

test("away until it's due, then back", () => {
  expect(backState(null)).toBeNull();
  expect(backState("2026-10-25T20:00:00Z", Date.parse("2026-10-25T19:00:00Z"))).toBe("away");
  expect(backState("2026-10-25T20:00:00Z", Date.parse("2026-10-25T20:00:00Z"))).toBe("back");
});

test("a chat with an open pull request can wait for it to merge", () => {
  expect(backChoices(new Date(2026, 9, 25, 21, 0), 287).at(-1)).toEqual({ label: "when #287 merges", at: "merge" });
  expect(backState("merge", Date.now(), false)).toBe("away");
  expect(backState("merge", Date.now(), true)).toBe("back");
});
