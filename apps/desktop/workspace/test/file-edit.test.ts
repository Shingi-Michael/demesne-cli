import { expect, test } from "bun:test";
import { editRegions, fileEditModel, fileSourceRows } from "../file-edit.ts";
import type { ToolFileChange } from "@demesne/protocol";
const change = (before: string | null, after: string | null, extra: Partial<ToolFileChange> = {}): ToolFileChange => ({ path: "src/file.ts", before, after, beforeExists: true, afterExists: true, ...extra });

test("regions retain recorded line numbers and distinguish distant edits", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const after = [...before]; after[2] = "<script>not HTML</script>"; after[35] = "changed";
  const model = fileEditModel(change(before.join("\n"), after.join("\n")));
  expect(model.diff).toMatchObject({ added: 2, removed: 2 });
  const hunks = model.regions.filter(region => !region.gap);
  expect(hunks).toHaveLength(2);
  expect(hunks[0]!.rows.find(row => row.kind === "added")).toMatchObject({ text: "<script>not HTML</script>", next: 3 });
  expect(hunks[1]!.rows.find(row => row.kind === "added")).toMatchObject({ next: 36 });
  expect(model.regions.some(region => region.gap?.includes("unchanged"))).toBe(true);
});

test("unrecorded existing content is never treated as an empty version", () => {
  const unavailable = fileEditModel(change(null, "new\n", { unavailable: "Before preview unavailable" }));
  expect(unavailable.beforeAvailable).toBe(false);
  expect(unavailable.afterAvailable).toBe(true);
  expect(unavailable.diff).toBeNull();
  expect(fileEditModel(change(null, null)).diff).toBeNull();
});

test("creation and deletion have valid empty sides", () => {
  expect(fileEditModel(change(null, "new\n", { beforeExists: false })).diff).toMatchObject({ added: 1, removed: 0 });
  expect(fileEditModel(change("old\n", null, { afterExists: false })).diff).toMatchObject({ added: 0, removed: 1 });
  expect(fileEditModel(change("", "")).diff?.rows).toEqual([]);
});

test("before and after keep full source, blank lines and final newline evidence", () => {
  expect(fileSourceRows("a\n\nb", "before")).toEqual([
    { kind: "context", text: "a", old: 1 }, { kind: "context", text: "", old: 2 }, { kind: "context", text: "b", old: 3 }, { kind: "gap", text: "No newline at end of file" },
  ]);
  expect(fileSourceRows("a\n", "after")).toEqual([{ kind: "context", text: "a", next: 1 }]);
  expect(fileSourceRows("", "after")).toEqual([]);
  expect(editRegions(fileEditModel(change("a\n", "a")).diff!.rows).some(region => region.gap === "No newline at end of file")).toBe(true);
});
