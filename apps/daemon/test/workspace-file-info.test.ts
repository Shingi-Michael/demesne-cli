import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceFileChanges, workspaceFileInfo } from "../src/workspace-file-info.ts";

test("file panel metadata reports actual sizes and git state in nested workspaces", () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-file-info-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/changed.ts"), "before");
    git("init"); git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
    writeFileSync(join(root, "src/changed.ts"), "after update");
    writeFileSync(join(root, "src/new file.ts"), "new");
    symlinkSync("/etc/hosts", join(root, "src/outside"));
    const files = workspaceFileInfo(join(root, "src"));
    expect(files).toContainEqual({ path: "changed.ts", byteLength: 12, status: "M", additions: 1, deletions: 1 });
    expect(files).toContainEqual({ path: "new file.ts", byteLength: 3, status: "?" });
    expect(files.some((file) => file.path === "outside")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a file's changes since the last commit: added, changed and removed lines", () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-file-changes-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  try {
    writeFileSync(join(root, "a.ts"), ["one", "two", "three", "four", "five", "six"].join("\n") + "\n");
    git("init"); git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
    expect(workspaceFileChanges(root, "a.ts")).toBeUndefined();
    // "two" changed, "four" removed, two lines added after "six".
    writeFileSync(join(root, "a.ts"), ["one", "TWO", "three", "five", "six", "seven", "eight"].join("\n") + "\n");
    writeFileSync(join(root, "b.ts"), "new\n");
    expect(workspaceFileChanges(root, "a.ts")).toEqual({ added: [[6, 7]], modified: [[2, 2]], removed: [3], additions: 3, deletions: 2 });
    expect(workspaceFileChanges(root, "b.ts")).toMatchObject({ untracked: true });
    expect(workspaceFileChanges(join(tmpdir()), "nope.ts")).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
