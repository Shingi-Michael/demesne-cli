import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveFix } from "@demesne/protocol";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// The daemon commits and cherry-picks with the user's git identity; CI has none.
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b" });
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: process.env });
const out = (cwd: string, ...args: string[]) => git(cwd, ...args).stdout.toString().trim();

test("a breakage is fixed in its own worktree, then applied to the user's branch or discarded", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "drive-fixes-"))); roots.push(root);
  const workspace = join(root, "repo");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(workspace, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(workspace, ".gitignore"), "node_modules\n");
  writeFileSync(join(workspace, "src", "count.ts"), "export const count = 1;\n");
  git(workspace, "init", "-q", "-b", "main"); git(workspace, "add", "-A"); git(workspace, "commit", "-qm", "init");
  // The user keeps working: an uncommitted change elsewhere survives the fix.
  writeFileSync(join(workspace, "notes.md"), "draft\n");

  let fixedIn = "", prompt = "";
  const processor: TurnProcessor = { providerId: "test", modelId: "coder", async listModels() { return []; },
    async *stream(messages) {
      const last = messages.at(-1)!;
      if (last.role === "user") {
        prompt = String(last.content);
        yield { type: "tool_call_delta" as const, index: 0, idDelta: "w", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: "src/count.ts", content: "export const count = 2;\n" }) };
        yield { type: "finish" as const, reason: "tool_calls" }; return;
      }
      fixedIn = String(messages.find((message) => message.role === "system")?.content ?? "");
      yield { type: "text_delta" as const, delta: "count was off by one; it's 2 now." };
      yield { type: "finish" as const, reason: "stop" };
    } };
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init });
    return { status: response.status, body: await response.json() as any };
  };
  const signals = [{ id: "check:abc", source: "checks", title: "Check failing: bun test", detail: "expected 2, got 1", urgent: true }];
  const until = async (id: string, done: (fix: DriveFix) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const fix = (await call(`/v1/drive/fixes?workspace=${encodeURIComponent(workspace)}`)).body.fixes.find((item: DriveFix) => item.id === id);
      if (done(fix)) return fix as DriveFix;
      await Bun.sleep(25);
    }
    throw new Error("the fix did not settle");
  };
  try {
    // Unknown workspaces are refused.
    expect((await call("/v1/drive/fixes", { method: "POST", body: JSON.stringify({ workspace, signals }) })).status).toBe(404);
    await call("/v1/sessions", { method: "POST", body: JSON.stringify({ title: "S", workspacePath: workspace, trustWorkspace: true }) });
    expect((await call("/v1/drive/alerts", { method: "POST", body: JSON.stringify({ workspace }) })).body.signals).toEqual([]);

    const started = await call("/v1/drive/fixes", { method: "POST", body: JSON.stringify({ workspace, signals }) });
    expect(started.body.error?.message ?? "").toBe("");
    expect(started.status).toBe(201);
    const first = started.body.fix as DriveFix;
    expect(first.branch).toMatch(/^drive\/fix-check-failing-bun-test-/);
    expect((await call("/v1/drive/fixes", { method: "POST", body: JSON.stringify({ workspace, signals }) })).body.error?.message ?? "").toMatch(/already running/);
    const ready = await until(first.id, (fix) => fix.status !== "running" && fix.status !== "starting");
    expect(ready).toMatchObject({ status: "ready", summary: "count was off by one; it's 2 now.", diff: { files: 1, additions: 1, deletions: 1, paths: ["src/count.ts"] } });
    expect(prompt).toContain("Check failing: bun test: expected 2, got 1");
    expect(fixedIn).toContain(ready.path);
    // The user's checkout is untouched; the worktree shares node_modules without committing it.
    expect(readFileSync(join(workspace, "src", "count.ts"), "utf8")).toBe("export const count = 1;\n");
    expect(lstatSync(join(ready.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(out(workspace, "show", "--stat", "--format=%s", ready.branch)).not.toContain("node_modules");

    const applied = await call(`/v1/drive/fixes/${first.id}/apply`, { method: "POST" });
    expect(applied.body.fix.status).toBe("applied");
    expect(readFileSync(join(workspace, "src", "count.ts"), "utf8")).toBe("export const count = 2;\n");
    expect(out(workspace, "log", "-1", "--format=%s")).toBe("Fix: Check failing: bun test");
    expect(readFileSync(join(workspace, "notes.md"), "utf8")).toBe("draft\n");
    expect(existsSync(ready.path)).toBe(false);
    expect(out(workspace, "branch", "--list", "drive/*")).toBe("");
    expect(existsSync(join(workspace, "node_modules", "dep", "index.js"))).toBe(true);

    // A second fix, discarded: nothing reaches the checkout.
    git(workspace, "reset", "-q", "--hard", "HEAD~1");
    const second = (await call("/v1/drive/fixes", { method: "POST", body: JSON.stringify({ workspace, signals }) })).body.fix as DriveFix;
    await until(second.id, (fix) => fix.status === "ready");
    expect((await call(`/v1/drive/fixes/${second.id}/discard`, { method: "POST" })).body.fix.status).toBe("discarded");
    expect(readFileSync(join(workspace, "src", "count.ts"), "utf8")).toBe("export const count = 1;\n");
    expect(out(workspace, "branch", "--list", "drive/*")).toBe("");
    expect(out(workspace, "worktree", "list").split("\n")).toHaveLength(1);
    expect((await call(`/v1/drive/fixes/${second.id}/apply`, { method: "POST" })).status).toBe(409);
  } finally { server.stop(true); await app.close(); }
});
