import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageArtifact } from "@demesne/protocol";
import { DemesneStore } from "../../../packages/storage/src/index.ts";
import { suggestCleanup } from "../src/session-cleanup.ts";
import { createDaemonApp } from "../src/app.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const DAY = 86_400_000, now = Date.parse("2026-10-05T12:00:00Z");
const row = (id: string, days: number, extra: Partial<ReturnType<DemesneStore["sessionActivity"]>[number]> = {}) => ({
  id, title: id, workspace: "/repo", createdAt: new Date(now - days * DAY).toISOString(), updatedAt: new Date(now - days * DAY).toISOString(),
  archivedAt: null, turns: 3, completed: 3, active: 0, files: 4, commands: 2, ...extra });

test("cleanup suggests empty, gone, archived, unfinished, quick and stale sessions, with exact reasons", () => {
  const candidates = suggestCleanup([
    row("empty", 3, { turns: 0, completed: 0, files: 0, commands: 0 }),
    row("just-made", 0, { turns: 0, completed: 0, files: 0, commands: 0 }),
    row("gone", 2, { workspace: "/deleted" }),
    row("archived", 2, { archivedAt: new Date(now).toISOString() }),
    row("failed", 4, { turns: 2, completed: 0, files: 0, commands: 0 }),
    row("failed-with-work", 4, { turns: 2, completed: 0, files: 1 }),
    row("quick", 6, { turns: 1, completed: 1, files: 0, commands: 0 }),
    row("stale-big", 45, { turns: 30 }),
    row("stale-small", 45, { turns: 4, files: 0, commands: 0 }),
    row("active-work", 2),
    row("running", 90, { turns: 0, active: 1 }),
    row("current", 90, { turns: 0, completed: 0 }),
  ], { now, keep: ["current"], exists: (path) => path !== "/deleted" });
  expect(candidates.map((item) => [item.id, item.reason, item.suggested, item.detail])).toEqual([
    ["empty", "empty", true, "No messages"],
    ["gone", "missing", true, "3 turns · 4 files changed · its folder is gone"],
    ["archived", "archived", true, "3 turns · 4 files changed · archived"],
    ["failed", "unfinished", true, "2 turns · no changes · never finished a turn"],
    ["failed-with-work", "unfinished", false, "2 turns · 1 file changed · never finished a turn"],
    ["quick", "quick", true, "1 turn · no changes · a quick question"],
    ["stale-big", "stale", false, "30 turns · 4 files changed"],
    ["stale-small", "stale", true, "4 turns · no changes"],
  ]);
});

test("deleting a session removes it and everything in it, for good", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "session-cleanup-"))); roots.push(root);
  const workspace = join(root, "ws"); mkdirSync(workspace);
  const databasePath = join(root, "data", "state.sqlite"); mkdirSync(join(root, "data"));
  const seed = new DemesneStore(databasePath);
  const old = seed.createSession("Old question", workspace).session;
  const { turn } = seed.createTurn(old.id, "what does serve do?");
  seed.startTurn(turn.id);
  seed.appendModelMessage(turn.id, { role: "user", content: "what does serve do?" });
  seed.appendMessageDelta(turn.id, "It starts the server.");
  seed.recordSnapshot(turn.id, [{ path: "a.ts", existed: false, data: null }]);
  seed.recordImageArtifact({ id: "img1", kind: "image", sessionId: old.id, turnId: turn.id, toolCallId: "t", createdAt: new Date().toISOString(), filename: "a.png", mimeType: "image/png", width: 1, height: 1, byteLength: 1, sha256: "x" } as ImageArtifact, "src-1");
  seed.completeTurn(turn.id);
  const empty = seed.createSession("Empty", workspace).session;
  const kept = seed.createSession("Current", workspace).session;
  seed.database.query("UPDATE sessions SET updated_at = ?").run(new Date(Date.now() - 40 * DAY).toISOString());
  seed.close?.();
  mkdirSync(join(root, "data", "session-tools"));
  writeFileSync(join(root, "data", "session-tools", `${old.id}.json`), "[]");

  const app = createDaemonApp({ databasePath });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(new URL(path, server.url), { headers: { "Content-Type": "application/json" }, ...init });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const { body } = await call(`/v1/sessions/cleanup?keep=${kept.id}`);
    expect(body.candidates.map((item: any) => `${item.title}: ${item.reason}`).sort()).toEqual(["Empty: empty", "Old question: stale"]);
    const deleted = await call("/v1/sessions/delete", { method: "POST", body: JSON.stringify({ ids: [old.id, empty.id, "nope"] }) });
    expect(deleted.body).toEqual({ deleted: [old.id, empty.id], skipped: [{ id: "nope", reason: "not found" }] });
    expect((await call(`/v1/sessions/${old.id}`)).status).toBe(404);
    expect((await call(`/v1/sessions/${kept.id}`)).status).toBe(200);
    expect(existsSync(join(root, "data", "session-tools", `${old.id}.json`))).toBe(false);
    expect((await call("/v1/sessions?query=server")).body.sessions).toEqual([]);
    expect((await call("/v1/sessions/delete", { method: "POST", body: JSON.stringify({ ids: "all" }) })).status).toBe(400);
  } finally { server.stop(true); await app.close(); }
  const check = new DemesneStore(databasePath);
  for (const table of ["turns", "events", "model_messages", "turn_snapshots", "image_artifacts"])
    expect((check.database.query(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(old.id) as { n: number }).n).toBe(0);
  check.close?.();
});
