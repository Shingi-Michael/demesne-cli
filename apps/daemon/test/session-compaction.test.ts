import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { DemesneStore } from "@demesne/storage";
import type { EventEnvelope, SubmitTurnResponse } from "@demesne/protocol";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";

const summary = JSON.stringify({ schemaVersion: 1, goal: "Improve the parser", currentState: "Inspection complete; implementation pending",
  constraints: [{ id: "REQ-01", text: "Preserve Unicode support" }], decisions: [{ id: "DEC-01", status: "active", text: "Use a shared lexer", supersedes: [] }],
  files: [{ path: "src/parser.ts", facts: ["Parser delegates to the lexer"], changes: [] }], validation: [], unresolved: [{ id: "OPEN-01", text: "Run parser tests" }] });

async function fixture(run: (value: {
  client: DemesneClient; id: string; initialMessages: unknown[]; originalTurns: string[]; db: Database;
  requests: ProviderMessage[][]; consume: (submitted: SubmitTurnResponse) => Promise<EventEnvelope[]>;
  restart: () => Promise<void>; setStream: (stream: TurnProcessor["stream"]) => void; close: () => Promise<void>;
}) => Promise<void>, options: { count?: number; size?: number; capacity?: number; source?: string; undo?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "demesne-compaction-"));
  mkdirSync(join(root, "data"));
  const databasePath = join(root, "data/state.sqlite");
  const store = new DemesneStore(databasePath);
  const { session } = store.createSession("Compact this session", options.undo ? root : undefined);
  const originalTurns: string[] = [];
  for (let i = 0; i < (options.count ?? 5); i++) {
    const { turn } = store.createTurn(session.id, `Request ${i}: preserve Unicode support`);
    originalTurns.push(turn.id);
    store.startTurn(turn.id);
    if (options.undo && i === 0) {
      mkdirSync(join(root, "src"));
      for (const path of ["src/parser.ts", "src/lexer.ts"]) {
        store.recordSnapshot(turn.id, [{ path, existed: true, data: new TextEncoder().encode("before") }]);
        writeFileSync(join(root, path), "after");
        store.recordSnapshotPostState(turn.id, [{ path, existed: true, data: null, postHash: createHash("sha256").update("after").digest("hex") }]);
      }
    }
    store.appendModelMessage(turn.id, { role: "user", content: turn.content });
    store.appendModelMessage(turn.id, { role: "assistant", content: null, toolCalls: [{ id: `read-${i}`, name: "read_file", arguments: '{"path":"src/parser.ts"}' }] });
    store.appendModelMessage(turn.id, { role: "tool", toolCallId: `read-${i}`, content: `OLD_SOURCE_${i}: ` + (options.source ?? "parser evidence ").repeat(options.size ?? 300) });
    store.appendModelMessage(turn.id, { role: "assistant", content: `Answer ${i}` });
    store.appendMessageDelta(turn.id, `Answer ${i}`);
    store.completeTurn(turn.id);
  }
  const initialMessages = store.database.query("SELECT * FROM model_messages ORDER BY id").all();
  store.close();
  const requests: ProviderMessage[][] = [];
  let implementation: TurnProcessor["stream"] = async function* (messages, tools, _signal, thinking) {
    if (messages[0]?.content?.includes("immutable coding-session checkpoints")) {
      expect(tools).toEqual([]); expect(thinking).toBe(false);
      yield { type: "text_delta", delta: summary };
    } else yield { type: "text_delta", delta: "Continuing from the checkpoint" };
    yield { type: "finish", reason: "stop" };
    yield { type: "usage", usage: { inputTokens: 2000, outputTokens: 200, totalTokens: 2200 } };
  };
  const processor: TurnProcessor = { providerId: "test", modelId: "test-model", contextCapacity: options.capacity ?? 32768,
    maxOutputTokens: 1024, async listModels() { return []; }, async *stream(...args) {
      requests.push(structuredClone(args[0]));
      yield* implementation(...args);
    } };
  const appOptions = { databasePath, processor };
  let app = createDaemonApp(appOptions);
  const db = new Database(databasePath, { readonly: true });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  const consume = async (submitted: SubmitTurnResponse) => {
    const events: EventEnvelope[] = [];
    for await (const event of client.streamEvents(session.id, submitted.eventId, AbortSignal.timeout(3000))) {
      if (event.turnId !== submitted.turn.id) continue;
      events.push(event);
      if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) break;
    }
    expect(events.at(-1)?.type).toMatch(/^turn\.(completed|failed|cancelled|interrupted)$/);
    return events;
  };
  try {
    await run({ client, id: session.id, db, initialMessages, originalTurns, requests, consume,
      setStream: (stream) => { implementation = stream; }, restart: async () => { await app.close(); app = createDaemonApp(appOptions); }, close: () => app.close() });
  } finally { db.close(); await app.close(); rmSync(root, { recursive: true, force: true }); }
}

test("manual compaction preserves the journal and tool pairs, persists a summary, and injects it after restart", async () => {
  await fixture(async ({ client, id, db, initialMessages, originalTurns, requests, consume, restart }) => {
    const submitted = await client.compactSession(id, { instructions: "Preserve Unicode and unfinished parser tests" });
    expect(submitted.turn.kind).toBe("compaction");
    const events = await consume(submitted);
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(events.some((event) => event.type === "tool.call_requested")).toBe(false);
    expect(requests[0]?.[1]?.content).toContain("Preserve Unicode and unfinished parser tests");
    expect(requests[0]?.[1]?.content).not.toContain("OLD_SOURCE_3");
    const state = await client.getSessionState(id);
    const checkpoint = state.checkpoint!;
    expect(checkpoint.retainedTurns).toBe(2);
    expect(checkpoint.summarizedTurns).toBe(3);
    expect(checkpoint.afterTokens).toBeLessThan(checkpoint.beforeTokens);
    expect(checkpoint.summary).toContain("Preserve Unicode support");
    expect(state.latestProviderCall?.contextPlan?.estimatedInputTokens).toBe(checkpoint.afterTokens);
    expect(state.session.turns.at(-1)?.responseText).toContain("Full transcript remains in History");
    expect(db.query("SELECT * FROM model_messages WHERE turn_id <> ? ORDER BY id").all(submitted.turn.id)).toEqual(initialMessages);
    expect(state.session.turns.map((turn) => turn.id).slice(0, -1)).toEqual(originalTurns);
    expect(await client.exportSession(id)).toContain("Answer 0");
    await restart();
    expect((await client.getSessionState(id)).checkpoint).toEqual(checkpoint);
    await consume(await client.submitTurn(id, { content: "Continue the task" }));
    const next = requests.at(-1)!;
    expect(next[1]).toEqual({ role: "assistant", content: checkpoint.summary });
    expect(next.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "Request 3: preserve Unicode support", "Request 4: preserve Unicode support", "Continue the task",
    ]);
    expect(JSON.stringify(next)).not.toContain("OLD_SOURCE_0");
    expect(JSON.stringify(next)).not.toContain("/compact");
    expect(next.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["read-3", "read-4"]);
  });
});

test("repeat compaction merges the checkpoint and only summarizes newly old turns", async () => {
  await fixture(async ({ client, id, requests, consume }) => {
    await consume(await client.compactSession(id));
    const first = (await client.getSessionState(id)).checkpoint!;
    await consume(await client.submitTurn(id, { content: "One more task" }));
    const events = await consume(await client.compactSession(id));
    expect(events.at(-1)?.type).toBe("turn.completed");
    const second = (await client.getSessionState(id)).checkpoint!;
    expect(second.id).not.toBe(first.id);
    expect(second.summarizedTurns).toBe(4);
    const request = requests.at(-1)!;
    expect(request[1]?.content).toContain("Historical conversation checkpoint");
    expect(request[1]?.content).toContain("OLD_SOURCE_3");
    expect(request[1]?.content).not.toContain("OLD_SOURCE_0");
    expect(request[1]?.content).not.toContain("One more task");
  });
});

test.each(["malformed", "truncated", "empty", "tools"] as const)("%s summary failure never changes the active context", async (failure) => {
  await fixture(async ({ client, id, db, consume, setStream }) => {
    await consume(await client.compactSession(id));
    const previous = (await client.getSessionState(id)).checkpoint!;
    await consume(await client.submitTurn(id, { content: "Another task" }));
    setStream(async function* () {
      if (failure === "tools") yield { type: "tool_call_delta", index: 0, idDelta: "write", nameDelta: "write_file", argumentsDelta: '{"path":"surprise"}' };
      else if (failure !== "empty") yield { type: "text_delta", delta: failure === "malformed" ? "not JSON" : summary };
      yield { type: "finish", reason: failure === "truncated" ? "length" : "stop" };
    });
    const events = await consume(await client.compactSession(id));
    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.at(-1)?.payload.message).toContain("Previous context remains active");
    expect(events.some((event) => event.type === "session.compacted" || event.type === "tool.call_requested")).toBe(false);
    expect((await client.getSessionState(id)).checkpoint).toEqual(previous);
    expect(db.query("SELECT context_start_message_id FROM sessions WHERE id = ?").get(id)).toEqual({ context_start_message_id: previous.firstRetainedMessageId });
  });
});

test("cancellation and busy-session checks leave the cursor unchanged and release inference", async () => {
  await fixture(async ({ client, id, consume, setStream, restart }) => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    setStream(async function* (_messages, _tools, signal) {
      started();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const submitted = await client.compactSession(id);
    await ready;
    await expect(client.compactSession(id)).rejects.toThrow("active turn");
    await expect(client.submitTurn(id, { content: "Cannot interleave" })).rejects.toThrow("active turn");
    await client.cancelTurn(submitted.turn.id);
    expect((await consume(submitted)).at(-1)?.type).toBe("turn.cancelled");
    await restart();
    const state = await client.getSessionState(id);
    expect(state.checkpoint).toBeNull();
    expect(state.session.turns.at(-1)?.status).toBe("cancelled");
  });
});

test("short histories skip inference and invalid instructions do not create a turn", async () => {
  await fixture(async ({ client, id, requests, consume }) => {
    await expect(client.compactSession(id, { instructions: "x".repeat(4001) })).rejects.toThrow("4000");
    await expect(client.request(`/v1/sessions/${id}/compact`, { method: "POST", body: '{"instructions":42}' })).rejects.toThrow("string");
    expect((await client.getSessionState(id)).session.turns).toHaveLength(2);
    await consume(await client.compactSession(id));
    expect(requests).toHaveLength(0);
    expect((await client.getSessionState(id)).session.turns.at(-1)?.responseText).toContain("Nothing older to compact");
  }, { count: 2 });
});

test("a larger summary is not installed", async () => {
  await fixture(async ({ client, id, consume }) => {
    const events = await consume(await client.compactSession(id));
    expect(events.at(-1)?.type).toBe("turn.completed");
    const state = await client.getSessionState(id);
    expect(state.checkpoint).toBeNull();
    expect(state.session.turns.at(-1)?.responseText).toContain("Context unchanged");
  }, { count: 3, size: 0 });
});

test("oversized source messages use bounded rolling summaries instead of dropping source material", async () => {
  await fixture(async ({ client, id, requests, consume, db }) => {
    const submitted = await client.compactSession(id);
    const events = await consume(submitted);
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.slice(1).some((request) => request[1]?.content?.includes("Historical conversation checkpoint"))).toBe(true);
    for (const call of db.query("SELECT context_plan_json FROM provider_calls WHERE turn_id = ?").all(submitted.turn.id) as { context_plan_json: string }[]) {
      const plan = JSON.parse(call.context_plan_json);
      expect(plan.estimatedInputTokens).toBeLessThanOrEqual(plan.maximumPlannedInputTokens);
    }
    expect((await client.getSessionState(id)).checkpoint?.retainedTurns).toBe(2);
  }, { count: 3, size: 1500, capacity: 8192 });
});

test("splitting quote-heavy source makes progress without repeatedly escaping fragments", async () => {
  await fixture(async ({ client, id, requests, consume }) => {
    expect((await consume(await client.compactSession(id))).at(-1)?.type).toBe("turn.completed");
    expect(requests.length).toBeGreaterThan(2);
    expect(requests.length).toBeLessThan(32);
    expect((await client.getSessionState(id)).checkpoint).not.toBeNull();
  }, { count: 3, size: 4000, source: '"\\', capacity: 6000 });
});

test.each(["partial", "full"] as const)("%s undo invalidates a checkpoint and restores annotated full history", async (mode) => {
  await fixture(async ({ client, id, originalTurns, requests, consume, restart, db }) => {
    await consume(await client.compactSession(id));
    const checkpoint = (await client.getSessionState(id)).checkpoint!;
    expect(checkpoint).not.toBeNull();
    const reverted = await client.undo(id, { turnId: originalTurns[0], ...(mode === "partial" ? { paths: ["src/parser.ts"] } : {}) });
    expect(reverted.complete).toBe(mode === "full");
    expect((await client.getSessionState(id)).checkpoint).toBeNull();
    expect(db.query("SELECT context_start_message_id FROM sessions WHERE id = ?").get(id)).toEqual({ context_start_message_id: null });
    expect(db.query("SELECT id FROM session_checkpoints WHERE id = ?").get(checkpoint.id)).not.toBeNull();
    await restart();
    await consume(await client.submitTurn(id, { content: "Inspect current state" }));
    const messages = JSON.stringify(requests.at(-1));
    expect(messages).toContain("OLD_SOURCE_0");
    expect(messages).toContain("Recorded user undo");
    expect(messages).toContain("src/parser.ts");
    expect(messages).not.toContain("Historical conversation checkpoint");
    expect((await client.getSessionState(id)).session.turns[0]?.responseText).toBe("Answer 0");
  }, { undo: true });
});

test("undo during summarization prevents committing a stale checkpoint", async () => {
  await fixture(async ({ client, id, originalTurns, consume, setStream, db }) => {
    let started!: () => void; let finish!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const proceed = new Promise<void>((resolve) => { finish = resolve; });
    setStream(async function* () {
      started(); await proceed;
      yield { type: "text_delta", delta: summary };
      yield { type: "finish", reason: "stop" };
    });
    const submitted = await client.compactSession(id);
    try {
      await ready;
      await client.undo(id, { turnId: originalTurns[0], paths: ["src/parser.ts"] });
    } finally { finish(); }
    const events = await consume(submitted);
    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.at(-1)?.payload.message).toContain("Session context changed");
    expect(events.some((event) => event.type === "session.compacted" || event.type === "message.delta")).toBe(false);
    expect(db.query("SELECT id FROM session_checkpoints").all()).toEqual([]);
    expect((await client.getSessionState(id)).checkpoint).toBeNull();
  }, { undo: true });
});

test("a persistence failure rolls back the checkpoint, context cursor, and completion together", async () => {
  await fixture(async ({ client, id, db, initialMessages, consume }) => {
    const writer = new Database(db.filename);
    try {
      writer.run(`CREATE TRIGGER reject_compaction BEFORE INSERT ON events WHEN new.type = 'session.compacted'
        BEGIN SELECT RAISE(ABORT, 'Injected checkpoint failure'); END;`);
      const submitted = await client.compactSession(id);
      const events = await consume(submitted);
      expect(events.at(-1)?.type).toBe("turn.failed");
      expect(events.some((event) => event.type === "session.compacted" || event.type === "message.delta")).toBe(false);
      expect(db.query("SELECT id FROM session_checkpoints").all()).toEqual([]);
      expect(db.query("SELECT * FROM model_messages ORDER BY id").all()).toEqual(initialMessages);
      expect(db.query("SELECT context_start_message_id FROM sessions WHERE id = ?").get(id)).toEqual({ context_start_message_id: null });
      expect((await client.getSessionState(id)).checkpoint).toBeNull();
    } finally { writer.close(); }
  });
});

test("shutdown cancels a summary without publishing a checkpoint", async () => {
  await fixture(async ({ client, id, setStream, close, restart }) => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    setStream(async function* (_messages, _tools, signal): AsyncGenerator<ProviderStreamEvent> {
      started(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    await client.compactSession(id); await ready; await close(); await restart();
    expect((await client.getSessionState(id)).checkpoint).toBeNull();
  });
});
