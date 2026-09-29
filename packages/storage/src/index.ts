import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type ImageArtifact,
  type ArtifactPage,
  PROTOCOL_VERSION,
  type ContextPlan,
  type SessionCheckpoint,
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
  type ToolFileChange,
} from "@demesne/protocol";

export interface SnapshotFile {
  path: string;
  existed: boolean;
  data: Uint8Array | null;
  postExisted?: boolean | null;
  postHash?: string | null;
  revertedAt?: string;
}

interface SnapshotRow {
  turn_id: string;
  file_path: string;
  kind: "file" | "absent";
  content: Uint8Array | null;
  post_kind: "file" | "absent" | null;
  post_hash: string | null;
  reverted_at: string | null;
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
  preferred_model: string | null;
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
  plan_only: number | null;
  kind: string;
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
  finish_reason: string | null;
}

interface ModelMessageRow {
  image_artifact_ids_json: string | null;
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
const STORAGE_SCHEMA_VERSION = 6;

export class DemesneStore {
  readonly filename: string;
  readonly database: Database;
  private eventSink: EventSink | undefined;
  private ftsEnabled = false;

  constructor(filename: string, eventSink?: EventSink) {
    this.filename = filename;
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
    // SQLite's default, stated explicitly: some builds (macOS's system SQLite)
    // enable legacy renames, which would hide platform differences in migrations.
    this.database.run("PRAGMA legacy_alter_table = OFF");
    if (filename !== ":memory:") {
      for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
        if (existsSync(path)) chmodSync(path, 0o600);
      }
    }
    this.migrate();
    this.database.run(`CREATE TABLE IF NOT EXISTS image_artifacts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      turn_id TEXT NOT NULL REFERENCES turns(id),
      source_key TEXT NOT NULL UNIQUE,
      descriptor TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS image_artifacts_session ON image_artifacts(session_id, sequence);`);
    if (schemaVersion < STORAGE_SCHEMA_VERSION) this.database.run(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
    this.recoverInterruptedTurns();
  }

  setEventSink(eventSink: EventSink): void {
    this.eventSink = eventSink;
  }

  recordImageArtifact(artifact: ImageArtifact, sourceKey: string): ImageArtifact {
    const result = this.database.transaction(() => {
      const existing = this.database.query("SELECT descriptor FROM image_artifacts WHERE source_key = ?").get(sourceKey) as { descriptor: string } | null;
      if (existing) {
        const saved = JSON.parse(existing.descriptor) as ImageArtifact;
        if (saved.sessionId !== artifact.sessionId || saved.turnId !== artifact.turnId) throw new InvalidStateError("Artifact source identity mismatch");
        return { artifact: saved, event: null };
      }
      if (this.getTurnOrThrow(artifact.turnId).sessionId !== artifact.sessionId) throw new InvalidStateError("Artifact session mismatch");
      this.database.query("INSERT INTO image_artifacts(id,session_id,turn_id,source_key,descriptor) VALUES (?,?,?,?,?)")
        .run(artifact.id, artifact.sessionId, artifact.turnId, sourceKey, JSON.stringify(artifact));
      const event = this.insertEvent("artifact.created", artifact.sessionId, artifact.turnId, { artifact }, artifact.createdAt);
      return { artifact, event };
    })();
    if (result.event) this.eventSink?.(result.event);
    return result.artifact;
  }

  getImageArtifact(sessionId: string, id: string): ImageArtifact | null {
    const row = this.database.query("SELECT descriptor FROM image_artifacts WHERE session_id = ? AND id = ?").get(sessionId, id) as { descriptor: string } | null;
    return row ? JSON.parse(row.descriptor) : null;
  }

  listImageArtifacts(sessionId: string, after = 0, limit = 50): ArtifactPage {
    this.getSessionOrThrow(sessionId);
    return this.database.transaction(() => {
      const rows = this.database.query("SELECT sequence, descriptor FROM image_artifacts WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
        .all(sessionId, after, Math.min(100, Math.max(1, limit)) + 1) as { sequence: number; descriptor: string }[];
      const more = rows.length > Math.min(100, Math.max(1, limit));
      if (more) rows.pop();
      const watermark = (this.database.query("SELECT COALESCE(MAX(id),0) AS id FROM events WHERE session_id = ?").get(sessionId) as { id: number }).id;
      return { artifacts: rows.map((row) => JSON.parse(row.descriptor) as ImageArtifact), nextCursor: more ? rows.at(-1)!.sequence : null, watermark };
    })();
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
               sessions.workspace_id, sessions.archived_at, sessions.preferred_model,
               workspaces.root AS workspace_root
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
      ...(row.preferred_model ? { preferredModel: row.preferred_model } : {}),
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

  /// Records the model a session was last switched to. The daemon does not
  /// auto-switch: the preference is a hint so resuming a session can tell the
  /// user which model it used without forcing an expensive model reload.
  setSessionPreferredModel(id: string, model: string | null): Session {
    return this.database.transaction(() => {
      this.getSessionOrThrow(id);
      this.database.query("UPDATE sessions SET preferred_model = ? WHERE id = ?").run(model, id);
      return this.getSessionOrThrow(id);
    })();
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

  /// Sessions with a queued or running turn, oldest turn first. Used by the
  /// daemon status route and the `demesne ps` dashboard.
  listActiveTurns(): Array<{
    sessionId: string;
    title: string;
    workspaceRoot: string | null;
    turnId: string;
    status: TurnStatus;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.database.query(`
      SELECT turns.id AS turn_id, turns.status AS status, turns.created_at AS created_at,
             sessions.id AS session_id, sessions.title AS title, sessions.updated_at AS updated_at,
             workspaces.root AS workspace_root
      FROM turns
      JOIN sessions ON sessions.id = turns.session_id
      LEFT JOIN workspaces ON workspaces.id = sessions.workspace_id
      WHERE turns.status IN ('queued', 'running')
      ORDER BY turns.created_at, turns.rowid
    `).all() as Array<{
      turn_id: string;
      status: TurnStatus;
      created_at: string;
      session_id: string;
      title: string;
      updated_at: string;
      workspace_root: string | null;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      title: row.title,
      workspaceRoot: row.workspace_root,
      turnId: row.turn_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getSessionState(id: string): {
    session: Session;
    lastEventId: number;
    pendingPermissions: PendingPermissionSnapshot[];
    latestProviderCall: ProviderCallSnapshot | null;
    checkpoint: SessionCheckpoint | null;
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
      const checkpoint = this.getSessionCheckpoint(id);
      const snapshot = latestProviderCall ? mapProviderCallSnapshot(latestProviderCall) : null;
      if (snapshot && checkpoint && checkpoint.turnId === latestProviderCall?.turn_id) snapshot.contextPlan = checkpoint.contextPlan;
      return {
        session,
        lastEventId: latest.id,
        latestProviderCall: snapshot,
        checkpoint,
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
      INSERT INTO model_messages (session_id, turn_id, role, content, tool_call_id, tool_calls_json, created_at, image_artifact_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn.sessionId,
      turnId,
      message.role,
      message.content,
      toolCallId,
      toolCallsJson,
      new Date().toISOString(),
      message.role === "tool" && message.imageArtifactIds?.length ? JSON.stringify(message.imageArtifactIds) : null,
    );
    return { id: Number(result.lastInsertRowid), turnId, message };
  }

  getCompletedModelTranscript(sessionId: string): StoredModelMessage[] {
    return this.readModelTranscript(sessionId, false);
  }

  /// Terminal turns retain useful findings even when they did not finish the
  /// task. Reconstruct only complete tool exchanges for the next model request.
  getModelContextTranscript(sessionId: string): StoredModelMessage[] {
    return this.readModelTranscript(sessionId, true);
  }

  private readModelTranscript(sessionId: string, includeStopped: boolean): StoredModelMessage[] {
    const session = this.getSessionOrThrow(sessionId);
    const rows = this.database.query(`
      SELECT model_messages.id, model_messages.turn_id, model_messages.role, model_messages.content,
              model_messages.tool_call_id, model_messages.tool_calls_json, model_messages.image_artifact_ids_json
      FROM model_messages
      JOIN turns ON turns.id = model_messages.turn_id
      JOIN sessions ON sessions.id = model_messages.session_id
      WHERE model_messages.session_id = ?
        AND (turns.status = 'completed' OR (? AND turns.status IN ('failed', 'cancelled', 'interrupted')))
        AND turns.kind = 'chat'
        AND (sessions.context_start_message_id IS NULL OR model_messages.id >= sessions.context_start_message_id)
      ORDER BY model_messages.id
    `).all(sessionId, includeStopped ? 1 : 0) as ModelMessageRow[];
    const reverted = this.database.query("SELECT turn_id, file_path FROM turn_snapshots WHERE session_id = ? AND reverted_at IS NOT NULL")
      .all(sessionId) as { turn_id: string; file_path: string }[];
    const transcript = rows.flatMap((row, index): StoredModelMessage[] => {
      const message = mapModelMessage(row);
      if (rows[index + 1]?.turn_id === row.turn_id) return [message];
      const paths = reverted.filter((file) => file.turn_id === row.turn_id).map((file) => file.file_path);
      return paths.length ? [message, { id: row.id, turnId: row.turn_id, message: { role: "assistant",
        content: `Recorded user undo: changes to ${JSON.stringify(paths)} from this turn were later reverted. Historical tool results describe the state before undo; inspect current files before further changes.` } }] : [message];
    });
    if (!includeStopped) return transcript;
    const outcomes = new Map((this.database.query(`SELECT turn_id, payload FROM events WHERE session_id = ?
      AND type IN ('turn.failed', 'turn.cancelled', 'turn.interrupted') ORDER BY id`).all(sessionId) as { turn_id: string; payload: string }[])
      .map((row) => [row.turn_id, JSON.parse(row.payload).message as string | undefined]));
    const byTurn = new Map<string, StoredModelMessage[]>();
    for (const entry of transcript) {
      const messages = byTurn.get(entry.turnId) ?? [];
      messages.push(entry);
      byTurn.set(entry.turnId, messages);
    }
    const normalized: StoredModelMessage[] = [];
    for (const turn of session.turns) {
      const messages = byTurn.get(turn.id) ?? [];
      if (turn.status === "completed" || messages.length === 0) { normalized.push(...messages); continue; }
      for (let index = 0; index < messages.length; index++) {
        const entry = messages[index]!;
        if (entry.message.role === "tool") continue; // Orphaned results are not valid provider input.
        if (entry.message.role === "assistant" && entry.message.toolCalls?.length) {
          const results: StoredModelMessage[] = [];
          while (messages[index + 1]?.message.role === "tool") results.push(messages[++index]!);
          const calls = entry.message.toolCalls.filter((call) => results.filter((result) => result.message.role === "tool" && result.message.toolCallId === call.id).length === 1);
          if (calls.length) {
            normalized.push({ ...entry, message: { ...entry.message, toolCalls: calls } });
            for (const call of calls) normalized.push(results.find((result) => result.message.role === "tool" && result.message.toolCallId === call.id)!);
          } else if (entry.message.content) normalized.push({ ...entry, message: { role: "assistant", content: entry.message.content } });
        } else normalized.push(entry);
      }
      normalized.push({ id: messages.at(-1)!.id, turnId: turn.id, message: { role: "assistant", content:
        `Historical turn ended ${turn.status}${outcomes.get(turn.id) ? `: ${outcomes.get(turn.id)!.slice(0, 2000)}` : "."} Its output may be incomplete. Continue from the recorded findings and verify current files before repeating changes; do not assume the task was completed.` } });
    }
    return normalized;
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

  /// Returns a turn's un-reverted snapshot files. Without `turnId` the latest
  /// completed turn that still has un-reverted files is used.
  undoableTurn(sessionId: string, turnId?: string): { turnId: string; files: SnapshotFile[] } | null {
    const row = turnId
      ? this.database.query(`
          SELECT t.id AS turn_id
          FROM turns t
          WHERE t.id = ? AND t.session_id = ? AND t.status = 'completed'
            AND EXISTS (SELECT 1 FROM turn_snapshots s WHERE s.turn_id = t.id AND s.reverted_at IS NULL)
        `).get(turnId, sessionId) as { turn_id: string } | null
      : this.database.query(`
          SELECT t.id AS turn_id
          FROM turns t
          WHERE t.session_id = ? AND t.status = 'completed' AND t.reverted_at IS NULL
            AND EXISTS (SELECT 1 FROM turn_snapshots s WHERE s.turn_id = t.id AND s.reverted_at IS NULL)
          ORDER BY t.completed_at DESC, t.rowid DESC
          LIMIT 1
        `).get(sessionId) as { turn_id: string } | null;
    if (!row) return null;
    const files = this.database
      .query(`
        SELECT file_path, kind, content, post_kind, post_hash, reverted_at
        FROM turn_snapshots WHERE turn_id = ? AND reverted_at IS NULL ORDER BY rowid
      `)
      .all(row.turn_id) as SnapshotRow[];
    return { turnId: row.turn_id, files: files.map(mapSnapshotFile) };
  }

  /// Every snapshot for a turn, including reverted files, for change review.
  snapshotsForTurn(sessionId: string, turnId: string): SnapshotFile[] | null {
    const turn = this.getTurn(turnId);
    if (!turn || turn.sessionId !== sessionId) return null;
    const files = this.database
      .query(`
        SELECT file_path, kind, content, post_kind, post_hash, reverted_at
        FROM turn_snapshots WHERE turn_id = ? ORDER BY rowid
      `)
      .all(turnId) as SnapshotRow[];
    return files.map(mapSnapshotFile);
  }

  /// Marks files reverted. The turn itself is marked reverted only once every
  /// snapshot file has been reverted, so partial reverts stay undoable.
  markTurnReverted(sessionId: string, turnId: string, files: string[]): { event: EventEnvelope; complete: boolean } {
    const result = this.database.transaction(() => {
      const now = new Date().toISOString();
      for (const file of files) {
        this.database.query(
          "UPDATE turn_snapshots SET reverted_at = ? WHERE turn_id = ? AND file_path = ? AND reverted_at IS NULL",
        ).run(now, turnId, file);
      }
      const remaining = this.database
        .query("SELECT COUNT(*) AS count FROM turn_snapshots WHERE turn_id = ? AND reverted_at IS NULL")
        .get(turnId) as { count: number };
      const complete = remaining.count === 0;
      if (complete) {
        this.database.query(
          "UPDATE turns SET reverted_at = ? WHERE id = ? AND session_id = ? AND status = 'completed'",
        ).run(now, turnId, sessionId);
      }
      // Undo can invalidate facts in a summary. Restore full context rather than
      // continue with a checkpoint that claims reverted changes still exist.
      this.database.query("UPDATE sessions SET checkpoint_id = NULL, context_start_message_id = NULL WHERE id = ? AND checkpoint_id IS NOT NULL").run(sessionId);
      const event = this.insertEvent("turn.reverted", sessionId, turnId, { files, complete }, now);
      return { event, complete };
    })();
    this.eventSink?.(result.event);
    return result;
  }

  trimModelContext(turnId: string, firstRetainedMessageId: number, droppedTurnIds: string[]): EventEnvelope {
    const event = this.database.transaction(() => {
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

  getSessionCheckpoint(sessionId: string): SessionCheckpoint | null {
    const row = this.database.query(`SELECT c.descriptor FROM session_checkpoints c
      JOIN sessions s ON s.checkpoint_id = c.id WHERE s.id = ?`).get(sessionId) as { descriptor: string } | null;
    return row ? JSON.parse(row.descriptor) as SessionCheckpoint : null;
  }

  modelContextVersion(sessionId: string): number {
    return (this.database.query(`SELECT COALESCE(MAX(id), 0) AS version FROM events WHERE session_id = ?
      AND type IN ('session.compacted', 'model.context_trimmed', 'turn.reverted')`).get(sessionId) as { version: number }).version;
  }

  completeCompaction(turnId: string, checkpoint: SessionCheckpoint, response: string, expectedVersion: number): void {
    const events = this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      if (turn.kind !== "compaction" || turn.status !== "running" || turn.sessionId !== checkpoint.sessionId || checkpoint.turnId !== turnId) {
        throw new InvalidStateError("Compaction is no longer active");
      }
      if (this.modelContextVersion(turn.sessionId) !== expectedVersion) throw new InvalidStateError("Session context changed during compaction; retry /compact");
      const retained = this.database.query(`SELECT m.session_id FROM model_messages m JOIN turns t ON t.id = m.turn_id
        WHERE m.id = ? AND t.status IN ('completed', 'failed', 'cancelled', 'interrupted') AND t.kind = 'chat' AND m.role = 'user'`).get(checkpoint.firstRetainedMessageId) as { session_id: string } | null;
      if (retained?.session_id !== turn.sessionId) throw new InvalidStateError("Compaction boundary is outside the session");
      this.database.query("INSERT INTO session_checkpoints(id, session_id, turn_id, descriptor) VALUES (?, ?, ?, ?)")
        .run(checkpoint.id, turn.sessionId, turnId, JSON.stringify(checkpoint));
      this.database.query("UPDATE sessions SET checkpoint_id = ?, context_start_message_id = ?, updated_at = ? WHERE id = ?")
        .run(checkpoint.id, checkpoint.firstRetainedMessageId, checkpoint.createdAt, turn.sessionId);
      this.appendModelMessage(turnId, { role: "user", content: turn.content });
      this.appendModelMessage(turnId, { role: "assistant", content: response });
      this.database.query("UPDATE turns SET response_text = ?, status = 'completed', completed_at = ? WHERE id = ?")
        .run(response, checkpoint.createdAt, turnId);
      return [
        this.insertEvent("message.delta", turn.sessionId, turnId, { delta: response }, checkpoint.createdAt),
        this.insertEvent("session.compacted", turn.sessionId, turnId, { checkpoint }, checkpoint.createdAt),
        this.insertEvent("message.completed", turn.sessionId, turnId, {}, checkpoint.createdAt),
        this.insertEvent("turn.completed", turn.sessionId, turnId, {}, checkpoint.createdAt),
      ];
    })();
    events.forEach((event) => this.eventSink?.(event));
  }

  createTurn(
    sessionId: string,
    content: string,
    permissionMode: PermissionMode = "deny",
    thinkingEnabled?: boolean,
    planOnly = false,
    kind: "chat" | "compaction" = "chat",
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
          "INSERT INTO turns (id, session_id, content, response_text, status, created_at, permission_mode, thinking_enabled, plan_only, kind) VALUES (?, ?, ?, '', 'queued', ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          sessionId,
          content,
          now,
          permissionMode,
          thinkingEnabled === undefined ? null : thinkingEnabled ? 1 : 0,
          planOnly ? 1 : 0,
          kind,
        );
      this.database.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
      const event = this.insertEvent("turn.created", sessionId, id, {
        content,
        ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
        ...(planOnly ? { planOnly: true } : {}),
        ...(kind === "compaction" ? { kind } : {}),
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
    finishReason?: string,
  ): EventEnvelope {
    const event = this.database.transaction(() => {
      const call = this.getProviderCallOrThrow(providerCallId);
      if (call.status !== "running") {
        throw new InvalidStateError(`Provider call cannot settle from ${call.status}`);
      }
      const turn = this.getTurnOrThrow(call.turn_id);
      const now = new Date().toISOString();
      this.database
        .query("UPDATE provider_calls SET status = ?, completed_at = ?, error_message = ?, finish_reason = ? WHERE id = ?")
        .run(outcome, now, message ?? null, finishReason ?? null, providerCallId);
      const type = outcome === "completed"
        ? "model.request_completed"
        : outcome === "cancelled"
          ? "model.request_cancelled"
          : "model.request_failed";
      return this.insertEvent(
        type,
        turn.sessionId,
        turn.id,
        { providerCallId, ...(message ? { message } : {}), ...(finishReason !== undefined ? { finishReason } : {}) },
        now,
      );
    })();
    this.eventSink?.(event);
    return event;
  }

  appendToolDraft(turnId: string, draftId: string, name: string, delta: string): void {
    const turn = this.getTurnOrThrow(turnId);
    if (turn.status !== "running") throw new InvalidStateError("Tool draft requires a running turn");
    const event = this.insertEvent("tool.call_draft", turn.sessionId, turnId, { draftId, name, delta }, new Date().toISOString());
    this.eventSink?.(event);
  }

  recordToolCall(
    turnId: string,
    providerCallId: string,
    providerToolCallId: string,
    name: string,
    argumentsJson: string,
    draftId?: string,
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
        { toolCallId, providerToolCallId, providerCallId, name, arguments: argumentsJson, ...(draftId ? { draftId } : {}) },
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
    changes?: ToolFileChange[],
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
        ...(changes?.length ? { changes } : {}),
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

  interruptTurn(turnId: string, message: string): EventEnvelope {
    const event = this.database.transaction(() => {
      const turn = this.getTurnOrThrow(turnId);
      if (turn.status !== "running") throw new InvalidStateError(`Turn cannot stop from ${turn.status}`);
      const now = new Date().toISOString();
      this.database.query("UPDATE turns SET status = 'interrupted', completed_at = ? WHERE id = ?").run(now, turnId);
      this.database.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, turn.sessionId);
      return this.insertEvent("turn.interrupted", turn.sessionId, turnId, { message, reason: "turn_budget" }, now);
    })();
    this.eventSink?.(event);
    return event;
  }

  eventsAfter(sessionId: string, afterEventId: number, limit = 100): EventEnvelope[] {
    this.requireSession(sessionId);
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.database
      .query("SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(sessionId, afterEventId, boundedLimit) as EventRow[];
    return rows.map(mapEvent);
  }

  /// Bounded bulk reads for saved history, pinned to a snapshot cursor even
  /// while a new turn is appending events. Avoid loading all turns per batch.
  eventsBetween(sessionId: string, afterEventId: number, throughEventId: number, limit = 20_000): EventEnvelope[] {
    this.requireSession(sessionId);
    const rows = this.database.query("SELECT * FROM events WHERE session_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?")
      .all(sessionId, afterEventId, throughEventId, Math.max(1, Math.min(limit, 20_000))) as EventRow[];
    return rows.map(mapEvent);
  }

  private requireSession(id: string): void {
    if (!this.database.query("SELECT 1 FROM sessions WHERE id = ?").get(id)) throw new NotFoundError(`Session not found: ${id}`);
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
    if (!this.hasColumn("turns", "plan_only")) {
      this.database.run("ALTER TABLE turns ADD COLUMN plan_only INTEGER NOT NULL DEFAULT 0");
    }
    if (!this.hasColumn("turns", "kind")) this.database.run("ALTER TABLE turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
    if (!this.hasColumn("sessions", "checkpoint_id")) this.database.run("ALTER TABLE sessions ADD COLUMN checkpoint_id TEXT");
    this.database.run(`CREATE TABLE IF NOT EXISTS session_checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
      descriptor TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS session_checkpoints_session ON session_checkpoints(session_id);`);
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
    if (!this.hasColumn("model_messages", "image_artifact_ids_json")) {
      this.database.run("ALTER TABLE model_messages ADD COLUMN image_artifact_ids_json TEXT");
    }
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
    if (!this.hasColumn("provider_calls", "finish_reason")) {
      this.database.run("ALTER TABLE provider_calls ADD COLUMN finish_reason TEXT");
    }
    if (!this.hasColumn("turn_snapshots", "post_kind")) {
      this.database.run("ALTER TABLE turn_snapshots ADD COLUMN post_kind TEXT CHECK (post_kind IN ('file', 'absent'))");
    }
    if (!this.hasColumn("turn_snapshots", "post_hash")) {
      this.database.run("ALTER TABLE turn_snapshots ADD COLUMN post_hash TEXT");
    }
    if (!this.hasColumn("turn_snapshots", "reverted_at")) {
      this.database.run("ALTER TABLE turn_snapshots ADD COLUMN reverted_at TEXT");
    }
    if (!this.hasColumn("sessions", "archived_at")) {
      this.database.run("ALTER TABLE sessions ADD COLUMN archived_at TEXT");
    }
    if (!this.hasColumn("sessions", "preferred_model")) {
      this.database.run("ALTER TABLE sessions ADD COLUMN preferred_model TEXT");
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
        AND turns.kind = 'chat'
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
    // Renaming `turns` must not rewrite other tables' references to it:
    // provider_calls and events keep pointing at "turns", which is rebuilt
    // below, instead of following the rename to the dropped turns_legacy.
    this.database.run("PRAGMA legacy_alter_table = ON");
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
      this.database.run("PRAGMA legacy_alter_table = OFF");
      this.database.run("PRAGMA foreign_keys = ON");
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }
}

function mapSnapshotFile(row: SnapshotRow): SnapshotFile {
  return {
    path: row.file_path,
    existed: row.kind === "file",
    data: row.content,
    postExisted: row.post_kind === null ? null : row.post_kind === "file",
    postHash: row.post_hash,
    ...(row.reverted_at ? { revertedAt: row.reverted_at } : {}),
  };
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
    ...(row.plan_only ? { planOnly: true } : {}),
    ...(row.kind === "compaction" ? { kind: "compaction" as const } : {}),
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
      message: { role: "tool", toolCallId: row.tool_call_id, content: row.content,
        ...(row.image_artifact_ids_json ? { imageArtifactIds: JSON.parse(row.image_artifact_ids_json) as string[] } : {}) },
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
    const limit = 16_000;
    return {
      ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
      ...(typeof value.timedOut === "boolean" ? { timedOut: value.timedOut } : {}),
      ...(typeof value.stdout === "string" ? { stdout: value.stdout.slice(0, limit) } : {}),
      ...(typeof value.stderr === "string" ? { stderr: value.stderr.slice(0, limit) } : {}),
      outputTruncated: value.stdoutTruncated === true || value.stderrTruncated === true
        || (typeof value.stdout === "string" && value.stdout.length > limit)
        || (typeof value.stderr === "string" && value.stderr.length > limit),
    };
  }
  return {};
}
