import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseThreadReport, type DriveFix } from "@demesne/protocol";
import { createDaemonApp } from "../src/app.ts";
import { overlappingClaims } from "../src/threads.ts";
import type { TurnProcessor } from "../src/processor.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b" });
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: process.env });

test("claims overlap when two threads name the same path or one holds the other", () => {
  expect(overlappingClaims([{ title: "A", files: ["src/a.ts"] }, { title: "B", files: ["src/b.ts"] }])).toBeNull();
  expect(overlappingClaims([{ title: "A", files: ["./src/a.ts"] }, { title: "B", files: ["src/a.ts"] }])).toContain("both claim src/a.ts");
  expect(overlappingClaims([{ title: "A", files: ["docs/"] }, { title: "B", files: ["docs/assets/x.png"] }])).toContain("docs and docs/assets/x.png");
});

test("an orchestrator chat splits work into threads that run side by side, report back, and merge only when asked", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "threads-"))); roots.push(root);
  const workspace = join(root, "repo");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(workspace, "src", "b.ts"), "export const b = 1;\n");
  git(workspace, "init", "-q", "-b", "main"); git(workspace, "add", "-A"); git(workspace, "commit", "-qm", "init");

  const reports: string[] = [], threadTools: string[][] = [], told: string[] = [], orchestrated: string[][] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "coder", async listModels() { return []; },
    async *stream(messages, tools) {
      const last = messages.at(-1)!;
      const said = String(last.content);
      if (last.role === "user" && said.startsWith("Thread report: ")) { reports.push(said); yield { type: "text_delta" as const, delta: "Noted." }; yield { type: "finish" as const, reason: "stop" }; return; }
      if (last.role === "user" && said.includes("You're one of the threads")) {
        threadTools.push((tools ?? []).map((tool) => tool.name));
        const file = said.includes("Bump a") ? "src/a.ts" : "src/b.ts";
        yield { type: "tool_call_delta" as const, index: 0, idDelta: "w", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: file, content: `export const ${file.includes("a.ts") ? "a" : "b"} = 2;\n` }) };
        yield { type: "finish" as const, reason: "tool_calls" }; return;
      }
      if (last.role === "user" && said === "what can you do here") {
        orchestrated.push((tools ?? []).map((tool) => tool.name));
        yield { type: "text_delta" as const, delta: "Plan and run threads." }; yield { type: "finish" as const, reason: "stop" }; return;
      }
      if (last.role === "user" && said === "tell bump a to use 3") {
        yield { type: "tool_call_delta" as const, index: 0, idDelta: "m", nameDelta: "message_thread", argumentsDelta: JSON.stringify({ thread: "bump a", text: "Use 3, not 2." }) };
        yield { type: "finish" as const, reason: "tool_calls" }; return;
      }
      if (last.role === "user" && said === "Use 3, not 2.") {
        told.push(said);
        yield { type: "tool_call_delta" as const, index: 0, idDelta: "w3", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: "src/a.ts", content: "export const a = 3;\n" }) };
        yield { type: "finish" as const, reason: "tool_calls" }; return;
      }
      if (last.role === "user" && said === "split it") {
        yield { type: "tool_call_delta" as const, index: 0, idDelta: "t", nameDelta: "start_threads", argumentsDelta: JSON.stringify({ threads: [
          { title: "Bump a", brief: "Set a to 2.", files: ["src/a.ts"] },
          { title: "Bump b", brief: "Set b to 2.", files: ["src/b.ts"] },
        ] }) };
        yield { type: "finish" as const, reason: "tool_calls" }; return;
      }
      yield { type: "text_delta" as const, delta: "Done." };
      yield { type: "finish" as const, reason: "stop" };
    } };
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor, worktreeRoot: join(root, "worktrees") });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const { body: { session } } = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "Orchestrator", workspacePath: workspace, trustWorkspace: true }) });
    await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "split it", permissionMode: "ask" }) });
    let threads: DriveFix[] = [];
    for (let i = 0; i < 400 && (threads.length < 2 || threads.some((fix) => fix.status !== "ready") || reports.length < 2); i++) {
      threads = (await call(`/v1/threads?from=${session.id}`)).body.fixes;
      await Bun.sleep(25);
    }
    expect(threads.map((fix) => [fix.title, fix.status, fix.thread?.files])).toEqual([["Bump a", "ready", ["src/a.ts"]], ["Bump b", "ready", ["src/b.ts"]]]);
    expect(threads[0]!.branch).toMatch(/^thread\/bump-a-/);
    // A thread doesn't start threads of its own (nor see Heartbeat).
    expect(threadTools.length).toBe(2);
    for (const names of threadTools) { expect(names).toContain("write_file"); expect(names).not.toContain("start_threads"); }
    // Drive's own list doesn't show them.
    expect((await call(`/v1/drive/fixes?workspace=${encodeURIComponent(workspace)}`)).body.fixes).toEqual([]);
    // Each reported back to the orchestrator; the last one says none are left.
    const parsed = reports.map((report) => parseThreadReport(report)!);
    expect(parsed.map((report) => report.status)).toEqual(["ready", "ready"]);
    expect(Math.min(...parsed.map((report) => report.working))).toBe(0);
    // The orchestrator passes words to a thread; the thread does the work.
    const { body: { turn: ask } } = await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "tell bump a to use 3", permissionMode: "ask" }) });
    expect(ask).toBeTruthy();
    const thread = join(threads[0]!.path, "src", "a.ts");
    for (let i = 0; i < 400 && !(existsSync(thread) && readFileSync(thread, "utf8") === "export const a = 3;\n"); i++) await Bun.sleep(25);
    expect(told).toEqual(["Use 3, not 2."]);
    for (let i = 0; i < 400 && (await call(`/v1/sessions/${threads[0]!.sessionId}`)).body.session.turns.some((turn: { status: string }) => turn.status === "running" || turn.status === "queued"); i++) await Bun.sleep(25);
    // Orchestrate mode: the chat reads and runs threads, never edits or runs commands.
    expect((await call(`/v1/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ orchestrate: true }) })).body.session.orchestrate).toBe(true);
    await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "what can you do here", permissionMode: "ask" }) });
    for (let i = 0; i < 400 && !orchestrated.length; i++) await Bun.sleep(25);
    expect(orchestrated[0]).toContain("start_threads");
    expect(orchestrated[0]).toContain("message_thread");
    expect(orchestrated[0]).toContain("read_file");
    for (const name of ["write_file", "edit_file", "run_command"]) expect(orchestrated[0]).not.toContain(name);
    // Nothing reached the checkout until the person merges.
    expect(readFileSync(join(workspace, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    for (const fix of threads) expect((await call(`/v1/drive/fixes/${fix.id}/apply`, { method: "POST" })).body.fix.status).toBe("applied");
    expect(readFileSync(join(workspace, "src", "a.ts"), "utf8")).toBe("export const a = 3;\n");
    expect(readFileSync(join(workspace, "src", "b.ts"), "utf8")).toBe("export const b = 2;\n");
  } finally {
    server.stop(true);
    await app.close();
  }
}, 30_000);
