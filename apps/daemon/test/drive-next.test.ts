import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveNextResponse, DriveSignal } from "@demesne/protocol";
import { DemesneStore } from "../../../packages/storage/src/index.ts";
import { collectDriveSignals } from "../src/drive-signals.ts";
import { rankProposals } from "../src/drive-next.ts";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "drive-next-"))); roots.push(root); return root; };
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=t", ...args], { cwd });

test("ranking: value × confidence ÷ cost, urgent evidence doubles it, uncited proposals are dropped", () => {
  const signals: DriveSignal[] = [
    { id: "check:1", source: "checks", title: "Check failing", detail: "", urgent: true },
    { id: "git:uncommitted", source: "git", title: "3 uncommitted", detail: "" },
  ];
  const ranked = rankProposals([
    { kind: "tidy", title: "Commit the drafts", why: "w", evidence: ["git:uncommitted"], minutes: 10, coders: 1, confidence: "high", value: 3 },
    { kind: "fix", title: "Fix the failing check", why: "w", evidence: ["check:1"], minutes: 30, coders: 1, confidence: "medium", value: 4 },
    { kind: "experiment", title: "Made up", why: "w", evidence: ["telemetry:nope"], minutes: 20, coders: 2, confidence: "low", value: 5 },
  ], signals);
  expect(ranked.map((item) => [item.title, item.score, item.urgent])).toEqual([["Commit the drafts", 6, false], ["Fix the failing check", 5.6, true]]);
  expect(ranked[0]!.id).toMatch(/^[0-9a-f]{10}$/);
});

test("signals: a failing check, an unfinished ask, uncommitted work and TODOs, with a stable fingerprint", async () => {
  const root = scratch(), workspace = join(root, "ws");
  Bun.spawnSync(["mkdir", "-p", workspace]);
  git(workspace, "init", "-q");
  writeFileSync(join(workspace, "lexer.ts"), "// TODO: accept Unicode digits\nexport const lex = 1;\n");
  git(workspace, "add", "-A"); git(workspace, "commit", "-qm", "init");
  writeFileSync(join(workspace, "draft.ts"), "export const draft = 1;\n");
  const store = new DemesneStore(join(root, "state.sqlite"));
  const { session } = store.createSession("S", workspace);
  const { turn } = store.createTurn(session.id, "Fix the parser");
  store.startTurn(turn.id); store.failTurn(turn.id, "provider down");
  const ask = store.createTurn(session.id, "Run the checks").turn;
  store.startTurn(ask.id);
  store.saveCommand({ id: "c1", sessionId: session.id, turnId: ask.id, toolCallId: null, rerunOf: null, argv: ["/usr/local/bin/bun", "test"], cwd: workspace,
    background: false, check: true, pid: null, status: "failed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), lastOutputAt: null,
    exitCode: 1, timedOut: false, stdout: "1 fail", stderr: "expected 2", truncated: false, fingerprint: null, freshness: "current" });
  const first = await collectDriveSignals(store.database, workspace, { gh: false });
  const byId = Object.fromEntries(first.signals.map((signal) => [signal.id.split(":")[0] + (signal.id.startsWith("git") ? `:${signal.id.split(":")[1]}` : ""), signal]));
  expect(byId.check).toMatchObject({ source: "checks", urgent: true, title: "Check failing: bun test" });
  expect(byId.ask).toMatchObject({ source: "sessions", title: "Unfinished ask (failed)" });
  expect(byId["git:uncommitted"]).toMatchObject({ title: "1 uncommitted change" });
  expect(byId.code).toMatchObject({ title: "1 TODO/FIXME note in code" });
  expect((await collectDriveSignals(store.database, workspace, { gh: false })).fingerprint).toBe(first.fingerprint);
  writeFileSync(join(workspace, "another.ts"), "x\n");
  expect((await collectDriveSignals(store.database, workspace, { gh: false })).fingerprint).not.toBe(first.fingerprint);
  store.close?.();
});

test("/v1/drive/next: known workspaces only, cached until signals change, vetoes never return", async () => {
  const root = scratch(), workspace = join(root, "ws");
  Bun.spawnSync(["mkdir", "-p", workspace]); git(workspace, "init", "-q");
  writeFileSync(join(workspace, "draft.ts"), "export const draft = 1;\n");
  let calls = 0;
  const processor: TurnProcessor = { providerId: "test", modelId: "planner", async listModels() { return []; },
    async *stream(_messages, tools) {
      if (!tools.some((tool) => tool.name === "propose_next")) { yield { type: "finish" as const, reason: "stop" }; return; }
      calls++;
      yield { type: "tool_call_delta" as const, index: 0, idDelta: "p", nameDelta: "propose_next", argumentsDelta: JSON.stringify({ proposals: [
        { kind: "tidy", title: "Commit the draft", why: "draft.ts is uncommitted", evidence: ["git:uncommitted"], minutes: 10, coders: 1, confidence: "high", value: 3 },
        { kind: "tidy", title: "Delete the draft", why: "draft.ts looks abandoned", evidence: ["git:uncommitted"], minutes: 5, coders: 1, confidence: "low", value: 1 },
      ] }) };
      yield { type: "finish" as const, reason: "tool_calls" };
    } };
  // The data directory may not contain the workspace.
  const app = createDaemonApp({ databasePath: join(root, "data", "state.sqlite"), processor });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const post = async (body: unknown) => { const response = await fetch(new URL("/v1/drive/next", server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as DriveNextResponse }; };
  try {
    expect((await post({ workspace: "/etc" })).status).toBe(404);
    expect((await fetch(new URL("/v1/sessions", server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "S", workspacePath: workspace }) })).status).toBe(201);
    const memory = [{ id: "v1", kind: "veto", text: "Delete the draft: draft.ts looks abandoned", source: "you", at: "now" }];
    const first = await post({ workspace, memory });
    expect(first.status).toBe(200);
    expect(first.body.cached).toBe(false);
    expect(first.body.proposals.map((item) => item.title)).toEqual(["Commit the draft"]);
    expect(first.body.signals.map((item) => item.id)).toContain("git:uncommitted");
    // Same signals: served from cache, no model call.
    const second = await post({ workspace, memory });
    expect(second.body.cached).toBe(true);
    expect(calls).toBe(1);
    // Force asks again.
    expect((await post({ workspace, memory, force: true })).body.cached).toBe(false);
    expect(calls).toBe(2);
  } finally { server.stop(true); await app.close(); }
});
