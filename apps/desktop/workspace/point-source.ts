import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findSource, SOURCE_FILE, type PointPick, type PointSource } from "./point.ts";

/// Reads the project's tracked source files (git, else nothing) and finds
/// where a picked element is written. Large and generated files are skipped.
export function pointSourceIn(root: string, pick: PointPick): PointSource | null {
  if (!pick || typeof pick.html !== "string") return null;
  let paths: string[] = [];
  try { paths = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\n"); }
  catch { paths = walk(root); }
  const files: { path: string; text: string }[] = [];
  for (const path of paths) {
    if (!SOURCE_FILE.test(path) || /(^|\/)(node_modules|dist|build)\//.test(path) || /\.min\.js$/.test(path)) continue;
    try {
      const full = join(root, path);
      if (statSync(full).size > 512 * 1024) continue;
      files.push({ path, text: readFileSync(full, "utf8") });
    } catch { /* deleted since listing */ }
    if (files.length >= 4000) break;
  }
  return findSource(files, pick, root);
}

/// Outside git: the folder's files, a few levels deep, without dependencies.
function walk(root: string, dir = "", depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 8000) return out;
  let entries: import("node:fs").Dirent[] = [];
  try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, path, depth + 1, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
