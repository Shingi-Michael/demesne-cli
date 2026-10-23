import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countLines, groupDistricts, workspaceMap } from "../src/workspace-map.ts";

describe("workspace map", () => {
  test("counts lines and skips binaries", () => {
    expect(countLines(new TextEncoder().encode("a\nb\nc"))).toBe(3);
    expect(countLines(new TextEncoder().encode("a\nb\n"))).toBe(2);
    expect(countLines(new Uint8Array([1, 0, 2]))).toBeNull();
  });

  test("a folder that is mostly subfolders splits into them", () => {
    const districts = groupDistricts([
      { path: "packages/a/x.ts", lines: 50 }, { path: "packages/b/x.ts", lines: 30 }, { path: "packages/c/x.ts", lines: 20 },
      { path: "docs/one.md", lines: 40 }, { path: "docs/deep/two.md", lines: 5 },
      { path: "README.md", lines: 10, changedAt: 1000 },
    ]);
    expect(districts.map((district) => [district.path, district.lines])).toEqual([
      ["packages/a", 50], ["docs", 45], ["packages/b", 30], ["packages/c", 20], ["", 10],
    ]);
    expect(districts.find((district) => district.path === "")!.changedAt).toBe(1000);
  });

  test("beyond twenty parcels the smallest share one", () => {
    const files = Array.from({ length: 30 }, (_, index) => ({ path: `f${index}/x.ts`, lines: 100 - index }));
    const districts = groupDistricts(files);
    expect(districts).toHaveLength(20);
    expect(districts.at(-1)!.path).toBeNull();
    expect(districts.at(-1)!.files).toBe(11);
  });

  test("maps a folder that is not a repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "demesne-map-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.ts"), "one\ntwo\nthree\n");
    writeFileSync(join(root, "logo.png"), "png\nbytes\n");
    const map = await workspaceMap(root);
    expect(map.districts).toEqual([{ path: "src", lines: 3, files: 1, changedAt: null }]);
    expect(map.lines).toBe(3);
  });
});
