import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceFileInfo } from "../src/workspace-file-info.ts";

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
    expect(files).toContainEqual({ path: "changed.ts", byteLength: 12, status: "M" });
    expect(files).toContainEqual({ path: "new file.ts", byteLength: 3, status: "?" });
    expect(files.some((file) => file.path === "outside")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
