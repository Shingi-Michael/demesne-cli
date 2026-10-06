import { createHash } from "node:crypto";
import { isRecord, type ModelDescriptor } from "@demesne/protocol";
import { ProviderError, readEventData, readLimitedText, type ProviderAdapter, type ProviderMessage, type ProviderRequest, type ProviderStreamEvent } from "./index.ts";

const API = "https://api.openai.com/v1";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const SOL = "gpt-6.1-sol";
// Public Responses specifications, not an assertion of account eligibility:
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
const SOL_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"];
function solDescriptor(): ModelDescriptor {
  return { id: SOL, displayName: "GPT-6.1 Sol", provider: "ChatGPT", contextWindow: 1_050_000, maxOutputTokens: 128_000,
    reasoningLevels: [...SOL_REASONING_LEVELS], defaultReasoningLevel: "medium" };
}
const integer = (n: unknown): number | undefined => typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
const count = (n: unknown): number | null => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
function wireName(name: string): string { return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : `${name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 47)}_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`; }

/** ChatGPT plan OAuth uses public Responses, with a fixed credential destination. */
export class ChatGPTProvider implements ProviderAdapter {
  readonly id = "ChatGPT";
  private readonly fetcher: typeof fetch;
  /// Models whose catalog entry says they can stream reasoning summaries.
  private readonly summaries = new Set<string>();
  private listedSol?: ModelDescriptor;
  private verifiedSol = false;
  constructor(private readonly options: {
    accountId: string;
    accessToken: (signal?: AbortSignal) => Promise<string>;
    contextWindow?: number;
    /// Retain an explicitly selected Sol model when the account catalog omits it.
    /// This is discovery metadata; inference still enforces account eligibility.
    configuredModel?: string;
    fetch?: typeof fetch;
  }) { this.fetcher = options.fetch ?? fetch; }
  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const response = await this.request("models", { signal });
    if (!response.ok) throw await httpError(response);
    let body: unknown;
    try { body = JSON.parse(await readLimitedText(response, 1024 * 1024)); } catch { throw new ProviderError("ChatGPT returned an invalid model catalog."); }
    if (!isRecord(body) || !Array.isArray(body.models) || body.models.length > 1000) throw new ProviderError("ChatGPT returned an invalid model catalog.");
    this.summaries.clear();
    const seen = new Set<string>();
    const models = body.models.flatMap((m): ModelDescriptor[] => {
      if (!isRecord(m) || m.visibility !== "list" || typeof m.slug !== "string" || !m.slug || seen.has(m.slug)) return [];
      seen.add(m.slug);
      if (m.supports_reasoning_summaries === true) this.summaries.add(m.slug);
      const levels = Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.flatMap((level: unknown) => isRecord(level) && typeof level.effort === "string" && /^[a-z]{1,16}$/.test(level.effort) ? [level.effort] : [])
        : [];
      return [{ id: m.slug, displayName: typeof m.display_name === "string" ? m.display_name : m.slug, provider: this.id,
        contextWindow: integer(m.context_window) ?? this.options.contextWindow,
        maxOutputTokens: integer(m.max_output_tokens),
        ...(levels.length ? { reasoningLevels: levels } : {}),
        ...(typeof m.default_reasoning_level === "string" && levels.includes(m.default_reasoning_level) ? { defaultReasoningLevel: m.default_reasoning_level } : {}) }];
    });
    this.listedSol = models.find(model => model.id === SOL);
    // Do not probe from discovery or inject every documented model. A selected
    // model may be usable despite lagging catalog data; an explicit verification
    // can also retain Sol for this provider/account instance only.
    if (!this.listedSol && (this.options.configuredModel === SOL || this.verifiedSol)) models.push(solDescriptor());
    return models;
  }
  /// Verify an explicitly requested, unlisted Sol with a small synthetic request.
  /// No workspace messages or tools are sent, and no credential/config is changed.
  async verifyModel(model: string, signal?: AbortSignal): Promise<ModelDescriptor> {
    signal?.throwIfAborted();
    if (model !== SOL) throw new ProviderError("This model is not in the ChatGPT account catalog. Choose a listed model; only gpt-6.1-sol supports explicit verification.", undefined, "model_not_listed");
    if (!this.verifiedSol) {
      for await (const _event of this.stream({ model, messages: [{ role: "user", content: "Reply exactly: OK." }], reasoningLevel: "low", thinkingEnabled: false }, signal ?? new AbortController().signal)) { /* Consume through the validated terminal event. */ }
      this.verifiedSol = true;
    }
    return this.listedSol ? { ...this.listedSol, ...(this.listedSol.reasoningLevels ? { reasoningLevels: [...this.listedSol.reasoningLevels] } : {}) } : solDescriptor();
  }
  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    if (request.model === SOL && request.reasoningLevel) {
      const levels = this.listedSol?.reasoningLevels ?? SOL_REASONING_LEVELS;
      if (!levels.includes(request.reasoningLevel)) throw new ProviderError(`GPT-6.1 Sol through ChatGPT does not support the ${request.reasoningLevel} reasoning effort. Choose ${levels.join(", ")}.`, undefined, "unsupported_reasoning_effort");
    }
    const names = new Map((request.tools ?? []).map(t => [wireName(t.name), t.name]));
    const response = await this.request("responses", { signal, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      model: request.model, store: false, stream: true,
      // Each tool round resends the conversation; the key lets the plan route
      // reuse its cached prefix instead of reprocessing every token.
      ...(request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
      // The chosen effort, and a readable summary of the model's reasoning
      // (shown as its thinking) when the model offers one.
      ...(() => {
        const summary = this.summaries.has(request.model) && request.thinkingEnabled !== false;
        return request.reasoningLevel || summary ? { reasoning: { ...(request.reasoningLevel ? { effort: request.reasoningLevel } : {}), ...(summary ? { summary: "auto" } : {}) } } : {};
      })(),
      input: this.input(request.messages, request.model), include: ["reasoning.encrypted_content"],
      // The plan route forbids max_output_tokens, temperature and other Chat Completions knobs.
      ...(request.tools?.length ? { tools: [{ type: "namespace", name: "demesne", description: "Demesne workspace and agent tools.", tools: request.tools.map(t => ({ type: "function", name: wireName(t.name), description: t.description, parameters: t.inputSchema, strict: false })) }] } : {}),
    }) });
    if (!response.ok) throw await httpError(response);
    if (!response.body) throw new ProviderError("ChatGPT returned an empty stream.");
    const calls = new Map<number, { index: number; id: string; name: string; arguments: string; done: boolean }>();
    const startedItems = new Map<number, { id: unknown; type: unknown }>();
    const finishedItems = new Map<number, Record<string, unknown>>();
    let finishedItemBytes = 0;
    let completed = false;
    let summaryParts = 0;
    for await (const data of readEventData(response.body)) {
      let event: unknown;
      try { event = JSON.parse(data); } catch { throw new ProviderError("ChatGPT stream contained invalid JSON."); }
      if (!isRecord(event)) throw new ProviderError("ChatGPT stream contained an invalid event.");
      if (event.type === "error") throw responseError(event);
      if (event.type === "response.failed" || event.type === "response.incomplete") {
        const result = isRecord(event.response) ? event.response : {};
        if (isRecord(result.error)) throw responseError(result.error);
        throw new ProviderError("ChatGPT did not complete this response. Progress is saved; send a follow-up to continue.", undefined, "incomplete_response");
      }
      if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
        if (typeof event.delta === "string") yield { type: "text_delta", delta: event.delta };
      }
      // Each summary part is its own short section ("**Checking the bound**"):
      // start every part after the first on a new paragraph.
      if (event.type === "response.reasoning_summary_part.added" && request.thinkingEnabled !== false && summaryParts++ > 0) yield { type: "reasoning_delta", delta: "\n\n" };
      if (event.type === "response.reasoning_summary_text.delta" && typeof event.delta === "string" && request.thinkingEnabled !== false) yield { type: "reasoning_delta", delta: event.delta };
      if (event.type === "response.output_item.added") {
        if (!Number.isSafeInteger(event.output_index) || Number(event.output_index) < 0 || !isRecord(event.item) || startedItems.has(Number(event.output_index))) throw new ProviderError("ChatGPT returned an invalid output item.");
        startedItems.set(Number(event.output_index), { id: event.item.id, type: event.item.type });
        if (startedItems.size > 1000) throw new ProviderError("ChatGPT response exceeded the output item limit.");
      }
      if (event.type === "response.output_item.added" && isRecord(event.item) && event.item.type === "function_call") {
        const item = event.item;
        if (!Number.isSafeInteger(event.output_index) || calls.has(Number(event.output_index)) || typeof item.call_id !== "string" || typeof item.name !== "string" || item.namespace !== "demesne" || !names.has(item.name)) throw new ProviderError("ChatGPT returned an unknown tool call.");
        const call = { index: calls.size, id: item.call_id, name: names.get(item.name)!, arguments: typeof item.arguments === "string" ? item.arguments : "", done: false };
        calls.set(Number(event.output_index), call);
        yield { type: "tool_call_delta", index: call.index, idDelta: call.id, nameDelta: call.name, argumentsDelta: call.arguments };
      }
      if (event.type === "response.function_call_arguments.delta") {
        const call = calls.get(Number(event.output_index));
        if (!call || call.done || typeof event.delta !== "string") throw new ProviderError("ChatGPT returned an invalid tool argument stream.");
        call.arguments += event.delta;
        if (call.arguments.length > 128 * 1024) throw new ProviderError("ChatGPT tool arguments exceeded the limit.");
        yield { type: "tool_call_delta", index: call.index, idDelta: "", nameDelta: "", argumentsDelta: event.delta };
      }
      if (event.type === "response.output_item.done" && isRecord(event.item) && event.item.type === "function_call") {
        const call = calls.get(Number(event.output_index));
        if (!call || event.item.call_id !== call.id || event.item.arguments !== call.arguments || names.get(String(event.item.name)) !== call.name || event.item.namespace !== "demesne") throw new ProviderError("ChatGPT returned conflicting tool call data.");
        call.done = true;
      }
      if (event.type === "response.output_item.done") {
        if (!Number.isSafeInteger(event.output_index) || Number(event.output_index) < 0 || !isRecord(event.item) || typeof event.item.type !== "string" || finishedItems.has(Number(event.output_index))) throw new ProviderError("ChatGPT returned an invalid completed output item.");
        const started = startedItems.get(Number(event.output_index));
        if (started && (started.id !== event.item.id || started.type !== event.item.type)) throw new ProviderError("ChatGPT changed an output item's identity.");
        if (event.item.status !== undefined && event.item.status !== "completed") throw new ProviderError("ChatGPT returned an unfinished output item.");
        finishedItemBytes += JSON.stringify(event.item).length;
        if (finishedItemBytes > 1024 * 1024 || finishedItems.size >= 1000) throw new ProviderError("ChatGPT response state exceeded the limit.");
        finishedItems.set(Number(event.output_index), event.item);
      }
      if (event.type === "response.completed") {
        if (!isRecord(event.response) || event.response.status !== "completed" || !Array.isArray(event.response.output) || event.response.output.some((item: unknown) => !isRecord(item))) throw new ProviderError("ChatGPT returned an invalid completion event.");
        if (request.model === SOL && event.response.model !== request.model) throw new ProviderError("ChatGPT did not confirm the requested GPT-6.1 Sol model in its completed response.", undefined, "model_mismatch");
        // The ChatGPT plan route can send an empty terminal output array after
        // emitting every completed item individually. Keep those items (including
        // encrypted reasoning) in output-index order for the next tool round.
        const terminalOutput = event.response.output as Record<string, unknown>[];
        if (!terminalOutput.length && [...startedItems.keys()].some(index => !finishedItems.has(index))) throw new ProviderError("ChatGPT returned incomplete output items.");
        const output = terminalOutput.length ? terminalOutput : [...finishedItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
        if (JSON.stringify(output).length > 1024 * 1024) throw new ProviderError("ChatGPT response state exceeded the limit.");
        if ([...calls.values()].some(c => !c.done) || output.filter(i => i.type === "function_call").length !== calls.size) throw new ProviderError("ChatGPT returned incomplete tool calls.");
        for (const item of output.filter(i => i.type === "function_call")) {
          if (![...calls.values()].some(c => c.id === item.call_id && c.arguments === item.arguments && c.name === names.get(String(item.name)) && item.namespace === "demesne")) throw new ProviderError("ChatGPT completion changed a tool call.");
        }
        yield { type: "response_state", state: { accountId: this.options.accountId, model: request.model, output } };
        const usage = event.response.usage;
        if (isRecord(usage)) yield { type: "usage", usage: { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens), totalTokens: count(usage.total_tokens),
          ...(isRecord(usage.input_tokens_details) && count(usage.input_tokens_details.cached_tokens) !== null ? { cachedInputTokens: count(usage.input_tokens_details.cached_tokens)! } : {}) } };
        yield { type: "finish", reason: calls.size ? "tool_calls" : "stop" };
        completed = true; break;
      }
    }
    if (!completed) throw new ProviderError("ChatGPT stream ended before response.completed. No pending tools were executed.", undefined, "interrupted_stream");
  }
  private input(messages: ProviderMessage[], model: string): Record<string, unknown>[] {
    const input: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (message.role === "assistant" && message.responses?.accountId === this.options.accountId && message.responses.model === model) {
        // Interrupted turns may have retained only the calls with completed tool results.
        const ids = new Set(message.toolCalls?.map(c => c.id));
        input.push(...message.responses.output.filter(i => i.type !== "function_call" || ids.has(String(i.call_id))));
      } else if (message.role === "tool") input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      else {
        if (message.content) input.push({ role: message.role === "system" ? "developer" : message.role, content: message.content });
        if (message.role === "assistant") for (const call of message.toolCalls ?? []) input.push({ type: "function_call", call_id: call.id, name: wireName(call.name), namespace: "demesne", arguments: call.arguments });
      }
      if (message.imageInputs?.length) input.push({ role: "user", content: message.imageInputs.map(image => ({ type: "input_image", image_url: image.url, detail: "auto" })) });
    }
    return input;
  }
  private async request(path: "models" | "responses", init: RequestInit): Promise<Response> {
    const token = await this.options.accessToken(init.signal ?? undefined);
    return this.fetcher(`${API}/${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, redirect: "manual" });
  }
}
const messages: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: `Your ChatGPT plan usage limit has been reached. Manage usage: ${CHATGPT_USAGE_URL}. Demesne will not switch billing automatically.`,
  subscription_sharing_user_not_eligible: "This ChatGPT account is not eligible for plan usage in Demesne. Choose another account.",
  subscription_sharing_usage_unavailable: "ChatGPT usage is temporarily unavailable. Try again later.",
  subscription_sharing_user_unavailable: "ChatGPT is temporarily unavailable. Try again later.",
  invalid_user: "ChatGPT could not authorize this account. Sign in again if the connection was revoked.",
  unsupported_capability: "ChatGPT rejected an unsupported request capability. Update Demesne before retrying.",
  route_not_supported: "ChatGPT rejected the API route.",
  chatpass_v2_scope_not_authorized: "ChatGPT plan permission is missing. Sign in again with --consent.",
  invalid_authorization_context: "ChatGPT rejected this authorization. Sign in again with --consent.",
};
function responseError(value: Record<string, unknown>, status?: number): ProviderError {
  const code = typeof value.code === "string" && /^[a-z0-9_]{1,100}$/.test(value.code) ? value.code : undefined;
  // Do not reflect server messages: they can contain request headers or credentials.
  return new ProviderError(code && messages[code] || `ChatGPT request failed${status ? ` (HTTP ${status})` : ""}${code ? `: ${code}` : ""}.`, status, code);
}
async function httpError(response: Response): Promise<ProviderError> {
  try {
    const value = JSON.parse(await readLimitedText(response, 4096, false));
    if (isRecord(value)) return responseError(isRecord(value.error) ? value.error : isRecord(value.detail) ? value.detail : value, response.status);
  } catch { /* Never echo an unstructured error body. */ }
  return new ProviderError(`ChatGPT request failed (HTTP ${response.status}).`, response.status);
}
