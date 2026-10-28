import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitIn, gitStep, repoSnapshot, stepDirectory } from "../src/repo-flow.ts";

describe("gitStep", () => {
  test("finds commits and merges, with -C and -a", () => {
    expect(gitStep(["git", "commit", "-m", "x"])).toEqual({ kind: "commit", all: false, dir: null });
    expect(gitStep(["git", "commit", "-am", "x"])).toEqual({ kind: "commit", all: true, dir: null });
    expect(gitStep(["/usr/bin/git", "-C", "sub", "commit", "--all", "-m", "x"])).toEqual({ kind: "commit", all: true, dir: "sub" });
    expect(gitStep(["git", "-c", "user.name=x", "merge", "--no-ff", "feature"])).toEqual({ kind: "merge", all: false, dir: null });
    expect(stepDirectory("/repo", { kind: "commit", all: false, dir: "sub" })).toBe("/repo/sub");
  });
  test("ignores everything else", () => {
    expect(gitStep(["git", "status"])).toBeNull();
    expect(gitStep(["git", "merge", "--abort"])).toBeNull();
    expect(gitStep(["bun", "test"])).toBeNull();
    expect(gitStep(["git", "log", "--grep", "commit"])).toBeNull();
  });
});

describe("repoSnapshot", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  async function repo() {
    const dir = mkdtempSync(join(tmpdir(), "repo-flow-"));
    dirs.push(dir);
    const run = async (...args: string[]) => {
      const child = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
      if (await child.exited !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(child.stderr).text()}`);
    };
    await run("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "one\n");
    await run("add", "-A"); await run("commit", "-qm", "First (#1)");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    await run("commit", "-qam", "Second (#2)");
    return { dir, run };
  }

  test("a commit on a branch: the lane gains a commit and the files go", async () => {
    const { dir, run } = await repo();
    await run("switch", "-qc", "feature");
    writeFileSync(join(dir, "b.txt"), "x\ny\nz\n");
    writeFileSync(join(dir, "a.txt"), "one\n");
    await run("add", "-A");
    const git = gitIn(dir);
    const before = (await repoSnapshot(git))!;
    expect(before.main).toBe("main");
    expect(before.head).toBe("feature");
    expect(before.commits.map((commit) => commit.subject)).toEqual(["First (#1)", "Second (#2)"]);
    expect(before.lanes).toEqual([]);
    expect(before.files).toEqual([{ path: "b.txt", added: 3, removed: 0 }, { path: "a.txt", added: 0, removed: 1 }]);
    await run("commit", "-qm", "Add b");
    const after = (await repoSnapshot(git))!;
    expect(after.tip).not.toBe(before.tip);
    expect(after.lanes).toHaveLength(1);
    expect(after.lanes[0]).toMatchObject({ name: "feature", base: before.commits.at(-1)!.sha, worktree: false });
    expect(after.lanes[0]!.commits.map((commit) => commit.subject)).toEqual(["Add b"]);
    expect(after.files).toEqual([]);
  });

  test("a merge: the lane leaves and main gains a merge commit", async () => {
    const { dir, run } = await repo();
    await run("switch", "-qc", "feature");
    writeFileSync(join(dir, "b.txt"), "x\n");
    await run("add", "-A"); await run("commit", "-qm", "Add b");
    await run("switch", "-q", "main");
    const git = gitIn(dir);
    const before = (await repoSnapshot(git))!;
    expect(before.lanes.map((lane) => lane.name)).toEqual(["feature"]);
    await run("merge", "-q", "--no-ff", "-m", "Merge feature (#3)", "feature");
    const after = (await repoSnapshot(git))!;
    expect(after.lanes).toEqual([]);
    expect(after.commits.at(-1)).toMatchObject({ subject: "Merge feature (#3)", merge: true });
  });

  test("no repository, no tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-flow-none-"));
    dirs.push(dir);
    expect(await repoSnapshot(gitIn(dir))).toBeNull();
  });
});
