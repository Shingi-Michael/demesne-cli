import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeInspection } from "../src/inspection-commands.ts";
import { ToolRegistry } from "../src/tools.ts";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "inspection-"))); roots.push(root); return root; };

test("inspection commands map to the equivalent built-in tool, point at it, or run normally", () => {
  const route = (argv: string[], cwd?: string) => routeInspection({ argv, ...(cwd ? { cwd } : {}) });
  expect(route(["ls", "-la", "src"])).toMatchObject({ kind: "tool", name: "list_files", input: { path: "src" } });
  expect(route(["ls"], "apps/daemon")).toMatchObject({ name: "list_files", input: { path: "apps/daemon" } });
  expect(route(["cat", "README.md"])).toMatchObject({ name: "read_file", input: { path: "README.md" } });
  expect(route(["cat", "a.ts", "b.ts"])).toMatchObject({ name: "read_files", input: { files: [{ path: "a.ts" }, { path: "b.ts" }] } });
  expect(route(["head", "-n", "40", "src/app.ts"])).toMatchObject({ name: "read_file", input: { path: "src/app.ts", offset: 1, limit: 40 } });
  expect(route(["head", "-25", "x.ts"])).toMatchObject({ input: { limit: 25 } });
  expect(route(["sed", "-n", "120,180p", "src/engine.ts"])).toMatchObject({ name: "read_file", input: { offset: 120, limit: 61 } });
  expect(route(["grep", "-rn", "routeInspection", "apps/daemon/src"])).toMatchObject({ name: "search_files", input: { query: "routeInspection", path: "apps/daemon/src" } });
  expect(route(["grep", "-rn", "--include=*.ts", "app.ts", "."])).toMatchObject({ input: { query: "app.ts", include: "*.ts", path: "." } });
  expect(route(["rg", "-F", "a|b"])).toMatchObject({ input: { query: "a|b" } });
  expect(route(["find", "apps", "-name", "*.test.ts", "-type", "f"])).toMatchObject({ name: "list_files", input: { path: "apps", pattern: "**/*.test.ts" } });
  expect(route(["tail", "-n", "20", "log.txt"])).toMatchObject({ kind: "pointer" });
  expect(route(["wc", "-l", "src/app.ts"])).toMatchObject({ kind: "pointer" });
  // Not equivalent: run as a normal command.
  for (const argv of [["grep", "-E", "a|b", "."], ["grep", "-rn", "foo.*bar", "."], ["grep", "-l", "x", "."], ["grep", "x", "a", "b"], ["ls", "a", "b"], ["head", "a", "b"],
    ["find", ".", "-mtime", "-1"], ["find", ".", "-name", "*.ts", "-exec", "rm", "{}", ";"], ["sed", "-i", "s/a/b/", "x"], ["cat"], ["sh", "-c", "grep x . | wc -l"], ["bun", "test"]])
    expect(route(argv)).toBeNull();
  expect(routeInspection({ argv: ["ls"], background: true })).toBeNull();
});

test("git_history reads logs, revisions, blame and diffs, and refuses odd revisions and protected files", async () => {
  const root = scratch();
  const run = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@local", "-c", "user.name=Tester", ...args], { cwd: root });
  run("init", "-q", "-b", "main");
  writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
  run("add", "."); run("commit", "-q", "-m", "first");
  writeFileSync(join(root, "app.ts"), "export const a = 2;\nexport const b = 3;\n");
  run("add", "."); run("commit", "-q", "-m", "second");
  const tool = new ToolRegistry().get("git_history")!;
  const context = { workspaceRoot: root, signal: new AbortController().signal };
  const call = async (input: Record<string, unknown>) => JSON.parse(await tool.execute(input, context)).output as string;
  expect(tool.permission({ action: "log" })).toBeNull();
  const log = await call({ action: "log" });
  expect(log).toContain("second"); expect(log.indexOf("second")).toBeLessThan(log.indexOf("first"));
  expect(await call({ action: "show", revision: "HEAD~1", path: "app.ts" })).toBe("export const a = 1;\n");
  expect(await call({ action: "show" })).toContain("+export const b = 3;");
  expect(await call({ action: "blame", path: "app.ts", start: 2, end: 2 })).toContain("Tester");
  expect(await call({ action: "diff", base: "HEAD~1" })).toContain("-export const a = 1;");
  await expect(tool.execute({ action: "log", revision: "--output=/tmp/x" }, context)).rejects.toThrow(/not a revision/);
  await expect(tool.execute({ action: "show", path: ".env" }, context)).rejects.toThrow(/protected/);
  await expect(tool.execute({ action: "diff" }, context)).rejects.toThrow(/needs a base/);
});

test("a turn's grep through run_command is answered by search_files without asking", async () => {
  const root = scratch(), workspace = join(root, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "app.ts"), "export const needle = true;\n");
  const results: string[] = [];
  let round = 0;
  const processor: TurnProcessor = { providerId: "test", modelId: "local", async listModels() { return []; },
    async *stream(messages) {
      const current = round++;
      if (current > 0) results.push(String(messages.at(-1)?.content ?? ""));
      const commands = [["grep", "-rn", "needle", "src"], ["tail", "src/app.ts"]];
      if (current < commands.length) {
        yield { type: "tool_call_delta" as const, index: 0, idDelta: `c${current}`, nameDelta: "run_command", argumentsDelta: JSON.stringify({ argv: commands[current] }) };
        yield { type: "finish" as const, reason: "tool_calls" }; return;
      }
      yield { type: "text_delta" as const, delta: "Done." }; yield { type: "finish" as const, reason: "stop" };
    } };
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => (await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init })).json() as Promise<any>;
  try {
    const { session } = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "S", workspacePath: workspace, trustWorkspace: true }) });
    const { turn } = await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "find the needle", permissionMode: "ask" }) });
    let asked = false;
    for (let i = 0; i < 200; i++) {
      const state = await call(`/v1/sessions/${session.id}`);
      if (state.pendingPermissions.length) asked = true;
      if (state.session.turns.find((t: any) => t.id === turn.id)?.status !== "running" && state.session.turns.find((t: any) => t.id === turn.id)?.status !== "queued") break;
      await Bun.sleep(25);
    }
    expect(asked).toBe(false);
    expect(results[0]).toContain("Ran as search_files");
    expect(results[0]).toContain("src/app.ts:1:export const needle = true;");
    expect(results[1]).toContain("Not run: use read_file instead of tail");
  } finally { server.stop(true); await app.close(); }
});
