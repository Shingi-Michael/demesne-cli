import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  PROTOCOL_VERSION,
  type ContextPlan,
  type EventEnvelope,
  type EventType,
  type ModelMessage,
  type PermissionDecision,
  type PermissionMode,
  type PendingPermissionSnapshot,
  type ProviderCallSnapshot,
  type ProviderMetrics,
  type Session,
  type SessionExportTurn,
  type StoredModelMessage,
  type TokenUsage,
  type Turn,
  type TurnStatus,
} from "@demesne/protocol";

export interface SnapshotFile {
  path: string;
  existed: boolean;
  data: Uint8Array | null;
  postExisted?: boolean | null;
  postHash?: string | null;
}

interface SnapshotRow {
  turn_id: string;
  file_path: string;
  kind: "file" | "absent";
  content: Uint8Array | null;
  post_kind: "file" | "absent" | null;
  post_hash: string | null;
}

interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  workspace_id: string | null;
  workspace_root: string | null;
  context_start_message_id: number | null;
  archived_at: string | null;
}

interface TurnRow {
  id: string;
  session_id: string;
  content: string;
  response_text: string;
  status: TurnStatus;
  created_at: string;
  completed_at: string | null;
  permission_mode: PermissionMode;
  thinking_enabled: number | null;
}

interface EventRow {
  id: number;
  type: EventType;
  occurred_at: string;
  workspace_id: string | null;
  session_id: string;
  turn_id: string | null;
  agent_run_id: string | null;
  payload: string;
}

interface ProviderCallRow {
  id: string;
  turn_id: string;
  provider: string;
  model: string;
  status: "running" | "completed" | "cancelled" | "interrupted" | "failed";
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens: number | null;
  queue_duration_ms: number | null;
  duration_ms: number | null;
  time_to_first_token_ms: number | null;
  context_plan_json: string | null;
}

interface ModelMessageRow {
  id: number;
  turn_id: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id: string | null;
  tool_calls_json: string | null;
}

interface ToolCallRow {
  id: string;
  turn_id: string;
  provider_call_id: string;
  provider_tool_call_id: string;
  name: string;
  arguments_json: string;
  status: string;
  permission_id: string | null;
  permission_status: string;
  result_text: string | null;
  error_message: string | null;
}

export class NotFoundError extends Error {}
export class InvalidStateError extends Error {}

export type EventSink = (event: EventEnvelope) => void;
const STORAGE_SCHEMA_VERSION = 2;

export class DemesneStore {
  readonly database: Database;
  private eventSink: EventSink | undefined;
  private ftsEnabled = false;

  constructor(filename: string, eventSink?: EventSink) {
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.database = new Database(filename, { create: true, strict: true });
    const schemaVersion = (this.database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (schemaVersion > STORAGE_SCHEMA_VERSION) {
      this.database.close();
      throw new Error(`Database schema ${schemaVersion} is newer than supported schema ${STORAGE_SCHEMA_VERSION}`);
    }
    this.eventSink = eventSink;
    this.database.run("PRAGMA journal_mode = WAL");
    this.database.run("PRAGMA foreign_keys = ON");
    if (filename !== ":memory:") {
      for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
        if (existsSync(path)) chmodSync(path, 0o600);
      }
    }
    this.migrate();
    if (schemaVersion < STORAGE_SCHEMA_VERSION) this.database.run(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
    this.recoverInterruptedTurns();
  }

  setEventSink(eventSink: EventSink): void {
    this.eventSink = eventSink;
  }

  close(): void {
    this.database.close();
  }

  createSession(title = "New session", workspaceRoot?: string): { session: Session; event: EventEnvelope } {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const result = this.database.transaction(() => {
      let workspaceId: string | null = null;
      if (workspaceRoot) {
        const existing = this.database.query("SELECT id FROM workspaces WHERE root = ?").get(workspaceRoot) as
          | { id: string }
          | null;
        workspaceId = existing?.id ?? crypto.randomUUID();
        if (!existing) {
          this.database.query("INSERT INTO workspaces (id, root, created_at) VALUES (?, ?, ?)")
            .run(workspaceId, workspaceRoot, now);
        }
      }
      this.database
        .query("INSERT INTO sessions (id, title, created_at, updated_at, workspace_id) VALUES (?, ?, ?, ?, ?)")
        .run(id, title, now, now, workspaceId);
      const event = this.insertEvent("session.created", id, null, { title }, now);
      return { session: this.getSessionOrThrow(id), event };
    })();
    this.eventSink?.(result.event);
    return result;
  }

  getSession(id: string): Session | null {
    const row = this.database
      .query(`
        SELECT sessions.id, sessions.title, sessions.created_at, sessions.updated_at,
               sessions.workspace_id, sessions.archived_at, workspaces.root AS workspace_root
        FROM sessions
        LEFT JOIN workspaces ON workspaces.id = sessions.workspace_id
        WHERE sessions.id = ?
      `)
      .get(id) as SessionRow | null;
    if (!row) return null;
    const turns = this.database
      .query("SELECT * FROM turns WHERE session_id = ? ORDER BY rowid")
      .all(id) as TurnRow[];
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      workspace: row.workspace_id && row.workspace_root
        ? { id: row.workspace_id, root: row.workspace_root }
        : null,
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
      turns: turns.map(mapTurn),
    };
  }

  listSessions(limit = 100, options: { includeArchived?: boolean } = {}): Session[] {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows = this.database
      .query(options.includeArchived
        ? "SELECT id FROM sessions ORDER BY updated_at DESC, id LIMIT ?"
        : "SELECT id FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC, id LIMIT ?")
      .all(boundedLimit) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const session = this.getSession(row.id);
      return session ? [session] : [];
    });
  }

  renameSession(id: string, title: string): { session: Session; event: EventEnvelope } {
    const trimmed = title.trim();
    if (!trimmed) throw new InvalidStateError("Session title cannot be empty");
    if (trimmed.length > 200) throw new InvalidStateError("Session title must be at most 200 characters");
    const result = this.database.transaction(() => {
      this.getSessionOrThrow(id);
      const now = new Date().toISOString();
      this.database.query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(trimmed, now, id);
      const event = this.insertEvent("session.renamed", id, null, { title: trimmed }, now);
      return { session: this.getSessionOrThrow(id), event };
    })();
    this.eventSink?.(result.event);
    return result;
  }

  archiveSession(id: string): { session: Session; event: EventEnvelope } {
    const result = this.database.transaction(() => {
      const session = this.getSessionOrThrow(id);
      if (session.archivedAt) throw new InvalidStateError("Session is already archived");
      const now = new Date().toISOString();
      this.database.query("UPDATE sessions SET archived_at = ? WHERE id = ?").run(now, id);
      const event = this.insertEvent("session.archived", id, null, {}, now);
      return { session: this.getSessionOrThrow(id), event };
    })();
    this.eventSink?.(result.event);
    return result;
  }

  /// Title and transcript search. Transcript matches use FTS5 when the SQLite
  /// build provides it and a bounded LIKE scan otherwise; both cover user and
  /// assistant messages only, never tool output or hidden reasoning.
  searchSessions(query: string, limit = 20): Session[] {
    const trimmed = query.trim();
    if (!trimmed) return this.listSessions(limit);
    const bounded = Math.max(1, Math.min(limit, 100));
    const ids = new Set<string>();
    const escaped = trimmed.replace(/[\\%_]/g, (character) => `\\${character}`);
    const like = `%${escaped}%`;
    const titleRows = this.database.query(
      "SELECT id FROM sessions WHERE archived_at IS NULL AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?",
    ).all(like, bounded) as Array<{ id: string }>;
    for (const row of titleRows) ids.add(row.id);

    if (this.ftsEnabled) {
      // Bare quotes would be a syntax error in MATCH; drop them and let the
      // remaining terms run as an AND query.
      const matchQuery = trimmed.replace(/["']/g, " ").replace(/\s+/g, " ").trim();
      if (matchQuery) {
        try {
          const rows = this.database.query(`
            SELECT DISTINCT sessions.id AS id
            FROM message_search
            JOIN sessions ON sessions.id = message_search.session_id
            WHERE message_search MATCH ? AND sessions.archived_at IS NULL
            ORDER BY sessions.updated_at DESC LIMIT ?
          `).all(matchQuery, bounded) as Array<{ id: string }>;
          for (const row of rows) ids.add(row.id);
        } catch {
          // Malformed full-text queries fall back to the title matches.
        }
      }
    } else {
      const rows = this.database.query(`
        SELECT DISTINCT model_messages.session_id AS id
        FROM model_messages
        JOIN sessions ON sessions.id = model_messages.session_id
        WHERE sessions.archived_at IS NULL
          AND model_messages.role IN ('user', 'assistant')
          AND model_messages.content LIKE ? ESCAPE '\\'
        ORDER BY sessions.updated_at DESC LIMIT ?
      `).all(like, bounded) as Array<{ id: string }>;
      for (const row of rows) ids.add(row.id);
    }

    return [...ids]
      .flatMap((id) => {
        const session = this.getSession(id);
        return session ? [session] : [];
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, bounded);
  }

  /// Structured transcript export: each turn's request plus its visible
  /// assistant responses. Hidden reasoning and tool output are excluded.
  getSessionExport(id: string): { session: Session; turns: SessionExportTurn[] } {
    const session = this.getSessionOrThrow(id);
    const rows = this.database.query(`
      SELECT turns.id, turns.content, turns.status, turns.created_at,
             model_messages.content AS response
      FROM turns
      LEFT JOIN model_messages
        ON model_messages.turn_id = turns.id AND model_messages.role = 'assistant'
      WHERE turns.session_id = ?
      ORDER BY turns.rowid, model_messages.id
    `).all(id) as Array<{
      id: string;
      content: string;
      status: TurnStatus;
      created_at: string;
      response: string | null;
    }>;
    const turns: SessionExportTurn[] = [];
    for (const row of rows) {
      const last = turns.at(-1);
      if (last && last.id === row.id) {
        if (row.response) last.responses.push(row.response);
        continue;
      }
      turns.push({
        id: row.id,
        content: row.content,
        status: row.status,
        createdAt: row.created_at,
        responses: row.response ? [row.response] : [],
      });
    }
    return { session, turns };
  }

  getSessionState(id: string): {
    session: Session;
    lastEventId: number;
    pendingPermissions: PendingPermissionSnapshot[];
    latestProviderCall: ProviderCallSnapshot | null;
  } | null {
    return this.database.transaction(() => {
      const session = this.getSession(id);
      if (!session) return null;
      const latest = this.database
        .query("SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE session_id = ?")
        .get(id) as { id: number };
      const rows = this.database.query(`
        SELECT tool_calls.permission_id, tool_calls.id AS tool_call_id, tool_calls.turn_id,
               tool_calls.name, tool_calls.arguments_json
        FROM tool_calls
        JOIN turns ON turns.id = tool_calls.turn_id
        WHERE turns.session_id = ? AND tool_calls.status = 'pending' AND tool_calls.permission_status = 'pending'
        ORDER BY tool_calls.created_at, tool_calls.id
      `).all(id) as Array<{
        permission_id: string;
        tool_call_id: string;
        turn_id: string;
        name: string;
        arguments_json: string;
      }>;
      const latestProviderCall = this.database.query(`
        SELECT provider_calls.*
        FROM provider_calls
        JOIN turns ON turns.id = provider_calls.turn_id
        WHERE turns.session_id = ? AND provider_calls.status = 'completed'
        ORDER BY provider_calls.rowid DESC
        LIMIT 1
      `).get(id) as ProviderCallRow | null;
      return {
        session,
        lastEventId: latest.id,
        latestProviderCall: latestProviderCall ? mapProviderCallSnapshot(latestProviderCall) : null,
        pendingPermissions: rows.map((row) => ({
          id: row.permission_id,
          turnId: row.turn_id,
          toolCallId: row.tool_call_id,
          summary: `${row.name}: ${row.arguments_json}`.slice(0, 500),
        })),
      };
    })();
  }

  getTurn(id: string): Turn | null {
    const row = this.database.query("SELECT * FROM turns WHERE id = ?").get(id) as TurnRow | null;
    return row ? mapTurn(row) : null;
  }

  appendModelMessage(turnId: string, message: Exclude<ModelMessage, { role: "system" }>): StoredModelMessage {
    const turn = this.getTurnOrThrow(turnId);
    if (turn.status !== "running") throw new InvalidStateError(`Turn cannot receive model context from ${turn.status}`);
    const toolCallId = message.role === "tool" ? message.toolCallId : null;
    const toolCallsJson = message.role === "assistant" && message.toolCalls?.length
      ? JSON.stringify(message.toolCalls)
      : null;
    const result = this.database.query(`
      INSERT INTO model_messages (session_id, turn_id, role, content, tool_call_id, tool_calls_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn.sessionId,
      turnId,
      message.role,
      message.content,
      toolCallId,
      toolCallsJson,
      new Date().toISOString(),
    );
    return { id: Number(result.lastInsertRowid), turnId, message };
  }

  getCompletedModelTranscript(sessionId: string): StoredModelMessage[] {
    this.getSessionOrThrow(sessionId);
    const rows = this.database.query(`
      SELECT model_messages.id, model_messages.turn_id, model_messages.role, model_messages.content,
             model_messages.tool_call_id, model_messages.tool_calls_json
      FROM model_messages
      JOIN turns ON turns.id = model_messages.turn_id
      JOIN sessions ON sessions.id = model_messages.session_id
      WHERE model_messages.session_id = ?
        AND turns.status = 'completed'
        AND (sessions.context_start_message_id IS NULL OR model_messages.id >= sessions.context_start_message_id)
      ORDER BY model_messages.id
    `).all(sessionId) as ModelMessageRow[];
    return rows.map(mapModelMessage);
  }

  recordSnapshot(turnId: string, files: SnapshotFile[]): void {
    if (files.length === 0) return;
    this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      if (turn.status !== "running") throw new InvalidStateError("Snapshots require a running turn");
      for (const file of files) {
        this.database.query(`
          INSERT OR IGNORE INTO turn_snapshots (session_id, turn_id, file_path, kind, content)
          VALUES (?, ?, ?, ?, ?)
        `).run(turn.sessionId, turnId, file.path, file.existed ? "file" : "absent", file.data);
      }
    })();
  }

  recordSnapshotPostState(turnId: string, files: SnapshotFile[]): void {
    this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      if (turn.status !== "running") throw new InvalidStateError("Snapshot post-state requires a running turn");
      for (const file of files) {
        const updated = this.database.query(`
          UPDATE turn_snapshots SET post_kind = ?, post_hash = ?
          WHERE turn_id = ? AND file_path = ?
        `).run(file.existed ? "file" : "absent", file.postHash ?? null, turnId, file.path);
        if (Number(updated.changes) !== 1) throw new InvalidStateError(`Snapshot is missing for ${file.path}`);
      }
    })();
  }

  latestUndoableTurn(sessionId: string): { turnId: string; files: SnapshotFile[] } | null {
    const row = this.database.query(`
      SELECT t.id AS turn_id
      FROM turns t
      WHERE t.session_id = ? AND t.status = 'completed' AND t.reverted_at IS NULL
        AND EXISTS (SELECT 1 FROM turn_snapshots s WHERE s.turn_id = t.id)
      ORDER BY t.completed_at DESC, t.rowid DESC
      LIMIT 1
    `).get(sessionId) as { turn_id: string } | null;
    if (!row) return null;
    const files = this.database
      .query("SELECT file_path, kind, content, post_kind, post_hash FROM turn_snapshots WHERE turn_id = ? ORDER BY rowid")
      .all(row.turn_id) as SnapshotRow[];
    return {
      turnId: row.turn_id,
      files: files.map((file) => ({
        path: file.file_path,
        existed: file.kind === "file",
        data: file.content,
        postExisted: file.post_kind === null ? null : file.post_kind === "file",
        postHash: file.post_hash,
      })),
    };
  }

  markTurnReverted(sessionId: string, turnId: string, files: string[]): EventEnvelope {
    const event = this.database.transaction(() => {
      const now = new Date().toISOString();
      const updated = this.database
        .query("UPDATE turns SET reverted_at = ? WHERE id = ? AND session_id = ? AND status = 'completed'")
        .run(now, turnId, sessionId);
      if (Number(updated.changes) !== 1) throw new InvalidStateError(`Turn cannot be reverted: ${turnId}`);
      return this.insertEvent("turn.reverted", sessionId, turnId, { files }, now);
    })();
    this.eventSink?.(event);
    return event;
  }

  trimModelContext(turnId: string, firstRetainedMessageId: number, droppedTurnIds: string[]): EventEnvelope {    const event = this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      if (turn.status !== "running") throw new InvalidStateError(`Turn cannot trim model context from ${turn.status}`);
      const retained = this.database.query("SELECT session_id FROM model_messages WHERE id = ?")
        .get(firstRetainedMessageId) as { session_id: string } | null;
      if (retained?.session_id !== turn.sessionId) throw new InvalidStateError("Context cursor is outside the session");
      this.database.query("UPDATE sessions SET context_start_message_id = ? WHERE id = ?")
        .run(firstRetainedMessageId, turn.sessionId);
      return this.insertEvent("model.context_trimmed", turn.sessionId, turnId, {
        droppedTurnIds,
        firstRetainedMessageId,
      }, new Date().toISOString());
    })();
    this.eventSink?.(event);
    return event;
  }

  createTurn(
    sessionId: string,
    content: string,
    permissionMode: PermissionMode = "deny",
    thinkingEnabled?: boolean,
  ): { turn: Turn; event: EventEnvelope } {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const result = this.database.transaction(() => {
      this.getSessionOrThrow(sessionId);
      const active = this.database
        .query("SELECT COUNT(*) AS count FROM turns WHERE session_id = ? AND status IN ('queued', 'running')")
        .get(sessionId) as { count: number };
      if (active.count > 0) throw new InvalidStateError("Session already has an active turn");
      this.database
        .query(
          "INSERT INTO turns (id, session_id, content, response_text, status, created_at, permission_mode, thinking_enabled) VALUES (?, ?, ?, '', 'queued', ?, ?, ?)",
        )
        .run(id, sessionId, content, now, permissionMode, thinkingEnabled === undefined ? null : thinkingEnabled ? 1 : 0);
      this.database.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
      const event = this.insertEvent("turn.created", sessionId, id, {
        content,
        ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
      }, now);
      return { turn: this.getTurnOrThrow(id), event };
    })();
    this.eventSink?.(result.event);
    return result;
  }

  startTurn(turnId: string): EventEnvelope {
    const event = this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      if (turn.status !== "queued") throw new InvalidStateError(`Turn cannot start from ${turn.status}`);
      const now = new Date().toISOString();
      this.database.query("UPDATE turns SET status = 'running' WHERE id = ?").run(turnId);
      return this.insertEvent("agent.started", turn.sessionId, turnId, {}, now);
    })();
    this.eventSink?.(event);
    return event;
  }

  appendMessageDelta(turnId: string, delta: string): EventEnvelope {
    const event = this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      if (turn.status !== "running") throw new InvalidStateError(`Turn cannot receive output from ${turn.status}`);
      const now = new Date().toISOString();
      this.database
        .query("UPDATE turns SET response_text = response_text || ? WHERE id = ?")
        .run(delta, turnId);
      return this.insertEvent("message.delta", turn.sessionId, turnId, { delta }, now);
    })();
    this.eventSink?.(event);
    return event;
  }

  appendReasoningDelta(turnId: string, delta: string): EventEnvelope {
    const event = this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      if (turn.status !== "running") throw new InvalidStateError(`Turn cannot receive reasoning from ${turn.status}`);
      return this.insertEvent("reasoning.delta", turn.sessionId, turnId, { delta }, new Date().toISOString());
    })();
    this.eventSink?.(event);
    return event;
  }

  completeTurn(turnId: string): EventEnvelope[] {
    const events = this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      if (turn.status !== "running") throw new InvalidStateError(`Turn cannot complete from ${turn.status}`);
      const now = new Date().toISOString();
      this.database
        .query("UPDATE turns SET status = 'completed', completed_at = ? WHERE id = ?")
        .run(now, turnId);
      this.database.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, turn.sessionId);
      return [
        this.insertEvent("message.completed", turn.sessionId, turnId, {}, now),
        this.insertEvent("turn.completed", turn.sessionId, turnId, {}, now),
      ];
    })();
    events.forEach((event) => this.eventSink?.(event));
    return events;
  }

  cancelTurn(turnId: string): { turn: Turn; event: EventEnvelope } {
    const result = this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      if (turn.status !== "queued" && turn.status !== "running") {
        throw new InvalidStateError(`Turn cannot be cancelled from ${turn.status}`);
      }
      const now = new Date().toISOString();
      const toolCalls = this.database
        .query("SELECT * FROM tool_calls WHERE turn_id = ? AND status IN ('pending', 'running')")
        .all(turnId) as ToolCallRow[];
      const toolEvents = toolCalls.map((call) => {
        this.database
          .query(`
            UPDATE tool_calls
            SET status = 'cancelled', completed_at = ?,
                permission_status = CASE WHEN permission_status = 'pending' THEN 'cancelled' ELSE permission_status END
            WHERE id = ?
          `)
          .run(now, call.id);
        return this.insertEvent(
          "tool.call_cancelled",
          turn.sessionId,
          turnId,
          { toolCallId: call.id, name: call.name },
          now,
        );
      });
      const providerCalls = this.database
        .query("SELECT * FROM provider_calls WHERE turn_id = ? AND status = 'running'")
        .all(turnId) as ProviderCallRow[];
      const events = providerCalls.map((call) => {
        this.database
          .query("UPDATE provider_calls SET status = 'cancelled', completed_at = ? WHERE id = ?")
          .run(now, call.id);
        return this.insertEvent(
          "model.request_cancelled",
          turn.sessionId,
          turnId,
          { providerCallId: call.id },
          now,
        );
      });
      this.database
        .query("UPDATE turns SET status = 'cancelled', completed_at = ? WHERE id = ?")
        .run(now, turnId);
      const event = this.insertEvent("turn.cancelled", turn.sessionId, turnId, {}, now);
      return { turn: this.getTurnOrThrow(turnId), event, events: [...toolEvents, ...events, event] };
    })();
    result.events.forEach((event) => this.eventSink?.(event));
    return { turn: result.turn, event: result.event };
  }

  startProviderCall(
    turnId: string,
    provider: string,
    model: string,
    configuration?: {
      profile: string | null;
      thinkingEnabled: boolean | undefined;
      contextPlan?: ContextPlan;
    },
  ): { providerCallId: string; event: EventEnvelope } {
    const providerCallId = crypto.randomUUID();
    const result = this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      if (turn.status !== "running") {
        throw new InvalidStateError(`Provider call cannot start from ${turn.status}`);
      }
      const now = new Date().toISOString();
      this.database
        .query(
          "INSERT INTO provider_calls (id, turn_id, provider, model, status, started_at, context_plan_json) VALUES (?, ?, ?, ?, 'running', ?, ?)",
        )
        .run(providerCallId, turnId, provider, model, now, configuration?.contextPlan ? JSON.stringify(configuration.contextPlan) : null);
      const event = this.insertEvent(
        "model.request_started",
        turn.sessionId,
        turnId,
        {
          providerCallId,
          provider,
          model,
          ...(configuration ? {
            profile: configuration.profile,
            thinkingEnabled: configuration.thinkingEnabled ?? null,
            ...(configuration.contextPlan ? { contextPlan: configuration.contextPlan } : {}),
          } : {}),
        },
        now,
      );
      return { providerCallId, event };
    })();
    this.eventSink?.(result.event);
    return result;
  }

  recordProviderUsage(providerCallId: string, usage: TokenUsage): EventEnvelope {
    const event = this.database.transaction(() => {
      const call = this.getProviderCallOrThrow(providerCallId);
      if (call.status !== "running") {
        throw new InvalidStateError(`Provider call cannot receive usage from ${call.status}`);
      }
      const turn = this.getTurnOrThrow(call.turn_id);
      const now = new Date().toISOString();
      this.database
        .query(
          "UPDATE provider_calls SET input_tokens = ?, output_tokens = ?, total_tokens = ?, cached_input_tokens = ? WHERE id = ?",
        )
        .run(usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cachedInputTokens ?? null, providerCallId);
      return this.insertEvent(
        "model.usage",
        turn.sessionId,
        turn.id,
        { providerCallId, ...usage },
        now,
      );
    })();
    this.eventSink?.(event);
    return event;
  }

  recordProviderMetrics(
    providerCallId: string,
    metrics: ProviderMetrics,
  ): EventEnvelope {
    const event = this.database.transaction(() => {
      const call = this.getProviderCallOrThrow(providerCallId);
      if (call.status !== "running") {
        throw new InvalidStateError(`Provider call cannot receive metrics from ${call.status}`);
      }
      const turn = this.getTurnOrThrow(call.turn_id);
      const now = new Date().toISOString();
      this.database.query(
        "UPDATE provider_calls SET queue_duration_ms = ?, duration_ms = ?, time_to_first_token_ms = ? WHERE id = ?",
      ).run(metrics.queueDurationMs, metrics.durationMs, metrics.timeToFirstTokenMs, providerCallId);
      return this.insertEvent("model.metrics", turn.sessionId, turn.id, { providerCallId, ...metrics }, now);
    })();
    this.eventSink?.(event);
    return event;
  }

  settleProviderCall(
    providerCallId: string,
    outcome: "completed" | "cancelled" | "failed",
    message?: string,
  ): EventEnvelope {
    const event = this.database.transaction(() => {
      const call = this.getProviderCallOrThrow(providerCallId);
      if (call.status !== "running") {
        throw new InvalidStateError(`Provider call cannot settle from ${call.status}`);
      }
      const turn = this.getTurnOrThrow(call.turn_id);
      const now = new Date().toISOString();
      this.database
        .query("UPDATE provider_calls SET status = ?, completed_at = ?, error_message = ? WHERE id = ?")
        .run(outcome, now, message ?? null, providerCallId);
      const type = outcome === "completed"
        ? "model.request_completed"
        : outcome === "cancelled"
          ? "model.request_cancelled"
          : "model.request_failed";
      return this.insertEvent(
        type,
        turn.sessionId,
        turn.id,
        { providerCallId, ...(message ? { message } : {}) },
        now,
      );
    })();
    this.eventSink?.(event);
    return event;
  }

  recordToolCall(
    turnId: string,
    providerCallId: string,
    providerToolCallId: string,
    name: string,
    argumentsJson: string,
  ): { toolCallId: string; event: EventEnvelope } {
    const toolCallId = crypto.randomUUID();
    const result = this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      const now = new Date().toISOString();
      this.database.query(`
        INSERT INTO tool_calls (
          id, turn_id, provider_call_id, provider_tool_call_id, name, arguments_json,
          status, permission_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'not_required', ?)
      `).run(toolCallId, turnId, providerCallId, providerToolCallId, name, argumentsJson, now);
      const event = this.insertEvent(
        "tool.call_requested",
        turn.sessionId,
        turnId,
        { toolCallId, providerToolCallId, providerCallId, name, arguments: argumentsJson },
        now,
      );
      return { toolCallId, event };
    })();
    this.eventSink?.(result.event);
    return result;
  }

  requestToolPermission(
    toolCallId: string,
    kind: "write" | "execute",
    summary: string,
  ): { permissionId: string; event: EventEnvelope } {
    const permissionId = crypto.randomUUID();
    const result = this.database.transaction(() => {
      const call = this.getToolCallOrThrow(toolCallId);
      const turn = this.getTurnOrThrow(call.turn_id);
      if (call.status !== "pending") throw new InvalidStateError("Tool call is not pending");
      const now = new Date().toISOString();
      this.database
        .query("UPDATE tool_calls SET permission_id = ?, permission_status = 'pending' WHERE id = ?")
        .run(permissionId, toolCallId);
      const event = this.insertEvent(
        "permission.requested",
        turn.sessionId,
        turn.id,
        { permissionId, toolCallId, kind, summary, name: call.name, arguments: call.arguments_json },
        now,
      );
      return { permissionId, event };
    })();
    this.eventSink?.(result.event);
    return result;
  }

  resolveToolPermission(permissionId: string, decision: PermissionDecision): EventEnvelope {
    const event = this.database.transaction(() => {
      const call = this.database
        .query("SELECT * FROM tool_calls WHERE permission_id = ?")
        .get(permissionId) as ToolCallRow | null;
      if (!call) throw new NotFoundError(`Permission not found: ${permissionId}`);
      if (call.permission_status !== "pending") throw new InvalidStateError("Permission is no longer pending");
      const turn = this.getTurnOrThrow(call.turn_id);
      const now = new Date().toISOString();
      this.database
        .query("UPDATE tool_calls SET permission_status = ? WHERE id = ?")
        .run(decision === "deny" ? "denied" : "allowed", call.id);
      return this.insertEvent(
        "permission.resolved",
        turn.sessionId,
        turn.id,
        { permissionId, toolCallId: call.id, decision },
        now,
      );
    })();
    this.eventSink?.(event);
    return event;
  }

  startToolCall(toolCallId: string): EventEnvelope {
    const event = this.database.transaction(() => {
      const call = this.getToolCallOrThrow(toolCallId);
      const turn = this.getTurnOrThrow(call.turn_id);
      if (call.status !== "pending") throw new InvalidStateError("Tool call is not pending");
      if (call.permission_status !== "not_required" && call.permission_status !== "allowed") {
        throw new InvalidStateError("Tool call permission is not allowed");
      }
      const now = new Date().toISOString();
      this.database.query("UPDATE tool_calls SET status = 'running', started_at = ? WHERE id = ?")
        .run(now, toolCallId);
      return this.insertEvent("tool.call_started", turn.sessionId, turn.id, {
        toolCallId,
        name: call.name,
      }, now);
    })();
    this.eventSink?.(event);
    return event;
  }

  settleToolCall(
    toolCallId: string,
    outcome: "completed" | "failed" | "denied",
    resultText: string,
  ): EventEnvelope {
    const event = this.database.transaction(() => {
      const call = this.getToolCallOrThrow(toolCallId);
      const turn = this.getTurnOrThrow(call.turn_id);
      if (call.status !== "pending" && call.status !== "running") {
        throw new InvalidStateError(`Tool call cannot settle from ${call.status}`);
      }
      const now = new Date().toISOString();
      this.database.query(`
        UPDATE tool_calls
        SET status = ?, result_text = ?, error_message = ?, completed_at = ?
        WHERE id = ?
      `).run(outcome, resultText, outcome === "failed" ? resultText : null, now, toolCallId);
      const type = outcome === "completed"
        ? "tool.call_completed"
        : outcome === "denied"
          ? "tool.call_denied"
          : "tool.call_failed";
      return this.insertEvent(type, turn.sessionId, turn.id, {
        toolCallId,
        name: call.name,
        outputBytes: Buffer.byteLength(resultText),
        ...toolResultMetadata(call.name, resultText),
        ...(outcome !== "completed" ? { message: resultText } : {}),
      }, now);
    })();
    this.eventSink?.(event);
    return event;
  }

  failTurn(turnId: string, message: string): EventEnvelope {
    const event = this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      if (turn.status !== "queued" && turn.status !== "running") {
        throw new InvalidStateError(`Turn cannot fail from ${turn.status}`);
      }
      const now = new Date().toISOString();
      this.database
        .query("UPDATE turns SET status = 'failed', completed_at = ? WHERE id = ?")
        .run(now, turnId);
      return this.insertEvent("turn.failed", turn.sessionId, turnId, { message }, now);
    })();
    this.eventSink?.(event);
    return event;
  }

  eventsAfter(sessionId: string, afterEventId: number, limit = 100): EventEnvelope[] {
    this.getSessionOrThrow(sessionId);
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.database
      .query("SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(sessionId, afterEventId, boundedLimit) as EventRow[];
    return rows.map(mapEvent);
  }

  private getSessionOrThrow(id: string): Session {
    const session = this.getSession(id);
    if (!session) throw new NotFoundError(`Session not found: ${id}`);
    return session;
  }

  private getTurnOrThrow(id: string): Turn {
    const turn = this.getTurn(id);
    if (!turn) throw new NotFoundError(`Turn not found: ${id}`);
    return turn;
  }

  private getProviderCallOrThrow(id: string): ProviderCallRow {
    const row = this.database.query("SELECT * FROM provider_calls WHERE id = ?").get(id) as ProviderCallRow | null;
    if (!row) throw new NotFoundError(`Provider call not found: ${id}`);
    return row;
  }

  private getToolCallOrThrow(id: string): ToolCallRow {
    const row = this.database.query("SELECT * FROM tool_calls WHERE id = ?").get(id) as ToolCallRow | null;
    if (!row) throw new NotFoundError(`Tool call not found: ${id}`);
    return row;
  }

  private insertEvent(
    type: EventType,
    sessionId: string,
    turnId: string | null,
    payload: Record<string, unknown>,
    occurredAt: string,
  ): EventEnvelope {
    const workspace = this.database
      .query("SELECT workspace_id FROM sessions WHERE id = ?")
      .get(sessionId) as { workspace_id: string | null } | null;
    const result = this.database
      .query(
        "INSERT INTO events (type, occurred_at, workspace_id, session_id, turn_id, payload) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(type, occurredAt, workspace?.workspace_id ?? null, sessionId, turnId, JSON.stringify(payload));
    return {
      schemaVersion: PROTOCOL_VERSION,
      eventId: Number(result.lastInsertRowid),
      type,
      occurredAt,
      workspaceId: workspace?.workspace_id ?? null,
      sessionId,
      turnId,
      agentRunId: null,
      payload,
    };
  }

  private migrate(): void {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id),
        context_start_message_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        response_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        permission_mode TEXT NOT NULL DEFAULT 'deny',
        thinking_enabled INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        workspace_id TEXT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
        agent_run_id TEXT,
        payload TEXT NOT NULL
      );
    `);
    const turnsSchema = this.database
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'")
      .get() as { sql: string } | null;
    if (turnsSchema?.sql.toUpperCase().includes("CHECK")) this.rebuildLegacyTurnTables();
    if (!this.hasColumn("sessions", "workspace_id")) {
      this.database.run("ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)");
    }
    if (!this.hasColumn("sessions", "context_start_message_id")) {
      this.database.run("ALTER TABLE sessions ADD COLUMN context_start_message_id INTEGER");
    }
    if (!this.hasColumn("turns", "permission_mode")) {
      this.database.run("ALTER TABLE turns ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'deny'");
    }
    if (!this.hasColumn("turns", "thinking_enabled")) {
      this.database.run("ALTER TABLE turns ADD COLUMN thinking_enabled INTEGER");
    }
    if (!this.hasColumn("turns", "reverted_at")) {
      this.database.run("ALTER TABLE turns ADD COLUMN reverted_at TEXT");
    }
    this.database.run(`
      CREATE TABLE IF NOT EXISTS provider_calls (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        cached_input_tokens INTEGER,
        queue_duration_ms INTEGER,
        duration_ms INTEGER,
        time_to_first_token_ms INTEGER,
        context_plan_json TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS model_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT,
        tool_call_id TEXT,
        tool_calls_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turn_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'absent')),
        content BLOB,
        post_kind TEXT CHECK (post_kind IN ('file', 'absent')),
        post_hash TEXT,
        UNIQUE (turn_id, file_path)
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        provider_call_id TEXT NOT NULL REFERENCES provider_calls(id) ON DELETE CASCADE,
        provider_tool_call_id TEXT NOT NULL,
        name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        status TEXT NOT NULL,
        permission_id TEXT UNIQUE,
        permission_status TEXT NOT NULL,
        result_text TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS events_session_cursor ON events(session_id, id);
      CREATE INDEX IF NOT EXISTS turns_session_created ON turns(session_id, created_at);
      CREATE INDEX IF NOT EXISTS provider_calls_turn ON provider_calls(turn_id, started_at);
      CREATE INDEX IF NOT EXISTS tool_calls_turn ON tool_calls(turn_id, created_at);
      CREATE INDEX IF NOT EXISTS model_messages_session ON model_messages(session_id, id);
    `);
    if (!this.hasColumn("provider_calls", "cached_input_tokens")) {
      this.database.run("ALTER TABLE provider_calls ADD COLUMN cached_input_tokens INTEGER");
    }
    if (!this.hasColumn("provider_calls", "duration_ms")) {
      this.database.run("ALTER TABLE provider_calls ADD COLUMN duration_ms INTEGER");
    }
    if (!this.hasColumn("provider_calls", "queue_duration_ms")) {
      this.database.run("ALTER TABLE provider_calls ADD COLUMN queue_duration_ms INTEGER");
    }
    if (!this.hasColumn("provider_calls", "time_to_first_token_ms")) {
      this.database.run("ALTER TABLE provider_calls ADD COLUMN time_to_first_token_ms INTEGER");
    }
    if (!this.hasColumn("provider_calls", "context_plan_json")) {
      this.database.run("ALTER TABLE provider_calls ADD COLUMN context_plan_json TEXT");
    }
    if (!this.hasColumn("turn_snapshots", "post_kind")) {
      this.database.run("ALTER TABLE turn_snapshots ADD COLUMN post_kind TEXT CHECK (post_kind IN ('file', 'absent'))");
    }
    if (!this.hasColumn("turn_snapshots", "post_hash")) {
      this.database.run("ALTER TABLE turn_snapshots ADD COLUMN post_hash TEXT");
    }
    if (!this.hasColumn("sessions", "archived_at")) {
      this.database.run("ALTER TABLE sessions ADD COLUMN archived_at TEXT");
    }
    this.backfillModelMessages();
    this.migrateSearchIndex();
  }

  /// FTS5 index over visible user and assistant messages. SQLite builds
  /// without FTS5 fall back to a bounded LIKE scan in `searchSessions`.
  private migrateSearchIndex(): void {
    const existing = this.database
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_search'")
      .get() as { name: string } | null;
    if (!existing) {
      try {
        this.database.run(
          "CREATE VIRTUAL TABLE message_search USING fts5(content, session_id UNINDEXED, turn_id UNINDEXED)",
        );
      } catch {
        this.ftsEnabled = false;
        return;
      }
      this.ftsEnabled = true;
      this.database.run(`
        INSERT INTO message_search(rowid, content, session_id, turn_id)
        SELECT id, content, session_id, turn_id FROM model_messages
        WHERE role IN ('user', 'assistant') AND content IS NOT NULL AND content <> ''
      `);
    } else {
      this.ftsEnabled = true;
    }
    this.database.run(`
      CREATE TRIGGER IF NOT EXISTS model_messages_search_insert AFTER INSERT ON model_messages
      WHEN new.role IN ('user', 'assistant') AND new.content IS NOT NULL AND new.content <> ''
      BEGIN
        INSERT INTO message_search(rowid, content, session_id, turn_id)
        VALUES (new.id, new.content, new.session_id, new.turn_id);
      END;
      CREATE TRIGGER IF NOT EXISTS model_messages_search_delete AFTER DELETE ON model_messages
      BEGIN
        DELETE FROM message_search WHERE rowid = old.id;
      END;
    `);
  }

  private backfillModelMessages(): void {
    const rows = this.database.query(`
      SELECT turns.id, turns.session_id, turns.content, turns.response_text,
             turns.created_at, turns.completed_at
      FROM turns
      WHERE turns.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM model_messages WHERE model_messages.turn_id = turns.id)
      ORDER BY turns.rowid
    `).all() as Array<{
      id: string;
      session_id: string;
      content: string;
      response_text: string;
      created_at: string;
      completed_at: string | null;
    }>;
    this.database.transaction(() => {
      for (const row of rows) {
        this.database.query(`
          INSERT INTO model_messages (session_id, turn_id, role, content, created_at)
          VALUES (?, ?, 'user', ?, ?)
        `).run(row.session_id, row.id, row.content, row.created_at);
        const toolCalls = this.database.query(`
          SELECT tool_calls.*
          FROM tool_calls
          JOIN provider_calls ON provider_calls.id = tool_calls.provider_call_id
          WHERE tool_calls.turn_id = ?
          ORDER BY provider_calls.rowid, tool_calls.rowid
        `).all(row.id) as ToolCallRow[];
        const callsByProvider = new Map<string, ToolCallRow[]>();
        for (const call of toolCalls) {
          const calls = callsByProvider.get(call.provider_call_id) ?? [];
          calls.push(call);
          callsByProvider.set(call.provider_call_id, calls);
        }
        for (const calls of callsByProvider.values()) {
          this.database.query(`
            INSERT INTO model_messages (session_id, turn_id, role, content, tool_calls_json, created_at)
            VALUES (?, ?, 'assistant', NULL, ?, ?)
          `).run(row.session_id, row.id, JSON.stringify(calls.map((call) => ({
            id: call.provider_tool_call_id,
            name: call.name,
            arguments: call.arguments_json,
          }))), row.created_at);
          for (const call of calls) {
            this.database.query(`
              INSERT INTO model_messages (session_id, turn_id, role, content, tool_call_id, created_at)
              VALUES (?, ?, 'tool', ?, ?, ?)
            `).run(
              row.session_id,
              row.id,
              call.result_text ?? call.error_message ?? `Error: tool call ended with ${call.status}`,
              call.provider_tool_call_id,
              row.completed_at ?? row.created_at,
            );
          }
        }
        this.database.query(`
          INSERT INTO model_messages (session_id, turn_id, role, content, created_at)
          VALUES (?, ?, 'assistant', ?, ?)
        `).run(row.session_id, row.id, row.response_text, row.completed_at ?? row.created_at);
      }
    })();
  }

  private recoverInterruptedTurns(): void {
    const events = this.database.transaction(() => {
      const toolCalls = this.database.query(`
        SELECT tool_calls.*, turns.session_id
        FROM tool_calls
        JOIN turns ON turns.id = tool_calls.turn_id
        WHERE tool_calls.status IN ('pending', 'running')
        ORDER BY tool_calls.created_at, tool_calls.id
      `).all() as Array<ToolCallRow & { session_id: string }>;
      const toolEvents = toolCalls.map((call) => {
        const now = new Date().toISOString();
        this.database.query(`
          UPDATE tool_calls
          SET status = 'interrupted',
              permission_status = CASE WHEN permission_status = 'pending' THEN 'denied' ELSE permission_status END,
              completed_at = ?
          WHERE id = ?
        `).run(now, call.id);
        return this.insertEvent("tool.call_interrupted", call.session_id, call.turn_id, {
          toolCallId: call.id,
          name: call.name,
        }, now);
      });
      const providerCalls = this.database
        .query(`
          SELECT provider_calls.*, turns.session_id
          FROM provider_calls
          JOIN turns ON turns.id = provider_calls.turn_id
          WHERE provider_calls.status = 'running'
          ORDER BY provider_calls.started_at, provider_calls.id
        `)
        .all() as Array<ProviderCallRow & { session_id: string }>;
      const providerEvents = providerCalls.map((call) => {
        const now = new Date().toISOString();
        this.database
          .query("UPDATE provider_calls SET status = 'interrupted', completed_at = ? WHERE id = ?")
          .run(now, call.id);
        return this.insertEvent(
          "model.request_interrupted",
          call.session_id,
          call.turn_id,
          { providerCallId: call.id, message: "Daemon stopped during the model request" },
          now,
        );
      });
      const turns = this.database
        .query("SELECT * FROM turns WHERE status IN ('queued', 'running') ORDER BY created_at, id")
        .all() as TurnRow[];
      const turnEvents = turns.map((turn) => {
        const now = new Date().toISOString();
        this.database
          .query("UPDATE turns SET status = 'interrupted', completed_at = ? WHERE id = ?")
          .run(now, turn.id);
        return this.insertEvent(
          "turn.interrupted",
          turn.session_id,
          turn.id,
          { message: "Daemon stopped before the turn completed" },
          now,
        );
      });
      return [...toolEvents, ...providerEvents, ...turnEvents];
    })();
    events.forEach((event) => this.eventSink?.(event));
  }

  private rebuildLegacyTurnTables(): void {
    const hasPermissionMode = this.hasColumn("turns", "permission_mode");
    const hasThinkingEnabled = this.hasColumn("turns", "thinking_enabled");
    this.database.run("PRAGMA foreign_keys = OFF");
    try {
      this.database.transaction(() => {
        this.database.run(`
          ALTER TABLE events RENAME TO events_legacy;
          ALTER TABLE turns RENAME TO turns_legacy;
          CREATE TABLE turns (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            response_text TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            permission_mode TEXT NOT NULL DEFAULT 'deny',
            thinking_enabled INTEGER
          );
          INSERT INTO turns (id, session_id, content, response_text, status, created_at, completed_at, permission_mode, thinking_enabled)
          SELECT id, session_id, content, response_text, status, created_at, completed_at,
                 ${hasPermissionMode ? "permission_mode" : "'deny'"},
                 ${hasThinkingEnabled ? "thinking_enabled" : "NULL"}
          FROM turns_legacy;
          CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            workspace_id TEXT,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
            agent_run_id TEXT,
            payload TEXT NOT NULL
          );
          INSERT INTO events (id, type, occurred_at, workspace_id, session_id, turn_id, agent_run_id, payload)
          SELECT id, type, occurred_at, workspace_id, session_id, turn_id, agent_run_id, payload FROM events_legacy;
          DROP TABLE events_legacy;
          DROP TABLE turns_legacy;
        `);
      })();
    } finally {
      this.database.run("PRAGMA foreign_keys = ON");
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }
}

function mapTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    responseText: row.response_text,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    permissionMode: row.permission_mode,
    thinkingEnabled: row.thinking_enabled === null ? null : row.thinking_enabled !== 0,
  };
}

function mapProviderCallSnapshot(row: ProviderCallRow): ProviderCallSnapshot {
  const hasUsage = row.input_tokens !== null || row.output_tokens !== null || row.total_tokens !== null;
  return {
    provider: row.provider,
    model: row.model,
    contextPlan: row.context_plan_json ? JSON.parse(row.context_plan_json) as ContextPlan : null,
    usage: hasUsage
      ? {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
        ...(row.cached_input_tokens !== null ? { cachedInputTokens: row.cached_input_tokens } : {}),
      }
      : null,
    metrics: row.duration_ms === null
      ? null
      : {
        queueDurationMs: row.queue_duration_ms,
        durationMs: row.duration_ms,
        timeToFirstTokenMs: row.time_to_first_token_ms,
      },
  };
}

function mapModelMessage(row: ModelMessageRow): StoredModelMessage {
  if (row.role === "user") {
    if (row.content === null) throw new InvalidStateError(`User model message ${row.id} has no content`);
    return { id: row.id, turnId: row.turn_id, message: { role: "user", content: row.content } };
  }
  if (row.role === "tool") {
    if (row.content === null || !row.tool_call_id) {
      throw new InvalidStateError(`Tool model message ${row.id} is incomplete`);
    }
    return {
      id: row.id,
      turnId: row.turn_id,
      message: { role: "tool", toolCallId: row.tool_call_id, content: row.content },
    };
  }
  let toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
  if (row.tool_calls_json) {
    const parsed: unknown = JSON.parse(row.tool_calls_json);
    if (!Array.isArray(parsed) || !parsed.every(isStoredToolCall)) {
      throw new InvalidStateError(`Assistant model message ${row.id} has invalid tool calls`);
    }
    toolCalls = parsed;
  }
  return {
    id: row.id,
    turnId: row.turn_id,
    message: {
      role: "assistant",
      content: row.content,
      ...(toolCalls?.length ? { toolCalls } : {}),
    },
  };
}

function isStoredToolCall(value: unknown): value is { id: string; name: string; arguments: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const call = value as Record<string, unknown>;
  return typeof call.id === "string" && typeof call.name === "string" && typeof call.arguments === "string";
}

function mapEvent(row: EventRow): EventEnvelope {
  return {
    schemaVersion: PROTOCOL_VERSION,
    eventId: row.id,
    type: row.type,
    occurredAt: row.occurred_at,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    agentRunId: row.agent_run_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

function toolResultMetadata(name: string, resultText: string): Record<string, unknown> {
  let result: unknown;
  try {
    result = JSON.parse(resultText);
  } catch {
    return {};
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) return {};
  const value = result as Record<string, unknown>;
  if (name === "edit_file" || name === "write_file") {
    return {
      ...(typeof value.path === "string" ? { path: value.path } : {}),
      ...(typeof value.created === "boolean" ? { created: value.created } : {}),
      ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
    };
  }
  if (name === "move_path") {
    return {
      ...(typeof value.from === "string" ? { from: value.from } : {}),
      ...(typeof value.to === "string" ? { to: value.to } : {}),
      ...(typeof value.moved === "boolean" ? { moved: value.moved } : {}),
    };
  }
  if (name === "delete_path") {
    return {
      ...(typeof value.path === "string" ? { path: value.path } : {}),
      ...(typeof value.deleted === "boolean" ? { deleted: value.deleted } : {}),
      ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
    };
  }
  if (name === "run_command") {
    return {
      ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
      ...(typeof value.timedOut === "boolean" ? { timedOut: value.timedOut } : {}),
    };
  }
  return {};
}
