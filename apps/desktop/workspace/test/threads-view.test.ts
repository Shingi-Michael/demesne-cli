import { expect, test } from "bun:test";
import type { DriveFix } from "@demesne/protocol";
import { threadLine, threadListHTML, threadProgress, threadsFootHTML, threadState, type ThreadsView } from "../threads-view.ts";

const fix = (id: string, more: Partial<DriveFix> = {}): DriveFix => ({ id, workspace: "/p", title: `Thread ${id}`, signals: [], branch: `thread/${id}`, path: `/w/${id}`, base: "abc",
  sessionId: `s-${id}`, turnId: `t-${id}`, status: "running", startedAt: new Date().toISOString(), finishedAt: null, from: "orch", thread: { brief: "Do it.", files: [`${id}.ts`] }, ...more });
const view = (list: DriveFix[], more: Partial<ThreadsView> = {}): ThreadsView => ({ list, open: list[0]?.id ?? null, closed: false, busy: null, message: null, ...more });

test("a thread's state, ring and line follow its job", () => {
  expect(threadState(fix("a"))).toBe("work");
  expect(threadState(fix("a", { waiting: true }))).toBe("you");
  expect(threadState(fix("a", { status: "ready" }))).toBe("ready");
  expect(threadState(fix("a", { status: "applied" }))).toBe("merged");
  expect(threadProgress(fix("a", { activity: { steps: 0, last: null } }))).toBeLessThan(0.2);
  expect(threadProgress(fix("a", { activity: { steps: 300, last: null } }))).toBe(0.9);
  expect(threadProgress(fix("a", { status: "ready" }))).toBe(1);
  expect(threadLine(fix("a", { activity: { steps: 3, last: "Reading live.ts" } }))).toBe("Reading live.ts…");
  expect(threadLine(fix("a", { status: "ready", diff: { files: 1, additions: 4, deletions: 2, paths: ["a.ts"] }, checks: [{ command: "bun test", passed: true }] }))).toContain("checks passed");
});

test("the list lights the open row, and only the person's pick moves it", () => {
  const html = threadListHTML(view([fix("a"), fix("b", { waiting: true })], { open: "b" }));
  expect(html.match(/th-row on/g)?.length).toBe(1);
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain("Needs you");
  expect(threadListHTML(view([fix("a")], { closed: true }))).not.toContain("th-row on");
  expect(threadListHTML(view([]))).toBe("");
});

test("the line above the composer says how they're doing, then offers Merge once all are back", () => {
  expect(threadsFootHTML(view([fix("a"), fix("b", { waiting: true }), fix("c", { status: "ready" })]))).toContain("1 needs you</span> · 1 working · 1 ready");
  const ready = (id: string, passed = true) => fix(id, { status: "ready", checks: [{ command: "bun test", passed }] });
  const both = threadsFootHTML(view([ready("a"), ready("b")]));
  expect(both).toContain("Merge both");
  expect(both).toContain("checks passed on each");
  expect(threadsFootHTML(view([ready("a"), fix("b", { status: "ready" })]))).not.toContain("checks passed");
  expect(threadsFootHTML(view([ready("a"), ready("b"), ready("c")], { busy: "merge" }))).toContain("Merging…");
  expect(threadsFootHTML(view([fix("a", { status: "applied" })]))).toBe("");
});
