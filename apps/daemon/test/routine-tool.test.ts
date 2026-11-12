import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Routines } from "../src/routines.ts";
import { routineTool } from "../src/routine-tool.ts";
import type { ToolContext } from "../src/tools.ts";

const setup = (project: string | null) => {
  const folder = mkdtempSync(join(tmpdir(), "demesne-routine-tool-"));
  const routines = new Routines(join(folder, "routines.json"), { trusted: () => true, start: () => "chat" }, () => Date.parse("2026-11-11T12:00:00Z"));
  const tool = routineTool(() => routines, () => project);
  const context: ToolContext = { workspaceRoot: folder, signal: new AbortController().signal, sessionId: "s" };
  const run = async (input: Record<string, unknown>) => JSON.parse(await tool.execute(input, context)) as Record<string, unknown>;
  return { routines, tool, run };
};

test("a chat makes a routine in its own project, and asks first", async () => {
  const { routines, tool, run } = setup("/work/app");
  expect(tool.permission({ action: "list" })).toBeNull();
  expect(tool.permission({ action: "add", text: "Every weekday at 9, list the PRs waiting on me" })).toEqual({ kind: "write", summary: "Make a routine: Weekdays · 9:00, List the PRs waiting on me" });
  const added = await run({ action: "add", text: "Every weekday at 9, list the PRs waiting on me" });
  expect(added).toMatchObject({ routine: "added", when: "Weekdays · 9:00", prompt: "List the PRs waiting on me", on: true, project: "/work/app" });
  expect(routines.list()).toHaveLength(1);
  expect(routines.list()[0]!.workspace).toBe("/work/app");
  await expect(run({ action: "add", text: "list the PRs" })).rejects.toThrow(/when first/i);
});

test("list, pause, resume and remove work on this project's routines only", async () => {
  const { routines, tool, run } = setup("/work/app");
  routines.add("Every day at 8, elsewhere", "/work/other");
  const { id } = await run({ action: "add", text: "Fridays at 5, write the week's notes" }) as { id: string };
  const listed = await run({ action: "list" }) as { routines: { id: string }[] };
  expect(listed.routines.map((routine) => routine.id)).toEqual([id]);
  expect(tool.permission({ action: "pause", id })!.summary).toBe("Pause the routine Fridays · 17:00, Write the week's notes");
  expect(await run({ action: "pause", id })).toMatchObject({ routine: "paused", on: false });
  expect(await run({ action: "resume", id })).toMatchObject({ routine: "resumed", on: true });
  const other = routines.list().find((routine) => routine.workspace === "/work/other")!.id;
  await expect(run({ action: "remove", id: other })).rejects.toThrow(/no routine here/);
  expect(await run({ action: "remove", id })).toMatchObject({ routine: "removed", id });
  expect(routines.list()).toHaveLength(1);
});

test("outside a project, the routine is Just a chat", async () => {
  const { routines, run } = setup(null);
  await run({ action: "add", text: "Every morning, tell me the weather" });
  expect(routines.list()[0]).toMatchObject({ workspace: null, at: "09:00" });
});
