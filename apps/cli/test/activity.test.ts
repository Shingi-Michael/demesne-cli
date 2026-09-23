import { expect, test } from "bun:test";
import { evidenceCounts, groupActivity, changeSummary, type ActivityEntry } from "../src/workbench/activity.ts";

test("activity groups the recorded task without losing or duplicating entries", () => {
  const entries: ActivityEntry[] = [
    { id: 1, type: "user" },
    { id: 2, type: "assistant" },
    { id: 3, type: "tool", phase: "inspect", state: "done" },
    { id: 4, type: "tool", phase: "change", state: "done" },
    { id: 5, type: "tool", phase: "verify", state: "failed" },
    { id: 6, type: "assistant" },
    { id: 7, type: "notice", closesTurn: true },
    { id: 8, type: "user" },
    { id: 9, type: "assistant" },
  ];
  const pages = groupActivity(entries);
  expect(pages.map((page) => page.number)).toEqual([1, 2]);
  expect(pages[0]!.sections.map((section) => [section.name, section.entries.map((entry) => entry.id)])).toEqual([
    ["Updates", [2, 3]], ["Changes", [4]], ["Verification", [5]], ["Response", [6, 7]],
  ]);
  expect(pages[1]!.sections[0]!.name).toBe("Updates");
  const ids = pages.flatMap((page) => [...(page.request ? [page.request.id] : []), ...page.sections.flatMap((section) => section.entries.map((entry) => entry.id))]);
  expect(ids.sort((a, b) => a - b)).toEqual(entries.map((entry) => entry.id));
});

test("an interrupted tool run does not turn its earlier commentary into a response", () => {
  const pages = groupActivity([
    { id: 1, type: "user" }, { id: 2, type: "assistant" },
    { id: 3, type: "tool", phase: "change" as const, state: "running" },
    { id: 4, type: "notice", closesTurn: true },
  ]);
  expect(pages[0]!.sections.find((section) => section.name === "Response")!.entries.map((entry) => entry.id)).toEqual([4]);
});

test("index totals separate successful checks from failures, denials and pending work", () => {
  const entries: ActivityEntry[] = [
    { id: 1, type: "tool", phase: "change", state: "denied" },
    { id: 2, type: "tool", phase: "verify", state: "done", exitCode: 0 },
    { id: 3, type: "tool", phase: "verify", state: "done", exitCode: 1 },
    { id: 4, type: "tool", phase: "verify", state: "running" },
    { id: 5, type: "tool", phase: "verify", state: "denied" },
    { id: 6, type: "tool", phase: "verify", state: "stopped", exitCode: 130 },
    { id: 7, type: "tool", phase: "verify", state: "running", waiting: true },
    { id: 8, type: "tool", phase: "verify", state: "done" },
  ];
  expect(evidenceCounts(entries)).toEqual({ passed: 1, failed: 1, pending: 1, blocked: 1, stopped: 1, waiting: 1, unknown: 1 });
  expect(changeSummary(entries)).toBe("1 change operation (1 incomplete) · 1 check passed · 1 failed · 1 pending · 1 awaiting approval · 1 denied · 1 stopped · 1 unknown");
});

test("notices before the first task remain present without incrementing the task number", () => {
  const pages = groupActivity([{ id: 1, type: "notice" }, { id: 2, type: "user" }]);
  expect(pages[0]!.number).toBe(0);
  expect(pages[0]!.sections[0]!.entries[0]!.id).toBe(1);
  expect(pages[1]!.number).toBe(1);
});
