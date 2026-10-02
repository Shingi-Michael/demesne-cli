export const PROTOCOL_VERSION = 1 as const;
export * from "./drive.ts";
export * from "./panels.ts";

export type EventType =
  | "command.changed"
  | "artifact.created"
  | "session.created"
  | "session.renamed"
  | "session.archived"
  | "session.compacted"
  | "turn.created"
  | "agent.started"
  | "model.request_started"
  | "model.usage"
  | "model.metrics"
  | "model.context_trimmed"
  | "model.request_completed"
  | "model.request_failed"
  | "model.request_cancelled"
  | "model.request_interrupted"
  | "tool.call_requested"
  | "tool.call_draft"
  | "permission.requested"
  | "permission.resolved"
  | "question.requested"
  | "question.resolved"
  | "tool.call_started"
  | "tool.call_progress"
  | "tool.call_completed"
  | "tool.call_failed"
  | "tool.call_denied"
  | "tool.call_cancelled"
  | "tool.call_interrupted"
  | "reasoning.delta"
  | "message.delta"
  | "message.completed"
  | "turn.completed"
  | "turn.reverted"
  | "turn.cancelled"
  | "turn.interrupted"
  | "turn.failed";

export type TurnStatus = "queued" | "running" | "completed" | "cancelled" | "interrupted" | "failed";

/// Immutable per-operation file evidence. Omitted text is explicit (binary or
/// over the preview limit); null means the file did not exist on that side.
export interface ToolFileChange {
  path: string;
  before: string | null;
  after: string | null;
  beforeExists: boolean;
  afterExists: boolean;
  unavailable?: string;
}

export interface ImageArtifact {
  id: string;
  kind: "image";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  createdAt: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  source: { kind: "mcp" | "tool"; name: string; modelId: string | null };
  revisionOf: string | null;
  viewport?: {width:number;height:number;deviceScaleFactor?:number};
}

export interface ArtifactPage {
  artifacts: ImageArtifact[];
  nextCursor: number | null;
  watermark: number;
}

export interface ModelDescriptor {
  displayName?: string;
  id: string;
  provider: string;
  ownedBy?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type RuntimeProfileState = "unconfigured" | "pending" | "verified" | "mismatch" | "unavailable";

export interface RuntimeProfileSettings {
  contextWindow: number;
  batchSize: number;
  microBatchSize: number;
  parallelSequences: number;
  keyCacheType: string;
  valueCacheType: string;
  flashAttention: string;
  loadedModels: number;
  speculationType?: string;
  visionEnabled?: boolean;
  loadMode?: string;
}

export interface ObservedRuntimeSettings {
  model: string | null;
  contextWindow: number | null;
  batchSize: number | null;
  microBatchSize: number | null;
  parallelSequences: number | null;
  keyCacheType: string | null;
  valueCacheType: string | null;
  flashAttention: string | null;
  loadedModels: number;
  runnerProcesses: number;
  speculationType?: string;
  visionEnabled?: boolean;
  loadMode?: string;
}

export interface RuntimeProfileStatus {
  profile: string | null;
  state: RuntimeProfileState;
  expected: RuntimeProfileSettings | null;
  observed: ObservedRuntimeSettings | null;
  mismatches: string[];
  observedAt: string | null;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens?: number;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface WorkspaceFileInfo { path: string; byteLength: number | null; status: string | null }
/// A workspace file's text for the file viewer; `content` is null with a
/// `reason` when it cannot be shown (protected, binary, too large, missing).
export interface WorkspaceFileStatus { path: string; byteLength: number | null; revision?: string; modifiedAt?: string; reason?: string }
export interface WorkspaceFileText extends WorkspaceFileStatus { content: string | null }

/// Opaque Responses items, retained for stateless tool and reasoning continuity.
export interface ResponsesState { accountId: string; model: string; output: Record<string, unknown>[] }

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ModelToolCall[]; responses?: ResponsesState }
  | { role: "tool"; toolCallId: string; content: string; imageArtifactIds?: string[] };

export interface StoredModelMessage {
  id: number;
  turnId: string;
  message: ModelMessage;
}

export interface ProviderMetrics {
  queueDurationMs: number | null;
  durationMs: number;
  timeToFirstTokenMs: number | null;
}

export type ContextBudgetStatus =
  | "capacity_unknown"
  | "within_soft_limit"
  | "over_soft_limit"
  | "over_hard_limit"
  | "over_capacity";

export interface HistoricalToolOutputTruncationAction {
  kind: "truncate_historical_tool_output";
  scope?: "historical" | "current_turn";
  messageIndex: number;
  originalCharacters: number;
  compactedCharacters: number;
  removedLines: number;
  estimatedTokensSaved: number;
}

export interface HistoricalFileContentDeduplicationAction {
  kind: "deduplicate_historical_file_content";
  messageIndex: number;
  retainedMessageIndex: number;
  toolCallId: string;
  retainedToolCallId: string;
  path: string;
  originalCharacters: number;
  compactedCharacters: number;
  estimatedTokensSaved: number;
}

export interface HistoricalTurnDropAction {
  kind: "drop_historical_turn";
  turnId: string;
  messageStartIndex: number;
  messageCount: number;
  estimatedTokensSaved: number;
}

export type ContextCompactionAction =
  | HistoricalToolOutputTruncationAction
  | HistoricalFileContentDeduplicationAction
  | HistoricalTurnDropAction;

export interface ContextPlan {
  schemaVersion: 1 | 2 | 3;
  estimator:
    | {
      method: "openai-json-utf8-bytes-divisor-3";
      version: 1;
    }
    | {
      method: "openai-json-utf8-bytes-divisor-3";
      version: 2;
      safetyFactor: 1.2;
    };
  capacityTokens: number | null;
  reserves: {
    outputTokens: number | null;
    toolResultTokens: number;
    safetyTokens: number;
    totalTokens: number | null;
  };
  maximumPlannedInputTokens: number | null;
  hardInputLimitTokens: number | null;
  originalEstimatedInputTokens: number;
  estimatedInputTokens: number;
  estimatedMessageTokens: number;
  estimatedToolDefinitionTokens: number;
  budgetStatus: ContextBudgetStatus;
  actions: ContextCompactionAction[];
}

export interface ProviderCallSnapshot {
  provider: string;
  model: string;
  contextPlan: ContextPlan | null;
  usage: TokenUsage | null;
  metrics: ProviderMetrics | null;
}

export interface EventEnvelope {
  schemaVersion: typeof PROTOCOL_VERSION;
  eventId: number;
  type: EventType;
  occurredAt: string;
  workspaceId: string | null;
  sessionId: string;
  turnId: string | null;
  agentRunId: string | null;
  payload: Record<string, unknown>;
}

/// Historical transport can combine consecutive, nonempty text deltas. The
/// envelope retains the first event's ID/time; these fields describe its range.
/// Live SSE and the durable event journal always retain the original events.
export interface ReplayEvent extends EventEnvelope {
  throughEventId?: number;
  deltaCount?: number;
}

export interface SessionReplayPage {
  events: ReplayEvent[];
  throughEventId: number;
  nextCursor: number | null;
}

export interface Turn {
  id: string;
  sessionId: string;
  content: string;
  responseText: string;
  status: TurnStatus;
  createdAt: string;
  completedAt: string | null;
  permissionMode: PermissionMode;
  thinkingEnabled: boolean | null;
  /// Read-only planning turn: write and execution tools are not offered.
  planOnly?: boolean;
  kind?: "compaction";
}

export interface SessionCheckpoint {
  id: string;
  sessionId: string;
  turnId: string;
  createdAt: string;
  summary: string;
  instructions: string;
  firstRetainedMessageId: number;
  summarizedTurns: number;
  retainedTurns: number;
  beforeTokens: number;
  afterTokens: number;
  contextPlan: ContextPlan;
}

export interface CompactSessionRequest {
  instructions?: string;
}

export type PermissionMode = "ask" | "deny";
export type PermissionDecision = "allow_once" | "allow_session" | "allow_always" | "deny";

export interface Workspace {
  id: string;
  root: string;
  /// Current branch of the workspace repository, when it is a clean git
  /// checkout. Populated by the daemon when session state is read; absent for
  /// non-repositories and detached HEADs.
  gitBranch?: string;
}

export interface PendingPermissionSnapshot {
  id: string;
  turnId: string;
  toolCallId: string;
  summary: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspace: Workspace | null;
  turns: Turn[];
  /// Set when the session has been archived; archived sessions are excluded
  /// from the default listing but remain readable and exportable.
  archivedAt?: string | null;
  /// Model this session was last switched to through the CLI. It is a hint for
  /// the user, not an automatic daemon-side switch.
  preferredModel?: string | null;
}

export interface UpdateSessionRequest {
  title?: string;
  preferredModel?: string | null;
}

export interface UpdateSessionResponse {
  session: Session;
  eventId: number | null;
}

export interface ArchiveSessionResponse {
  session: Session;
  eventId: number;
}

export interface SessionExportTurn {
  id: string;
  content: string;
  status: TurnStatus;
  createdAt: string;
  responses: string[];
}

export interface SessionExport {
  session: Session;
  turns: SessionExportTurn[];
}

export interface SessionStateResponse {
  session: Session;
  lastEventId: number;
  pendingPermissions: PendingPermissionSnapshot[];
  latestProviderCall: ProviderCallSnapshot | null;
  /// `argv`/`cwd` are set for command grants: that exact command, there.
  sessionGrants?: Array<{ tool: string; pathPrefix: string; argv?: string[]; cwd?: string }>;
  checkpoint?: SessionCheckpoint | null;
}

export interface WorkspaceFilesResponse {
  files: string[];
}

export interface ActiveSessionStatus {
  id: string;
  title: string;
  workspace: string | null;
  turnId: string;
  turnStatus: TurnStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DaemonStatusResponse {
  version?: string;
  provider: string;
  model: string;
  inferenceSlots: number;
  activeInferences: number;
  queuedInferences: number;
  active: ActiveSessionStatus[];
}

export interface CreateSessionRequest {
  title?: string;
  workspacePath?: string;
}

export interface CreateSessionResponse {
  session: Session;
  eventId: number;
}

export interface SubmitTurnRequest {
  content: string;
  permissionMode?: PermissionMode;
  thinkingEnabled?: boolean;
  planOnly?: boolean;
}

export interface SubmitTurnResponse {
  turn: Turn;
  eventId: number;
}

export interface CancelTurnResponse {
  turn: Turn;
  eventId: number;
}

export interface UndoSessionRequest {
  turnId?: string;
  paths?: string[];
}

export interface UndoTurnResponse {
  turnId: string;
  files: string[];
  complete: boolean;
}

export interface TurnChange {
  path: string;
  operation: "A" | "M" | "D";
  reverted: boolean;
  binary?: boolean;
  diff: string[];
}

export interface TurnChangesResponse {
  turnId: string;
  changes: TurnChange[];
}

export interface ResolvePermissionRequest {
  decision: PermissionDecision;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export class ProtocolValidationError extends Error {}

export class EventStreamHttpError extends Error {
  constructor(readonly status: number) {
    super(`Event stream failed with HTTP ${status}`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCreateSessionRequest(value: unknown): CreateSessionRequest {
  if (!isRecord(value)) throw new ProtocolValidationError("Request body must be a JSON object");
  if (value.title !== undefined && typeof value.title !== "string") {
    throw new ProtocolValidationError("title must be a string");
  }
  const title = typeof value.title === "string" ? value.title.trim() : undefined;
  if (title && title.length > 200) throw new ProtocolValidationError("title must be at most 200 characters");
  if (value.workspacePath !== undefined && typeof value.workspacePath !== "string") {
    throw new ProtocolValidationError("workspacePath must be a string");
  }
  const workspacePath = typeof value.workspacePath === "string" ? value.workspacePath.trim() : undefined;
  if (workspacePath && workspacePath.length > 4_096) {
    throw new ProtocolValidationError("workspacePath must be at most 4096 characters");
  }
  return { ...(title ? { title } : {}), ...(workspacePath ? { workspacePath } : {}) };
}

export function parseUndoSessionRequest(value: unknown): UndoSessionRequest {
  if (!isRecord(value)) throw new ProtocolValidationError("Request body must be a JSON object");
  const request: UndoSessionRequest = {};
  if (value.turnId !== undefined) {
    if (typeof value.turnId !== "string" || !value.turnId.trim()) {
      throw new ProtocolValidationError("turnId must be a non-empty string");
    }
    request.turnId = value.turnId.trim();
  }
  if (value.paths !== undefined) {
    if (!Array.isArray(value.paths) || value.paths.some((path) => typeof path !== "string" || !path.trim())) {
      throw new ProtocolValidationError("paths must be a list of non-empty strings");
    }
    if (value.paths.length > 100) throw new ProtocolValidationError("paths must contain at most 100 entries");
    request.paths = value.paths.map((path) => (path as string).trim());
  }
  return request;
}

export function parseUpdateSessionRequest(value: unknown): UpdateSessionRequest {
  if (!isRecord(value)) throw new ProtocolValidationError("Request body must be a JSON object");
  const update: UpdateSessionRequest = {};
  if (value.title !== undefined) {
    if (typeof value.title !== "string") throw new ProtocolValidationError("title must be a string");
    const title = value.title.trim();
    if (!title) throw new ProtocolValidationError("title cannot be empty");
    if (title.length > 200) throw new ProtocolValidationError("title must be at most 200 characters");
    update.title = title;
  }
  if (value.preferredModel !== undefined) {
    if (value.preferredModel !== null && typeof value.preferredModel !== "string") {
      throw new ProtocolValidationError("preferredModel must be a string or null");
    }
    if (typeof value.preferredModel === "string") {
      const preferredModel = value.preferredModel.trim();
      if (!preferredModel) throw new ProtocolValidationError("preferredModel cannot be empty");
      if (preferredModel.length > 200) throw new ProtocolValidationError("preferredModel must be at most 200 characters");
      update.preferredModel = preferredModel;
    } else {
      update.preferredModel = null;
    }
  }
  if (update.title === undefined && update.preferredModel === undefined) {
    throw new ProtocolValidationError("title or preferredModel is required");
  }
  return update;
}

export function parseCompactSessionRequest(value: unknown): CompactSessionRequest {
  if (!isRecord(value)) throw new ProtocolValidationError("Request body must be a JSON object");
  if (Object.keys(value).some((key) => key !== "instructions")) throw new ProtocolValidationError("Only compaction instructions may be provided");
  if (value.instructions !== undefined && typeof value.instructions !== "string") throw new ProtocolValidationError("instructions must be a string");
  const instructions = typeof value.instructions === "string" ? value.instructions.trim() : "";
  if (instructions.length > 4000) throw new ProtocolValidationError("instructions must be at most 4000 characters");
  return instructions ? { instructions } : {};
}

export function parseSubmitTurnRequest(value: unknown): SubmitTurnRequest {
  if (!isRecord(value)) throw new ProtocolValidationError("Request body must be a JSON object");
  if (typeof value.content !== "string") throw new ProtocolValidationError("content must be a string");
  const content = value.content.trim();
  if (!content) throw new ProtocolValidationError("content cannot be empty");
  if (content.length > 100_000) {
    throw new ProtocolValidationError("content must be at most 100000 characters");
  }
  if (value.permissionMode !== undefined && value.permissionMode !== "ask" && value.permissionMode !== "deny") {
    throw new ProtocolValidationError("permissionMode must be ask or deny");
  }
  if (value.thinkingEnabled !== undefined && typeof value.thinkingEnabled !== "boolean") {
    throw new ProtocolValidationError("thinkingEnabled must be a boolean");
  }
  if (value.planOnly !== undefined && typeof value.planOnly !== "boolean") {
    throw new ProtocolValidationError("planOnly must be a boolean");
  }
  return {
    content,
    ...(value.permissionMode ? { permissionMode: value.permissionMode } : {}),
    ...(value.thinkingEnabled !== undefined ? { thinkingEnabled: value.thinkingEnabled } : {}),
    ...(value.planOnly !== undefined ? { planOnly: value.planOnly } : {}),
  };
}

/// A question the agent puts to the user mid-turn (`ask_user`). The first
/// suggestion is the agent's recommended answer.
export interface UserQuestion {
  question: string;
  reason?: string;
  suggestions: string[];
}

/// How one question was answered: a suggestion taken as offered, the user's
/// own words, or skipped (the agent decides and says what it assumed).
export interface UserAnswer {
  answer: string | null;
  source: "suggestion" | "typed" | "skipped";
}

export interface AnswerQuestionsRequest {
  answers: UserAnswer[];
}

export const MAX_USER_QUESTIONS = 4;
export const MAX_QUESTION_SUGGESTIONS = 4;

export function parseUserQuestions(value: unknown): UserQuestion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_USER_QUESTIONS) {
    throw new ProtocolValidationError(`questions must be an array of 1 to ${MAX_USER_QUESTIONS} questions`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.question !== "string" || !entry.question.trim() || entry.question.length > 500) {
      throw new ProtocolValidationError(`questions[${index}].question must be 1 to 500 characters`);
    }
    if (entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.length > 500)) {
      throw new ProtocolValidationError(`questions[${index}].reason must be at most 500 characters`);
    }
    const suggestions = entry.suggestions ?? [];
    if (!Array.isArray(suggestions) || suggestions.length > MAX_QUESTION_SUGGESTIONS
      || !suggestions.every((item) => typeof item === "string" && item.trim() && item.length <= 200)) {
      throw new ProtocolValidationError(`questions[${index}].suggestions must be up to ${MAX_QUESTION_SUGGESTIONS} strings of 1 to 200 characters`);
    }
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    return { question: entry.question.trim(), ...(reason ? { reason } : {}), suggestions: (suggestions as string[]).map((item) => item.trim()) };
  });
}

export function parseAnswerQuestionsRequest(value: unknown): AnswerQuestionsRequest {
  if (!isRecord(value) || !Array.isArray(value.answers) || value.answers.length === 0 || value.answers.length > MAX_USER_QUESTIONS) {
    throw new ProtocolValidationError(`answers must be an array of 1 to ${MAX_USER_QUESTIONS} answers`);
  }
  const answers = value.answers.map((entry, index): UserAnswer => {
    if (!isRecord(entry) || (entry.source !== "suggestion" && entry.source !== "typed" && entry.source !== "skipped")) {
      throw new ProtocolValidationError(`answers[${index}].source must be suggestion, typed, or skipped`);
    }
    if (entry.source === "skipped") return { answer: null, source: "skipped" };
    if (typeof entry.answer !== "string" || !entry.answer.trim() || entry.answer.length > 2000) {
      throw new ProtocolValidationError(`answers[${index}].answer must be 1 to 2000 characters`);
    }
    return { answer: entry.answer.trim(), source: entry.source };
  });
  return { answers };
}

export function parseResolvePermissionRequest(value: unknown): ResolvePermissionRequest {
  if (!isRecord(value)) throw new ProtocolValidationError("Request body must be a JSON object");
  if (value.decision !== "allow_once" && value.decision !== "allow_session" && value.decision !== "allow_always" && value.decision !== "deny") {
    throw new ProtocolValidationError("decision must be allow_once, allow_session, allow_always, or deny");
  }
  return { decision: value.decision };
}

export function encodeServerSentEvent(event: EventEnvelope): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function* readServerSentEvents<T = EventEnvelope>(response: Response): AsyncGenerator<T> {
  if (!response.ok) throw new EventStreamHttpError(response.status);
  if (!response.body) throw new Error("Event stream has no response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = findServerSentEventBoundary(buffer, done);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = block
          .split(/\r\n|\r|\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield JSON.parse(data) as T;
        boundary = findServerSentEventBoundary(buffer, done);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function findServerSentEventBoundary(
  value: string,
  final: boolean,
): { index: number; length: number } | null {
  for (let index = 0; index < value.length; index += 1) {
    const first = lineEndingLength(value, index, final);
    if (first === 0) continue;
    const second = lineEndingLength(value, index + first, final);
    if (second > 0) return { index, length: first + second };
    index += first - 1;
  }
  return null;
}

function lineEndingLength(value: string, index: number, final: boolean): number {
  if (value[index] === "\n") return 1;
  if (value[index] !== "\r") return 0;
  if (value[index + 1] === "\n") return 2;
  if (index + 1 < value.length || final) return 1;
  return 0;
}

export * from "./drive-tasks.ts";

export * from "./drive-review.ts";
