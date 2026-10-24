import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Routine } from "@demesne/protocol";
import { nextSlot, parseRoutine, Routines, whenWords } from "../src/routines.ts";

test("reads when, then what, from one sentence", () => {
  expect(parseRoutine("Every Monday at 9, list the PRs waiting on me")).toEqual({ days: [1], at: "09:00", prompt: "List the PRs waiting on me" });
  expect(parseRoutine("Weekdays at 8:30 summarize what Drive finished overnight")).toEqual({ days: [1, 2, 3, 4, 5], at: "08:30", prompt: "Summarize what Drive finished overnight" });
  expect(parseRoutine("Every Monday and Thursday at 5pm, tidy merged branches")).toEqual({ days: [1, 4], at: "17:00", prompt: "Tidy merged branches" });
  expect(parseRoutine("Every morning, read the failing checks")).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], at: "09:00", prompt: "Read the failing checks" });
  expect(parseRoutine("At noon, check the release")).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], at: "12:00", prompt: "Check the release" });
  // A bare afternoon hour means the afternoon.
  expect(parseRoutine("Fridays at 5, write the week's notes")).toMatchObject({ days: [5], at: "17:00" });
  // With a comma, the task can name days of its own.
  expect(parseRoutine("Every day at 9, check what's due on Fridays")).toMatchObject({ days: [0, 1, 2, 3, 4, 5, 6], prompt: "Check what's due on Fridays" });
  expect(parseRoutine("list the PRs")).toHaveProperty("error");
  expect(parseRoutine("Every Monday at 9")).toHaveProperty("error");
  expect(parseRoutine("Every day at 25, nothing")).toHaveProperty("error");
});

test("says when in a few words", () => {
  expect(whenWords({ days: [1, 2, 3, 4, 5], at: "08:30" })).toBe("Weekdays · 8:30");
  expect(whenWords({ days: [0, 1, 2, 3, 4, 5, 6], at: "09:00" })).toBe("Every day · 9:00");
  expect(whenWords({ days: [5], at: "17:00" })).toBe("Fridays · 17:00");
  expect(whenWords({ days: [0, 1, 4], at: "07:05" })).toBe("Mon, Thu, Sun · 7:05");
});

test("runs each routine once at its time, and not for slots it was off for", () => {
  // Monday 2026-10-19, 08:00 local.
  let now = new Date(2026, 9, 19, 8, 0).getTime();
  const started: Routine[] = [];
  const routines = new Routines(join(mkdtempSync(join(tmpdir(), "demesne-routines-")), "routines.json"), {
    trusted: (workspace) => workspace === "/work",
    start: (routine) => { started.push(routine); return `s${started.length}`; },
  }, () => now);
  const added = routines.add("Weekdays at 8:30, summarize the night", "/work");
  expect(added).toMatchObject({ prompt: "Summarize the night", when: "Weekdays · 8:30" });
  expect(routines.add("Every day at 9, look around", "/elsewhere")).toEqual({ error: "Trust this folder before giving it routines." });
  expect(routines.tick()).toEqual([]);
  now = new Date(2026, 9, 19, 8, 31).getTime();
  expect(routines.tick()).toHaveLength(1);
  expect(routines.tick()).toEqual([]);
  expect(routines.list()[0]!.runs).toEqual([{ at: new Date(now).toISOString(), sessionId: "s1" }]);
  // Off over Tuesday's slot, back on Wednesday morning: Tuesday doesn't run late.
  const id = (added as Routine).id;
  routines.set(id, false);
  now = new Date(2026, 9, 20, 9, 0).getTime();
  expect(routines.tick()).toEqual([]);
  routines.set(id, true);
  expect(routines.tick()).toEqual([]);
  now = new Date(2026, 9, 21, 8, 30).getTime();
  expect(routines.tick()).toHaveLength(1);
  expect(started.map((routine) => routine.workspace)).toEqual(["/work", "/work"]);
  // Saturday has no slot.
  expect(nextSlot({ days: [1, 2, 3, 4, 5], at: "08:30" }, new Date(2026, 9, 24, 10, 0))?.getDay()).toBe(1);
  expect(routines.remove(id)).toBe(true);
  expect(routines.list()).toEqual([]);
});
