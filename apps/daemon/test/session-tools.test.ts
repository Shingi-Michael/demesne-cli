import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fill, parseVariant, stepData } from "../src/session-tools.ts";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const builtIn = new Set(["search_files", "read_file", "write_file", "run_command", "list_files", "subagent"]);

test("definitions are checked against the real tools, and compositions stay read-only", () => {
  expect(parseVariant({ name: "ts_search", base: "search_files", defaults: { include: "*.ts", limit: 30 } }, builtIn)).toMatchObject({ kind: "preset", base: "search_files" });
  expect(parseVariant({ name: "find_definition", params: { name: { type: "string" } }, steps: [{ tool: "search_files", args: { query: "function {{name}}" } }] }, builtIn)).toMatchObject({ kind: "composition" });
  expect(() => parseVariant({ name: "search_files", base: "read_file", defaults: {} }, builtIn)).toThrow(/built-in/);
  expect(() => parseVariant({ name: "Bad Name", base: "read_file", defaults: {} }, builtIn)).toThrow(/lowercase/);
  expect(() => parseVariant({ name: "x1", base: "nope", defaults: {} }, builtIn)).toThrow(/built-in tool/);
  expect(() => parseVariant({ name: "x1", base: "subagent", defaults: {} }, builtIn)).toThrow(/built-in tool/);
  expect(() => parseVariant({ name: "sneaky", steps: [{ tool: "run_command", args: { argv: ["rm", "-rf", "."] } }] }, builtIn)).toThrow(/can't be composed/);
  expect(() => parseVariant({ name: "edits", steps: [{ tool: "write_file", args: { path: "a", content: "b" } }] }, builtIn)).toThrow(/can't be composed/);
  expect(() => parseVariant({ name: "many", steps: Array.from({ length: 7 }, () => ({ tool: "read_file", args: { path: "a" } })) }, builtIn)).toThrow(/1-6 steps/);
});

test("templates read params and earlier results, with simple arithmetic", () => {
  const search = stepData(JSON.stringify({ matches: ["src/app.ts:42:export function serve() {"], truncated: false })) as Record<string, unknown>;
  expect(search.first).toEqual({ path: "src/app.ts", line: 42, text: "export function serve() {" });
  const scope = { name: "serve", steps: [search] };
  expect(fill({ query: "function {{name}}", path: "{{steps[0].first.path}}", offset: "{{steps[0].first.line - 20}}" }, scope))
    .toEqual({ query: "function serve", path: "src/app.ts", offset: 22 });
  expect(() => fill("{{steps[1].first.path}}", scope)).toThrow(/no value/);
  expect(() => fill("{{name + 1}}", scope)).toThrow(/only numbers/);
  expect(() => fill("{{process.exit()}}", scope)).toThrow(/can't read/);
});

test("a model defines a preset and a composition, runs them in one call each, and they last for the session", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "session-tools-"))); roots.push(root);
  const workspace = join(root, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "app.ts"), Array.from({ length: 80 }, (_, i) => i === 59 ? "export function serve() { return 1; }" : `// line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(workspace, "notes.md"), "serve is documented here\n");
  const calls: Array<Record<string, unknown>> = [
    { action: "define", name: "ts_search", base: "search_files", defaults: { include: "*.ts" } },
    { action: "run", name: "ts_search", args: { query: "serve" } },
    { action: "define", name: "find_definition", params: { name: { type: "string" } }, steps: [
      { tool: "search_files", args: { query: "function {{name}}", include: "*.ts" } },
      { tool: "read_file", args: { path: "{{steps[0].first.path}}", offset: "{{steps[0].first.line - 2}}", limit: 5 } }] },
    { action: "run", name: "find_definition", args: { name: "serve" } },
    { action: "define", name: "scribble", base: "write_file", defaults: { path: "out.txt", content: "x\n" } },
    { action: "run", name: "scribble" },
    { action: "list" },
  ];
  const results: string[] = [];
  let round = 0;
  const processor: TurnProcessor = { providerId: "test", modelId: "local", async listModels() { return []; },
    async *stream(messages, tools) {
      if (round === 0) expect(tools.some((tool) => tool.name === "session_tools")).toBe(true);
      const current = round++;
      if (current > 0) results.push(String(messages.at(-1)?.content ?? ""));
      if (current < calls.length) {
        yield { type: "tool_call_delta" as const, index: 0, idDelta: `c${current}`, nameDelta: "session_tools", argumentsDelta: JSON.stringify(calls[current]) };
        yield { type: "finish" as const, reason: "tool_calls" }; return;
      }
      yield { type: "text_delta" as const, delta: "Done." }; yield { type: "finish" as const, reason: "stop" };
    } };
  const databasePath = join(root, "data", "state.sqlite");
  const app = createDaemonApp({ databasePath, processor });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => (await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init })).json() as Promise<any>;
  let sessionId = "";
  try {
    const { session } = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "S", workspacePath: workspace, trustWorkspace: true }) });
    sessionId = session.id;
    const { turn } = await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "find serve", permissionMode: "ask" }) });
    const asked: string[] = [];
    for (let i = 0; i < 400; i++) {
      const state = await call(`/v1/sessions/${session.id}`);
      for (const pending of state.pendingPermissions) if (!asked.includes(pending.id)) {
        asked.push(pending.id);
        await call(`/v1/permissions/${pending.id}`, { method: "POST", body: JSON.stringify({ decision: "deny" }) });
      }
      const status = state.session.turns.find((t: any) => t.id === turn.id)?.status;
      if (status !== "running" && status !== "queued") break;
      await Bun.sleep(25);
    }
    expect(results[0]).toContain("Defined ts_search");
    // The preset searched only .ts files.
    expect(results[1]).toContain("Ran ts_search");
    expect(results[1]).toContain("src/app.ts:60:");
    expect(results[1]).not.toContain("notes.md");
    // The composition found the definition and read around it, in one call.
    expect(results[3]).toContain("## 2. read_file");
    expect(results[3]).toContain("export function serve()");
    // A preset of a write tool still asked, and was denied.
    expect(asked).toHaveLength(1);
    expect(results[5]).toContain("Permission denied");
    expect(existsSync(join(workspace, "out.txt"))).toBe(false);
    expect(results[6]).toContain("find_definition(name): search_files → read_file");
  } finally { server.stop(true); await app.close(); }
  // Saved with the session: a restarted daemon still has them.
  const reopened = createDaemonApp({ databasePath, processor });
  try { expect(existsSync(join(root, "data", "session-tools", `${sessionId}.json`))).toBe(true); }
  finally { await reopened.close(); }
});
