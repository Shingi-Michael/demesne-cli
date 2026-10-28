/// The tree a commit or merge step draws. When a chat runs `git commit` or
/// `git merge`, the engine reads git just before and just after, and the
/// window draws the two as main, the branches not in it, and the files
/// flowing in (workspace/repo-flow.ts). Read-only, a handful of quick git
/// calls; any failure (no repository, no main, a timeout) means no tree.
import { isAbsolute, join } from "node:path";

import type { RepoCommit, RepoFile, RepoLane, RepoSnapshot } from "@demesne/protocol";

/// Runs one git command in the repository and returns its stdout, or null
/// when it fails.
export type Git = (args: string[]) => Promise<string | null>;

export interface GitStep { kind: "commit" | "merge"; all: boolean; dir: string | null }

const MAIN_NAMES = ["main", "master", "trunk"];
const MAIN_COMMITS = 6, LANES = 3, LANE_COMMITS = 4, FILES = 5, BRANCHES_CHECKED = 16;

/// Whether a run_command argv is a commit or a merge, and where (`-C`).
/// `merge --abort` changes nothing worth drawing.
export function gitStep(argv: readonly string[]): GitStep | null {
  if (!argv.length || argv[0]!.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "") !== "git") return null;
  let dir: string | null = null, index = 1;
  while (index < argv.length && argv[index]!.startsWith("-")) {
    const option = argv[index]!;
    if (option === "-C" && index + 1 < argv.length) { dir = argv[index + 1]!; index += 2; continue; }
    if (option === "-c" || option === "--git-dir" || option === "--work-tree") { index += 2; continue; }
    index++;
  }
  const command = argv[index], rest = argv.slice(index + 1);
  if (command === "commit") {
    const all = rest.some((arg) => arg === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(arg));
    return { kind: "commit", all, dir };
  }
  if (command === "merge" && !rest.some((arg) => arg === "--abort" || arg === "--quit")) return { kind: "merge", all: false, dir };
  return null;
}

/// The directory git runs in for a step: the command's cwd, then `-C`.
export const stepDirectory = (cwd: string, step: GitStep) => step.dir ? (isAbsolute(step.dir) ? step.dir : join(cwd, step.dir)) : cwd;

const lines = (text: string | null) => (text ?? "").split("\n").map((line) => line.trimEnd()).filter(Boolean);
const clip = (subject: string) => subject.length > 80 ? `${subject.slice(0, 79)}…` : subject;
function commits(text: string | null): RepoCommit[] {
  return lines(text).map((line) => {
    const [sha = "", subject = "", parents = ""] = line.split("\x1f");
    return { sha, subject: clip(subject), merge: parents.trim().split(/\s+/).filter(Boolean).length > 1 };
  }).filter((commit) => /^[0-9a-f]{7,64}$/.test(commit.sha)).reverse();
}
function numstat(text: string | null): RepoFile[] {
  return lines(text).flatMap((line) => {
    const [added, removed, ...path] = line.split("\t");
    if (!path.length) return [];
    return [{ path: path.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 }];
  });
}
const LOG = ["--format=%H%x1f%s%x1f%P"];

/// Reads the tree. `all` counts unstaged changes as about to be committed
/// (`git commit -a`); otherwise the staged ones, or every change when
/// nothing is staged yet.
export async function repoSnapshot(git: Git, options: { all?: boolean } = {}): Promise<RepoSnapshot | null> {
  const [head, tip] = await Promise.all([
    git(["symbolic-ref", "--short", "-q", "HEAD"]).then((out) => out?.trim() || null),
    git(["rev-parse", "-q", "--verify", "HEAD"]).then((out) => out?.trim() || null),
  ]);
  let main: string | null = null;
  for (const name of MAIN_NAMES) if (await git(["rev-parse", "-q", "--verify", `refs/heads/${name}`]) !== null) { main = name; break; }
  main ??= head;
  if (!main) return null;
  const [mainLog, refs, worktrees, staged] = await Promise.all([
    git(["log", "--first-parent", "-n", String(MAIN_COMMITS), ...LOG, main]),
    git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]),
    git(["worktree", "list", "--porcelain"]),
    options.all ? Promise.resolve(null) : git(["diff", "--cached", "--numstat"]),
  ]);
  const checkedOut = new Set(lines(worktrees).filter((line) => line.startsWith("branch refs/heads/")).map((line) => line.slice("branch refs/heads/".length)));
  const names = lines(refs).filter((name) => name !== main).slice(0, BRANCHES_CHECKED);
  const found = await Promise.all(names.map(async (name): Promise<RepoLane | null> => {
    const ahead = commits(await git(["log", "-n", String(LANE_COMMITS), ...LOG, `${main}..${name}`, "--"]));
    if (!ahead.length) return null;
    const base = (await git(["merge-base", main!, name]))?.trim() || null;
    return { name, base, commits: ahead, worktree: checkedOut.has(name) && name !== head };
  }));
  const open = found.filter((lane): lane is RepoLane => Boolean(lane));
  // The branch you're on always shows; the rest by recency.
  const lanes = [...open.filter((lane) => lane.name === head), ...open.filter((lane) => lane.name !== head)].slice(0, LANES);
  let files = numstat(staged);
  if (!files.length) files = numstat(await git(["diff", "HEAD", "--numstat"]));
  files.sort((a, b) => b.added + b.removed - (a.added + a.removed));
  return {
    main, head, tip, commits: commits(mainLog), lanes, older: open.length - lanes.length,
    files: files.slice(0, FILES), moreFiles: Math.max(0, files.length - FILES),
  };
}

/// git in one directory, with a short timeout and no prompts or locks.
export function gitIn(directory: string, timeoutMs = 2_000): Git {
  return async (args) => {
    try {
      const child = Bun.spawn(["git", "-C", directory, ...args], {
        stdout: "pipe", stderr: "ignore", stdin: "ignore",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      try {
        const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        return code === 0 ? stdout : null;
      } finally { clearTimeout(timer); }
    } catch { return null; }
  };
}
