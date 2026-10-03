import { expect, test } from "bun:test";
import { partialToolArguments, applyToolDraft } from "../src/workbench/tool-preview.ts";
import { codeDiff } from "../src/workbench/change-diff.ts";
import type { WorkbenchEntry } from "../src/workbench/entries.ts";
const user = (id = 1): WorkbenchEntry => ({ id, type: "user", text: "Write code", at: "12:00" });

test("partial JSON renders streamed escaped code and multi-hunk edits without interpreting unfinished escapes", () => {
  const args = { path: "src/界.ts", edits: [{ oldText: "const a = 1;", newText: 'const a = "👩‍💻\\n";\n' }, { oldText: "b", newText: "c" }], all: true };
  const raw = JSON.stringify(args);
  for (let i = 0; i <= raw.length; i++) expect(() => partialToolArguments(raw.slice(0, i))).not.toThrow();
  expect(partialToolArguments(raw)).toEqual(args);
  expect(partialToolArguments('{"path":"a","content":"one\\n\\u754')).toMatchObject({ path: "a", content: "one\n" });
  expect(partialToolArguments('{"content":"\\uD83D')).toMatchObject({ content: "" });
  const entries: WorkbenchEntry[] = [user()]; let id = 2;
  for (const delta of raw) applyToolDraft(entries, { draftId: "round:0", name: "edit_file", delta }, () => id++, 0);
  expect(entries).toHaveLength(2);
  expect(entries[1]).toMatchObject({ drafting: true, state: "running", input: args, diff: { oldText: "const a = 1;\n…\nb" } });
});

test("every tool call drafts while the model writes it; only file tools preview a change", () => {
  const entries: WorkbenchEntry[] = [user()]; let id = 2;
  for (const delta of ['{"description":"Read the par', 'ser","prompt":"Read src/parser.ts'])
    applyToolDraft(entries, { draftId: "round:0", name: "subagent", delta }, () => id++, 0);
  expect(entries).toHaveLength(2);
  expect(entries[1]).toMatchObject({ name: "subagent", drafting: true, state: "running", input: { description: "Read the parser", prompt: "Read src/parser.ts" } });
  expect(entries[1]).not.toHaveProperty("diff");
  // A draft without a tool name yet waits for it.
  applyToolDraft(entries, { draftId: "round:1", name: "", delta: "{" }, () => id++, 0);
  expect(entries).toHaveLength(2);
});

test("line diffs retain true line numbers and separate distant changes, including newline-only changes", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const after = [...before]; after[2] = "replaced"; after.splice(30, 0, "inserted");
  const diff = codeDiff(before.join("\n"), after.join("\n"));
  expect(diff.added).toBe(2); expect(diff.removed).toBe(1);
  expect(diff.rows.find((row) => row.text === "replaced")).toMatchObject({ next: 3, kind: "added" });
  expect(diff.rows.find((row) => row.text === "inserted")).toMatchObject({ next: 31, kind: "added" });
  expect(diff.rows.some((row) => row.kind === "gap")).toBe(true);
  expect(codeDiff("a\n", "a").rows.at(-1)?.text).toBe("No newline at end of file");
  expect(codeDiff("", "a\n")).toMatchObject({ added: 1, removed: 0 });
  expect(codeDiff("a\n", "")).toMatchObject({ added: 0, removed: 1 });
  expect(codeDiff("x\n".repeat(2000), "y\n".repeat(2000))).toMatchObject({ added: 2000, removed: 2000 });
});
