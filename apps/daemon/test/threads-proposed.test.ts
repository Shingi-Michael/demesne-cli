import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveFix } from "@demesne/protocol";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";

// Threads proposed first (the person starts each one), and Try again for a
// thread that stopped.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b" });
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: process.env });

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "threads-proposed-"))); roots.push(root);
  const workspace = join(root, "repo");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(workspace, "src", "b.ts"), "export const b = 1;\n");
  git(workspace, "init", "-q", "-b", "main"); git(workspace, "add", "-A"); git(workspace, "commit", "-qm", "init");
  return { root, workspace };
}

async function serve(root: string, stream: TurnProcessor["stream"]) {
  const processor: TurnProcessor = { providerId: "test", modelId: "coder", async listModels() { return []; }, stream };
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor, worktreeRoot: join(root, "worktrees") });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init });
    return { status: response.status, body: await response.json() as any };
  };
  const close = async () => { server.stop(true); await app.close(); };
  return { call, close };
}

const tool = (id: string, name: string, input: unknown) => [
  { type: "tool_call_delta" as const, index: 0, idDelta: id, nameDelta: name, argumentsDelta: JSON.stringify(input) },
  { type: "finish" as const, reason: "tool_calls" as const },
];
const say = (text: string) => [{ type: "text_delta" as const, delta: text }, { type: "finish" as const, reason: "stop" as const }];
async function until(read: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) { if (await read()) return; await Bun.sleep(25); }
  throw new Error("never got there");
}
const worktrees = (root: string) => existsSync(join(root, "worktrees")) ? readdirSync(join(root, "worktrees")) : [];
const branches = (workspace: string) => git(workspace, "branch", "--list", "thread/*").stdout.toString().trim();

test("threads proposed first: nothing runs until the person starts one, and a new split replaces the rest", async () => {
  const { root, workspace } = repo();
  const results: string[] = [];
  let reports = 0;
  const stream: TurnProcessor["stream"] = async function* (messages) {
    const last = messages.at(-1)!, said = String(last.content), first = String(messages.find((message) => message.role === "user")?.content);
    if (last.role === "user" && said.startsWith("Thread report: ")) { reports++; yield* say("Noted."); return; }
    if (first.includes("You're one of the threads")) {
      if (last.role === "tool") { yield* say("Done."); return; }
      const file = first.includes("Your job: Bump a") ? "a" : first.includes("Your job: Bump b") ? "b" : "c";
      yield* tool(`w-${file}`, "write_file", { path: `src/${file}.ts`, content: `export const ${file} = 2;\n` }); return;
    }
    if (last.role === "tool") { results.push(said); yield* say("Nothing has started yet."); return; }
    if (said === "propose it") { yield* tool("p1", "start_threads", { propose: true, threads: [{ title: "Bump a", brief: "Set a to 2.", files: ["src/a.ts"] }, { title: "Bump b", brief: "Set b to 2.", files: ["src/b.ts"] }] }); return; }
    if (said === "c instead of b") { yield* tool("p2", "start_threads", { propose: true, threads: [{ title: "Add c", brief: "Add src/c.ts.", files: ["src/c.ts"] }] }); return; }
    if (said === "go ahead") { yield* tool("p3", "start_threads", { threads: [{ title: "Add c", brief: "Add src/c.ts.", files: ["src/c.ts"] }] }); return; }
    yield* say("Done.");
  };
  let { call, close } = await serve(root, stream);
  try {
    const { body: { session } } = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "Orchestrator", workspacePath: workspace, trustWorkspace: true }) });
    const threads = async (): Promise<DriveFix[]> => (await call(`/v1/threads?from=${session.id}`)).body.fixes;
    const turn = async (content: string, tools: number) => {
      await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content, permissionMode: "ask" }) });
      await until(async () => results.length === tools);
    };
    await turn("propose it", 1);
    expect(results[0]).toContain("Proposed 2 threads. Nothing has started");
    let list = await threads();
    expect(list.map((fix) => [fix.title, fix.status, fix.thread?.proposed, fix.sessionId])).toEqual([["Bump a", "starting", true, null], ["Bump b", "starting", true, null]]);
    // A proposal holds nothing: no worktree, no branch, no chat.
    expect(worktrees(root)).toEqual([]);
    expect(branches(workspace)).toBe("");
    // It is still there after the daemon restarts, and still not started.
    await close();
    ({ call, close } = await serve(root, stream));
    list = await threads();
    expect(list.map((fix) => [fix.status, fix.thread?.proposed])).toEqual([["starting", true], ["starting", true]]);
    // Only a proposed thread starts; the person starts this one.
    expect((await call(`/v1/drive/fixes/${list[0]!.id}/retry`, { method: "POST" })).status).toBe(409);
    const started = await call(`/v1/drive/fixes/${list[0]!.id}/start`, { method: "POST" });
    expect(started.status).toBe(200);
    expect(started.body.fix.thread.proposed).toBeUndefined();
    await until(async () => (await threads())[0]!.status === "ready");
    expect((await call(`/v1/drive/fixes/${list[0]!.id}/start`, { method: "POST" })).status).toBe(409);
    expect((await threads())[1]!.thread?.proposed).toBe(true);
    // A new proposed split replaces the proposals nobody started, and leaves the started one.
    await turn("c instead of b", 2);
    expect(results[1]).toContain("in place of 1 proposed before");
    expect((await threads()).map((fix) => [fix.title, fix.thread?.proposed ?? false])).toEqual([["Bump a", false], ["Add c", true]]);
    // Told in words to go ahead, the orchestrator starts the same title: the proposal becomes the thread.
    await turn("go ahead", 3);
    expect(results[2]).toContain("Started 1 thread");
    await until(async () => (await threads()).every((fix) => fix.status === "ready"));
    expect((await threads()).map((fix) => fix.title)).toEqual(["Bump a", "Add c"]);
    // Each one reported back, so nothing is still in flight.
    await until(async () => reports === 2);
    // A proposal is deleted like any thread.
    await turn("propose it", 4);
    const again = (await threads()).filter((fix) => fix.thread?.proposed);
    expect(again.length).toBe(2);
    expect((await call(`/v1/drive/fixes/${again[1]!.id}/discard`, { method: "POST" })).body.fix.status).toBe("discarded");
  } finally { await close(); }
}, 40_000);

test("a thread built on a proposed one waits for it to be started", async () => {
  const { root, workspace } = repo();
  let reports = 0;
  const { call, close } = await serve(root, async function* (messages) {
    const last = messages.at(-1)!, said = String(last.content), first = String(messages.find((message) => message.role === "user")?.content);
    if (last.role === "user" && said.startsWith("Thread report: ")) { reports++; yield* say("Noted."); return; }
    if (first.includes("You're one of the threads")) {
      if (last.role === "tool") { yield* say("Done."); return; }
      yield* tool("w", "write_file", { path: "src/a.ts", content: first.includes("Your job: Second") ? "export const a = 3;\n" : "export const a = 2;\n" }); return;
    }
    if (last.role === "tool") { yield* say("Nothing has started yet."); return; }
    yield* tool("p", "start_threads", { propose: true, threads: [{ title: "First", brief: "Set a to 2.", files: ["src/a.ts"] }, { title: "Second", brief: "Then set a to 3.", files: ["src/a.ts"], after: "First" }] });
  });
  try {
    const { body: { session } } = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "Orchestrator", workspacePath: workspace, trustWorkspace: true }) });
    const threads = async (): Promise<DriveFix[]> => (await call(`/v1/threads?from=${session.id}`)).body.fixes;
    await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "propose it", permissionMode: "ask" }) });
    await until(async () => (await threads()).length === 2);
    const [first, second] = await threads();
    const early = await call(`/v1/drive/fixes/${second!.id}/start`, { method: "POST" });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toContain('Start "First" first');
    await call(`/v1/drive/fixes/${first!.id}/start`, { method: "POST" });
    expect((await call(`/v1/drive/fixes/${second!.id}/start`, { method: "POST" })).status).toBe(200);
    await until(async () => (await threads()).every((fix) => fix.status === "ready"));
    expect(readFileSync(join((await threads())[1]!.path, "src", "a.ts"), "utf8")).toBe("export const a = 3;\n");
    await until(async () => reports === 2);
  } finally { await close(); }
}, 30_000);

test("Try again: a thread that stopped picks up in its own chat and worktree", async () => {
  const { root, workspace } = repo();
  let tries = 0, resumed = "", reports = 0;
  const { call, close } = await serve(root, async function* (messages) {
    const last = messages.at(-1)!, said = String(last.content), first = String(messages.find((message) => message.role === "user")?.content);
    if (last.role === "user" && said.startsWith("Thread report: ")) { reports++; yield* say("Noted."); return; }
    if (first.includes("You're one of the threads")) {
      if (last.role === "tool") { yield* say("Set a to 2."); return; }
      if (tries++ === 0) throw new Error("the provider dropped the connection");
      resumed = said;
      yield* tool("w", "write_file", { path: "src/a.ts", content: "export const a = 2;\n" }); return;
    }
    if (last.role === "tool") { yield* say("On it."); return; }
    yield* tool("t", "start_threads", { threads: [{ title: "Bump a", brief: "Set a to 2.", files: ["src/a.ts"] }] });
  });
  try {
    const { body: { session } } = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "Orchestrator", workspacePath: workspace, trustWorkspace: true }) });
    const thread = async (): Promise<DriveFix | undefined> => (await call(`/v1/threads?from=${session.id}`)).body.fixes[0];
    await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "split it", permissionMode: "ask" }) });
    await until(async () => (await thread())?.status === "failed");
    const stopped = (await thread())!;
    expect(stopped.error).toBeTruthy();
    // Its worktree and chat are still there: nothing was lost.
    expect(existsSync(stopped.path)).toBe(true);
    const retried = await call(`/v1/drive/fixes/${stopped.id}/retry`, { method: "POST" });
    expect(retried.status).toBe(200);
    expect(retried.body.fix.status).toBe("running");
    expect(retried.body.fix.error).toBeUndefined();
    expect(retried.body.fix.sessionId).toBe(stopped.sessionId);
    await until(async () => (await thread())?.status === "ready");
    expect(resumed).toContain("Your last turn stopped before the job was done");
    const ready = (await thread())!;
    expect(ready.diff?.paths).toEqual(["src/a.ts"]);
    // Only a stopped thread can be tried again.
    expect((await call(`/v1/drive/fixes/${ready.id}/retry`, { method: "POST" })).status).toBe(409);
    // It reported twice: once stopped, once ready.
    await until(async () => reports === 2);
  } finally { await close(); }
}, 30_000);
