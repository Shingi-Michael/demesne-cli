import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

/// After an edit to a TypeScript file, Demesne runs the project's own
/// TypeScript (from its node_modules) once and hands the model that file's
/// type errors with the edit result, plus errors the edit caused elsewhere.
/// Nothing is installed: no local typescript, no tsconfig, no check. A
/// project too slow to check is left alone for a while.

const SOURCE = new Set([".ts", ".tsx", ".mts", ".cts"]);
const BUDGET_MS = 15_000;
const SLOW_PAUSE_MS = 10 * 60_000;
const MAX_HERE = 8;
const MAX_ELSEWHERE = 4;

export interface TypeReport {
  /// "no errors", or this file's errors as "line:col TS1234 message".
  types: "no errors" | string[];
  /// New errors in other files since the last check of this project.
  typesElsewhere?: string[];
}

interface Project { tsconfig: string; tsc: string }

const previous = new Map<string, Set<string>>();
const slowUntil = new Map<string, number>();
const running = new Map<string, Promise<unknown>>();

/// The edited file's type report, or null when there's nothing to check with.
export async function checkTypes(workspaceRoot: string, path: string, signal?: AbortSignal): Promise<TypeReport | null> {
  if (!SOURCE.has(extname(path)) || path.endsWith(".d.ts")) return null;
  const file = resolve(workspaceRoot, path);
  const project = findProject(workspaceRoot, file);
  if (!project) return null;
  if ((slowUntil.get(project.tsconfig) ?? 0) > Date.now()) return null;
  // One check per project at a time: the next edit waits for the last one.
  const before = running.get(project.tsconfig) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(() => runCheck(project, signal));
  running.set(project.tsconfig, run);
  try {
    const lines = await run;
    if (lines === null) return null;
    return report(project, file, lines);
  } finally {
    if (running.get(project.tsconfig) === run) running.delete(project.tsconfig);
  }
}

/// The nearest tsconfig.json from the file up to the workspace root, and the
/// project's own TypeScript beside it or above it (still inside the workspace).
export function findProject(workspaceRoot: string, file: string): Project | null {
  const root = resolve(workspaceRoot);
  let tsconfig: string | null = null;
  for (let folder = dirname(file); inside(root, folder); folder = dirname(folder)) {
    if (!tsconfig && existsSync(join(folder, "tsconfig.json"))) tsconfig = join(folder, "tsconfig.json");
    if (tsconfig) {
      const tsc = typescriptBin(folder);
      if (tsc) return { tsconfig, tsc };
    }
    if (folder === root || dirname(folder) === folder) break;
  }
  return null;
}

function typescriptBin(folder: string): string | null {
  const pkg = join(folder, "node_modules", "typescript", "package.json");
  if (!existsSync(pkg)) return null;
  try {
    const bin = (JSON.parse(readFileSync(pkg, "utf8")) as { bin?: { tsc?: string } }).bin?.tsc;
    const path = bin ? join(dirname(pkg), bin) : "";
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
};

async function runCheck(project: Project, signal?: AbortSignal): Promise<string[] | null> {
  const cache = join(tmpdir(), "demesne-types");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const info = join(cache, `${createHash("sha256").update(project.tsconfig).digest("hex").slice(0, 16)}.tsbuildinfo`);
  // Demesne's own runtime runs the script, so no node is needed on PATH.
  const child = Bun.spawn([process.execPath, project.tsc, "--noEmit", "--pretty", "false", "-p", project.tsconfig, "--incremental", "--tsBuildInfoFile", info], {
    cwd: dirname(project.tsconfig),
    env: { ...process.env, BUN_BE_BUN: "1", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, BUDGET_MS);
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [out] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (timedOut) { slowUntil.set(project.tsconfig, Date.now() + SLOW_PAUSE_MS); return null; }
    if (signal?.aborted) return null;
    const lines = out.split("\n").filter((line) => / error TS\d+:/.test(line));
    // A failure that printed no diagnostics (bad config, missing runtime) says nothing about the edit.
    if (child.exitCode !== 0 && !lines.length) return null;
    return lines;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/// "src/a.ts(12,5): error TS2339: Property…" → { file, text: "12:5 TS2339 Property…" }
export function parseDiagnostic(line: string, base: string): { file: string; text: string } | null {
  const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
  if (!match) return null;
  return { file: resolve(base, match[1]!), text: `${match[2]}:${match[3]} ${match[4]} ${clip(match[5]!)}` };
}

function report(project: Project, file: string, lines: string[]): TypeReport {
  const base = dirname(project.tsconfig);
  const parsed = lines.map((line) => parseDiagnostic(line, base)).filter((entry) => entry !== null);
  const here = parsed.filter((entry) => entry.file === file).map((entry) => entry.text);
  const others = parsed.filter((entry) => entry.file !== file).map((entry) => `${relative(base, entry.file)}:${entry.text}`);
  const seen = previous.get(project.tsconfig);
  previous.set(project.tsconfig, new Set(others));
  // The first check only learns what was already broken; later ones name what's new.
  const fresh = seen ? others.filter((line) => !seen.has(line)) : [];
  const result: TypeReport = { types: here.length ? cap(here, MAX_HERE) : "no errors" };
  if (fresh.length) result.typesElsewhere = cap(fresh, MAX_ELSEWHERE);
  return result;
}

const cap = (items: string[], max: number) => items.length > max ? [...items.slice(0, max), `…and ${items.length - max} more`] : items;
const clip = (text: string) => text.length > 240 ? `${text.slice(0, 239)}…` : text;
