import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSubmitTurnRequest } from "@demesne/protocol";
import { createDaemonApp } from "../src/app.ts";
import { publishesOutside } from "../src/engine.ts";
import type { TurnProcessor } from "../src/processor.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("publishesOutside: pushes, PR and release changes, and package publishes", () => {
  const run = (...argv: string[]) => publishesOutside("run_command", { argv });
  expect(run("git", "push", "origin", "main")).toBe(true);
  expect(run("git", "-C", "repo", "push")).toBe(true);
  expect(run("sh", "-c", "git add -A && git push")).toBe(true);
  expect(run("gh", "pr", "create", "--fill")).toBe(true);
  expect(run("gh", "pr", "merge", "12")).toBe(true);
  expect(run("gh", "release", "create", "v1")).toBe(true);
  expect(run("gh", "api", "-X", "POST", "repos/o/r/issues")).toBe(true);
  expect(run("npm", "publish")).toBe(true);
  expect(run("bun", "publish")).toBe(true);
  expect(run("git", "status")).toBe(false);
  expect(run("git", "commit", "-m", "push the button")).toBe(false);
  expect(run("gh", "pr", "view", "12")).toBe(false);
  expect(run("gh", "api", "repos/o/r")).toBe(false);
  expect(run("bun", "test")).toBe(false);
  expect(publishesOutside("write_file", { path: "push.txt" })).toBe(false);
});

test("submit accepts allow alongside ask and deny", () => {
  expect(parseSubmitTurnRequest({ content: "x", permissionMode: "allow" }).permissionMode).toBe("allow");
  expect(() => parseSubmitTurnRequest({ content: "x", permissionMode: "yes" })).toThrow(/ask, deny or allow/);
});

test("allow: edits run without asking, but a push still asks", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "drive-permissions-")));
  roots.push(root);
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  let round = 0;
  const processor: TurnProcessor = {
    providerId: "test", modelId: "coder", async listModels() { return []; },
    async *stream() {
      const current = round++;
      if (current === 0) {
        yield { type: "tool_call_delta" as const, index: 0, idDelta: "w", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: "answer.txt", content: "42\n" }) };
        yield { type: "finish" as const, reason: "tool_calls" }; return;
      }
      if (current === 1) {
        yield { type: "tool_call_delta" as const, index: 0, idDelta: "p", nameDelta: "run_command", argumentsDelta: JSON.stringify({ argv: ["git", "push", "origin", "main"] }) };
        yield { type: "finish" as const, reason: "tool_calls" }; return;
      }
      yield { type: "text_delta" as const, delta: "Done." };
      yield { type: "finish" as const, reason: "stop" };
    },
  };
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => (await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init })).json() as Promise<any>;
  try {
    const { session } = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "Drive", workspacePath: workspace, trustWorkspace: true }) });
    const { turn } = await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "Set the answer, then push", permissionMode: "allow" }) });
    const asked: string[] = [];
    for (let i = 0; i < 200; i++) {
      const state = await call(`/v1/sessions/${session.id}`);
      for (const pending of state.pendingPermissions) {
        if (asked.includes(pending.id)) continue;
        asked.push(pending.id);
        // The push must be the only thing that asks; decline it.
        expect(existsSync(join(workspace, "answer.txt"))).toBe(true);
        await call(`/v1/permissions/${pending.id}`, { method: "POST", body: JSON.stringify({ decision: "deny" }) });
      }
      if (state.session.turns.find((t: any) => t.id === turn.id)?.status === "completed") break;
      await Bun.sleep(25);
    }
    expect(readFileSync(join(workspace, "answer.txt"), "utf8")).toBe("42\n");
    expect(asked).toHaveLength(1);
    expect(round).toBe(3);
  } finally { server.stop(true); await app.close(); }
});
