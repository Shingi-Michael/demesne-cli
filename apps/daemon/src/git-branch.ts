/// Resolves the current git branch for a workspace root.
///
/// The result is cached briefly because session state is read often (startup,
/// session switching, and after every turn) while branches change rarely. A
/// missing repository, a detached HEAD, a missing git binary, or a timeout all
/// resolve to null rather than failing the request that asked.

export interface GitBranchDependencies {
  run: (command: string[]) => Promise<{ code: number; stdout: string }>;
  now: () => number;
}

export const GIT_BRANCH_CACHE_TTL_MS = 5_000;
const GIT_TIMEOUT_MS = 1_000;

interface CacheEntry {
  branch: string | null;
  checkedAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function detectGitBranch(
  workspaceRoot: string,
  overrides: Partial<GitBranchDependencies> = {},
): Promise<string | null> {
  const now = overrides.now ?? Date.now;
  const cached = cache.get(workspaceRoot);
  if (cached && now() - cached.checkedAt < GIT_BRANCH_CACHE_TTL_MS) return cached.branch;

  const run = overrides.run ?? runGit;
  let branch: string | null = null;
  try {
    // symbolic-ref reports the branch even in a repository with no commits,
    // where `rev-parse --abbrev-ref HEAD` fails; it exits non-zero on a
    // detached HEAD.
    const result = await run(["git", "-C", workspaceRoot, "symbolic-ref", "--short", "-q", "HEAD"]);
    const value = result.stdout.trim();
    branch = result.code === 0 && value && value !== "HEAD" ? value : null;
  } catch {
    branch = null;
  }
  cache.set(workspaceRoot, { branch, checkedAt: now() });
  return branch;
}

export function clearGitBranchCache(): void {
  cache.clear();
}

async function runGit(command: string[]): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
  try {
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { code, stdout };
  } finally {
    clearTimeout(timer);
  }
}

/// How far the branch is from the one it tracks (usually on GitHub): commits
/// to push and commits to pull. Null without an upstream, outside a
/// repository, or when git fails; cached like the branch.
export interface GitSync { ahead: number; behind: number }
const syncCache = new Map<string, { sync: GitSync | null; checkedAt: number }>();

export async function detectGitSync(
  workspaceRoot: string,
  overrides: Partial<GitBranchDependencies> = {},
): Promise<GitSync | null> {
  const now = overrides.now ?? Date.now;
  const cached = syncCache.get(workspaceRoot);
  if (cached && now() - cached.checkedAt < GIT_BRANCH_CACHE_TTL_MS) return cached.sync;
  const run = overrides.run ?? runGit;
  let sync: GitSync | null = null;
  try {
    // "<behind>\t<ahead>": the left side is the upstream, the right is HEAD.
    const result = await run(["git", "-C", workspaceRoot, "rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    const match = /^(\d+)\s+(\d+)$/.exec(result.stdout.trim());
    if (result.code === 0 && match) sync = { behind: Number(match[1]), ahead: Number(match[2]) };
  } catch {
    sync = null;
  }
  syncCache.set(workspaceRoot, { sync, checkedAt: now() });
  return sync;
}

export function clearGitSyncCache(): void {
  syncCache.clear();
}
