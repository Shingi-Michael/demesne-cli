import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DemesneStore } from "../src/index.ts";
import type { ContextPlan } from "@demesne/protocol";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("DemesneStore", () => {
  test("marks unfinished turns as interrupted when the journal reopens", () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-storage-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "demesne.sqlite");
    const first = new DemesneStore(databasePath);
    const { session } = first.createSession("Crash recovery");
    const { turn } = first.createTurn(session.id, "Do not repeat side effects");
    first.startTurn(turn.id);
    first.startProviderCall(turn.id, "test-provider", "test-model");
    first.close();

    const second = new DemesneStore(databasePath);
    const recovered = second.getSession(session.id);
    const events = second.eventsAfter(session.id, 0);

    expect(recovered?.turns[0]?.status).toBe("interrupted");
    expect(events.at(-1)?.type).toBe("turn.interrupted");
    expect(events.at(-1)?.turnId).toBe(turn.id);
    expect(events.at(-2)?.type).toBe("model.request_interrupted");
    second.close();
  });

  test("rejects a database created by a newer storage schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-storage-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "demesne.sqlite");
    const database = new Database(databasePath, { create: true });
    database.run("PRAGMA user_version = 99");
    database.close();
    expect(() => new DemesneStore(databasePath)).toThrow("newer than supported schema");
  });

  test("clears unresolved permissions during crash recovery", () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-storage-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "demesne.sqlite");
    const first = new DemesneStore(databasePath);
    const { session } = first.createSession("Permission recovery");
    const { turn } = first.createTurn(session.id, "Edit", "ask");
    first.startTurn(turn.id);
    const { providerCallId } = first.startProviderCall(turn.id, "provider", "model");
    first.settleProviderCall(providerCallId, "completed");
    const { toolCallId } = first.recordToolCall(turn.id, providerCallId, "call", "edit_file", "{}");
    first.requestToolPermission(toolCallId, "write", "edit file");
    first.close();

    const second = new DemesneStore(databasePath);
    expect(second.getSessionState(session.id)?.pendingPermissions).toEqual([]);
    expect(second.database.query("SELECT status, permission_status FROM tool_calls WHERE id = ?").get(toolCallId)).toEqual({
      status: "interrupted",
      permission_status: "denied",
    });
    second.close();
  });

  test("journals reasoning separately from the final response", () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-storage-test-"));
    temporaryDirectories.push(directory);
    const store = new DemesneStore(join(directory, "demesne.sqlite"));
    const { session } = store.createSession("Reasoning");
    const { turn } = store.createTurn(session.id, "Think through this");
    expect(turn.thinkingEnabled).toBeNull();
    store.startTurn(turn.id);

    store.appendReasoningDelta(turn.id, "private working");
    store.appendMessageDelta(turn.id, "final answer");

    const events = store.eventsAfter(session.id, 0);
    expect(events.find((event) => event.type === "reasoning.delta")?.payload).toEqual({ delta: "private working" });
    expect(store.getTurn(turn.id)?.responseText).toBe("final answer");
    store.close();
  });

  test("cancelling a permission wait clears persisted permission state", () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-storage-test-"));
    temporaryDirectories.push(directory);
    const store = new DemesneStore(join(directory, "demesne.sqlite"));
    const { session } = store.createSession("Cancelled permission");
    const { turn } = store.createTurn(session.id, "Edit the file", "ask");
    store.startTurn(turn.id);
    const { providerCallId } = store.startProviderCall(turn.id, "provider", "model");
    store.settleProviderCall(providerCallId, "completed");
    const { toolCallId } = store.recordToolCall(turn.id, providerCallId, "edit", "edit_file", "{}");
    const { permissionId } = store.requestToolPermission(toolCallId, "write", "Edit file");

    expect(store.getSessionState(session.id)?.pendingPermissions).toHaveLength(1);
    store.cancelTurn(turn.id);

    expect(store.getSessionState(session.id)?.pendingPermissions).toEqual([]);
    expect(store.database.query("SELECT status, permission_status FROM tool_calls WHERE id = ?").get(toolCallId)).toEqual({
      status: "cancelled",
      permission_status: "cancelled",
    });
    expect(() => store.resolveToolPermission(permissionId, "allow_once")).toThrow("no longer pending");
    expect(() => store.startToolCall(toolCallId)).toThrow("not pending");
    store.close();
  });

  test("persists structured model messages across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-storage-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "demesne.sqlite");
    const first = new DemesneStore(databasePath);
    const { session } = first.createSession("Structured transcript");
    const { turn } = first.createTurn(session.id, "Inspect the file");
    first.startTurn(turn.id);
    first.appendModelMessage(turn.id, { role: "user", content: "Inspect the file" });
    first.appendModelMessage(turn.id, {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" }],
    });
    first.appendModelMessage(turn.id, { role: "tool", toolCallId: "call-1", content: "contents" });
    first.appendModelMessage(turn.id, { role: "assistant", content: "The file contains contents." });
    first.completeTurn(turn.id);
    first.close();

    const second = new DemesneStore(databasePath);
    expect(second.getCompletedModelTranscript(session.id).map((entry) => entry.message)).toEqual([
      { role: "user", content: "Inspect the file" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call-1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" }],
      },
      { role: "tool", toolCallId: "call-1", content: "contents" },
      { role: "assistant", content: "The file contains contents." },
    ]);
    second.close();
  });

  test("backfills tool transcripts and persists exact provider metrics", () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-storage-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "demesne.sqlite");
    const first = new DemesneStore(databasePath);
    const { session } = first.createSession("Legacy tool transcript");
    const { turn } = first.createTurn(session.id, "Read a.txt");
    expect(() => first.startProviderCall(turn.id, "provider", "model")).toThrow("cannot start from queued");
    first.startTurn(turn.id);
    const contextPlan: ContextPlan = {
      schemaVersion: 1,
      estimator: { method: "openai-json-utf8-bytes-divisor-3", version: 1 },
      capacityTokens: 8_192,
      reserves: { outputTokens: 1_536, toolResultTokens: 768, safetyTokens: 512, totalTokens: 2_816 },
      maximumPlannedInputTokens: 5_376,
      hardInputLimitTokens: 6_656,
      originalEstimatedInputTokens: 101,
      estimatedInputTokens: 100,
      estimatedMessageTokens: 80,
      estimatedToolDefinitionTokens: 20,
      budgetStatus: "within_soft_limit",
      actions: [],
    };
    const { providerCallId } = first.startProviderCall(turn.id, "provider", "model", {
      profile: "balanced-32gb",
      thinkingEnabled: false,
      contextPlan,
    });
    const { toolCallId } = first.recordToolCall(turn.id, providerCallId, "provider-tool", "read_file", "{\"path\":\"a.txt\"}");
    first.startToolCall(toolCallId);
    first.settleToolCall(toolCallId, "completed", "contents");
    first.recordProviderUsage(providerCallId, {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 80,
    });
    first.recordProviderMetrics(providerCallId, { queueDurationMs: 125, durationMs: 500, timeToFirstTokenMs: 75 });
    first.settleProviderCall(providerCallId, "completed");
    first.appendMessageDelta(turn.id, "Read the file.");
    first.completeTurn(turn.id);
    first.close();

    const second = new DemesneStore(databasePath);
    expect(second.getCompletedModelTranscript(session.id).map((entry) => entry.message)).toEqual([
      { role: "user", content: "Read a.txt" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "provider-tool", name: "read_file", arguments: "{\"path\":\"a.txt\"}" }],
      },
      { role: "tool", toolCallId: "provider-tool", content: "contents" },
      { role: "assistant", content: "Read the file." },
    ]);
    expect(second.database.query(`
      SELECT cached_input_tokens, queue_duration_ms, duration_ms, time_to_first_token_ms
      FROM provider_calls WHERE id = ?
    `).get(providerCallId)).toEqual({
      cached_input_tokens: 80,
      queue_duration_ms: 125,
      duration_ms: 500,
      time_to_first_token_ms: 75,
    });
    expect(second.getSessionState(session.id)?.latestProviderCall).toEqual({
      provider: "provider",
      model: "model",
      contextPlan,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 80 },
      metrics: { queueDurationMs: 125, durationMs: 500, timeToFirstTokenMs: 75 },
    });
    second.close();
  });

  test("migrates the previous constrained schema without losing journal entries", () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-storage-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "legacy.sqlite");
    const legacy = new Database(databasePath, { create: true });
    legacy.run(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        content TEXT NOT NULL,
        response_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL check (status IN ('queued', 'running', 'completed', 'interrupted', 'failed')),
        created_at TEXT NOT NULL,
        completed_at TEXT
        ,permission_mode TEXT NOT NULL DEFAULT 'deny'
        ,thinking_enabled INTEGER
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        workspace_id TEXT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        turn_id TEXT REFERENCES turns(id),
        agent_run_id TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE provider_calls (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        error_message TEXT
      );
      INSERT INTO sessions VALUES ('session', 'Legacy', '2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z');
      INSERT INTO turns VALUES ('turn', 'session', 'Resume safely', '', 'running', '2026-08-23T00:00:00Z', NULL, 'ask', 1);
      INSERT INTO events VALUES (7, 'turn.created', '2026-08-23T00:00:00Z', NULL, 'session', 'turn', NULL, '{}');
      INSERT INTO provider_calls VALUES ('call', 'turn', 'provider', 'model', 'running', '2026-08-23T00:00:00Z', NULL, NULL, NULL, NULL, NULL);
    `);
    legacy.close();

    const migrated = new DemesneStore(databasePath);
    expect(migrated.getTurn("turn")?.status).toBe("interrupted");
    expect(migrated.getTurn("turn")?.permissionMode).toBe("ask");
    expect(migrated.getTurn("turn")?.thinkingEnabled).toBe(true);
    expect(migrated.eventsAfter("session", 0).map((event) => event.eventId)).toEqual([7, 8, 9]);
    expect(
      (migrated.database.query("PRAGMA table_info(provider_calls)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    ).toEqual(expect.arrayContaining([
      "cached_input_tokens",
      "queue_duration_ms",
      "duration_ms",
      "time_to_first_token_ms",
      "context_plan_json",
    ]));
    expect(migrated.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  });

  test("renames and archives sessions without losing transcripts", () => {
    const store = new DemesneStore(":memory:");
    const { session } = store.createSession("Original");
    const renamed = store.renameSession(session.id, "  Better title  ");
    expect(renamed.session.title).toBe("Better title");
    expect(renamed.event.type).toBe("session.renamed");
    expect(store.listSessions().map((entry) => entry.id)).toEqual([session.id]);

    const archived = store.archiveSession(session.id);
    expect(archived.session.archivedAt).toBeTruthy();
    expect(archived.event.type).toBe("session.archived");
    expect(store.listSessions()).toEqual([]);
    expect(store.listSessions(100, { includeArchived: true }).map((entry) => entry.id)).toEqual([session.id]);
    expect(() => store.archiveSession(session.id)).toThrow("already archived");
    store.close();
  });

  test("searches titles and transcripts, excluding archived sessions", () => {
    const store = new DemesneStore(":memory:");
    const { session } = store.createSession("Parser work");
    const { turn } = store.createTurn(session.id, "Fix the tokenizer bug");
    store.startTurn(turn.id);
    store.appendModelMessage(turn.id, { role: "user", content: "Fix the tokenizer bug" });
    store.appendModelMessage(turn.id, { role: "assistant", content: "The lexer now handles unicode." });
    store.completeTurn(turn.id);

    const { session: archived } = store.createSession("Unrelated archived");
    store.archiveSession(archived.id);

    expect(store.searchSessions("tokenizer").map((entry) => entry.id)).toEqual([session.id]);
    expect(store.searchSessions("Parser").map((entry) => entry.id)).toEqual([session.id]);
    expect(store.searchSessions("unicode").map((entry) => entry.id)).toEqual([session.id]);
    expect(store.searchSessions("Unrelated")).toEqual([]);
    expect(store.searchSessions("missing")).toEqual([]);
    store.close();
  });

  test("exports visible requests and responses only", () => {
    const store = new DemesneStore(":memory:");
    const { session } = store.createSession("Export me");
    const { turn } = store.createTurn(session.id, "Summarize the parser");
    store.startTurn(turn.id);
    store.appendModelMessage(turn.id, { role: "user", content: "Summarize the parser" });
    store.appendReasoningDelta(turn.id, "hidden reasoning");
    store.appendModelMessage(turn.id, { role: "assistant", content: "It tokenizes and parses." });
    store.completeTurn(turn.id);

    const exported = store.getSessionExport(session.id);
    expect(exported.session.title).toBe("Export me");
    expect(exported.turns).toEqual([{
      id: turn.id,
      content: "Summarize the parser",
      status: "completed",
      createdAt: expect.any(String),
      responses: ["It tokenizes and parses."],
    }]);
    store.close();
  });

  test("creates private database files", () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-storage-test-"));
    temporaryDirectories.push(directory);
    const dataDirectory = join(directory, "private");
    const databasePath = join(dataDirectory, "demesne.sqlite");
    const store = new DemesneStore(databasePath);
    store.createSession("Private");

    expect(statSync(dataDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(databasePath + suffix)) expect(statSync(databasePath + suffix).mode & 0o077).toBe(0);
    }

    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(databasePath + suffix)) chmodSync(databasePath + suffix, 0o644);
    }
    const reopened = new DemesneStore(databasePath);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(databasePath + suffix)) expect(statSync(databasePath + suffix).mode & 0o077).toBe(0);
    }
    reopened.close();
    store.close();
  });

  test("does not change an existing parent directory mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-storage-test-"));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o755);
    const store = new DemesneStore(join(directory, "demesne.sqlite"));

    expect(statSync(directory).mode & 0o777).toBe(0o755);
    expect(statSync(join(directory, "demesne.sqlite")).mode & 0o777).toBe(0o600);
    store.close();
  });

  test("persists workspace, tool, and permission lifecycle events", () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-storage-test-"));
    temporaryDirectories.push(directory);
    const store = new DemesneStore(join(directory, "demesne.sqlite"));
    const { session, event: sessionEvent } = store.createSession("Tools", directory);
    const { turn } = store.createTurn(session.id, "Edit a file", "ask", false);
    store.startTurn(turn.id);
    const { providerCallId } = store.startProviderCall(turn.id, "provider", "model");
    store.settleProviderCall(providerCallId, "completed");
    const { toolCallId } = store.recordToolCall(turn.id, providerCallId, "provider-call", "edit_file", "{}");
    const { permissionId } = store.requestToolPermission(toolCallId, "write", "edit file.txt");
    store.resolveToolPermission(permissionId, "allow_once");
    store.startToolCall(toolCallId);
    store.settleToolCall(toolCallId, "completed", JSON.stringify({ path: "file.txt", created: true, bytes: 2 }));
    const { toolCallId: writeCallId } = store.recordToolCall(turn.id, providerCallId, "provider-call-write", "write_file", "{}");
    const { permissionId: writePermissionId } = store.requestToolPermission(writeCallId, "write", "write created.txt");
    store.resolveToolPermission(writePermissionId, "allow_once");
    store.startToolCall(writeCallId);
    store.settleToolCall(writeCallId, "completed", JSON.stringify({ path: "created.txt", created: true, bytes: 3 }));

    const snapshot = store.getSession(session.id);
    const events = store.eventsAfter(session.id, 0, 100);
    if (!session.workspace) throw new Error("Expected a workspace-bound session");
    const workspaceId = session.workspace.id;
    expect(snapshot?.workspace).toEqual({ id: workspaceId, root: directory });
    expect(snapshot?.turns[0]?.permissionMode).toBe("ask");
    expect(snapshot?.turns[0]?.thinkingEnabled).toBe(false);
    expect(events.find((event) => event.type === "turn.created")?.payload.thinkingEnabled).toBe(false);
    expect(sessionEvent.workspaceId).toBe(workspaceId);
    expect(events.every((event) => event.workspaceId === workspaceId)).toBe(true);
    expect(events.map((event) => event.type)).toContain("permission.resolved");
    expect(events.map((event) => event.type)).toContain("tool.call_completed");
    expect(events.find((event) => event.type === "tool.call_completed")?.payload).toMatchObject({
      path: "file.txt",
      created: true,
      bytes: 2,
    });
    expect(events.find((event) => event.type === "tool.call_completed" && event.payload.name === "write_file")?.payload).toMatchObject({
      path: "created.txt",
      created: true,
      bytes: 3,
    });
    store.close();
  });
});
