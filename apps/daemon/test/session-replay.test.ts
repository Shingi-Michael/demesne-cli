import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { DemesneStore } from "@demesne/storage";
import type { EventEnvelope, SessionStateResponse } from "@demesne/protocol";
import { coalesceReplayEvents, SessionReplay } from "../src/session-replay.ts";
import { createDaemonApp } from "../src/app.ts";
import { replaySession, restoreSessionEntries } from "../../cli/src/workbench/history.ts";

const at = "2026-09-21T12:00:00.000Z";
const event = (eventId: number, type: EventEnvelope["type"], payload: EventEnvelope["payload"] = {}): EventEnvelope => ({
  schemaVersion: 1, eventId, type, payload, occurredAt: new Date(Date.parse(at) + eventId * 10).toISOString(),
  workspaceId: null, sessionId: "session", turnId: "turn", agentRunId: null,
});

test("coalesced history reconstructs identical text, revisions, timestamps, tools and multi-round receipts", () => {
  const events = [event(1, "model.request_started", { model: "original" }),
    event(2, "reasoning.delta", { delta: "" }), event(3, "reasoning.delta", { delta: "Check " }), event(4, "reasoning.delta", { delta: "the code." }),
    event(5, "message.delta", { delta: "" }), event(6, "message.delta", { delta: "Looking " }), event(7, "message.delta", { delta: "now." }),
    event(8, "tool.call_requested", { toolCallId: "tool", name: "read_file", arguments: { path: "src/a.ts" } }),
    event(9, "permission.requested", { toolCallId: "tool", permissionId: "permission" }),
    event(10, "permission.resolved", { permissionId: "permission", decision: "allow_once" }),
    event(11, "tool.call_completed", { toolCallId: "tool", name: "read_file", message: "source intact" }),
    event(12, "model.usage", { providerCallId: "round", outputTokens: 100 }),
    event(13, "model.metrics", { providerCallId: "round", durationMs: 1000, timeToFirstTokenMs: 200 }),
    event(14, "model.request_started", { model: "original" }),
    ...Array.from({ length: 300 }, (_, i) => event(i + 15, "message.delta", { delta: "Unicode 界👩‍💻 " })),
    event(315, "turn.completed")];
  const snapshot: SessionStateResponse = { session: { id: "session", title: "History", createdAt: at, updatedAt: at, workspace: null,
    turns: [{ id: "turn", sessionId: "session", status: "completed", content: "Inspect", responseText: "", createdAt: at,
      completedAt: events.at(-1)!.occurredAt, permissionMode: "ask", thinkingEnabled: true }] },
    lastEventId: 315, latestProviderCall: null, pendingPermissions: [] };
  const originals = JSON.stringify(events);
  const packed = coalesceReplayEvents(events);
  expect(packed.length).toBeLessThan(20);
  expect(JSON.stringify(events)).toBe(originals);
  expect(restoreSessionEntries(snapshot, packed)).toEqual(restoreSessionEntries(snapshot, events));
  // A token range straddling an older snapshot cannot leak future text into it.
  expect(restoreSessionEntries({ ...snapshot, lastEventId: 14 }, packed)).toEqual(restoreSessionEntries({ ...snapshot, lastEventId: 14 }, events));
});

test("coalescing bounds text chunks and preserves extra metadata and cross-turn boundaries", () => {
  const events = [event(1, "message.delta", { delta: "a".repeat(40_000) }), event(2, "message.delta", { delta: "b".repeat(40_000) }),
    event(3, "message.delta", { delta: "c", annotation: "keep" }), event(4, "message.delta", { delta: "d" }),
    { ...event(5, "message.delta", { delta: "e" }), turnId: "other" }];
  expect(coalesceReplayEvents(events)).toEqual(events);
});

test("replay cache keys include the snapshot, promotes recent pages, and evicts within its byte budget", () => {
  let reads = 0;
  const source = { eventsBetween: (_session: string, _after: number, through: number) => {
    reads++;
    return [event(through, "message.delta", { delta: "x".repeat(50) })];
  } };
  const size = Buffer.byteLength(new SessionReplay(source).page("session", 0, 1));
  reads = 0;
  const cache = new SessionReplay(source, size * 2);
  const one = cache.page("session", 0, 1);
  cache.page("session", 0, 2);
  expect(cache.page("session", 0, 1)).toBe(one);
  expect(reads).toBe(2);
  cache.page("session", 0, 3);
  cache.page("session", 0, 1);
  expect(reads).toBe(3);
  cache.page("session", 0, 2);
  expect(reads).toBe(4);
  const disabled = new SessionReplay(source, 1);
  disabled.page("session", 0, 1); disabled.page("session", 0, 1);
  expect(reads).toBe(6);
});

test("authenticated bulk replay pages a large persisted journal through its exact saved cursor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "demesne-replay-"));
  const databasePath = join(directory, "demesne.sqlite");
  const store = new DemesneStore(databasePath);
  const { session } = store.createSession("Bulk history");
  const { turn } = store.createTurn(session.id, "Inspect");
  store.startTurn(turn.id);
  store.database.transaction(() => {
    for (let i = 0; i < 20_050; i++) store.appendReasoningDelta(turn.id, "word ");
    store.appendMessageDelta(turn.id, "Answer intact.");
  })();
  store.completeTurn(turn.id);
  const snapshot = store.getSessionState(session.id)!;
  const original = [...store.eventsBetween(session.id, 0, snapshot.lastEventId), ...store.eventsBetween(session.id, 20_000, snapshot.lastEventId)];
  store.renameSession(session.id, "Newer than snapshot");
  store.close();
  const app = createDaemonApp({ databasePath, authToken: "replay-secret" });
  const calls: string[] = [];
  const client = new DemesneClient({ server: "http://localhost", token: "replay-secret", fetch: (async (url, init) => {
    calls.push(String(url));
    return app.fetch(new Request(url, init));
  }) as typeof fetch });
  try {
    const packed = await replaySession(snapshot, async function* () { throw new Error("Must not use live SSE"); },
      (id, after, through, signal) => client.replayPage(id, after, through, signal));
    expect(calls).toHaveLength(2);
    expect(packed.length).toBeLessThan(10);
    expect(restoreSessionEntries(snapshot, packed)).toEqual(restoreSessionEntries(snapshot, original));
    expect(packed.at(-1)?.eventId).toBe(snapshot.lastEventId);
    const newer = await client.getSessionState(session.id);
    const page = await client.replayPage(session.id, snapshot.lastEventId, newer.lastEventId);
    expect(page.events.map((event) => event.type)).toEqual(["session.renamed"]);
    expect(page.nextCursor).toBeNull();
    const response = await app.fetch(new Request(`http://localhost/v1/sessions/${session.id}/replay?through=${snapshot.lastEventId}`));
    expect(response.status).toBe(401);
    for (const query of ["", "?through=-1", "?after=2&through=1", "?through=NaN", "?through=1.5"]) {
      expect((await app.fetch(new Request(`http://localhost/v1/sessions/${session.id}/replay${query}`, { headers: { Authorization: "Bearer replay-secret" } }))).status).toBe(400);
    }
    await expect(client.replayPage("missing", 0, 1)).rejects.toMatchObject({ status: 404 });
    await expect(client.replayPage(session.id, newer.lastEventId, newer.lastEventId + 1)).rejects.toMatchObject({ status: 409 });
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
