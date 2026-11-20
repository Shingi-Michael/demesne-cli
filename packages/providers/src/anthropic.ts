import Anthropic from "@anthropic-ai/sdk";
import { CACHE_LIFE_MS, ProviderError, type ProviderAdapter, type ProviderMessage, type ProviderRequest, type ProviderStreamEvent } from "./index.ts";

const origin = "https://api.anthropic.com";
export function isAnthropicEndpoint(url?: string): boolean {
  return [origin, `${origin}/v1`].includes((url ?? "").replace(/\/$/, ""));
}

function images(message: ProviderMessage): Anthropic.ImageBlockParam[] {
  return (message.imageInputs ?? []).map(({ url }) => {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/.exec(url);
    if (!match) throw new ProviderError("Claude image inputs require a supported base64 image");
    return { type: "image", source: { type: "base64", media_type: match[1] as Anthropic.Base64ImageSource["media_type"], data: match[2]! } };
  });
}

function history(input: ProviderMessage[]) {
  const system: Anthropic.TextBlockParam[] = [];
  const messages: { role: "user" | "assistant"; content: Anthropic.ContentBlockParam[] }[] = [];
  for (const message of input) {
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
  constructor(private readonly key?: string, readonly id = "Anthropic", private readonly transport?: typeof fetch) {}
  private client() {
    if (!this.key) throw new ProviderError("Set ANTHROPIC_API_KEY or configure an Anthropic API key");
    return new Anthropic({ apiKey: this.key, baseURL: origin, maxRetries: 0, fetch: this.transport, fetchOptions: { redirect: "error" } });
  }
  cacheLifeMs() { return CACHE_LIFE_MS.short; }
  async listModels(signal?: AbortSignal) {
    const models = [];
    for await (const model of this.client().models.list({}, { signal })) {
      models.push({ id: model.id, provider: this.id });
      if (models.length >= 1000) break;
    }
    return models;
  }
  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    const stream = await this.client().messages.create({ model: request.model, stream: true,
      ...history(request.messages), max_tokens: request.maxOutputTokens ?? 4096,
      cache_control: { type: "ephemeral" },
      ...(request.tools?.length ? { tools: request.tools.map(t => ({ name: t.name, description: t.description, input_schema: { ...t.inputSchema, type: "object" as const } })) } : {}),
    }, { signal });
    let usage: Anthropic.Usage | undefined;
    let finish = "stop";
    for await (const event of stream) {
      if (event.type === "message_start") usage = event.message.usage;
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") yield { type: "tool_call_delta", index: event.index, idDelta: event.content_block.id, nameDelta: event.content_block.name, argumentsDelta: "" };
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") yield { type: "text_delta", delta: event.delta.text };
        if (event.delta.type === "input_json_delta") yield { type: "tool_call_delta", index: event.index, idDelta: "", nameDelta: "", argumentsDelta: event.delta.partial_json };
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
