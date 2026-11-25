import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveFixes } from "../src/drive-fixes.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b" });
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: process.env });

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "thread-orphan-"))); roots.push(root);
  const workspace = join(root, "repo");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.ts"), "export const a = 1;\n");
  git(workspace, "init", "-q", "-b", "main"); git(workspace, "add", "-A"); git(workspace, "commit", "-qm", "init");
  const turns = new Set<string>();
  // The thread's turn never settles, as when its chat disappears under it.
  const host = {
    startSession: () => "child", startTurn: () => { turns.add("turn"); return { turnId: "turn", done: new Promise<void>(() => {}) }; },
    turn: (id: string) => turns.has(id) ? { id, status: "running", responseText: "" } : null,
    cancel: () => { throw new Error("Turn not found"); },
    archive: () => {}, commands: () => [], activity: () => ({ steps: 0, last: null }),
  };
  const fixes = new DriveFixes(join(root, "data", "drive-fixes.json"), join(root, "worktrees"), host as never);
  return { workspace, fixes, lose: () => turns.clear() };
}

test("a running thread whose chat is gone stops, and can be deleted", async () => {
  const { workspace, fixes, lose } = setup();
  const fix = await fixes.startThread(workspace, "parent", { title: "Mock up", brief: "x", files: ["a.ts"] });
  expect(fix.status).toBe("running");
  lose();
  const [listed] = fixes.threads("parent");
  expect(listed!.status).toBe("failed");
  expect(listed!.error).toContain("chat is gone");
  expect((await fixes.act(fix.id, "discard")).status).toBe("discarded");
});

test("a stopped thread whose chat is gone stops naming it, and can be deleted", async () => {
  const { workspace, fixes, lose } = setup();
  const fix = await fixes.startThread(workspace, "parent", { title: "Mock up", brief: "x", files: ["a.ts"] });
  // It had stopped on its own before its chat went.
  Object.assign(fixes.get(fix.id)!, { status: "failed", error: "The agent made no changes." });
  lose();
  const [listed] = fixes.threads("parent");
  expect(listed!.status).toBe("failed");
  expect(listed!.sessionId).toBeNull();
  expect((await fixes.act(fix.id, "discard")).status).toBe("discarded");
  expect(fixes.threads("parent").map((item) => item.status)).toEqual(["discarded"]);
});

test("a stopped thread whose chat is gone can be tried again from scratch", async () => {
  const { workspace, fixes, lose } = setup();
  const fix = await fixes.startThread(workspace, "parent", { title: "Mock up", brief: "x", files: ["a.ts"] });
  Object.assign(fixes.get(fix.id)!, { status: "failed" });
  lose();
  fixes.threads("parent");
  const again = await fixes.act(fix.id, "retry");
  expect(again.status).toBe("running");
  expect(again.sessionId).toBe("child");
});

test("deleting a running thread whose chat vanished doesn't hang", async () => {
  const { workspace, fixes, lose } = setup();
  const fix = await fixes.startThread(workspace, "parent", { title: "Mock up", brief: "x", files: ["a.ts"] });
  lose();
  const started = Date.now();
  expect((await fixes.act(fix.id, "discard")).status).toBe("discarded");
  expect(Date.now() - started).toBeLessThan(5_000);
});
