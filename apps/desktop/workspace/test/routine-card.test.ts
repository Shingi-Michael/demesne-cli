import { expect, test } from "bun:test";
import { chatRoutines, routinesCardHTML, routineTarget } from "../routine-card.ts";

const step = (input: Record<string, unknown>, result: Record<string, unknown>) => ({ type: "tool", name: "routine", state: "done", input, message: JSON.stringify(result) });

test("the card keeps each routine the chat made, as it last left it", () => {
  const runs = [
    { entries: [step({ action: "add" }, { routine: "added", id: "a", when: "Weekdays · 9:00", prompt: "List my PRs", on: true })] },
    { entries: [step({ action: "add" }, { routine: "added", id: "b", when: "Fridays · 17:00", prompt: "Write notes", on: true }), step({ action: "pause", id: "a" }, { routine: "paused", id: "a", when: "Weekdays · 9:00", prompt: "List my PRs", on: false })] },
    { entries: [step({ action: "remove", id: "b" }, { routine: "removed", id: "b", when: "Fridays · 17:00", prompt: "Write notes", on: true }), step({ action: "list" }, { routines: [] })] },
  ];
  expect(chatRoutines(runs)).toEqual([{ id: "a", when: "Weekdays · 9:00", prompt: "List my PRs", on: false }]);
  expect(routineTarget(runs[0]!.entries[0]!)).toBe("Weekdays · 9:00, List my PRs");
  const html = routinesCardHTML(chatRoutines(runs), false);
  expect(html).toContain("Routine · Weekdays · 9:00");
  expect(html).toContain("paused");
  expect(html).toContain('data-action="page-open"');
  expect(routinesCardHTML([], false)).toBe("");
  expect(routinesCardHTML([{ id: "a", when: "W", prompt: "<b>", on: true }, { id: "b", when: "F", prompt: "x", on: true }], true)).toContain("2 routines");
});
