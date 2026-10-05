import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import type { WorkspaceFileChanges, WorkspaceFileInfo } from "@demesne/protocol";
import { listWorkspaceFiles, resolveWorkspacePath } from "./tools.ts";

export function workspaceFileInfo(root: string): WorkspaceFileInfo[] {
  const statuses = new Map<string, string>();
  const counts = new Map<string, { additions: number; deletions: number }>();
  try {
    const prefix = execFileSync("git", ["-C", root, "rev-parse", "--show-prefix"], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const records = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\0");
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      if (record.length < 4) continue;
      const status = record.slice(0, 2);
      const path = record.slice(3);
      if (path.startsWith(prefix)) statuses.set(path.slice(prefix.length), status === "??" ? "?" : status.includes("M") ? "M" : status.trim()[0] ?? "?");
      if (status.includes("R") || status.includes("C")) index++;
    }
    // Lines added and removed since the last commit, per tracked file.
    const numstat = execFileSync("git", ["-C", root, "diff", "--numstat", "-z", "HEAD", "--", "."], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\0");
    for (const record of numstat) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(record);
      if (match && match[3]!.startsWith(prefix)) counts.set(match[3]!.slice(prefix.length), { additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0 });
    }
  } catch { /* Non-git workspaces still display file sizes. */ }
  return listWorkspaceFiles(root).map((path) => {
    let byteLength: number | null = null;
    try { byteLength = statSync(resolveWorkspacePath(root, path, true, true)).size; } catch {}
    return { path, byteLength, status: statuses.get(path) ?? null, ...counts.get(path) };
  });
}

/// One file's changes since the last commit, from `git diff -U0`. Untracked
/// files are all new; files outside git, or unchanged, have none.
export function workspaceFileChanges(root: string, path: string): WorkspaceFileChanges | undefined {
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  try {
    if (git(["status", "--porcelain=v1", "--", path]).startsWith("??")) return { added: [], modified: [], removed: [], additions: 0, deletions: 0, untracked: true };
    const changes: WorkspaceFileChanges = { added: [], modified: [], removed: [], additions: 0, deletions: 0 };
    for (const line of git(["diff", "-U0", "--no-color", "HEAD", "--", path]).split("\n")) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk) continue;
      const removed = hunk[1] === undefined ? 1 : Number(hunk[1]), start = Number(hunk[2]), added = hunk[3] === undefined ? 1 : Number(hunk[3]);
      changes.additions += added; changes.deletions += removed;
      if (!added) changes.removed.push(start);
      else if (!removed) changes.added.push([start, start + added - 1]);
      else changes.modified.push([start, start + added - 1]);
    }
    return changes.additions || changes.deletions ? changes : undefined;
  } catch { return undefined; }
}
