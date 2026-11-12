import { expect, test } from "bun:test";
import type { DriveFix } from "@demesne/protocol";
import { threadDoing, threadLine, threadListHTML, threadProgress, threadsFootHTML, threadState, type ThreadsView } from "../threads-view.ts";

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
  expect(threadLine(fix("a", { activity: { steps: 3, last: "read_file apps/desktop/live.ts" } }))).toBe("Reading live.ts");
  expect(threadLine(fix("a", { status: "ready", diff: { files: 1, additions: 4, deletions: 2, paths: ["a.ts"] }, checks: [{ command: "bun test", passed: true }] }))).toBe('Ready · <span class="add">+4</span> <span class="del">−2</span>');
  expect(threadLine(fix("a", { status: "ready", checks: [{ command: "bun test", passed: false }] }))).toBe("Ready · a check failed");
  expect(threadLine(fix("a", { status: "applied" }))).toBe("Merged");
  expect(threadLine(fix("a", { status: "applied", mergedElsewhere: "github" }))).toBe("Merged on GitHub");
  expect(threadListHTML(view([fix("a", { status: "applied", mergedElsewhere: "branch" })]))).toContain("Merged outside Demesne");
  expect(threadListHTML(view([fix("a", { status: "applied", mergedElsewhere: "branch" })]))).not.toContain("thread-merge");
  expect(threadLine(fix("a", { status: "failed", error: "It ran out of steps." }))).toBe('<span class="danger">Stopped</span> · It ran out of steps.');
  expect(threadLine(fix("a", { status: "starting" }))).toBe("Starting");
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

test("pass 211 A: stage marks, sent back, checked, waits, and Merge on each ready thread", () => {
  const first = fix("a", { status: "ready", review: { sentBack: 0, checked: true }, diff: { files: 1, additions: 4, deletions: 0, paths: ["a.ts"] }, checks: [{ command: "bun test", passed: true }] });
  const back = fix("b", { review: { sentBack: 1, note: "a check failed (bun test)" } });
  const waits = fix("c", { status: "starting", sessionId: null, thread: { brief: "", files: [], after: first.id } });
  expect(threadState(waits)).toBe("waits");
  expect(threadLine(waits, [first, back, waits])).toBe("After Thread a");
  expect(threadLine(back)).toContain("Sent back</span> · a check failed (bun test)");
  expect(threadLine(first)).toStartWith("Ready · ");
  expect(threadLine(fix("d", { status: "ready", review: { sentBack: 0, note: "no checks ran" } }))).toContain("Ready · no checks ran");
  const html = threadListHTML(view([first, back, waits]));
  expect(html.match(/data-action="thread-merge"/g)).toHaveLength(1);
});

test("pass 216 A: each thread is one line in plain words, with its minutes or Merge at the end", () => {
  expect(threadDoing("run_command sh -c while [ ! -f /tmp/gate ]; do sleep 1; done")).toBe("Running a command");
  expect(threadDoing("run_command bun test apps/desktop --bail")).toBe("Running bun test desktop");
  expect(threadDoing("run_command /usr/bin/git status")).toBe("Running git status");
  expect(threadDoing("edit_file src/csv.ts")).toBe("Editing csv.ts");
  expect(threadDoing("write_file docs/export.md")).toBe("Writing export.md");
  expect(threadDoing("search_files toCSV")).toBe("Searching");
  expect(threadDoing("remember")).toBe("Working");
  expect(threadDoing(null)).toBe("Working");
  const html = threadListHTML(view([fix("a", { activity: { steps: 2, last: "edit_file src/a.ts" } }), fix("b", { status: "ready" }), fix("c", { status: "applied" })]));
  expect(html).not.toContain("th-label");
  expect(html).not.toContain("th-stage");
  expect(html).toContain('<span class="th-line">Editing a.ts</span><span class="th-end">1m</span>');
  expect(html).toContain('class="th-item ready"');
  expect(html).toContain('class="th-item merged"');
  expect(html.match(/class="th-end"/g)).toHaveLength(1);
  expect(html).toContain("Only touches a.ts");
});
