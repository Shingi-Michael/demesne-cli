import { expect, test } from "bun:test";
import type { DriveFix } from "@demesne/protocol";
import { liveThreads, threadBriefHTML, threadDoing, threadLine, threadProgress, threadsBar, threadsBegunHTML, threadsMessageHTML, threadsRibbonHTML, threadState, type ThreadsLook, type ThreadsView } from "../threads-view.ts";

const fix = (id: string, more: Partial<DriveFix> = {}): DriveFix => ({ id, workspace: "/p", title: `Thread ${id}`, signals: [], branch: `thread/${id}`, path: `/w/${id}`, base: "abc",
  sessionId: `s-${id}`, turnId: `t-${id}`, status: "running", startedAt: new Date().toISOString(), finishedAt: null, from: "orch", thread: { brief: "Do it.", files: [`${id}.ts`] }, ...more });
const view = (list: DriveFix[], more: Partial<ThreadsView> = {}): ThreadsView => ({ list, open: null, busy: null, message: null, ...more });
const look = (more: Partial<ThreadsLook> = {}): ThreadsLook => ({ folded: false, file: null, armed: null, peek: null, asking: null, ...more });
const ready = (id: string, more: Partial<DriveFix> = {}) => fix(id, { status: "ready", diff: { files: 2, additions: 4, deletions: 1, paths: [`${id}.ts`, `${id}.test.ts`] }, checks: [{ command: "bun test", passed: true }], review: { sentBack: 0, checked: true }, summary: `Did ${id}.`, ...more });

test("a thread's state, ring and line follow its job", () => {
  expect(threadState(fix("a"))).toBe("work");
  expect(threadState(fix("a", { waiting: true }))).toBe("you");
  expect(threadState(fix("a", { status: "ready" }))).toBe("ready");
  expect(threadState(fix("a", { status: "applied" }))).toBe("merged");
  expect(threadProgress(fix("a", { activity: { steps: 0, last: null } }))).toBeLessThan(0.2);
  expect(threadProgress(fix("a", { activity: { steps: 300, last: null } }))).toBe(0.9);
  expect(threadProgress(fix("a", { status: "ready" }))).toBe(1);
  expect(threadLine(fix("a", { activity: { steps: 3, last: "read_file apps/desktop/live.ts" } }))).toBe("Reading live.ts");
  expect(threadLine(fix("a", { waiting: true }))).toBe('<span class="amber">Asks you</span>');
  expect(threadLine(ready("a"))).toBe('Ready · <span class="plus">+4</span> <span class="minus">−1</span>');
  expect(threadLine(fix("a", { status: "ready", checks: [{ command: "bun test", passed: false }] }))).toBe("Ready · a check failed");
  expect(threadLine(fix("a", { status: "applied" }))).toBe("Merged");
  expect(threadLine(fix("a", { status: "applied", mergedElsewhere: "github" }))).toBe("Merged on GitHub");
  expect(threadLine(fix("a", { status: "failed", error: "It ran out of steps." }))).toBe('<span class="red">Stopped</span> · It ran out of steps.');
  expect(threadLine(fix("a", { status: "starting" }))).toBe("Starting");
});

test("pass 211 A: sent back, checked and waits still read the same", () => {
  const first = ready("a");
  const back = fix("b", { review: { sentBack: 1, note: "a check failed (bun test)" } });
  const waits = fix("c", { status: "starting", sessionId: null, thread: { brief: "", files: [], after: first.id } });
  expect(threadState(waits)).toBe("waits");
  expect(threadLine(waits, [first, back, waits])).toBe("After Thread a");
  expect(threadLine(back)).toContain("Sent back</span> · a check failed (bun test)");
  expect(threadLine(fix("d", { status: "ready", review: { sentBack: 0, note: "no checks ran" } }))).toContain("Ready · no checks ran");
});

test("pass 216 A: what a thread is doing, in plain words", () => {
  expect(threadDoing("run_command sh -c while [ ! -f /tmp/gate ]; do sleep 1; done")).toBe("Running a command");
  expect(threadDoing("run_command bun test apps/desktop --bail")).toBe("Running bun test desktop");
  expect(threadDoing("run_command /usr/bin/git status")).toBe("Running git status");
  expect(threadDoing("edit_file src/csv.ts")).toBe("Editing csv.ts");
  expect(threadDoing("write_file docs/export.md")).toBe("Writing export.md");
  expect(threadDoing("search_files toCSV")).toBe("Searching");
  expect(threadDoing("remember")).toBe("Working");
  expect(threadDoing(null)).toBe("Working");
});

test("pass 232: the ribbon holds every live thread, with what needs you first, and merged ones leave", () => {
  const list = [fix("work"), ready("ready"), fix("gone", { status: "applied" }), fix("stopped", { status: "failed", error: "No such script." }), fix("asks", { waiting: true }),
    fix("waits", { status: "starting", sessionId: null, thread: { brief: "Later.", files: [], after: "ready" } })];
  expect(liveThreads(list).map((item) => item.id)).toEqual(["asks", "stopped", "ready", "work", "waits"]);
  // Among equals, the order they started in stays.
  expect(liveThreads([fix("b"), fix("a"), ready("d"), ready("c")]).map((item) => item.id)).toEqual(["d", "c", "b", "a"]);
  const html = threadsRibbonHTML(view(list), look());
  expect(html).not.toContain("Thread gone");
  expect(html.match(/class="tr-item /g)).toHaveLength(5);
  expect(html.indexOf("Thread asks")).toBeLessThan(html.indexOf("Thread stopped"));
  expect(html.indexOf("Thread stopped")).toBeLessThan(html.indexOf("Thread ready"));
  expect(html).toContain('<span class="pr-segs"><i class="y"><b></b></i><i class="r"><b></b></i><i class="d"><b></b></i><i class="n"><b></b></i><i class="p"><b></b></i></span>');
  expect(threadsRibbonHTML(view([fix("gone", { status: "applied" })]), look())).toBe("");
  expect(threadsRibbonHTML(view([]), look())).toBe("");
});

test("pass 232: the bar counts across threads, whatever each is on", () => {
  expect(threadsBar([fix("a"), fix("b"), fix("c")])).toEqual({ name: "Three threads working", count: "", tone: "" });
  expect(threadsBar([fix("a"), fix("b", { title: "Fix the jumping header", waiting: true }), ready("c")])).toEqual({ name: "Fix the jumping header asks you", count: "1 working · 1 ready", tone: "asks" });
  expect(threadsBar([fix("a", { waiting: true }), fix("b", { status: "failed" })]).name).toBe("Two threads need you");
  expect(threadsBar([fix("a", { title: "Switch the README to bun", status: "failed" }), ready("b")])).toEqual({ name: "Switch the README to bun stopped", count: "1 ready", tone: "asks" });
  expect(threadsBar([ready("a"), ready("b"), ready("c"), fix("d", { status: "applied" })])).toEqual({ name: "Three threads ready to merge", count: "", tone: "still" });
  expect(threadsBar([fix("a"), ready("b")])).toEqual({ name: "One thread working", count: "1 ready", tone: "" });
  // Nothing in the bar speaks of the threads as one job that comes back together.
  const html = threadsRibbonHTML(view([ready("a"), ready("b")]), look());
  expect(html).not.toMatch(/are back|all back|both back/i);
});

test("pass 232: each line ends in its one next step", () => {
  const html = threadsRibbonHTML(view([fix("work"), ready("ready"), fix("asks", { waiting: true }), fix("stopped", { status: "failed" })]), look());
  const next = (id: string) => /class="tr-next[^"]*" data-action="([\w-]+)"[^>]*>([^<]+)</.exec(html.slice(html.indexOf(`data-thread="${id}"`), html.indexOf("</div></div>", html.indexOf(`data-thread="${id}"`))))?.slice(1);
  expect(next("asks")).toEqual(["thread-answer", "Answer"]);
  expect(next("ready")).toEqual(["thread-merge", "Merge"]);
  expect(next("stopped")).toEqual(["select-session", "Open"]);
  expect(next("work")).toBeUndefined();
  expect(html).toContain('<span class="tr-words">Working</span><span class="tr-end">1m</span>');
  expect(html.match(/class="tr-end"/g)).toHaveLength(1);
  expect(threadsRibbonHTML(view([ready("a")], { busy: "a" }), look())).toContain("Merging…");
  // Folded, it is its one bar: the lines are there but out of reach.
  expect(threadsRibbonHTML(view([fix("a")]), look({ folded: true }))).toContain('class="pr-fold" inert');
  expect(threadsRibbonHTML(view([fix("a")]), look({ folded: true }))).toContain('class="plan-ribbon tr"');
  expect(threadsRibbonHTML(view([fix("a")]), look())).toContain('class="plan-ribbon tr open"');
});

test("pass 232: a line opens in place: last words and steps while it works, files, diffs and Merge once it is back", () => {
  const working = threadsRibbonHTML(view([fix("a")], { open: "a" }), look({ peek: { of: "a", say: "Writing the quoting first.", steps: '<button class="tool-row">Edit csv.ts</button>' } }));
  expect(working).toContain('class="tr-item work open"');
  expect(working).toContain('<p class="tr-say">Writing the quoting first.</p><div class="steps"><button class="tool-row">Edit csv.ts</button></div>');
  expect(working).toContain("thread/a");
  expect(working).toContain('data-action="select-session" data-args="{&quot;id&quot;:&quot;s-a&quot;}">Open its chat');
  expect(working).toContain('data-action="thread-close"');
  // Until its chat has loaded, the line says what it was asked to do.
  expect(threadsRibbonHTML(view([fix("a")], { open: "a" }), look())).toContain('<p class="tr-say">Do it.</p>');
  const changes = { id: "a", more: 2, files: [{ path: "src/csv.ts", additions: 3, deletions: 1, patch: "@@ -1,2 +1,4 @@\n export function toCsv() {\n-  return \"\";\n+  return rows.join(\"\\n\");\n }" }, { path: "logo.png", additions: 0, deletions: 0, patch: "" }] };
  const back = threadsRibbonHTML(view([ready("a")], { open: "a", changes }), look({ file: "src/csv.ts" }));
  expect(back).toContain('<p class="tr-say">Did a.</p>');
  expect(back).toContain('data-action="thread-file" data-args="{&quot;path&quot;:&quot;src/csv.ts&quot;}" aria-expanded="true"');
  expect(back).toContain('<div class="h">@@ -1,2 +1,4 @@</div><div class=""> export function toCsv() {</div><div class="d">-  return &quot;&quot;;</div><div class="a">+  return rows.join(&quot;\\n&quot;);</div>');
  expect(back).toContain('aria-expanded="false" disabled');
  expect(back).toContain("and 2 more files");
  expect(back).toContain("Stayed in its files · bun test passed");
  expect(back).toContain('class="tr-go" data-action="thread-merge"');
  expect(back.match(/<div class="tr-diff">/g)).toHaveLength(1);
  // Before what it changed has been read, the files it named stand in.
  expect(threadsRibbonHTML(view([ready("a")], { open: "a" }), look())).toContain('<div class="tr-file"><span class="path">a.ts</span></div>');
  // Delete asks once more.
  expect(back).toContain('data-action="thread-delete-arm"');
  expect(threadsRibbonHTML(view([ready("a")], { open: "a", changes }), look({ armed: "a" }))).toContain('data-action="thread-delete" data-args="{&quot;id&quot;:&quot;a&quot;}">Delete it and its branch');
  const asks = threadsRibbonHTML(view([fix("a", { waiting: true })], { open: "a" }), look({ asking: "a" }));
  expect(asks).toContain("Its question is waiting at the end of this chat");
  expect(threadsRibbonHTML(view([fix("a", { waiting: true })], { open: "a" }), look())).toContain("It waits for your go-ahead in its chat");
  expect(threadsRibbonHTML(view([fix("a", { status: "failed", error: "No such script." })], { open: "a" }), look())).toContain('<p class="tr-say">No such script.</p>');
});

test("pass 232: Merge all shows only once every live thread is ready", () => {
  const all = threadsRibbonHTML(view([ready("a"), ready("b"), ready("c"), fix("d", { status: "applied" })]), look());
  expect(all).toContain('<span class="plus">+12</span> <span class="minus">−3</span> in 6 files · each one checked');
  expect(all).toContain('data-action="threads-merge" data-args="{}">Merge all 3');
  expect(threadsRibbonHTML(view([ready("a"), ready("b")], { busy: "merge" }), look())).toContain("Merging…");
  expect(threadsRibbonHTML(view([ready("a"), ready("b", { checks: [], review: { sentBack: 0, checked: false } })]), look())).not.toContain("each one checked");
  expect(threadsRibbonHTML(view([ready("a"), ready("b"), fix("c")]), look())).not.toContain("threads-merge");
  expect(threadsRibbonHTML(view([ready("a")]), look())).not.toContain("threads-merge");
});

test("pass 232: the reply that started threads keeps one quiet line of them", () => {
  const list = [fix("a", { title: "Add CSV export" }), ready("b", { title: "Fix the jumping header" })];
  const html = threadsBegunHTML(view(list), ["Add CSV export", "fix the jumping header", "Never started"]);
  expect(html).toStartWith('<span class="tr-word">Started</span>');
  expect(html.match(/data-action="thread-jump"/g)).toHaveLength(2);
  expect(html).toContain('{&quot;id&quot;:&quot;a&quot;,&quot;chat&quot;:&quot;s-a&quot;}');
  expect(html).toContain('<span class="tr-gone">Never started</span>');
  const merged = threadsBegunHTML(view([fix("a", { title: "Add CSV export", status: "applied", mergedElsewhere: "branch" })]), ["Add CSV export"]);
  expect(merged).toStartWith('<span class="tr-word">Merged</span>');
  expect(merged).toContain("th-ring ok");
  expect(merged).toContain("Merged outside Demesne");
  // Two threads with one name: each reply keeps the one it started.
  const twice = [fix("old", { title: "Tidy", startedAt: new Date(1_000_000).toISOString() }), fix("new", { title: "Tidy", startedAt: new Date(9_000_000).toISOString() })];
  expect(threadsBegunHTML(view(twice), ["Tidy"], 1_000_500)).toContain("&quot;id&quot;:&quot;old&quot;");
  expect(threadsBegunHTML(view(twice), ["Tidy"], 8_999_000)).toContain("&quot;id&quot;:&quot;new&quot;");
  expect(threadsBegunHTML(view(list), [])).toBe("");
});

test("pass 232: a thread's own chat opens on one quiet line, with the way back", () => {
  const html = threadBriefHTML(fix("a", { thread: { brief: "Add toCsv().", files: ["src/csv.ts"] } }), "long prompt", { id: "orch", title: "Ledger, this week" });
  expect(html).toContain('A thread of <button type="button" class="" data-action="select-session" data-args="{&quot;id&quot;:&quot;orch&quot;}">Ledger, this week</button>');
  expect(html).toContain("<b>Add toCsv().</b> · Only touches <code>src/csv.ts</code>");
  expect(threadBriefHTML(null, "You're one of the threads…\nYour job: Tidy\nSort the imports.\n")).toBe('<div class="tr-brief">A thread · <b>Sort the imports.</b></div>');
});

test("what a merge just did sits above the composer, and nothing else", () => {
  expect(threadsMessageHTML(view([fix("a")]))).toBe("");
  expect(threadsMessageHTML(view([], { message: { text: "Merged Thread a onto your branch.", tone: "ok" } }))).toContain('<p class="th-msg ok"><span>Merged Thread a onto your branch.</span>');
});
