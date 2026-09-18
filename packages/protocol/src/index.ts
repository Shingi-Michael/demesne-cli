export const PROTOCOL_VERSION = 1 as const;

export type EventType =
  | "session.created"
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
  | "permission.requested"
  | "permission.resolved"
  | "tool.call_started"
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

export interface ModelDescriptor {
  id: string;
  provider: string;
  ownedBy?: string;
  contextWindow?: number;
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

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ModelToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

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
}

export type PermissionMode = "ask" | "deny";
export type PermissionDecision = "allow_once" | "allow_session" | "deny";

export interface Workspace {
  id: string;
  root: string;
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
}

export interface SessionStateResponse {
  session: Session;
  lastEventId: number;
  pendingPermissions: PendingPermissionSnapshot[];
  latestProviderCall: ProviderCallSnapshot | null;
  sessionGrants?: Array<{ tool: string; pathPrefix: string }>;
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
}

export interface SubmitTurnResponse {
  turn: Turn;
  eventId: number;
}

export interface CancelTurnResponse {
  turn: Turn;
  eventId: number;
}

export interface UndoTurnResponse {
  turnId: string;
  files: string[];
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
  return {
    content,
    ...(value.permissionMode ? { permissionMode: value.permissionMode } : {}),
    ...(value.thinkingEnabled !== undefined ? { thinkingEnabled: value.thinkingEnabled } : {}),
  };
}

export function parseResolvePermissionRequest(value: unknown): ResolvePermissionRequest {
  if (!isRecord(value)) throw new ProtocolValidationError("Request body must be a JSON object");
  if (value.decision !== "allow_once" && value.decision !== "allow_session" && value.decision !== "deny") {
    throw new ProtocolValidationError("decision must be allow_once, allow_session, or deny");
  }
  return { decision: value.decision };
}

export function encodeServerSentEvent(event: EventEnvelope): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function* readServerSentEvents(response: Response): AsyncGenerator<EventEnvelope> {
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
        if (data) yield JSON.parse(data) as EventEnvelope;
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
