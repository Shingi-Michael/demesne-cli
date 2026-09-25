import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import type { WorkspaceFileInfo } from "@demesne/protocol";
import { listWorkspaceFiles, resolveWorkspacePath } from "./tools.ts";

export function workspaceFileInfo(root: string): WorkspaceFileInfo[] {
  const statuses = new Map<string, string>();
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
  } catch { /* Non-git workspaces still display file sizes. */ }
  return listWorkspaceFiles(root).map((path) => {
    let byteLength: number | null = null;
    try { byteLength = statSync(resolveWorkspacePath(root, path, true, true)).size; } catch {}
    return { path, byteLength, status: statuses.get(path) ?? null };
  });
}
