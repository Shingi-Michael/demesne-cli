import { expect, test } from "bun:test";
import { catchUp, readSeen } from "../catch-up.ts";
import type { WorkspaceRun } from "../session-model.ts";

const run = (id: string, completedAt: string, entries: unknown[] = [], status = "completed") =>
  ({ id, number: 1, content: "", status, createdAt: completedAt, completedAt, planOnly: false, entries }) as unknown as WorkspaceRun;
const edit = (path: string) => ({ type: "tool", phase: "change", state: "done", name: "edit_file", input: { path } });
const check = (exitCode: number) => ({ type: "tool", phase: "verify", state: "done", name: "run_command", input: {}, exitCode });

test("says what happened since you looked, before the first turn you didn't see", () => {
  const runs = [run("a", "2026-10-31T07:00:00Z"), run("b", "2026-10-31T08:00:00Z", [edit("live.ts"), edit("live.css")]), run("c", "2026-10-31T08:10:00Z", [edit("live.ts"), edit("tabs.ts"), check(0)])];
  const since = Date.parse("2026-10-31T07:30:00Z");
  expect(catchUp(runs, since, { approvals: 1, questions: 0 })).toEqual({ before: "b", words: "it finished 2 turns, changed 3 files and its checks pass. One approval waits for you." });
  expect(catchUp([run("d", "2026-10-31T08:00:00Z", [check(1)], "failed")], since, { approvals: 0, questions: 2 })!.words).toBe("it stopped with an error and a check failed. 2 questions wait for you.");
});

test("nothing new, or a chat never seen, has no line", () => {
  expect(catchUp([run("a", "2026-10-31T07:00:00Z")], Date.parse("2026-10-31T07:30:00Z"), { approvals: 0, questions: 0 })).toBeNull();
  expect(catchUp([run("a", "2026-10-31T07:00:00Z")], null, { approvals: 0, questions: 0 })).toBeNull();
  expect(readSeen("not json")).toEqual({});
});
