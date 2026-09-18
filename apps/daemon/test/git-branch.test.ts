import { afterEach, describe, expect, test } from "bun:test";
import {
  clearGitBranchCache,
  detectGitBranch,
  GIT_BRANCH_CACHE_TTL_MS,
  type GitBranchDependencies,
} from "../src/git-branch.ts";

afterEach(() => {
  clearGitBranchCache();
});

interface FakeState {
  deps: Partial<GitBranchDependencies>;
  calls: string[][];
  code: number;
  stdout: string;
  now: number;
}

function fake(overrides: Partial<FakeState> = {}): FakeState {
  const state: FakeState = {
    calls: [],
    code: 0,
    stdout: "main\n",
    now: 1_000,
    deps: {},
    ...overrides,
  };
  state.deps = {
    run: async (command) => {
      state.calls.push(command);
      return { code: state.code, stdout: state.stdout };
    },
    now: () => state.now,
  };
  return state;
}

describe("detectGitBranch", () => {
  test("returns the branch reported by git", async () => {
    const state = fake({ stdout: "feature/work\n" });
    expect(await detectGitBranch("/workspace", state.deps)).toBe("feature/work");
    expect(state.calls[0]).toEqual(["git", "-C", "/workspace", "symbolic-ref", "--short", "-q", "HEAD"]);
  });

  test("returns null for detached HEADs, failures, and empty output", async () => {
    expect(await detectGitBranch("/a", fake({ code: 1, stdout: "" }).deps)).toBeNull();
    expect(await detectGitBranch("/b", fake({ code: 128, stdout: "" }).deps)).toBeNull();
    expect(await detectGitBranch("/c", fake({ stdout: "\n" }).deps)).toBeNull();
    expect(await detectGitBranch("/d", fake({ stdout: "HEAD\n" }).deps)).toBeNull();
  });

  test("returns null when git cannot be spawned", async () => {
    const deps: Partial<GitBranchDependencies> = {
      run: async () => {
        throw new Error("ENOENT");
      },
      now: () => 0,
    };
    expect(await detectGitBranch("/workspace", deps)).toBeNull();
  });

  test("caches within the TTL and refreshes after it", async () => {
    const state = fake({ stdout: "main\n" });
    await detectGitBranch("/workspace", state.deps);
    await detectGitBranch("/workspace", state.deps);
    expect(state.calls).toHaveLength(1);

    state.now += GIT_BRANCH_CACHE_TTL_MS + 1;
    state.stdout = "next\n";
    expect(await detectGitBranch("/workspace", state.deps)).toBe("next");
    expect(state.calls).toHaveLength(2);
  });
});
