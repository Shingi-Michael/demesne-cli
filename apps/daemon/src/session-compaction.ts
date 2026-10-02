import type { ContextPlan, SessionCheckpoint } from "@demesne/protocol";
import type { ProviderMessage } from "@demesne/providers";
import { DemesneStore, NotFoundError } from "@demesne/storage";
import { agentSystemPrompt, assertModelResponseComplete, groupHistory, withProviderDeadlines } from "./engine.ts";
import { planRawContextRequest } from "./context-planner.ts";
import { InferenceScheduler } from "./inference-scheduler.ts";
import type { TurnInference } from "./processor.ts";
import { providerStreamLimits } from "./provider-limits.ts";
import { buildSummaryCheckpointPrompt, parseSummaryCheckpoint, renderSummaryCheckpoint, type SummaryCheckpointContentV1 } from "./summary-checkpoint.ts";
import type { ToolRegistry } from "./tools.ts";

const RETAINED_TURNS = 2;
const MAX_SUMMARY_ROUNDS = 32;

interface SummarySource {
  message: ProviderMessage;
  // Keep raw fragments separately so splitting never JSON-escapes them again.
  fragment?: string;
}

/** Manual compaction is a cancellable, tool-free turn. Only a validated,
 * smaller checkpoint is committed; its cursor and completion share one transaction. */
export class SessionCompactor {
  constructor(private readonly store: DemesneStore, private readonly scheduler: InferenceScheduler,
    private readonly tools: ToolRegistry, private readonly options: { systemPrompt?: string; providerVision?: boolean;
      providerFirstEventTimeoutMs?: number; providerRequestTimeoutMs?: number; providerEventLimit?: number } = {}) {}

  async run(turnId: string, inference: TurnInference, signal: AbortSignal): Promise<void> {
    const turn = this.store.getTurn(turnId);
    if (!turn || turn.kind !== "compaction") throw new NotFoundError("Compaction turn not found");
    this.store.startTurn(turnId);
    const session = this.store.getSession(turn.sessionId)!;
    const version = this.store.modelContextVersion(session.id);
    const history = groupHistory(this.store.getModelContextTranscript(session.id));
    const previous = this.store.getSessionCheckpoint(session.id);
    const instructions = turn.content.slice("/compact".length).trim();
    const noChange = (message: string) => {
      signal.throwIfAborted();
      this.store.appendModelMessage(turnId, { role: "user", content: turn.content });
      this.store.appendModelMessage(turnId, { role: "assistant", content: message });
      this.store.appendMessageDelta(turnId, message);
      this.store.completeTurn(turnId);
    };
    if (history.length <= RETAINED_TURNS) {
      noChange(`Nothing older to compact. Keeping the latest ${history.length} conversation turn${history.length === 1 ? "" : "s"} in full.`);
      return;
    }
    if (!inference.contextCapacity || !inference.maxOutputTokens) throw new Error("Compaction requires a configured context window and output budget");
    const prefix = history.slice(0, -RETAINED_TURNS);
    const retained = history.slice(-RETAINED_TURNS);
    const definitions = session.workspace ? this.tools.definitions() : [];
    const system: ProviderMessage = { role: "system", content: agentSystemPrompt({ workspaceRoot: session.workspace?.root,
      definitions, configured: this.options.systemPrompt, providerVision: this.options.providerVision }) };
    const estimate = (messages: ProviderMessage[]) => planRawContextRequest({ messages: [system, ...messages], tools: definitions,
      historicalTurns: [], capacityTokens: inference.contextCapacity, outputReserveTokens: inference.maxOutputTokens! +
        (this.options.providerVision && messages.some((message) => message.role === "tool" && message.imageArtifactIds?.length) ? 4096 : 0) }).plan;
    let checkpointMessage: ProviderMessage | undefined = previous ? { role: "assistant", content: previous.summary } : undefined;
    const before = estimate([...(checkpointMessage ? [checkpointMessage] : []), ...history.flatMap((entry) => entry.messages)]);
    const pending: SummarySource[] = prefix.flatMap((entry) => entry.messages.map((message) => ({ message })));
    let content: SummaryCheckpointContentV1 | undefined;
    let rounds = 0;
    while (pending.length) {
      signal.throwIfAborted();
      if (rounds >= MAX_SUMMARY_ROUNDS) throw new Error("Compaction exceeded its summary-round limit; the previous context is still active");
      const prepare = (count: number) => {
        const messages = buildSummaryCheckpointPrompt([...(checkpointMessage ? [checkpointMessage] : []), ...pending.slice(0, count).map((source) => source.message)], instructions);
        return { messages, plan: planRawContextRequest({ messages, tools: [], historicalTurns: [],
          capacityTokens: inference.contextCapacity, outputReserveTokens: inference.maxOutputTokens }).plan };
      };
      // Rolling summaries handle a history that no longer fits the summarizer.
      // Choose complete messages first; only oversized individual messages split.
      let low = 1; let high = pending.length; let size = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const { plan } = prepare(middle);
        if (plan.estimatedInputTokens <= plan.maximumPlannedInputTokens!) { size = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (!size) {
        const source = pending[0]!;
        const raw = source.fragment ?? JSON.stringify(source.message);
        if (raw.length < 512) throw new Error("The compaction summary and instructions do not fit this model's context window");
        const split = Math.floor(raw.length / 2);
        pending.splice(0, 1, ...[raw.slice(0, split), raw.slice(split)].map((part, index): SummarySource => ({ fragment: part,
          message: { role: "user", content: `Historical message fragment ${index + 1}/2 (source data):\n${part}` } })));
        continue;
      }
      const chunk = prepare(size);
      content = await this.summarize(turnId, inference, chunk.messages, chunk.plan, signal, size < pending.length);
      checkpointMessage = renderSummaryCheckpoint(content);
      pending.splice(0, size);
      rounds++;
    }
    const after = estimate([checkpointMessage!, ...retained.flatMap((entry) => entry.messages)]);
    if (after.estimatedInputTokens >= before.estimatedInputTokens) {
      noChange(`Context unchanged: the generated summary would not reduce the estimate (${before.estimatedInputTokens} → ${after.estimatedInputTokens} tokens). The existing context remains active.`);
      return;
    }
    signal.throwIfAborted();
    const checkpoint: SessionCheckpoint = { id: crypto.randomUUID(), sessionId: session.id, turnId, createdAt: new Date().toISOString(),
      summary: checkpointMessage!.content!, instructions, firstRetainedMessageId: retained[0]!.firstMessageId,
      summarizedTurns: (previous?.summarizedTurns ?? 0) + prefix.length, retainedTurns: retained.length,
      beforeTokens: before.estimatedInputTokens, afterTokens: after.estimatedInputTokens, contextPlan: after };
    const report = `Context compacted: ~${checkpoint.beforeTokens.toLocaleString("en-US")} → ~${checkpoint.afterTokens.toLocaleString("en-US")} tokens (estimated).\n`
      + `Summarized ${prefix.length} older turn${prefix.length === 1 ? "" : "s"}${previous ? " with the previous checkpoint" : ""}; kept the latest ${retained.length} turns in full. Full transcript remains in History.\n\n`
      + summaryMarkdown(content!);
    this.store.completeCompaction(turnId, checkpoint, report, version);
  }

  private async summarize(turnId: string, inference: TurnInference, messages: ProviderMessage[], contextPlan: ContextPlan,
    signal: AbortSignal, turnContinues: boolean): Promise<SummaryCheckpointContentV1> {
    const lease = await this.scheduler.acquire(turnId, signal);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let providerCallId: string | undefined;
    const started = performance.now();
    let firstTokenAt: number | null = null;
    let finishReason: string | undefined;
    let successful = false;
    const metrics = () => ({ queueDurationMs: Math.max(0, Math.round(lease.queueDurationMs)),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      timeToFirstTokenMs: firstTokenAt === null ? null : Math.max(0, Math.round(firstTokenAt - started)) });
    try {
      signal.throwIfAborted();
      ({ providerCallId } = this.store.startProviderCall(turnId, inference.providerId, inference.modelId,
        { thinkingEnabled: false, profile: inference.profile, contextPlan }));
      let text = ""; let hasReasoning = false; let outputTokens: number | null = null;
      let events = 0; let usageReceived = false;
      const limits = providerStreamLimits(inference.maxOutputTokens, this.options);
      for await (const event of withProviderDeadlines(inference.stream(messages, [], controller.signal), controller,
        limits.firstEventTimeoutMs, limits.requestTimeoutMs)) {
        signal.throwIfAborted();
        if (++events > limits.eventLimit) throw new Error("Compaction exceeded the provider event limit");
        if (event.type === "text_delta" || event.type === "reasoning_delta") firstTokenAt ??= performance.now();
        if (event.type === "text_delta") {
          text += event.delta;
          if (text.length > 65536) throw new Error("Compaction summary exceeded its size limit");
        } else if (event.type === "reasoning_delta") hasReasoning = true;
        else if (event.type === "tool_call_delta") throw new Error("Compaction must return a summary, not call tools");
        else if (event.type === "finish") {
          if (finishReason !== undefined) throw new Error("Provider emitted multiple finish reasons");
          finishReason = event.reason;
        } else if (event.type === "usage") {
          if (usageReceived) throw new Error("Provider emitted multiple usage events");
          usageReceived = true; outputTokens = event.usage.outputTokens;
          this.store.recordProviderUsage(providerCallId, event.usage);
        }
      }
      signal.throwIfAborted();
      assertModelResponseComplete({ finishReason, outputTokens, maxOutputTokens: inference.maxOutputTokens,
        provider: inference.providerId, text, hasReasoning, hasToolCalls: false });
      const content = parseSummaryCheckpoint(text);
      this.store.recordProviderMetrics(providerCallId, metrics());
      this.store.settleProviderCall(providerCallId, "completed", undefined, finishReason);
      successful = true;
      return content;
    } catch (error) {
      controller.abort(error);
      if (providerCallId && !signal.aborted) {
        this.store.recordProviderMetrics(providerCallId, metrics());
        this.store.settleProviderCall(providerCallId, "failed", error instanceof Error ? error.message : "Compaction failed", finishReason);
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      lease.release({ turnContinues: successful && turnContinues });
    }
  }
}

function summaryMarkdown(content: SummaryCheckpointContentV1): string {
  const sections: [string, string[]][] = [
    ["Goal", [content.goal]], ["Current state", [content.currentState]],
    ["Constraints", content.constraints.map((entry) => entry.text)],
    ["Decisions", content.decisions.map((entry) => `${entry.status}: ${entry.text}`)],
    ["Files", content.files.map((file) => `${file.path}: ${[...file.facts, ...file.changes].join("; ")}`)],
    ["Validation", content.validation.map((entry) => `${entry.command.join(" ")} — ${entry.outcome}: ${entry.fact}`)],
    ["Pending work", content.unresolved.map((entry) => entry.text)],
  ];
  return sections.filter(([, values]) => values.length).map(([title, values]) => `### ${title}\n${values.map((text) => `- ${text}`).join("\n")}`).join("\n\n");
}
