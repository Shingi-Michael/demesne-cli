import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceDistrict, WorkspaceMapResponse } from "@demesne/protocol";
import { listWorkspaceFiles } from "./tools.ts";

/// The project map: every text file counted by lines, grouped into the
/// folders a person would name ("apps/desktop", "packages/storage", "docs").

const MAX_DISTRICTS = 20;
const MAX_FILE_BYTES = 512 * 1024;
const SKIPPED = /(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$|\.(?:min\.js|map|png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|mp[34]|mov|wasm|sqlite|db|bin|exe|dll|so|dylib)$/i;

/// Lines in one file, or null for binaries, generated files and very large files.
export function countLines(bytes: Uint8Array): number | null {
  const head = Math.min(bytes.length, 8000);
  for (let index = 0; index < head; index++) if (bytes[index] === 0) return null;
  let lines = 0;
  for (let index = 0; index < bytes.length; index++) if (bytes[index] === 10) lines++;
  return bytes.length && bytes[bytes.length - 1] !== 10 ? lines + 1 : lines;
}

/// Groups files into parcels. A top-level folder that is mostly subfolders
/// (apps/, packages/, src/ of a monorepo) splits into them; the smallest
/// parcels beyond the first twenty share one.
export function groupDistricts(files: { path: string; lines: number; changedAt?: number | null }[]): WorkspaceDistrict[] {
  const add = (map: Map<string, WorkspaceDistrict>, key: string, file: { lines: number; changedAt?: number | null }) => {
    const district = map.get(key) ?? { path: key, lines: 0, files: 0, changedAt: null };
    district.lines += file.lines;
    district.files++;
    if (file.changedAt && (district.changedAt ?? 0) < file.changedAt) district.changedAt = file.changedAt;
    map.set(key, district);
  };
  const top = new Map<string, typeof files>();
  for (const file of files) {
    if (!file.lines) continue;
    const parts = file.path.split("/");
    const key = parts.length > 1 ? parts[0]! : "";
    top.set(key, [...top.get(key) ?? [], file]);
  }
  const districts = new Map<string, WorkspaceDistrict>();
  for (const [key, group] of top) {
    const nested = new Map<string, number>();
    let total = 0;
    for (const file of group) {
      total += file.lines;
      const parts = file.path.split("/");
      if (key && parts.length > 2) nested.set(parts[1]!, (nested.get(parts[1]!) ?? 0) + file.lines);
    }
    const inSubfolders = [...nested.values()].reduce((sum, lines) => sum + lines, 0);
    const split = key !== "" && nested.size >= 3 && inSubfolders >= total * 0.6;
    for (const file of group) {
      const parts = file.path.split("/");
      add(districts, split && parts.length > 2 ? `${key}/${parts[1]}` : key, file);
    }
  }
  const sorted = [...districts.values()].sort((left, right) => right.lines - left.lines || String(left.path).localeCompare(String(right.path)));
  if (sorted.length <= MAX_DISTRICTS) return sorted;
  const kept = sorted.slice(0, MAX_DISTRICTS - 1), rest = sorted.slice(MAX_DISTRICTS - 1);
  return [...kept, rest.reduce<WorkspaceDistrict>((other, district) => ({
    path: null,
    lines: other.lines + district.lines,
    files: other.files + district.files,
    changedAt: Math.max(other.changedAt ?? 0, district.changedAt ?? 0) || null,
  }), { path: null, lines: 0, files: 0, changedAt: null })];
}

/// When each file last changed in the last 30 days, from git. Empty when the
/// folder is not a repository.
async function recentChanges(root: string): Promise<Map<string, number>> {
  const changed = new Map<string, number>();
  const output = await git(["log", "--since=30.days", "--format=%x00%ct", "--name-only", "--no-renames"], root);
  if (!output) return changed;
  for (const block of output.split("\0").slice(1)) {
    const [stamp, ...paths] = block.split("\n");
    const at = Number(stamp) * 1000;
    if (!Number.isFinite(at)) continue;
    for (const path of paths) if (path && !changed.has(path)) changed.set(path, at);
  }
  return changed;
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const timer = setTimeout(() => child.kill(), 8000);
    const text = await new Response(child.stdout).text();
    clearTimeout(timer);
    return (await child.exited) === 0 ? text.slice(0, 8 * 1024 * 1024) : null;
  } catch { return null; }
}

const cache = new Map<string, { at: number; map: WorkspaceMapResponse }>();

/// The map of a workspace, cached for a minute.
export async function workspaceMap(root: string, now = Date.now()): Promise<WorkspaceMapResponse> {
  const cached = cache.get(root);
  if (cached && now - cached.at < 60_000) return cached.map;
  const tracked = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
  const paths = tracked !== null ? tracked.split("\0").filter(Boolean) : listWorkspaceFiles(root, 20_000);
  const changed = await recentChanges(root);
  const files: { path: string; lines: number; changedAt: number | null }[] = [];
  for (const path of paths.slice(0, 20_000)) {
    if (SKIPPED.test(path)) continue;
    try {
      const absolute = join(root, path), info = statSync(absolute);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      const lines = countLines(readFileSync(absolute));
      if (lines) files.push({ path, lines, changedAt: changed.get(path) ?? null });
    } catch { /* gone since the listing */ }
  }
  const districts = groupDistricts(files);
  const map = { districts, lines: files.reduce((sum, file) => sum + file.lines, 0), files: files.length };
  cache.set(root, { at: now, map });
  return map;
}
