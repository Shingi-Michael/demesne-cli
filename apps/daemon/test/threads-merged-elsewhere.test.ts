import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveFix } from "@demesne/protocol";
import { createDaemonApp } from "../src/app.ts";
import { DriveFixes, type FixHost } from "../src/drive-fixes.ts";
import type { TurnProcessor } from "../src/processor.ts";

// A ready thread whose work was merged outside Demesne stops offering Merge.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b" });
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: process.env });

async function until(read: () => Promise<boolean>) {
  for (let i = 0; i < 600; i++) { if (await read()) return; await Bun.sleep(25); }
  throw new Error("never got there");
}

test("a thread merged or squashed onto your branch by hand turns Merged; one that wasn't keeps Merge", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "threads-elsewhere-"))); roots.push(root);
  const workspace = join(root, "repo");
  mkdirSync(join(workspace, "src"), { recursive: true });
  for (const name of ["a", "b", "c"]) writeFileSync(join(workspace, "src", `${name}.ts`), `export const ${name} = 1;\n`);
  git(workspace, "init", "-q", "-b", "main"); git(workspace, "add", "-A"); git(workspace, "commit", "-qm", "init");
  const reports: string[] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "coder", async listModels() { return []; }, async *stream(messages) {
    const last = messages.at(-1)!, said = String(last.content);
    if (last.role === "user" && said.startsWith("Thread report: ")) { reports.push(said); yield { type: "text_delta", delta: "Noted." }; yield { type: "finish", reason: "stop" }; return; }
    const job = /Your job: Bump (\w)/.exec(said)?.[1];
    if (last.role === "user" && job) {
      yield { type: "tool_call_delta", index: 0, idDelta: `w-${job}`, nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: `src/${job}.ts`, content: `export const ${job} = 2;\n` }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (last.role === "user" && said === "split it") {
      yield { type: "tool_call_delta", index: 0, idDelta: "t", nameDelta: "start_threads", argumentsDelta: JSON.stringify({ threads: ["a", "b", "c"].map((name) => ({ title: `Bump ${name}`, brief: `Set ${name} to 2.`, files: [`src/${name}.ts`] })) }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "Done." }; yield { type: "finish", reason: "stop" };
  } };
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor, worktreeRoot: join(root, "worktrees") });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => (await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init })).json() as Promise<any>;
  try {
    const { session } = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "Orchestrator", workspacePath: workspace, trustWorkspace: true }) });
    await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "split it", permissionMode: "ask" }) });
    await until(async () => reports.length === 3);
    const threads = async () => (await call(`/v1/threads?from=${session.id}`)).fixes as DriveFix[];
    const [a, b, c] = await threads();
    expect([a!.status, b!.status, c!.status]).toEqual(["ready", "ready", "ready"]);
    // Merged by hand, and squashed by hand, outside Demesne.
    expect(git(workspace, "merge", "-q", "--no-edit", a!.branch).exitCode).toBe(0);
    expect(git(workspace, "merge", "-q", "--squash", b!.branch).exitCode).toBe(0);
    expect(git(workspace, "commit", "-qm", "b, squashed").exitCode).toBe(0);
    await until(async () => (await threads()).filter((fix) => fix.status === "applied").length === 2);
    const after = await threads();
    expect(after.map((fix) => [fix.status, fix.mergedElsewhere])).toEqual([["applied", "branch"], ["applied", "branch"], ["ready", undefined]]);
    expect(existsSync(a!.path)).toBe(false);
    expect(git(workspace, "rev-parse", "--verify", "--quiet", `refs/heads/${b!.branch}`).exitCode).not.toBe(0);
    expect(existsSync(c!.path)).toBe(true);
  } finally { server.stop(true); await app.close(); }
}, 40_000);

test("a pushed thread whose pull request was merged on GitHub turns Merged, and GitHub is asked once a minute", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "threads-elsewhere-"))); roots.push(root);
  const state = join(root, "fixes.json");
  const fix: DriveFix = { id: "f1", workspace: "/repo", title: "Bump a", signals: [], branch: "thread/bump-a", path: join(root, "gone"), base: "base0", sessionId: "s1", turnId: "t1",
    status: "ready", startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(), from: "orch", thread: { brief: "Set a to 2.", files: ["src/a.ts"] } };
  writeFileSync(state, JSON.stringify([fix]));
  let now = 1_000_000, merged = false, pushed = false;
  const asked: string[] = [];
  const run = async (argv: string[]) => {
    const line = argv.join(" ");
    const ok = (out = "") => ({ ok: true, out, err: "" }), no = { ok: false, out: "", err: "" };
    if (line.includes("refs/heads/thread/bump-a")) return ok("tip1");
    if (line.includes("refs/remotes/origin/thread/bump-a")) return pushed ? ok("tip1") : no;
    if (argv[1] === "merge-base") return no;
    if (argv[1] === "cherry") return ok("+ tip1");
    if (argv[1] === "diff") return ok("a patch");
    if (argv[1] === "apply") return no;
    if (argv[0] === "gh") { asked.push(line); return ok(merged ? '[{"url":"https://github.com/o/r/pull/7"}]' : "[]"); }
    return ok();
  };
  const fixes = new DriveFixes(state, join(root, "worktrees"), { activity: () => ({ steps: 0, last: null }) } as unknown as FixHost, run, () => now);
  await fixes.noticeMerged("/repo");
  expect(asked).toHaveLength(0); // never pushed: GitHub isn't asked
  pushed = true; now += 6_000;
  await fixes.noticeMerged("/repo");
  expect(asked).toHaveLength(1);
  expect(fixes.threads("orch")[0]!.status).toBe("ready");
  merged = true; now += 6_000;
  await fixes.noticeMerged("/repo");
  expect(asked).toHaveLength(1); // not again inside the minute
  now += 60_000;
  await fixes.noticeMerged("/repo");
  expect(asked).toHaveLength(2);
  const [done] = fixes.threads("orch");
  expect([done!.status, done!.mergedElsewhere]).toEqual(["applied", "github"]);
});
