import { isRecord } from "@demesne/protocol";
import type { ProviderMessage, ProviderToolCall, ProviderToolDefinition } from "@demesne/providers";
import { planContextRequest } from "./context-planner.ts";
import { assertModelResponseComplete, withProviderDeadlines } from "./engine.ts";
import type { InferenceScheduler } from "./inference-scheduler.ts";
import type { TurnInference } from "./processor.ts";
import { providerStreamLimits, type ProviderStreamLimits } from "./provider-limits.ts";
import type { ToolRegistry } from "./tools.ts";

export const SUBAGENT_TOOL = "subagent";

/// What a sub-agent may use: reading and searching only. It cannot edit, run
/// commands, ask the person, or start sub-agents of its own, so it never needs
/// an approval and several can run at once.
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["list_files", "read_file", "read_files", "search_files", "git_status", "git_diff"]);

export const SUBAGENT_LIMITS = { rounds: 16, toolCalls: 48, toolResultBytes: 32 * 1024, reportBytes: 16 * 1024 } as const;

export const subagentDefinition: ProviderToolDefinition = {
  name: SUBAGENT_TOOL,
  description: "Delegate a self-contained, read-only investigation to a sub-agent with its own fresh context, so your context stays small. "
    + "Good for: finding where something is implemented across many files, tracing a flow, surveying usages, or answering a codebase question. "
    + "It can list, read and search files and read git status/diff; it cannot edit, run commands, or ask the user. "
    + "It sees nothing of this conversation: put everything it needs in prompt, and say what to report back. "
    + "Only its final report is returned. Call it several times in one round to run investigations in parallel.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["description", "prompt"],
    properties: {
      description: { type: "string", minLength: 1, maxLength: 80, description: "A 3–6 word label for the user, e.g. \"Find session restore code\"." },
      prompt: { type: "string", minLength: 1, maxLength: 16_000, description: "The complete task: what to find out, where to look, and what the report must contain." },
    },
  },
};

export interface SubagentModel { id: string; provider: string }

/// The tool as offered to one turn. With more than one model configured it
/// gains `model`, listing each with its provider, so naming a model or
/// provider ("use Qwen", "an astra sub-agent") maps onto a real ID.
export function subagentDefinitionFor(models: readonly SubagentModel[], defaultModel: string): ProviderToolDefinition {
  if (models.length < 2) return subagentDefinition;
  const schema = subagentDefinition.inputSchema as { properties: Record<string, unknown> };
  return { ...subagentDefinition, inputSchema: { ...subagentDefinition.inputSchema, properties: { ...schema.properties,
    model: { type: "string", enum: models.map((model) => model.id),
      description: `Optional: the model this sub-agent runs on. When the user names a model or provider for sub-agents, pass the matching id; otherwise omit it to use the default, ${defaultModel}. Available: ${models.map((model) => `${model.id} (${model.provider})`).join(", ")}.` } } } };
}

export function parseSubagentInput(input: unknown): { description: string; prompt: string; model?: string } {
  if (!isRecord(input) || typeof input.description !== "string" || typeof input.prompt !== "string")
    throw new Error("subagent needs a description and a prompt");
  const description = input.description.trim(), prompt = input.prompt.trim();
  if (!description || description.length > 80) throw new Error("description must be 1–80 characters");
  if (!prompt || prompt.length > 16_000) throw new Error("prompt must be 1–16,000 characters");
  if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200)) throw new Error("model must be a configured model id");
  return { description, prompt, ...(typeof input.model === "string" ? { model: input.model.trim() } : {}) };
}

const instructions = (workspaceRoot: string) => `You are a Demesne sub-agent: a focused, read-only researcher working for the main coding agent in ${workspaceRoot}.
You were given one task. Investigate it with the read-only tools (list, read, search files; git status and diff), batching independent reads in one round. Stop as soon as the evidence answers the task.
Your final message is returned verbatim to the main agent, which cannot see your tool calls. Make it a self-contained report: the answer first, then the supporting facts with workspace-relative file paths and line numbers, and anything you could not determine. Do not suggest that you edited or ran anything.`;

/// Runs one sub-agent to completion and returns its report. Its model calls
/// are part of the parent turn: they share the turn's inference settings and
/// queue on the scheduler as that turn's continuation, so a single-slot
/// runtime interleaves parallel sub-agents rather than deadlocking on them.
export async function runSubagent(options: {
  prompt: string;
  workspaceRoot: string;
  sessionId: string;
  turnId: string;
  tools: ToolRegistry;
  inference: TurnInference;
  scheduler: InferenceScheduler;
  signal: AbortSignal;
  /// A step (`text`) or a slice of the sub-agent's thinking, for its card's trace.
  progress: (update: { text?: string; thinking?: string }) => void;
  limits?: ProviderStreamLimits;
  /// Stable for this run, so its rounds can reuse the provider's prompt cache.
  cacheKey?: string;
}): Promise<string> {
  const { inference, signal } = options;
  const definitions = options.tools.definitions().filter((definition) => SUBAGENT_TOOLS.has(definition.name));
  const streamLimits = providerStreamLimits(inference.maxOutputTokens, options.limits);
  const messages: ProviderMessage[] = [{ role: "system", content: instructions(options.workspaceRoot) }, { role: "user", content: options.prompt }];
  const used = new Map<string, number>();
  let toolCalls = 0, reasoning = 0;
  for (let round = 0; round <= SUBAGENT_LIMITS.rounds; round++) {
    signal.throwIfAborted();
    const finalizing = round === SUBAGENT_LIMITS.rounds || toolCalls >= SUBAGENT_LIMITS.toolCalls;
    const tools = finalizing ? [] : definitions;
    const request: ProviderMessage[] = finalizing
      ? [...messages, { role: "user", content: "Your tool budget is spent. Write your report now from what you have found, and say what remains unknown." }]
      : messages;
    const { messages: planned } = planContextRequest({ messages: request, tools, historicalTurns: [], capacityTokens: inference.contextCapacity, outputReserveTokens: inference.maxOutputTokens });
    options.progress({ text: round === 0 ? "starting" : finalizing ? "writing report" : `thinking · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}` });
    const lease = await options.scheduler.acquire(options.turnId, signal);
    const calls = new Map<number, ProviderToolCall>();
    let text = "", hasReasoning = false, finishReason: string | undefined, outputTokens: number | null = null;
    // Thinking reaches the card in slices, not per token, to keep the event log small.
    let thinking = "", thinkingAt = Date.now();
    const flushThinking = () => { if (thinking) options.progress({ thinking }); thinking = ""; thinkingAt = Date.now(); };
    let responses: import("@demesne/protocol").ResponsesState | undefined;
    const controller = new AbortController();
    const forward = () => controller.abort(signal.reason);
    signal.addEventListener("abort", forward, { once: true });
    try {
      let events = 0;
      for await (const event of withProviderDeadlines(inference.stream(planned, tools, controller.signal, { cacheKey: options.cacheKey }), controller, streamLimits.firstEventTimeoutMs, streamLimits.requestTimeoutMs)) {
        if (++events > streamLimits.eventLimit) throw new Error("Sub-agent stream exceeded the event limit");
        if (event.type === "text_delta") text += event.delta;
        else if (event.type === "reasoning_delta") {
          hasReasoning ||= event.delta.length > 0;
          if (inference.thinkingEnabled === false) continue;
          reasoning += event.delta.length;
          if (reasoning > streamLimits.turnCharacterLimit) throw new Error("Sub-agent reasoning exceeded the turn limit");
          thinking += event.delta;
          if (thinking.length >= 2000 || Date.now() - thinkingAt >= 250) flushThinking();
        }
        else if (event.type === "finish") finishReason = event.reason;
        else if (event.type === "usage") outputTokens = event.usage.outputTokens;
        // Provider continuation state (the Responses API) rides on the assistant message.
        else if (event.type === "response_state") responses = event.state;
        else {
          if (event.index >= 8) throw new Error("Sub-agent requested too many tools in one round");
          const call = calls.get(event.index) ?? { id: "", name: "", arguments: "" };
          call.id += event.idDelta; call.name += event.nameDelta; call.arguments += event.argumentsDelta;
          if (call.arguments.length > 128 * 1024) throw new Error("Sub-agent tool arguments exceeded the limit");
          calls.set(event.index, call);
        }
        if (text.length > streamLimits.turnCharacterLimit) throw new Error("Sub-agent output exceeded the turn limit");
      }
      flushThinking();
      assertModelResponseComplete({ finishReason, outputTokens, maxOutputTokens: inference.maxOutputTokens, provider: inference.providerId,
        text, hasReasoning, hasToolCalls: calls.size > 0 });
    } finally {
      signal.removeEventListener("abort", forward);
      // The parent turn continues after this call either way.
      lease.release({ turnContinues: true });
    }

    if (!calls.size) return report(text, used, inference.modelId);
    if (finalizing) return report(text || "The sub-agent ran out of budget before writing a report.", used, inference.modelId);
    const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (ordered.some((call) => !call.id || !call.name)) throw new Error("Sub-agent returned an incomplete tool call");
    messages.push({ role: "assistant", content: text || null, toolCalls: ordered, ...(responses ? { responses } : {}) });
    toolCalls += ordered.length;
    const results = await Promise.all(ordered.map(async (call) => {
      used.set(call.name, (used.get(call.name) ?? 0) + 1);
      return { call, content: (await runReadOnlyTool(call, options)).slice(0, SUBAGENT_LIMITS.toolResultBytes) };
    }));
    for (const { call, content } of results) messages.push({ role: "tool", toolCallId: call.id, content });
  }
  throw new Error("Sub-agent could not produce a report");
}

async function runReadOnlyTool(call: ProviderToolCall, options: { workspaceRoot: string; sessionId: string; tools: ToolRegistry; signal: AbortSignal;
  progress: (update: { text?: string }) => void }): Promise<string> {
  const tool = SUBAGENT_TOOLS.has(call.name) ? options.tools.get(call.name) : undefined;
  if (!tool) return `Error: ${call.name} is not available to a sub-agent; use ${[...SUBAGENT_TOOLS].join(", ")}`;
  let input: unknown;
  try { input = JSON.parse(call.arguments); } catch { return "Error: tool arguments are not valid JSON"; }
  try {
    // Defence in depth: never run anything that would need an approval.
    if (tool.permission(input) !== null) return `Error: ${call.name} needs approval and is not available to a sub-agent`;
    options.progress({ text: describeCall(call.name, input) });
    return await tool.execute(input, { workspaceRoot: options.workspaceRoot, sessionId: options.sessionId, signal: options.signal });
  } catch (error) {
    if (options.signal.aborted) throw error;
    return `Error: ${error instanceof Error ? error.message : "tool execution failed"}`;
  }
}

/// `read src/app.ts`, `search "restoreSession"`: what the card shows live.
export function describeCall(name: string, input: unknown): string {
  const record = isRecord(input) ? input : {};
  const verb = name === "search_files" ? "search" : name.startsWith("read_") ? "read" : name === "list_files" ? "list" : name.replace("_", " ");
  const target = typeof record.path === "string" ? record.path
    : typeof record.query === "string" ? `"${record.query}"`
    : typeof record.pattern === "string" ? `"${record.pattern}"`
    : Array.isArray(record.files) ? `${record.files.length} files` : "";
  return `${verb}${target ? ` ${target}` : ""}`.slice(0, 200);
}

function report(text: string, used: ReadonlyMap<string, number>, model: string): string {
  const body = text.trim().slice(0, SUBAGENT_LIMITS.reportBytes) || "The sub-agent finished without a report.";
  const total = [...used.values()].reduce((sum, count) => sum + count, 0);
  const tally = [...used.entries()].map(([name, count]) => `${name} ×${count}`).join(", ");
  return `${body}\n\n(Sub-agent on ${model} used ${total} tool call${total === 1 ? "" : "s"}${tally ? `: ${tally}` : ""}.)`;
}
