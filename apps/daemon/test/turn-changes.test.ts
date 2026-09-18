import { describe, expect, test } from "bun:test";
import type { SnapshotFile } from "@demesne/storage";
import { buildTurnChanges, plainDiffLines } from "../src/turn-changes.ts";

function snapshot(overrides: Partial<SnapshotFile> & { path: string }): SnapshotFile {
  return {
    existed: true,
    data: new Uint8Array(),
    postExisted: true,
    postHash: "hash",
    ...overrides,
  };
}

const encode = (value: string) => new TextEncoder().encode(value);

describe("plainDiffLines", () => {
  test("renders removed and added lines around a change", () => {
    expect(plainDiffLines("a\nb\nc", "a\nB\nc", 10)).toEqual(["- b", "+ B"]);
  });

  test("renders whole-file additions and removals", () => {
    expect(plainDiffLines("", "new", 10)).toEqual(["+ new"]);
    expect(plainDiffLines("old", "", 10)).toEqual(["- old"]);
    expect(plainDiffLines("same", "same", 10)).toEqual([]);
  });

  test("bounds long diffs with an omission row", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const after = Array.from({ length: 40 }, (_, index) => `changed ${index}`).join("\n");
    const lines = plainDiffLines(before, after, 8);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines.some((line) => line.includes("more lines"))).toBe(true);
  });
});

describe("buildTurnChanges", () => {
  test("classifies additions, modifications, and deletions", () => {
    const files: SnapshotFile[] = [
      snapshot({ path: "created.txt", existed: false, data: null, postExisted: true }),
      snapshot({ path: "modified.txt", existed: true, data: encode("before\n") }),
      snapshot({ path: "deleted.txt", existed: true, data: encode("gone\n"), postExisted: false }),
    ];
    const current: Record<string, string | null> = {
      "created.txt": "new\n",
      "modified.txt": "after\n",
      "deleted.txt": null,
    };
    const changes = buildTurnChanges(files, { readCurrent: (path) => current[path] ?? null });
    expect(changes.map((change) => [change.path, change.operation])).toEqual([
      ["created.txt", "A"],
      ["modified.txt", "M"],
      ["deleted.txt", "D"],
    ]);
    expect(changes[0]!.diff).toEqual(["+ new"]);
    expect(changes[1]!.diff).toEqual(["- before", "+ after"]);
    expect(changes[2]!.diff).toEqual(["- gone"]);
  });

  test("marks reverted files and binary content", () => {
    const files: SnapshotFile[] = [
      snapshot({ path: "reverted.txt", data: encode("pre\n"), revertedAt: "2026-01-01T00:00:00.000Z" }),
      snapshot({ path: "binary.bin", data: encode("a\u0000b") }),
    ];
    const changes = buildTurnChanges(files, { readCurrent: () => "same\n" });
    expect(changes[0]!.reverted).toBe(true);
    expect(changes[1]!.binary).toBe(true);
    expect(changes[1]!.diff).toEqual([]);
  });

  test("caps the number of files", () => {
    const files = Array.from({ length: 10 }, (_, index) =>
      snapshot({ path: `file-${index}.txt`, data: encode("x\n") }));
    const changes = buildTurnChanges(files, { readCurrent: () => "y\n", maxFiles: 3 });
    expect(changes).toHaveLength(3);
  });
});
