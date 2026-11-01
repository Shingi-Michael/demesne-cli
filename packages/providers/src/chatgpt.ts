import { createHash } from "node:crypto";
import { isRecord, planLimitsFromEvent, planLimitsFromHeaders, type ModelDescriptor, type PlanLimits } from "@demesne/protocol";
import { ProviderError, readEventData, readLimitedText, thinkingOffLevel, type ProviderAdapter, type ProviderMessage, type ProviderRequest, type ProviderStreamEvent } from "./index.ts";

import { randomUUID } from "node:crypto";

const API = "https://api.openai.com/v1";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
/// Codex's own backend, the one the Codex CLI and app talk to. Requests here
/// are signed in as Codex, so they count against the Codex plan.
export const CODEX_BACKEND_URL = "https://chatgpt.com/backend-api/codex";
/// The catalog is served per client version; this is the one it was read with.
const CODEX_CLIENT_VERSION = "0.164.0";

/// One Responses adapter, two routes: the public plan-sharing route (ChatGPT)
/// and Codex's backend (Codex). They differ in where requests go, the
/// headers that name the account, how tools are declared and how model ids
/// are spelled; the stream they return is the same.
interface Route {
  id: "ChatGPT" | "Codex";
  baseUrl: string;
  modelsPath: string;
  /// Model ids carry this prefix in Demesne ("codex/gpt-6.1-sol"); the wire gets the slug.
  modelPrefix: string;
  /// Tools go in a "demesne" namespace on the public route; Codex's backend takes plain functions.
  namespace: string | null;
  /// Codex's backend takes system text as `instructions`; the public route as developer input.
  instructions: boolean;
  /// Only the public route documents Sol specially (explicit verification when unlisted).
  sol: boolean;
  headers: (options: { accountId: string; cacheKey?: string }) => Record<string, string>;
  usage: string;
}
const CHATGPT_ROUTE: Route = { id: "ChatGPT", baseUrl: API, modelsPath: "models", modelPrefix: "", namespace: "demesne", instructions: false, sol: true, headers: () => ({}), usage: CHATGPT_USAGE_URL };
const CODEX_ROUTE: Route = { id: "Codex", baseUrl: CODEX_BACKEND_URL, modelsPath: `models?client_version=${CODEX_CLIENT_VERSION}`, modelPrefix: "codex/", namespace: null, instructions: true, sol: false,
  headers: ({ accountId, cacheKey }) => ({ "chatgpt-account-id": accountId, "OpenAI-Beta": "responses=experimental", originator: "codex_cli_rs", session_id: cacheKey ?? randomUUID(), Accept: "text/event-stream" }), usage: CHATGPT_USAGE_URL };
const SOL = "gpt-6.1-sol";
// Public Responses specifications, not an assertion of account eligibility:
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
const SOL_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"];
function solDescriptor(): ModelDescriptor {
  return { id: SOL, displayName: "GPT-6.1 Sol", provider: "ChatGPT", contextWindow: 1_050_000, maxOutputTokens: 128_000,
    reasoningLevels: [...SOL_REASONING_LEVELS], defaultReasoningLevel: thinkingOffLevel(SOL_REASONING_LEVELS) };
}
const integer = (n: unknown): number | undefined => typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
const count = (n: unknown): number | null => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
function wireName(name: string): string { return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : `${name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 47)}_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`; }

/** Streamed Responses with an OAuth bearer, to a fixed destination per route. */
export class ResponsesProvider implements ProviderAdapter {
  readonly id: "ChatGPT" | "Codex";
  readonly vision = true;
  private readonly fetcher: typeof fetch;
  /// Models whose catalog entry says they can stream reasoning summaries.
  private readonly summaries = new Set<string>();
  private listedSol?: ModelDescriptor;
  /// Each listed model's thinking levels, for its default when none is chosen.
  private readonly levels = new Map<string, string[]>();
  private verifiedSol = false;
  /// The plan's 5-hour and weekly windows, from the last response that said.
  private limits: PlanLimits | null = null;
  constructor(private readonly options: {
    accountId: string;
    accessToken: (signal?: AbortSignal) => Promise<string>;
    /// The account the backend bills, when it differs from the identity
    /// `accountId` (Codex reads it from the signed-in tokens).
    billingAccount?: (signal?: AbortSignal) => Promise<string>;
    contextWindow?: number;
    /// Retain an explicitly selected Sol model when the account catalog omits it.
    /// This is discovery metadata; inference still enforces account eligibility.
    configuredModel?: string;
    fetch?: typeof fetch;
  }, private readonly route: Route = CHATGPT_ROUTE) { this.fetcher = options.fetch ?? fetch; this.id = route.id; }
  planLimits(): PlanLimits | null { return this.limits; }
  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const response = await this.request(this.route.modelsPath, { signal }, { Accept: "application/json" });
    if (!response.ok) throw await httpError(response, this.route);
    let body: unknown;
    try { body = JSON.parse(await readLimitedText(response, 1024 * 1024)); } catch { throw new ProviderError(`${this.id} returned an invalid model catalog.`); }
    if (!isRecord(body) || !Array.isArray(body.models) || body.models.length > 1000) throw new ProviderError(`${this.id} returned an invalid model catalog.`);
    this.summaries.clear();
    this.levels.clear();
    const seen = new Set<string>();
    const models = body.models.flatMap((m): ModelDescriptor[] => {
      if (!isRecord(m) || m.visibility !== "list" || typeof m.slug !== "string" || !m.slug || seen.has(m.slug)) return [];
      seen.add(m.slug);
      if (m.supports_reasoning_summaries === true) this.summaries.add(m.slug);
      const levels = Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.flatMap((level: unknown) => isRecord(level) && typeof level.effort === "string" && /^[a-z]{1,16}$/.test(level.effort) ? [level.effort] : [])
        : [];
      if (levels.length) this.levels.set(m.slug, levels);
      return [{ id: this.route.modelPrefix + m.slug, displayName: typeof m.display_name === "string" ? m.display_name : m.slug, provider: this.id,
        contextWindow: integer(m.context_window) ?? this.options.contextWindow,
        maxOutputTokens: integer(m.max_output_tokens),
        ...(levels.length ? { reasoningLevels: levels, defaultReasoningLevel: thinkingOffLevel(levels) } : {}) }];
    });
    this.listedSol = models.find(model => model.id === SOL);
    // Do not probe from discovery or inject every documented model. A selected
    // model may be usable despite lagging catalog data; an explicit verification
    // can also retain Sol for this provider/account instance only.
    if (this.route.sol && !this.listedSol && (this.options.configuredModel === SOL || this.verifiedSol)) models.push(solDescriptor());
    return models;
  }
  /// Verify an explicitly requested, unlisted Sol with a small synthetic request.
  /// No workspace messages or tools are sent, and no credential/config is changed.
  async verifyModel(model: string, signal?: AbortSignal): Promise<ModelDescriptor> {
    signal?.throwIfAborted();
    if (!this.route.sol || model !== SOL) throw new ProviderError("This model is not in the ChatGPT account catalog. Choose a listed model; only gpt-6.1-sol supports explicit verification.", undefined, "model_not_listed");
    if (!this.verifiedSol) {
      for await (const _event of this.stream({ model, messages: [{ role: "user", content: "Reply exactly: OK." }], reasoningLevel: "low", thinkingEnabled: false }, signal ?? new AbortController().signal)) { /* Consume through the validated terminal event. */ }
      this.verifiedSol = true;
    }
    return this.listedSol ? { ...this.listedSol, ...(this.listedSol.reasoningLevels ? { reasoningLevels: [...this.listedSol.reasoningLevels] } : {}) } : solDescriptor();
  }
  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    // Thinking starts off (or at its lowest) unless a level was chosen.
    const sol = this.route.sol && request.model === SOL;
    if (!request.reasoningLevel && request.thinkingEnabled !== false) {
      const levels = sol ? this.listedSol?.reasoningLevels ?? SOL_REASONING_LEVELS : this.levels.get(request.model);
      if (levels?.length) request = { ...request, reasoningLevel: thinkingOffLevel(levels) };
    }
    if (sol && request.reasoningLevel) {
      const levels = this.listedSol?.reasoningLevels ?? SOL_REASONING_LEVELS;
      if (!levels.includes(request.reasoningLevel)) throw new ProviderError(`GPT-6.1 Sol through ChatGPT does not support the ${request.reasoningLevel} reasoning effort. Choose ${levels.join(", ")}.`, undefined, "unsupported_reasoning_effort");
    }
    const names = new Map((request.tools ?? []).map(t => [wireName(t.name), t.name]));
    const functions = (request.tools ?? []).map(t => ({ type: "function", name: wireName(t.name), description: t.description, parameters: t.inputSchema, strict: false }));
    const instructions = this.route.instructions ? request.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n") : "";
    const response = await this.request("responses", { signal, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      model: request.model.slice(this.route.modelPrefix.length), store: false, stream: true,
      ...(this.route.instructions ? { instructions, tool_choice: "auto", parallel_tool_calls: true } : {}),
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
      ...(functions.length ? { tools: this.route.namespace ? [{ type: "namespace", name: this.route.namespace, description: "Demesne workspace and agent tools.", tools: functions }] : functions } : {}),
    }) }, {}, request.cacheKey);
    if (!response.ok) throw await httpError(response, this.route);
    if (!response.body) throw new ProviderError(`${this.id} returned an empty stream.`);
    const calls = new Map<number, { index: number; id: string; name: string; arguments: string; done: boolean }>();
    const startedItems = new Map<number, { id: unknown; type: unknown }>();
    const finishedItems = new Map<number, Record<string, unknown>>();
    let finishedItemBytes = 0;
    let completed = false;
    let summaryParts = 0;
    for await (const data of readEventData(response.body)) {
      let event: unknown;
      try { event = JSON.parse(data); } catch { throw new ProviderError(`${this.id} stream contained invalid JSON.`); }
      if (!isRecord(event)) throw new ProviderError(`${this.id} stream contained an invalid event.`);
      if (event.type === "error") throw responseError(event, this.route);
      if (event.type === "codex.rate_limits") { this.limits = planLimitsFromEvent(this.id, event) ?? this.limits; continue; }
      if (event.type === "response.failed" || event.type === "response.incomplete") {
        const result = isRecord(event.response) ? event.response : {};
        if (isRecord(result.error)) throw responseError(result.error, this.route);
        throw new ProviderError(`${this.id} did not complete this response. Progress is saved; send a follow-up to continue.`, undefined, "incomplete_response");
      }
      if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
        if (typeof event.delta === "string") yield { type: "text_delta", delta: event.delta };
      }
      // Each summary part is its own short section ("**Checking the bound**"):
      // start every part after the first on a new paragraph.
      if (event.type === "response.reasoning_summary_part.added" && request.thinkingEnabled !== false && summaryParts++ > 0) yield { type: "reasoning_delta", delta: "\n\n" };
      if (event.type === "response.reasoning_summary_text.delta" && typeof event.delta === "string" && request.thinkingEnabled !== false) yield { type: "reasoning_delta", delta: event.delta };
      if (event.type === "response.output_item.added") {
        if (!Number.isSafeInteger(event.output_index) || Number(event.output_index) < 0 || !isRecord(event.item) || startedItems.has(Number(event.output_index))) throw new ProviderError(`${this.id} returned an invalid output item.`);
        startedItems.set(Number(event.output_index), { id: event.item.id, type: event.item.type });
        if (startedItems.size > 1000) throw new ProviderError(`${this.id} response exceeded the output item limit.`);
      }
      if (event.type === "response.output_item.added" && isRecord(event.item) && event.item.type === "function_call") {
        const item = event.item;
        if (!Number.isSafeInteger(event.output_index) || calls.has(Number(event.output_index)) || typeof item.call_id !== "string" || typeof item.name !== "string" || (item.namespace ?? null) !== this.route.namespace || !names.has(item.name)) throw new ProviderError(`${this.id} returned an unknown tool call.`);
        const call = { index: calls.size, id: item.call_id, name: names.get(item.name)!, arguments: typeof item.arguments === "string" ? item.arguments : "", done: false };
        calls.set(Number(event.output_index), call);
        yield { type: "tool_call_delta", index: call.index, idDelta: call.id, nameDelta: call.name, argumentsDelta: call.arguments };
      }
      if (event.type === "response.function_call_arguments.delta") {
        const call = calls.get(Number(event.output_index));
        if (!call || call.done || typeof event.delta !== "string") throw new ProviderError(`${this.id} returned an invalid tool argument stream.`);
        call.arguments += event.delta;
        if (call.arguments.length > 128 * 1024) throw new ProviderError(`${this.id} tool arguments exceeded the limit.`);
        yield { type: "tool_call_delta", index: call.index, idDelta: "", nameDelta: "", argumentsDelta: event.delta };
      }
      // The arguments can also arrive whole, with no deltas (the Codex route
      // does this for some calls): add what the deltas didn't carry. Text
      // that contradicts the streamed part is still refused.
      if (event.type === "response.function_call_arguments.done" || (event.type === "response.output_item.done" && isRecord(event.item) && event.item.type === "function_call")) {
        const call = calls.get(Number(event.output_index)), final = event.type === "response.function_call_arguments.done" ? event.arguments : isRecord(event.item) ? event.item.arguments : undefined;
        if (call && !call.done && typeof final === "string" && final.length > call.arguments.length && final.startsWith(call.arguments)) {
          if (final.length > 128 * 1024) throw new ProviderError(`${this.id} tool arguments exceeded the limit.`);
          const rest = final.slice(call.arguments.length);
          call.arguments = final;
          yield { type: "tool_call_delta", index: call.index, idDelta: "", nameDelta: "", argumentsDelta: rest };
        }
      }
      if (event.type === "response.output_item.done" && isRecord(event.item) && event.item.type === "function_call") {
        const call = calls.get(Number(event.output_index));
        if (!call || event.item.call_id !== call.id || event.item.arguments !== call.arguments || names.get(String(event.item.name)) !== call.name || (event.item.namespace ?? null) !== this.route.namespace) throw new ProviderError(`${this.id} returned conflicting tool call data.`);
        call.done = true;
      }
      if (event.type === "response.output_item.done") {
        if (!Number.isSafeInteger(event.output_index) || Number(event.output_index) < 0 || !isRecord(event.item) || typeof event.item.type !== "string" || finishedItems.has(Number(event.output_index))) throw new ProviderError(`${this.id} returned an invalid completed output item.`);
        const started = startedItems.get(Number(event.output_index));
        if (started && (started.id !== event.item.id || started.type !== event.item.type)) throw new ProviderError(`${this.id} changed an output item's identity.`);
        if (event.item.status !== undefined && event.item.status !== "completed") throw new ProviderError(`${this.id} returned an unfinished output item.`);
        finishedItemBytes += JSON.stringify(event.item).length;
        if (finishedItemBytes > 1024 * 1024 || finishedItems.size >= 1000) throw new ProviderError(`${this.id} response state exceeded the limit.`);
        finishedItems.set(Number(event.output_index), event.item);
      }
      if (event.type === "response.completed") {
        if (!isRecord(event.response) || event.response.status !== "completed" || !Array.isArray(event.response.output) || event.response.output.some((item: unknown) => !isRecord(item))) throw new ProviderError(`${this.id} returned an invalid completion event.`);
        if (sol && event.response.model !== request.model) throw new ProviderError(`${this.id} did not confirm the requested GPT-6.1 Sol model in its completed response.`, undefined, "model_mismatch");
        // The ChatGPT plan route can send an empty terminal output array after
        // emitting every completed item individually. Keep those items (including
        // encrypted reasoning) in output-index order for the next tool round.
        const terminalOutput = event.response.output as Record<string, unknown>[];
        if (!terminalOutput.length && [...startedItems.keys()].some(index => !finishedItems.has(index))) throw new ProviderError(`${this.id} returned incomplete output items.`);
        const output = terminalOutput.length ? terminalOutput : [...finishedItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
        if (JSON.stringify(output).length > 1024 * 1024) throw new ProviderError(`${this.id} response state exceeded the limit.`);
        if ([...calls.values()].some(c => !c.done) || output.filter(i => i.type === "function_call").length !== calls.size) throw new ProviderError(`${this.id} returned incomplete tool calls.`);
        for (const item of output.filter(i => i.type === "function_call")) {
          if (![...calls.values()].some(c => c.id === item.call_id && c.arguments === item.arguments && c.name === names.get(String(item.name)) && (item.namespace ?? null) === this.route.namespace)) throw new ProviderError(`${this.id} completion changed a tool call.`);
        }
        yield { type: "response_state", state: { accountId: this.options.accountId, model: request.model, output } };
        const usage = event.response.usage;
        if (isRecord(usage)) yield { type: "usage", usage: { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens), totalTokens: count(usage.total_tokens),
          ...(isRecord(usage.input_tokens_details) && count(usage.input_tokens_details.cached_tokens) !== null ? { cachedInputTokens: count(usage.input_tokens_details.cached_tokens)! } : {}) } };
        yield { type: "finish", reason: calls.size ? "tool_calls" : "stop" };
        completed = true; break;
      }
    }
    if (!completed) throw new ProviderError(`${this.id} stream ended before response.completed. No pending tools were executed.`, undefined, "interrupted_stream");
  }
  private input(messages: ProviderMessage[], model: string): Record<string, unknown>[] {
    const input: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (message.role === "assistant" && message.responses?.accountId === this.options.accountId && message.responses.model === model) {
        // Interrupted turns may have retained only the calls with completed tool results.
        const ids = new Set(message.toolCalls?.map(c => c.id));
        input.push(...message.responses.output.filter(i => i.type !== "function_call" || ids.has(String(i.call_id))));
      } else if (message.role === "tool") input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      else if (message.role === "system" && this.route.instructions) continue;
      else {
        if (message.content) input.push({ role: message.role === "system" ? "developer" : message.role, content: message.content });
        if (message.role === "assistant") for (const call of message.toolCalls ?? []) input.push({ type: "function_call", call_id: call.id, name: wireName(call.name), ...(this.route.namespace ? { namespace: this.route.namespace } : {}), arguments: call.arguments });
      }
      if (message.imageInputs?.length) input.push({ role: "user", content: message.imageInputs.map(image => ({ type: "input_image", image_url: image.url, detail: "auto" })) });
    }
    return input;
  }
  private async request(path: string, init: RequestInit & { headers?: Record<string, string> }, extra: Record<string, string> = {}, cacheKey?: string): Promise<Response> {
    const signal = init.signal ?? undefined;
    const token = await this.options.accessToken(signal);
    const accountId = this.options.billingAccount ? await this.options.billingAccount(signal) : this.options.accountId;
    const headers = { ...init.headers, ...this.route.headers({ accountId, cacheKey }), ...extra, Authorization: `Bearer ${token}` };
    const response = await this.fetcher(`${this.route.baseUrl}/${path}`, { ...init, headers, redirect: "manual" });
    // Every answer, a refusal at the limit included, says how full the plan is.
    this.limits = planLimitsFromHeaders(this.id, response.headers) ?? this.limits;
    return response;
  }
}
/** ChatGPT plan OAuth uses public Responses, with a fixed credential destination. */
export class ChatGPTProvider extends ResponsesProvider {
  constructor(options: ConstructorParameters<typeof ResponsesProvider>[0]) { super(options, CHATGPT_ROUTE); }
}
/** Codex's backend with Codex's own sign-in: usage counts against the Codex plan. */
export class CodexProvider extends ResponsesProvider {
  constructor(options: ConstructorParameters<typeof ResponsesProvider>[0]) { super(options, CODEX_ROUTE); }
}
const messages: Record<string, string> = {
  usage_limit_reached: `Your Codex plan's usage limit has been reached. Manage usage: ${CHATGPT_USAGE_URL}. Demesne will not switch billing automatically.`,
  usage_not_included: "This ChatGPT plan does not include Codex. Choose another provider or plan.",
  rate_limit_exceeded: "Codex is rate limiting requests. Try again in a moment.",
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
function responseError(value: Record<string, unknown>, route: Route, status?: number): ProviderError {
  // Codex's backend names its errors under `type` ("usage_limit_reached"); the public route under `code`.
  const raw = typeof value.code === "string" ? value.code : typeof value.type === "string" ? value.type : undefined;
  const code = raw && /^[a-z0-9_]{1,100}$/.test(raw) ? raw : undefined;
  // Do not reflect server messages: they can contain request headers or credentials.
  return new ProviderError(code && messages[code] || `${route.id} request failed${status ? ` (HTTP ${status})` : ""}${code ? `: ${code}` : ""}.`, status, code);
}
async function httpError(response: Response, route: Route): Promise<ProviderError> {
  try {
    const value = JSON.parse(await readLimitedText(response, 4096, false));
    if (isRecord(value)) return responseError(isRecord(value.error) ? value.error : isRecord(value.detail) ? value.detail : value, route, response.status);
  } catch { /* Never echo an unstructured error body. */ }
  return new ProviderError(`${route.id} request failed (HTTP ${response.status}).`, response.status);
}
