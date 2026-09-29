import { existsSync, lstatSync, readFileSync } from "node:fs";
import type { ToolFileChange } from "@demesne/protocol";
import type { SnapshotFile } from "@demesne/storage";
import { resolveWorkspacePath } from "./tools.ts";

const LIMIT = 1024 * 1024;
const decode = (data: Uint8Array): string => {
  if (data.byteLength > LIMIT) throw new Error("File exceeds the 1 MiB preview limit.");
  if (data.includes(0)) throw new Error("Binary file; textual preview unavailable.");
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
};

export function recordedToolChanges(root: string, before: SnapshotFile[]): ToolFileChange[] {
  return before.map((file) => {
    const change: ToolFileChange = { path: file.path, before: null, after: null, beforeExists: file.existed, afterExists: false };
    try {
      const path = resolveWorkspacePath(root, file.path, true, true);
      change.afterExists = existsSync(path);
      if (file.existed && file.data) change.before = decode(file.data);
      if (change.afterExists) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > LIMIT) throw new Error("File exceeds the textual preview limit.");
        change.after = decode(readFileSync(path));
      }
    } catch (error) {
      change.unavailable = error instanceof Error ? error.message : "File preview unavailable.";
    }
    return change;
  });
}
