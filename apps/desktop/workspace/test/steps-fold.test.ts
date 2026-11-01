import { expect, test } from "bun:test";
import { fileName, inStretch, readPaths, stretchWords, stretches } from "../steps-fold.ts";

const step = (name: string, extra: Record<string, unknown> = {}) => ({ name, state: "done", input: {}, ...extra }) as Parameters<typeof inStretch>[0];
const totals = (tool: { input: Record<string, unknown> }) => (tool.input.counts as { added: number; removed: number } | undefined) ?? { added: 0, removed: 0 };

test("finished reads, edits and writes between two commands make one stretch", () => {
  const tools = [
    step("read_files", { input: { files: [{ path: "a.ts" }, { path: "b.ts" }] } }),
    step("edit_file", { input: { path: "src/live.ts" } }),
    step("run_command", { input: { argv: ["bun", "test"] } }),
    step("write_file", { input: { path: "src/new.ts" }, created: true }),
    step("edit_file", { input: { path: "src/host.ts" }, state: "running" }),
  ];
  const groups = stretches(tools);
  expect(groups.map((group) => group.kind === "stretch" ? group.tools.map((tool) => tool.name) : group.tool.name)).toEqual([
    ["read_files", "edit_file"], "run_command", "write_file", "edit_file",
  ]);
});

test("a step the turn waits on, a failed one, the running one and a commit keep their rows", () => {
  expect(inStretch(step("edit_file"))).toBe(true);
  expect(inStretch(step("edit_file", { waiting: true }))).toBe(false);
  expect(inStretch(step("edit_file", { state: "failed" }))).toBe(false);
  expect(inStretch(step("edit_file", { state: "running" }))).toBe(false);
  expect(inStretch(step("run_command"))).toBe(false);
  expect(inStretch(step("subagent"))).toBe(false);
  expect(inStretch(step("ask_user"))).toBe(false);
  expect(inStretch(step("run_command", { repo: { kind: "commit" } }))).toBe(false);
});

test("the line counts files once, says what is new and read, and names the last two", () => {
  const words = stretchWords([
    step("read_files", { input: { files: [{ path: "a.ts" }, { path: "b.ts" }] }, durationMs: 1400 }),
    step("edit_file", { input: { path: "packages/protocol/src/index.ts", counts: { added: 10, removed: 4 } } }),
    step("edit_file", { input: { path: "packages/protocol/src/index.ts", counts: { added: 14, removed: 0 } } }),
    step("write_file", { input: { path: "apps/daemon/test/reasoning.test.ts", counts: { added: 24, removed: 0 } }, created: true }),
    step("edit_file", { changes: [{ path: "apps/desktop/workspace/live.ts", before: "", after: "", beforeExists: true, afterExists: true }], input: { counts: { added: 7, removed: 1 } } }),
    step("read_file", { input: { path: "c.ts" }, durationMs: 300 }),
  ], totals);
  expect(words.verb).toBe("Changed 3 files");
  expect(words.files).toBe("1 new · read 3 · reasoning.test.ts, live.ts");
  expect([words.changed, words.fresh, words.reads, words.added, words.removed, words.durationMs]).toEqual([3, 1, 3, 55, 5, 1700]);
});

test("a stretch of reads says how many files, a mixed look says it explored", () => {
  expect(stretchWords([step("read_file", { input: { path: "a.ts" } }), step("read_files", { input: { files: [{ path: "b.ts" }, { path: "c.ts" }] } })], totals).verb).toBe("Read 3 files");
  expect(stretchWords([step("read_file", { input: { path: "a.ts" } }), step("search_files", { input: { query: "x" } }), step("list_files", { input: { path: "." } })], totals))
    .toMatchObject({ verb: "Explored · 3 steps", files: "read 1" });
  expect(stretchWords([step("edit_file", { input: { path: "one.ts" } })], totals).verb).toBe("Changed 1 file");
});

test("a read's paths and a file's name", () => {
  expect(readPaths(step("read_files", { input: { files: [{ path: "a.ts" }, { path: "b/c.ts" }] } }))).toEqual(["a.ts", "b/c.ts"]);
  expect(readPaths(step("read_file", { input: { path: "a.ts" } }))).toEqual(["a.ts"]);
  expect(readPaths(step("view_image", { input: {}, detail: "shot.png" }))).toEqual(["shot.png"]);
  expect(fileName("packages/protocol/src/index.ts")).toBe("index.ts");
  expect(fileName("C:\\Users\\shing\\a.ts")).toBe("a.ts");
});
