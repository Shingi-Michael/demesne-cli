import Anthropic from "@anthropic-ai/sdk";
import { CACHE_LIFE_MS, ProviderError, type ProviderAdapter, type ProviderMessage, type ProviderRequest, type ProviderStreamEvent } from "./index.ts";
import type { ModelDescriptor } from "@demesne/protocol";

const origin = "https://api.anthropic.com";
export function isAnthropicEndpoint(url?: string): boolean {
  return [origin, `${origin}/v1`].includes((url ?? "").replace(/\/$/, ""));
}

/// How a Claude model takes a thinking level, read from its listed capabilities:
/// adaptive thinking with an effort (newer models), a token budget (older
/// ones), and whether thinking can be turned off.
export interface ClaudeThinking { efforts: string[]; adaptive: boolean; budget: boolean; off: boolean }
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;
/// Token budgets for models that think by budget instead of effort.
export const THINKING_BUDGETS: Record<string, number> = { low: 2_048, medium: 8_192, high: 16_384 };

const yes = (value: unknown) => typeof value === "object" && value !== null && (value as { supported?: unknown }).supported === true;
export function claudeThinking(capabilities: Anthropic.ModelCapabilities | null | undefined): ClaudeThinking | null {
  if (!capabilities) return null;
  const effort = capabilities.effort, types = capabilities.thinking?.types;
  const efforts = yes(effort) ? EFFORT_ORDER.filter((level) => yes(effort[level])) : [];
  const adaptive = yes(types?.adaptive), budget = yes(types?.enabled);
  if (!efforts.length && !budget && !adaptive) return null;
  return { efforts, adaptive, budget, off: yes(types?.disabled) };
}
/// The levels the picker shows: "off" first when it can be turned off.
export function claudeLevels(thinking: ClaudeThinking | null): string[] | undefined {
  if (!thinking) return undefined;
  const levels = thinking.efforts.length ? thinking.efforts : thinking.budget ? Object.keys(THINKING_BUDGETS) : [];
  if (!levels.length) return undefined;
  return thinking.off ? ["off", ...levels] : levels;
}

/// What a request sends for a level: thinking, an effort, and room for both.
export function thinkingParams(thinking: ClaudeThinking | undefined, level: string | undefined, maxTokens: number):
  { thinking?: Anthropic.ThinkingConfigParam; output_config?: { effort: NonNullable<Anthropic.OutputConfig["effort"]> }; max_tokens: number; on: boolean } {
  if (!thinking || !level) return { max_tokens: maxTokens, on: false };
  if (level === "off" || level === "none") return { ...(thinking.off ? { thinking: { type: "disabled" as const } } : {}), max_tokens: maxTokens, on: false };
  const effort = (EFFORT_ORDER as readonly string[]).includes(level) && thinking.efforts.includes(level) ? level as NonNullable<Anthropic.OutputConfig["effort"]> : undefined;
  if (thinking.adaptive) return { thinking: { type: "adaptive", display: "summarized" }, ...(effort ? { output_config: { effort } } : {}), max_tokens: Math.max(maxTokens, 32_000), on: true };
  if (thinking.budget) {
    const budget_tokens = THINKING_BUDGETS[level] ?? THINKING_BUDGETS[effort === "low" ? "low" : effort ? "high" : "medium"]!;
    return { thinking: { type: "enabled", budget_tokens }, ...(effort ? { output_config: { effort } } : {}), max_tokens: Math.max(maxTokens, budget_tokens + 8_192), on: true };
  }
  return { ...(effort ? { output_config: { effort } } : {}), max_tokens: maxTokens, on: false };
}

/// Claude's thinking in a tool loop goes back to it unchanged, signature
/// and all: it rides on the first tool call's `extra` under this key.
export const CLAUDE_THINKING = "anthropicThinking";
type ThinkingBlock = Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam;
export const isClaudeThinking = (extra: unknown): extra is Record<typeof CLAUDE_THINKING, ThinkingBlock[]> =>
  typeof extra === "object" && extra !== null && Array.isArray((extra as Record<string, unknown>)[CLAUDE_THINKING]);

function images(message: ProviderMessage): Anthropic.ImageBlockParam[] {
  return (message.imageInputs ?? []).map(({ url }) => {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/.exec(url);
    if (!match) throw new ProviderError("Claude image inputs require a supported base64 image");
    return { type: "image", source: { type: "base64", media_type: match[1] as Anthropic.Base64ImageSource["media_type"], data: match[2]! } };
  });
}

/// thinking: thinking is on for this request, so the current tool loop's
/// thinking goes back (it must, in a loop; older turns' is dropped by Claude anyway).
function history(input: ProviderMessage[], thinking = false) {
  const system: Anthropic.TextBlockParam[] = [];
  const messages: { role: "user" | "assistant"; content: Anthropic.ContentBlockParam[] }[] = [];
  const loopStart = input.findLastIndex((message) => message.role === "user");
  for (const [index, message] of input.entries()) {
    if (message.role === "system") {
      if (message.content) system.push({ type: "text", text: message.content });
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (message.role === "tool") {
      const pictures = images(message);
      blocks.push({ type: "tool_result", tool_use_id: message.toolCallId, content: pictures.length ? [...(message.content ? [{ type: "text" as const, text: message.content }] : []), ...pictures] : message.content });
    } else {
      const extra = message.role === "assistant" ? message.toolCalls?.[0]?.extra : undefined;
      if (thinking && index > loopStart && isClaudeThinking(extra)) blocks.push(...extra[CLAUDE_THINKING]);
      if (message.content) blocks.push({ type: "text", text: message.content });
      if (message.role === "user") blocks.push(...images(message));
      else for (const call of message.toolCalls ?? []) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: JSON.parse(call.arguments || "{}") });
    }
    if (!blocks.length) continue;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  return { system, messages };
}

export class AnthropicProvider implements ProviderAdapter {
  readonly vision = true;
  /// What each listed model says about thinking, kept for its requests.
  private readonly thinking = new Map<string, ClaudeThinking | null>();
  constructor(private readonly key?: string, readonly id = "Anthropic", private readonly transport?: typeof fetch) {}
  private client() {
    if (!this.key) throw new ProviderError("Set ANTHROPIC_API_KEY or configure an Anthropic API key");
    return new Anthropic({ apiKey: this.key, baseURL: origin, maxRetries: 0, fetch: this.transport, fetchOptions: { redirect: "error" } });
  }
  cacheLifeMs() { return CACHE_LIFE_MS.short; }
  async listModels(signal?: AbortSignal) {
    const models: ModelDescriptor[] = [];
    for await (const model of this.client().models.list({}, { signal })) {
      const thinking = claudeThinking(model.capabilities), reasoningLevels = claudeLevels(thinking);
      this.thinking.set(model.id, thinking);
      models.push({ id: model.id, provider: this.id, ...(reasoningLevels ? { reasoningLevels, defaultReasoningLevel: reasoningLevels.includes("medium") ? "medium" : reasoningLevels.at(-1)! } : {}) });
      if (models.length >= 1000) break;
    }
    return models;
  }
  /// A model the list hasn't shown yet (a turn before the picker loaded) is looked up once.
  private async thinkingOf(id: string, signal: AbortSignal): Promise<ClaudeThinking | undefined> {
    if (!this.thinking.has(id)) {
      try { this.thinking.set(id, claudeThinking((await this.client().models.retrieve(id, {}, { signal })).capabilities)); }
      catch { if (signal.aborted) throw signal.reason; return undefined; }
    }
    return this.thinking.get(id) ?? undefined;
  }
  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    const level = request.reasoningLevel ?? (request.thinkingEnabled === false ? "off" : undefined);
    const params = thinkingParams(level ? await this.thinkingOf(request.model, signal) : undefined, level, request.maxOutputTokens ?? 4096);
    const stream = await this.client().messages.create({ model: request.model, stream: true,
      ...history(request.messages, params.on), max_tokens: params.max_tokens,
      ...(params.thinking ? { thinking: params.thinking } : {}),
      ...(params.output_config ? { output_config: params.output_config } : {}),
      cache_control: { type: "ephemeral" },
      ...(request.tools?.length ? { tools: request.tools.map(t => ({ name: t.name, description: t.description, input_schema: { ...t.inputSchema, type: "object" as const } })) } : {}),
    }, { signal });
    let usage: Anthropic.Usage | undefined;
    let finish = "stop";
    // This reply's thinking blocks, in order, to hand back with its tool calls.
    const thought: ThinkingBlock[] = [];
    let current: ThinkingBlock | undefined, handedBack = false;
    for await (const event of stream) {
      if (event.type === "message_start") usage = event.message.usage;
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "thinking") thought.push(current = { type: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? "" });
        else if (block.type === "redacted_thinking") thought.push(current = { type: "redacted_thinking", data: block.data });
        else current = undefined;
        if (block.type === "tool_use") {
          const extra = !handedBack && thought.length ? { extra: { [CLAUDE_THINKING]: thought } } : {};
          handedBack = true;
          yield { type: "tool_call_delta", index: event.index, idDelta: block.id, nameDelta: block.name, argumentsDelta: "", ...extra };
        }
      }
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") yield { type: "text_delta", delta: event.delta.text };
        if (event.delta.type === "input_json_delta") yield { type: "tool_call_delta", index: event.index, idDelta: "", nameDelta: "", argumentsDelta: event.delta.partial_json };
        if (event.delta.type === "thinking_delta") {
          if (current?.type === "thinking") current.thinking += event.delta.thinking;
          if (event.delta.thinking) yield { type: "reasoning_delta", delta: event.delta.thinking };
        }
        if (event.delta.type === "signature_delta" && current?.type === "thinking") current.signature = event.delta.signature;
      }
      if (event.type === "message_delta") {
        if (usage) for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const) {
          const n = event.usage[k]; if (typeof n === "number") usage[k] = n;
        }
        const reason = event.delta.stop_reason;
        finish = reason === "tool_use" ? "tool_calls" : reason === "max_tokens" || reason === "model_context_window_exceeded" ? "length" : reason === "end_turn" ? "stop" : reason ?? finish;
      }
      if (event.type === "message_stop") {
        if (usage) {
          const cachedInputTokens = usage.cache_read_input_tokens ?? 0, cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
          const inputTokens = usage.input_tokens + cachedInputTokens + cacheWriteTokens;
          yield { type: "usage", usage: { inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens: usage.output_tokens, totalTokens: inputTokens + usage.output_tokens } };
        }
        yield { type: "finish", reason: finish };
        return;
      }
    }
    throw new ProviderError("Anthropic stream ended before message_stop");
  }
}
