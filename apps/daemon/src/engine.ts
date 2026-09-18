import { isRecord, type StoredModelMessage } from "@demesne/protocol";
import { ProviderError, type ProviderMessage, type ProviderToolCall, type ProviderToolDefinition } from "@demesne/providers";
import { DemesneStore, NotFoundError, type SnapshotFile } from "@demesne/storage";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import type { TurnInference } from "./processor.ts";
import { PermissionBroker } from "./permissions.ts";
import { resolveWorkspacePath, ToolRegistry } from "./tools.ts";
import { InferenceScheduler } from "./inference-scheduler.ts";
import { composeSystemPrompt, loadProjectInstructions } from "./instructions.ts";
import {
  planCacheAwareContextRequest,
  planContextRequest,
  type ContextPlanner,
} from "./context-planner.ts";

interface AssembledToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface HistoryTurn {
  id: string;
  firstMessageId: number;
  messages: ProviderMessage[];
}

interface AgentEngineOptions {
  providerFirstEventTimeoutMs?: number;
  providerRequestTimeoutMs?: number;
  providerEventLimit?: number;
}

export class AgentEngine {
  constructor(
    private readonly store: DemesneStore,
    private readonly tools: ToolRegistry,
    private readonly permissions: PermissionBroker,
    private readonly scheduler: InferenceScheduler,
    private readonly configuredSystemPrompt?: string,
    private readonly contextPlanner?: ContextPlanner,
    private readonly options: AgentEngineOptions = {},
  ) {}

  async run(turnId: string, inference: TurnInference, signal: AbortSignal): Promise<void> {
    const turn = this.store.getTurn(turnId);
    if (!turn) throw new NotFoundError(`Turn not found: ${turnId}`);
    this.store.startTurn(turnId);
    const session = this.store.getSession(turn.sessionId);
    if (!session) throw new NotFoundError(`Session not found: ${turn.sessionId}`);

    const history = groupHistory(this.store.getCompletedModelTranscript(session.id));
    const userMessage = { role: "user" as const, content: turn.content };
    const currentUser = this.store.appendModelMessage(turnId, userMessage);
    const currentMessages: ProviderMessage[] = [userMessage];
    const definitions = session.workspace ? selectToolsForTurn(this.tools.definitions(), turn.content) : [];
    const baseSystemPrompt = this.configuredSystemPrompt?.trim() || defaultSystemPrompt(session.workspace?.root);
    const projectInstructions = loadProjectInstructions(session.workspace?.root);
    const guidedSystemPrompt = composeSystemPrompt(baseSystemPrompt, projectInstructions);
    const guidance = turnToolGuidance(turn.content);
    const systemPrompt = guidance ? `${guidedSystemPrompt}\n${guidance}` : guidedSystemPrompt;
    let totalToolCalls = 0;
    let totalToolResultBytes = 0;
    let visibleCharacters = 0;
    let reasoningCharacters = 0;
    const pendingContextDrops: HistoryTurn[] = [];

    let round = 0;
    while (round < 8) {
      if (signal.aborted) throw signal.reason;
      const historyMessages = history.flatMap((entry) => entry.messages);
      const unplannedMessages: ProviderMessage[] = [
        { role: "system", content: systemPrompt },
        ...historyMessages,
        ...currentMessages,
      ];
      let historyMessageIndex = 1;
      const historicalTurns = history.map((entry) => {
        const startMessageIndex = historyMessageIndex;
        historyMessageIndex += entry.messages.length;
        return { id: entry.id, startMessageIndex, endMessageIndex: historyMessageIndex };
      });
      const planner = this.contextPlanner
        ?? (inference.preservesPromptCache ? planCacheAwareContextRequest : planContextRequest);
      const { messages, plan: contextPlan, droppedHistoricalTurnIds } = planner({
        messages: unplannedMessages,
        tools: definitions,
        historicalTurns,
        capacityTokens: inference.contextCapacity,
        outputReserveTokens: inference.maxOutputTokens,
      });
      const assembled = new Map<number, AssembledToolCall>();
      let roundText = "";
      let receivedModelOutput = false;
      let firstTokenAt: number | null = null;
      const lease = await this.scheduler.acquire(turnId, signal);
      let turnContinues = false;
      let providerCallId: string;
      let requestStartedAt: number;
      const providerController = new AbortController();
      const forwardAbort = () => providerController.abort(signal.reason);
      signal.addEventListener("abort", forwardAbort, { once: true });
      try {
        if (signal.aborted) throw signal.reason;
        ({ providerCallId } = this.store.startProviderCall(
          turnId,
          inference.providerId,
          inference.modelId,
          { profile: inference.profile, thinkingEnabled: inference.thinkingEnabled, contextPlan },
        ));
        requestStartedAt = performance.now();
        try {
          let providerEventCount = 0;
          let usageEventCount = 0;
          const stream = inference.stream(messages, definitions, providerController.signal);
          for await (const event of withProviderDeadlines(
            stream,
            providerController,
            this.options.providerFirstEventTimeoutMs ?? 180_000,
            this.options.providerRequestTimeoutMs ?? 900_000,
          )) {
            if (signal.aborted) throw signal.reason;
            providerEventCount += 1;
            if (providerEventCount > (this.options.providerEventLimit ?? 20_000)) {
              throw new Error("Provider stream exceeded the event limit");
            }
            if (event.type !== "usage") {
              receivedModelOutput = true;
              firstTokenAt ??= performance.now();
            }
            if (event.type === "reasoning_delta") {
              if (inference.thinkingEnabled === false) continue;
              reasoningCharacters += event.delta.length;
              if (reasoningCharacters > 1_000_000) throw new Error("Model reasoning exceeded the turn limit");
              this.store.appendReasoningDelta(turnId, event.delta);
            } else if (event.type === "text_delta") {
              visibleCharacters += event.delta.length;
              if (visibleCharacters > 1_000_000) throw new Error("Model output exceeded the turn limit");
              roundText += event.delta;
              this.store.appendMessageDelta(turnId, event.delta);
            } else if (event.type === "usage") {
              usageEventCount += 1;
              if (usageEventCount > 1) throw new Error("Provider stream emitted multiple usage events");
              this.store.recordProviderUsage(providerCallId, event.usage);
            } else {
              if (event.index >= 8) throw new Error("Model requested too many tools in one round");
              const call = assembled.get(event.index) ?? { id: "", name: "", arguments: "" };
              call.id += event.idDelta;
              call.name += event.nameDelta;
              call.arguments += event.argumentsDelta;
              if (call.id.length > 512 || call.name.length > 256) throw new Error("Tool identity exceeded the limit");
              if (call.arguments.length > 128 * 1024) throw new Error("Tool arguments exceeded the limit");
              assembled.set(event.index, call);
            }
          }
          const requestCompletedAt = performance.now();
          this.store.recordProviderMetrics(providerCallId, {
            queueDurationMs: Math.max(0, Math.round(lease.queueDurationMs)),
            durationMs: Math.max(0, Math.round(requestCompletedAt - requestStartedAt)),
            timeToFirstTokenMs: firstTokenAt === null ? null : Math.max(0, Math.round(firstTokenAt - requestStartedAt)),
          });
          this.store.settleProviderCall(providerCallId, "completed");
        } catch (error) {
          if (!providerController.signal.aborted) providerController.abort(error);
          if (!signal.aborted) {
            const requestCompletedAt = performance.now();
            this.store.recordProviderMetrics(providerCallId, {
              queueDurationMs: Math.max(0, Math.round(lease.queueDurationMs)),
              durationMs: Math.max(0, Math.round(requestCompletedAt - requestStartedAt)),
              timeToFirstTokenMs: firstTokenAt === null ? null : Math.max(0, Math.round(firstTokenAt - requestStartedAt)),
            });
            const message = error instanceof Error ? error.message : "Model request failed";
            this.store.settleProviderCall(providerCallId, "failed", message);
          }
          if (!signal.aborted && !receivedModelOutput && isContextOverflow(error)) {
            const proactivelyDropped = takePlannedHistoryTurns(history, droppedHistoricalTurnIds);
            pendingContextDrops.push(...proactivelyDropped);
            if (history.length === 0) throw error;
            const dropCount = Math.max(1, Math.ceil(history.length / 2));
            const dropped = history.splice(0, dropCount);
            const firstRetainedMessageId = history[0]?.firstMessageId ?? currentUser.id;
            this.store.trimModelContext(
              turnId,
              firstRetainedMessageId,
              [...pendingContextDrops, ...dropped].map((entry) => entry.id),
            );
            pendingContextDrops.length = 0;
            turnContinues = true;
            continue;
          }
          throw error;
        }
        turnContinues = assembled.size > 0;
      } finally {
        signal.removeEventListener("abort", forwardAbort);
        lease.release({ turnContinues });
      }

      pendingContextDrops.push(...takePlannedHistoryTurns(history, droppedHistoricalTurnIds));

      round += 1;
      if (assembled.size === 0) {
        this.store.appendModelMessage(turnId, { role: "assistant", content: roundText });
        if (pendingContextDrops.length > 0) {
          const firstRetainedMessageId = history[0]?.firstMessageId ?? currentUser.id;
          this.store.trimModelContext(turnId, firstRetainedMessageId, pendingContextDrops.map((entry) => entry.id));
        }
        this.store.completeTurn(turnId);
        return;
      }

      const providerCalls = [...assembled.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
      totalToolCalls += providerCalls.length;
      if (totalToolCalls > 24) throw new Error("Turn exceeded the tool call limit");
      if (providerCalls.some((call) => !call.id || !call.name)) throw new Error("Model returned an incomplete tool call");
      const assistantMessage = {
        role: "assistant",
        content: roundText || null,
        toolCalls: providerCalls satisfies ProviderToolCall[],
      } as const;
      currentMessages.push(assistantMessage);
      this.store.appendModelMessage(turnId, assistantMessage);

      const callRecords = providerCalls.map((call) => {
        const { toolCallId } = this.store.recordToolCall(
          turnId,
          providerCallId,
          call.id,
          call.name,
          call.arguments,
        );
        return { call, toolCallId };
      });

      const allReadOnly = callRecords.every(({ call }) => {
        const tool = this.tools.get(call.name);
        if (!tool) return false;
        try {
          const input = JSON.parse(call.arguments);
          return tool.permission(input) === null;
        } catch {
          return false;
        }
      });

      if (allReadOnly && callRecords.length > 1) {
        const results = await Promise.all(
          callRecords.map(async ({ call, toolCallId }) => {
            const result = await this.executeTool(toolCallId, call, turn.permissionMode, session.workspace?.root, turnId, session.id, signal);
            return { call, result };
          }),
        );
        for (const { call, result } of results) {
          totalToolResultBytes += Buffer.byteLength(result);
          if (totalToolResultBytes > 512 * 1024) throw new Error("Turn exceeded the tool result limit");
          const toolMessage = { role: "tool" as const, toolCallId: call.id, content: result };
          currentMessages.push(toolMessage);
          this.store.appendModelMessage(turnId, toolMessage);
        }
      } else {
        for (const { call, toolCallId } of callRecords) {
          const result = await this.executeTool(toolCallId, call, turn.permissionMode, session.workspace?.root, turnId, session.id, signal);
          totalToolResultBytes += Buffer.byteLength(result);
          if (totalToolResultBytes > 512 * 1024) throw new Error("Turn exceeded the tool result limit");
          const toolMessage = { role: "tool" as const, toolCallId: call.id, content: result };
          currentMessages.push(toolMessage);
          this.store.appendModelMessage(turnId, toolMessage);
        }
      }
    }
    throw new Error("Turn exceeded the model round limit");
  }

  private captureSnapshot(
    turnId: string,
    sessionId: string,
    workspaceRoot: string | undefined,
    toolName: string,
    input: unknown,
  ): string[] {
    if (!workspaceRoot) return [];
    if (!["edit_file", "write_file", "move_path", "delete_path"].includes(toolName)) return [];
    const record = isRecord(input) ? input : {};
    const targets: string[] = [];
    const keys = toolName === "move_path" ? ["from", "to"] : ["path"];
    for (const key of keys) {
      const candidate = (record as Record<string, unknown>)[key];
      if (typeof candidate === "string" && candidate.length > 0) targets.push(candidate);
    }
    try {
      const files: SnapshotFile[] = [];
      for (const relativePath of new Set(targets)) {
        const absolute = resolveWorkspacePath(workspaceRoot, relativePath, true, true);
        if (!existsSync(absolute)) {
          files.push({ path: relativePath, existed: false, data: null });
        } else if (lstatSync(absolute).isFile()) {
          files.push({ path: relativePath, existed: true, data: new Uint8Array(readFileSync(absolute)) });
        }
      }
      this.store.recordSnapshot(turnId, files);
      return files.map((file) => file.path);
    } catch (error) {
      console.error(`Snapshot capture failed for session ${sessionId}; undo may be incomplete`, error);
      return [];
    }
  }

  private captureSnapshotPostState(turnId: string, sessionId: string, workspaceRoot: string, targets: string[]): void {
    if (targets.length === 0) return;
    try {
      this.store.recordSnapshotPostState(turnId, targets.map((relativePath) => {
        const absolute = resolveWorkspacePath(workspaceRoot, relativePath, true, true);
        if (!existsSync(absolute)) return { path: relativePath, existed: false, data: null, postHash: null };
        const stat = lstatSync(absolute);
        if (!stat.isFile()) throw new Error(`Undo only supports regular files: ${relativePath}`);
        const data = new Uint8Array(readFileSync(absolute));
        return { path: relativePath, existed: true, data: null, postHash: hashBytes(data) };
      }));
    } catch (error) {
      console.error(`Snapshot post-state capture failed for session ${sessionId}; undo disabled`, error);
    }
  }

  private async executeTool(
    toolCallId: string,
    call: AssembledToolCall,
    permissionMode: "ask" | "deny",
    workspaceRoot: string | undefined,
    turnId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (!workspaceRoot) {
      const result = "Error: this session is not bound to a workspace";
      this.store.settleToolCall(toolCallId, "failed", result);
      return result;
    }
    let input: unknown;
    try {
      input = JSON.parse(call.arguments);
    } catch {
      const result = "Error: tool arguments are not valid JSON";
      this.store.settleToolCall(toolCallId, "failed", result);
      return result;
    }
    const tool = this.tools.get(call.name);
    if (!tool) {
      const result = `Error: unknown tool ${call.name}`;
      this.store.settleToolCall(toolCallId, "failed", result);
      return result;
    }
    let permission;
    try {
      permission = tool.permission(input);
    } catch (error) {
      const result = `Error: ${error instanceof Error ? error.message : "invalid tool input"}`;
      this.store.settleToolCall(toolCallId, "failed", result);
      return result;
    }
    if (permission) {
      const preapproved = this.permissions.preapproved(sessionId, call.name, input);
      if (!preapproved && permissionMode === "deny") {
        const result = "Permission denied by session policy";
        this.store.settleToolCall(toolCallId, "denied", result);
        return result;
      }
      if (!preapproved) {
        const { permissionId } = this.store.requestToolPermission(toolCallId, permission.kind, permission.summary);
        const decision = await this.permissions.wait(permissionId, turnId, sessionId, call.name, call.arguments, signal);
        this.store.resolveToolPermission(permissionId, decision);
        if (decision === "deny") {
          const result = "Permission denied by user";
          this.store.settleToolCall(toolCallId, "denied", result);
          return result;
        }
      }
    }
    this.store.startToolCall(toolCallId);
    const snapshotTargets = this.captureSnapshot(turnId, sessionId, workspaceRoot, call.name, input);
    try {
      const result = (await tool.execute(input, { workspaceRoot, signal })).slice(0, 256 * 1024);
      this.captureSnapshotPostState(turnId, sessionId, workspaceRoot, snapshotTargets);
      this.store.settleToolCall(toolCallId, "completed", result);
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      const result = `Error: ${error instanceof Error ? error.message : "tool execution failed"}`;
      this.store.settleToolCall(toolCallId, "failed", result);
      return result;
    }
  }

}

function hashBytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function* withProviderDeadlines<T>(
  stream: AsyncIterable<T>,
  controller: AbortController,
  firstEventTimeoutMs: number,
  requestTimeoutMs: number,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  const startedAt = performance.now();
  let first = true;
  try {
    while (true) {
      const remaining = requestTimeoutMs - (performance.now() - startedAt);
      if (remaining <= 0) throw new Error("Provider request exceeded the total timeout");
      const timeoutMs = Math.max(1, Math.min(remaining, first ? firstEventTimeoutMs : remaining));
      const message = first ? "Provider did not emit an event before the timeout" : "Provider request exceeded the total timeout";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(controller.signal.reason);
          return;
        }
        abortListener = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abortListener, { once: true });
      });
      let result: IteratorResult<T>;
      try {
        result = await Promise.race([iterator.next(), timeout, aborted]);
      } finally {
        if (timer) clearTimeout(timer);
        if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      }
      if (result.done) return;
      first = false;
      yield result.value;
    }
  } finally {
    void Promise.resolve(iterator.return?.()).catch(() => {});
  }
}

function groupHistory(transcript: StoredModelMessage[]): HistoryTurn[] {
  const grouped: HistoryTurn[] = [];
  for (const entry of transcript) {
    const current = grouped.at(-1);
    if (current?.id === entry.turnId) {
      current.messages.push(entry.message);
    } else {
      grouped.push({ id: entry.turnId, firstMessageId: entry.id, messages: [entry.message] });
    }
  }
  return grouped;
}

function takePlannedHistoryTurns(history: HistoryTurn[], turnIds: string[]): HistoryTurn[] {
  if (turnIds.length === 0) return [];
  const expected = history.slice(0, turnIds.length).map((entry) => entry.id);
  if (expected.some((id, index) => id !== turnIds[index])) {
    throw new Error("Context planner returned a non-prefix history reduction");
  }
  return history.splice(0, turnIds.length);
}

function isContextOverflow(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (error.status !== undefined && error.status !== 400 && error.status !== 413) return false;
  if (error.code && ["context_length_exceeded", "context_window_exceeded", "prompt_too_long"].includes(error.code)) return true;
  return /maximum context length|context (?:length|window).*(?:exceed|greater|maximum)|(?:exceed|greater).*context (?:length|window)|too many (?:input )?tokens|prompt is too long/i
    .test(error.message);
}

export function defaultSystemPrompt(workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return "You are a concise assistant. This legacy session has no workspace or coding tools.";
  return `You are Demesne, a careful coding agent in ${workspaceRoot}.
Inspect before editing with focused list, search, and read tools; batch related reads with read_files. Use purpose-built tools, never run_command, for file listing, reading, searching, or qualitative repository measurements. For qualitative summaries, do not compute line counts, file counts, or disk usage unless requested; stop when evidence is sufficient. Use relative paths. Reads are automatic; edits and commands need approval. run_command executes host argv, not a shell/sandbox. Verify changes and summarize concisely.`;
}

const qualitativeInspectionTools = new Set(["list_files", "read_file", "read_files", "search_files"]);

export function selectToolsForTurn(definitions: ProviderToolDefinition[], request: string): ProviderToolDefinition[] {
  if (!isQualitativeWorkspaceOverview(request)) return definitions;
  return definitions.filter((definition) => qualitativeInspectionTools.has(definition.name));
}

export function turnToolGuidance(request: string): string | null {
  if (!isQualitativeWorkspaceOverview(request)) return null;
  return "Overview efficiency: use one initial tool round. Call list_files for the workspace root and one read_files request for likely root documentation/manifests together; read_files entries fail softly when absent. Then answer unless an essential fact is still missing. Do not serialize independent inspection calls.";
}

function isQualitativeWorkspaceOverview(request: string): boolean {
  const normalized = request.toLowerCase();
  const asksForOverview = /\b(?:summary|summarize|overview|describe)\b/.test(normalized)
    && /\b(?:folder|directory|repo|repository|codebase|project|workspace)\b/.test(normalized);
  const needsExecutionOrMeasurement = /\b(?:run|execute|test|build|fix|edit|change|implement|debug|diagnose|benchmark|count|lines?|loc|size|disk|measure|metrics?|statistics?)\b/.test(normalized)
    || /\bhow many\b/.test(normalized);
  return asksForOverview && !needsExecutionOrMeasurement;
}
