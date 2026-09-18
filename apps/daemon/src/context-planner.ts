import type { ContextBudgetStatus, ContextCompactionAction, ContextPlan } from "@demesne/protocol";
import type { ProviderMessage, ProviderToolDefinition } from "@demesne/providers";

const ESTIMATOR_METHOD = "openai-json-utf8-bytes-divisor-3" as const;
const TOOL_RESULT_RESERVE_TOKENS = 768;
const SAFETY_RESERVE_TOKENS = 512;
const REQUEST_OVERHEAD_TOKENS = 32;
const MESSAGE_OVERHEAD_TOKENS = 8;
const TOOL_OVERHEAD_TOKENS = 12;
const ESTIMATE_SAFETY_FACTOR = 1.2 as const;

export interface ContextPlannerInput {
  messages: ProviderMessage[];
  tools: ProviderToolDefinition[];
  historicalTurns: HistoricalContextTurn[];
  capacityTokens?: number;
  outputReserveTokens?: number;
}

export interface HistoricalContextTurn {
  id: string;
  startMessageIndex: number;
  endMessageIndex: number;
}

export interface PlannedContextRequest {
  messages: ProviderMessage[];
  plan: ContextPlan;
  droppedHistoricalTurnIds: string[];
}

export type ContextPlanner = (input: ContextPlannerInput) => PlannedContextRequest;

export const planRawContextRequest: ContextPlanner = (input) => planContextRequestInternal({
  ...input,
  historicalTurns: [],
}, false, false);

// Measurement-only policy for comparing soft-boundary compaction with hard-boundary compaction.
export const planDelayedHardContextRequest: ContextPlanner = (input) => {
  const raw = planRawContextRequest(input);
  const hardInputLimitTokens = raw.plan.hardInputLimitTokens;
  if (hardInputLimitTokens === null) {
    throw new Error("Delayed-hard context planning requires a known hard input limit");
  }
  if (raw.plan.originalEstimatedInputTokens <= hardInputLimitTokens) return raw;
  const planned = planContextRequest(input);
  if (planned.plan.estimatedInputTokens > hardInputLimitTokens) {
    throw new Error("Delayed-hard context planning could not satisfy the hard input limit");
  }
  return planned;
};

// Provider-specific policy for runtimes that report and preserve prompt-prefix
// caches. It keeps the append-only transcript intact until the hard input limit.
// If compaction becomes unavoidable, it rewrites newer historical content before
// older content so the longest possible prefix remains cacheable. Complete-turn
// dropping remains oldest-first because the persisted context cursor represents
// a contiguous suffix of session history.
export const planCacheAwareContextRequest: ContextPlanner = (input) => {
  const raw = planRawContextRequest(input);
  const hardInputLimitTokens = raw.plan.hardInputLimitTokens;
  if (hardInputLimitTokens === null) {
    throw new Error("Cache-aware context planning requires a known hard input limit");
  }
  if (raw.plan.originalEstimatedInputTokens <= hardInputLimitTokens) return raw;
  const planned = planContextRequestInternal(input, true, true);
  if (planned.plan.estimatedInputTokens > hardInputLimitTokens) {
    throw new Error("Cache-aware context planning could not satisfy the hard input limit");
  }
  return planned;
};

interface FileReadOccurrence {
  messageIndex: number;
  toolCallId: string;
  path: string;
  identity: string;
  value: Record<string, unknown>;
  parsedToolOutput: unknown;
}

export function planContextRequest(input: ContextPlannerInput): PlannedContextRequest {
  return planContextRequestInternal(input, false, true);
}

function planContextRequestInternal(
  input: ContextPlannerInput,
  preserveCachedPrefix: boolean,
  allowCurrentTurnCompaction: boolean,
): PlannedContextRequest {
  validateHistoricalTurns(input.historicalTurns, input.messages.length);
  const messages = [...input.messages];
  const serializedMessages = messages.map((message) => JSON.stringify(serializeMessage(message)));
  const originalMessageIndices = messages.map((_, index) => index);
  let serializedMessagesBytes = jsonArrayByteLength(serializedMessages);
  let estimatedMessageTokens = estimateMessageTokens(serializedMessagesBytes, messages.length);
  const estimatedToolDefinitionTokens = estimateToolDefinitionTokens(input.tools);
  const originalEstimatedInputTokens = estimatedMessageTokens + estimatedToolDefinitionTokens;
  let estimatedInputTokens = originalEstimatedInputTokens;
  const actions: ContextCompactionAction[] = [];
  const capacityTokens = positiveInteger(input.capacityTokens) ?? null;
  const outputTokens = positiveInteger(input.outputReserveTokens) ?? null;
  const totalReserveTokens = outputTokens === null
    ? null
    : outputTokens + TOOL_RESULT_RESERVE_TOKENS + SAFETY_RESERVE_TOKENS;
  const maximumPlannedInputTokens = capacityTokens === null || totalReserveTokens === null
    ? null
    : Math.max(0, capacityTokens - totalReserveTokens);
  const hardInputLimitTokens = capacityTokens === null || outputTokens === null
    ? null
    : Math.max(0, capacityTokens - outputTokens);
  const historicalMessageIndices = input.historicalTurns.flatMap((turn) =>
    Array.from({ length: turn.endMessageIndex - turn.startMessageIndex }, (_, offset) => turn.startMessageIndex + offset)
  );
  if (preserveCachedPrefix) historicalMessageIndices.reverse();
  const shouldReduceHistoricalContext = maximumPlannedInputTokens !== null
    && estimatedInputTokens > maximumPlannedInputTokens;

  const occurrences = shouldReduceHistoricalContext
    ? collectFileReadOccurrences(messages, input.historicalTurns, preserveCachedPrefix)
    : [];
  const retainedByIdentity = new Map<string, FileReadOccurrence>();
  for (const occurrence of occurrences) {
    const retained = retainedByIdentity.get(occurrence.identity);
    if (!retained) {
      retainedByIdentity.set(occurrence.identity, occurrence);
      continue;
    }
    const message = messages[occurrence.messageIndex];
    if (message?.role !== "tool") continue;
    const originalContent = occurrence.value.content;
    if (typeof originalContent !== "string") continue;
    const marker = `[duplicate historical file content omitted; matched tool result ${retained.toolCallId} before compaction]`;
    occurrence.value.content = marker;
    const compactedMessage = { ...message, content: JSON.stringify(occurrence.parsedToolOutput) };
    const compactedSerialized = JSON.stringify(serializeMessage(compactedMessage));
    const originalSerialized = serializedMessages[occurrence.messageIndex]!;
    const candidateBytes = serializedMessagesBytes
      - Buffer.byteLength(originalSerialized, "utf8")
      + Buffer.byteLength(compactedSerialized, "utf8");
    const candidateMessageTokens = estimateMessageTokens(candidateBytes, messages.length);
    const candidateInputTokens = candidateMessageTokens + estimatedToolDefinitionTokens;
    if (candidateInputTokens >= estimatedInputTokens) {
      occurrence.value.content = originalContent;
      continue;
    }
    messages[occurrence.messageIndex] = compactedMessage;
    serializedMessages[occurrence.messageIndex] = compactedSerialized;
    serializedMessagesBytes = candidateBytes;
    actions.push({
      kind: "deduplicate_historical_file_content",
      messageIndex: occurrence.messageIndex,
      retainedMessageIndex: retained.messageIndex,
      toolCallId: occurrence.toolCallId,
      retainedToolCallId: retained.toolCallId,
      path: occurrence.path,
      originalCharacters: originalContent.length,
      compactedCharacters: marker.length,
      estimatedTokensSaved: estimatedInputTokens - candidateInputTokens,
    });
    estimatedMessageTokens = candidateMessageTokens;
    estimatedInputTokens = candidateInputTokens;
  }

  for (const index of shouldReduceHistoricalContext ? historicalMessageIndices : []) {
    const message = messages[index]!;
    if (message.role !== "tool") continue;
    const compacted = compactHistoricalToolOutput(message);
    if (!compacted) continue;
    const originalSerialized = serializedMessages[index]!;
    const compactedSerialized = JSON.stringify(serializeMessage(compacted.message));
    const candidateBytes = serializedMessagesBytes
      - Buffer.byteLength(originalSerialized, "utf8")
      + Buffer.byteLength(compactedSerialized, "utf8");
    const candidateMessageTokens = estimateMessageTokens(candidateBytes, messages.length);
    const candidateInputTokens = candidateMessageTokens + estimatedToolDefinitionTokens;
    if (candidateInputTokens >= estimatedInputTokens) continue;
    messages[index] = compacted.message;
    serializedMessages[index] = compactedSerialized;
    serializedMessagesBytes = candidateBytes;
    actions.push({
      kind: "truncate_historical_tool_output",
      messageIndex: index,
      originalCharacters: message.content.length,
      compactedCharacters: compacted.message.content.length,
      removedLines: compacted.removedLines,
      estimatedTokensSaved: estimatedInputTokens - candidateInputTokens,
    });
    estimatedMessageTokens = candidateMessageTokens;
    estimatedInputTokens = candidateInputTokens;
  }

  const droppedHistoricalTurnIds: string[] = [];
  if (maximumPlannedInputTokens !== null) {
    for (const turn of input.historicalTurns) {
      if (estimatedInputTokens <= maximumPlannedInputTokens) break;
      const currentStartIndex = originalMessageIndices.indexOf(turn.startMessageIndex);
      if (currentStartIndex < 0) continue;
      let messageCount = 0;
      while (originalMessageIndices[currentStartIndex + messageCount] !== undefined
        && originalMessageIndices[currentStartIndex + messageCount]! < turn.endMessageIndex) {
        messageCount += 1;
      }
      if (messageCount === 0) continue;
      messages.splice(currentStartIndex, messageCount);
      serializedMessages.splice(currentStartIndex, messageCount);
      originalMessageIndices.splice(currentStartIndex, messageCount);
      serializedMessagesBytes = jsonArrayByteLength(serializedMessages);
      const candidateMessageTokens = estimateMessageTokens(serializedMessagesBytes, messages.length);
      const candidateInputTokens = candidateMessageTokens + estimatedToolDefinitionTokens;
      actions.push({
        kind: "drop_historical_turn",
        turnId: turn.id,
        messageStartIndex: turn.startMessageIndex,
        messageCount,
        estimatedTokensSaved: estimatedInputTokens - candidateInputTokens,
      });
      droppedHistoricalTurnIds.push(turn.id);
      estimatedMessageTokens = candidateMessageTokens;
      estimatedInputTokens = candidateInputTokens;
    }
  }

  // A long multi-round tool loop can exceed hard capacity even after all
  // historical turns are gone. Keep the newest tool-result batch intact first,
  // then compact earlier current-turn results from newest to oldest so the
  // longest cacheable prefix and the freshest evidence are preserved.
  if (allowCurrentTurnCompaction && hardInputLimitTokens !== null && estimatedInputTokens > hardInputLimitTokens) {
    const currentTurnStartIndex = input.historicalTurns.at(-1)?.endMessageIndex ?? 1;
    const protectedLatestToolIndices = new Set<number>();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role !== "tool") break;
      protectedLatestToolIndices.add(index);
    }
    const currentToolIndices = messages.flatMap((message, index) => {
      const originalIndex = originalMessageIndices[index];
      return message.role === "tool" && originalIndex !== undefined && originalIndex >= currentTurnStartIndex
        ? [index]
        : [];
    });
    const orderedCandidates = [
      ...currentToolIndices.filter((index) => !protectedLatestToolIndices.has(index)).reverse(),
      ...currentToolIndices.filter((index) => protectedLatestToolIndices.has(index)).reverse(),
    ];

    for (const index of orderedCandidates) {
      if (estimatedInputTokens <= hardInputLimitTokens) break;
      const message = messages[index];
      if (message?.role !== "tool") continue;
      const compacted = compactHistoricalToolOutput(message);
      if (!compacted) continue;
      const originalSerialized = serializedMessages[index]!;
      const compactedSerialized = JSON.stringify(serializeMessage(compacted.message));
      const candidateBytes = serializedMessagesBytes
        - Buffer.byteLength(originalSerialized, "utf8")
        + Buffer.byteLength(compactedSerialized, "utf8");
      const candidateMessageTokens = estimateMessageTokens(candidateBytes, messages.length);
      const candidateInputTokens = candidateMessageTokens + estimatedToolDefinitionTokens;
      if (candidateInputTokens >= estimatedInputTokens) continue;
      messages[index] = compacted.message;
      serializedMessages[index] = compactedSerialized;
      serializedMessagesBytes = candidateBytes;
      actions.push({
        kind: "truncate_historical_tool_output",
        scope: "current_turn",
        messageIndex: originalMessageIndices[index]!,
        originalCharacters: message.content.length,
        compactedCharacters: compacted.message.content.length,
        removedLines: compacted.removedLines,
        estimatedTokensSaved: estimatedInputTokens - candidateInputTokens,
      });
      estimatedMessageTokens = candidateMessageTokens;
      estimatedInputTokens = candidateInputTokens;
    }
  }

  return {
    messages,
    droppedHistoricalTurnIds,
    plan: {
      schemaVersion: 3,
      estimator: { method: ESTIMATOR_METHOD, version: 2, safetyFactor: ESTIMATE_SAFETY_FACTOR },
      capacityTokens,
      reserves: {
        outputTokens,
        toolResultTokens: TOOL_RESULT_RESERVE_TOKENS,
        safetyTokens: SAFETY_RESERVE_TOKENS,
        totalTokens: totalReserveTokens,
      },
      maximumPlannedInputTokens,
      hardInputLimitTokens,
      originalEstimatedInputTokens,
      estimatedInputTokens,
      estimatedMessageTokens,
      estimatedToolDefinitionTokens,
      budgetStatus: budgetStatus(estimatedInputTokens, capacityTokens, maximumPlannedInputTokens, hardInputLimitTokens),
      actions,
    },
  };
}

function collectFileReadOccurrences(
  messages: ProviderMessage[],
  historicalTurns: HistoricalContextTurn[],
  preserveCachedPrefix = false,
): FileReadOccurrence[] {
  const occurrences: FileReadOccurrence[] = [];
  const orderedTurns = preserveCachedPrefix ? historicalTurns : [...historicalTurns].reverse();
  for (const turn of orderedTurns) {
    const toolNames = new Map<string, string>();
    for (let index = turn.startMessageIndex; index < turn.endMessageIndex; index += 1) {
      const message = messages[index];
      if (message?.role !== "assistant") continue;
      for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
    }
    for (let index = turn.endMessageIndex - 1; index >= turn.startMessageIndex; index -= 1) {
      const message = messages[index];
      if (message?.role !== "tool") continue;
      const toolName = toolNames.get(message.toolCallId);
      if (toolName !== "read_file" && toolName !== "read_files") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.content);
      } catch {
        continue;
      }
      const values = toolName === "read_file"
        ? (isFileReadValue(parsed) ? [parsed] : [])
        : (isRecord(parsed) && Array.isArray(parsed.results) ? parsed.results.filter(isFileReadValue) : []);
      for (const value of [...values].reverse()) {
        occurrences.push({
          messageIndex: index,
          toolCallId: message.toolCallId,
          path: value.path,
          identity: JSON.stringify(value),
          value,
          parsedToolOutput: parsed,
        });
      }
    }
  }
  return occurrences;
}

function isFileReadValue(value: unknown): value is Record<string, unknown> & {
  path: string;
  totalLines: number;
  range: { from: number; to: number };
  content: string;
  truncated: boolean;
  remainingLines: number;
} {
  if (!isRecord(value) || "error" in value || typeof value.path !== "string" || typeof value.content !== "string"
    || typeof value.totalLines !== "number" || typeof value.truncated !== "boolean"
    || typeof value.remainingLines !== "number" || !isRecord(value.range)) return false;
  const from = value.range.from;
  const to = value.range.to;
  return value.path.length > 0
    && Number.isSafeInteger(value.totalLines) && value.totalLines >= 0
    && Number.isSafeInteger(value.remainingLines) && value.remainingLines >= 0
    && Number.isSafeInteger(from) && (from as number) >= 1
    && Number.isSafeInteger(to) && (to as number) >= 0 && (to as number) <= value.totalLines
    && (value.content.length === 0 || (to as number) >= (from as number));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateHistoricalTurns(turns: HistoricalContextTurn[], messageCount: number): void {
  let previousEnd = 0;
  for (const turn of turns) {
    if (!turn.id || !Number.isSafeInteger(turn.startMessageIndex) || !Number.isSafeInteger(turn.endMessageIndex)
      || turn.startMessageIndex < previousEnd || turn.startMessageIndex < 0
      || turn.endMessageIndex <= turn.startMessageIndex || turn.endMessageIndex > messageCount) {
      throw new Error("Historical context turns must be ordered, non-overlapping message ranges");
    }
    previousEnd = turn.endMessageIndex;
  }
}

function compactHistoricalToolOutput(
  message: Extract<ProviderMessage, { role: "tool" }>,
): { message: Extract<ProviderMessage, { role: "tool" }>; removedLines: number } | null {
  if (Buffer.byteLength(message.content, "utf8") <= 2_048) return null;
  let compacted: { value: string; removedLines: number } | null = null;
  try {
    const parsed: unknown = JSON.parse(message.content);
    const structured = compactStructuredValue(parsed);
    if (structured.removedLines > 0) {
      compacted = { value: JSON.stringify(structured.value), removedLines: structured.removedLines };
    }
  } catch {
    // Non-JSON tool output falls back to physical-line compaction.
  }
  compacted ??= compactMultilineString(message.content);
  if (!compacted) return null;
  return {
    message: {
      ...message,
      content: compacted.value,
    },
    removedLines: compacted.removedLines,
  };
}

function compactStructuredValue(value: unknown): { value: unknown; removedLines: number } {
  if (typeof value === "string") {
    const compacted = compactMultilineString(value);
    return compacted ?? { value, removedLines: 0 };
  }
  if (Array.isArray(value)) {
    let removedLines = 0;
    const compacted = value.map((entry) => {
      const result = compactStructuredValue(entry);
      removedLines += result.removedLines;
      return result.value;
    });
    return { value: removedLines > 0 ? compacted : value, removedLines };
  }
  if (value !== null && typeof value === "object") {
    let removedLines = 0;
    const compacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = compactStructuredValue(entry);
      compacted[key] = result.value;
      removedLines += result.removedLines;
    }
    return { value: removedLines > 0 ? compacted : value, removedLines };
  }
  return { value, removedLines: 0 };
}

function compactMultilineString(value: string): { value: string; removedLines: number } | null {
  const lines = value.split("\n");
  if (lines.length <= 30) return null;
  const removedLines = lines.length - 25;
  return {
    value: `${lines.slice(0, 15).join("\n")}\n\n[... ${removedLines} lines truncated in conversation history ...]\n\n${lines.slice(-10).join("\n")}`,
    removedLines,
  };
}

function estimateMessageTokens(serializedBytes: number, messageCount: number): number {
  return applySafetyFactor(
    Math.ceil(serializedBytes / 3) + messageCount * MESSAGE_OVERHEAD_TOKENS + REQUEST_OVERHEAD_TOKENS,
  );
}

function estimateToolDefinitionTokens(tools: ProviderToolDefinition[]): number {
  const serializedTools = tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
  const estimate = tools.length === 0
    ? 0
    : estimateTextTokens(JSON.stringify(serializedTools)) + tools.length * TOOL_OVERHEAD_TOKENS;
  return applySafetyFactor(estimate);
}

function serializeMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function estimateTextTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 3);
}

function applySafetyFactor(tokens: number): number {
  return Math.ceil(tokens * ESTIMATE_SAFETY_FACTOR);
}

function jsonArrayByteLength(serializedItems: string[]): number {
  return 2 + Math.max(0, serializedItems.length - 1)
    + serializedItems.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0);
}

function positiveInteger(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value : undefined;
}

function budgetStatus(
  estimatedInputTokens: number,
  capacityTokens: number | null,
  maximumPlannedInputTokens: number | null,
  hardInputLimitTokens: number | null,
): ContextBudgetStatus {
  if (capacityTokens === null || maximumPlannedInputTokens === null || hardInputLimitTokens === null) {
    return "capacity_unknown";
  }
  if (estimatedInputTokens <= maximumPlannedInputTokens) return "within_soft_limit";
  if (estimatedInputTokens <= hardInputLimitTokens) return "over_soft_limit";
  if (estimatedInputTokens <= capacityTokens) return "over_hard_limit";
  return "over_capacity";
}
