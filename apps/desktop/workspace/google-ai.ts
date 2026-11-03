import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig, renderConfigDocument, updateUserConfig, type ProviderConfig } from "@demesne/config";
import { isRecord } from "@demesne/protocol";
import { OpenAICompatibleProvider, ProviderError, readLimitedText, type ProviderMessage, type ProviderToolCall } from "../../../packages/providers/src/index.ts";

export const GOOGLE_AI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GOOGLE_AI_LABEL = "Google AI Studio";
export const isGoogleAI = (provider: ProviderConfig) => !provider.auth && provider.url?.replace(/\/$/, "") === GOOGLE_AI_URL;
export interface GoogleAIModel { id: string; contextWindow: number; maxOutputTokens: number }
export interface GoogleAICatalog { models: GoogleAIModel[] }
class GoogleAIError extends Error {}
const fail = (message: string): never => { throw new GoogleAIError(message); };
const modelId = (value: unknown) => typeof value === "string" ? value.replace(/^models\//, "") : "";
const chatModel = (id: string) => /^gemini-[a-z0-9][a-z0-9._-]{0,150}$/.test(id)
  && !/(?:image|audio|tts|live|embedding|robotics|computer-use)/.test(id);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** The only text allowed across the privileged boundary is ours, never a
 * transport exception or an upstream error body (which can echo credentials). */
function safeError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return new Error("Google connection cancelled or timed out. Try again.");
  if (error instanceof GoogleAIError) return new Error(error.message);
  if (error instanceof ProviderError) {
    if (error.status === 401) return new Error("Google rejected this API key. Create or check the key in AI Studio.");
    if (error.status === 400) return new Error("Google rejected this key or model request. If Check key works, try another model: this build may not support its tool metadata.");
    if (error.status === 403) return new Error("Google denied access. Check the key's API restrictions, project permissions and regional availability.");
    if (error.status === 429) return new Error("Google quota or rate limit reached. Check AI Studio billing and limits, then retry.");
    if (error.status === 404) return new Error("This Google model is no longer available. Check the key again to refresh models.");
    if (error.status && error.status >= 500) return new Error("Google is temporarily unavailable. Try again shortly.");
  }
  return new Error("Google connection failed. Check your network and try again. Nothing was saved.");
}

/** Neither discovery nor tests persist keys, requests, responses or chat turns.
 * Save is a separate, explicitly consented operation. No key is a class field. */
export class GoogleAIConnection {
  private pending: AbortController | null = null;
  constructor(private readonly options: { configPath: string; fetch?: typeof fetch; timeoutMs?: number; scrubBackup?: typeof scrubGoogleBackup }) {}
  cancel() { this.pending?.abort(); this.pending = null; }

  private async run<T>(raw: unknown, work: (key: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.cancel();
    if (typeof raw !== "string" || !raw.trim() || raw.length > 4096 || /\s/.test(raw.trim()))
      throw new Error("Enter a Google AI Studio API key without spaces.");
    const controller = this.pending = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.timeoutMs ?? 90_000)]);
    try { return await work(raw.trim(), signal); }
    catch (error) { throw safeError(error, signal); }
    finally { if (this.pending === controller) this.pending = null; }
  }
  private adapter(key: string) {
    return new OpenAICompatibleProvider({ baseUrl: GOOGLE_AI_URL, providerId: GOOGLE_AI_LABEL, apiKey: key, fetch: this.options.fetch });
  }
  private async catalog(key: string, signal: AbortSignal): Promise<GoogleAICatalog> {
    const models = new Map<string, GoogleAIModel>();
    let token = "";
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      signal.throwIfAborted();
      const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
      url.searchParams.set("pageSize", "100");
      if (token) url.searchParams.set("pageToken", token);
      const response = await (this.options.fetch ?? fetch)(url, { headers: { "x-goog-api-key": key }, redirect: "manual", signal });
      if (!response.ok) { await response.body?.cancel(); throw new ProviderError("Google model discovery failed", response.status); }
      const body: unknown = JSON.parse(await readLimitedText(response, 1_048_576));
      if (!isRecord(body) || !Array.isArray(body.models) || body.models.length > 1000) fail("Google returned an invalid model catalog. Try again.");
      for (const model of (body as { models: unknown[] }).models) {
        if (!isRecord(model)) continue;
        const id = modelId(model.name);
        if (!chatModel(id) || !Array.isArray(model.supportedGenerationMethods) || !model.supportedGenerationMethods.includes("generateContent")
          || !positive(model.inputTokenLimit) || !positive(model.outputTokenLimit)) continue;
        const contextWindow = Math.min(model.inputTokenLimit, 262_144);
        const maxOutputTokens = Math.min(model.outputTokenLimit, 16_384, Math.floor(contextWindow / 4));
        if (contextWindow >= 4096 && maxOutputTokens >= 1024) models.set(id, { id, contextWindow, maxOutputTokens });
      }
      const next = (body as Record<string, unknown>).nextPageToken;
      if (!next) break;
      if (typeof next !== "string" || next.length > 4096 || seen.has(next) || page === 9) fail("Google returned an incomplete model catalog. Try again.");
      token = next as string; seen.add(token);
    }
    // The native catalog supplies limits; only offer IDs also exposed by the
    // OpenAI-compatible endpoint used by the daemon. No hard-coded model names.
    const compatible = new Map((await this.adapter(key).listModels(signal)).filter(model => /^(?:models\/)?gemini-[a-z0-9._-]+$/.test(model.id)).map(model => [modelId(model.id), model.id]));
    signal.throwIfAborted();
    const available = [...models.values()].filter(model => compatible.has(model.id)).map(model => ({ ...model, id: compatible.get(model.id)! })).sort((a, b) => a.id.localeCompare(b.id));
    if (!available.length) fail("This key exposes no compatible Gemini chat models. Check the project and API access in AI Studio.");
    return { models: available };
  }
  discover(key: unknown) { return this.run(key, (key, signal) => this.catalog(key, signal)); }

  /** Exercise the same streaming adapter and tool-result serialization as the
   * daemon. Reject incompatible models rather than silently enabling broken
   * tool loops (including models requiring metadata the adapter cannot retain). */
  private async probe(key: string, model: GoogleAIModel, signal: AbortSignal) {
    const provider = this.adapter(key);
    const tools = [{ name: "connection_check", description: "Return the connection check result. Call once with value ready.", inputSchema: { type: "object", properties: { value: { type: "string", enum: ["ready"] } }, required: ["value"] } }];
    const messages: ProviderMessage[] = [{ role: "user", content: "Call connection_check once with value ready. After its result, reply with OK only." }];
    async function complete() {
      let text = "", size = 0, finish = "";
      const calls = new Map<number, ProviderToolCall>();
      for await (const event of provider.stream({ model: model.id, messages, tools, maxOutputTokens: Math.min(model.maxOutputTokens, 4096) }, signal)) {
        signal.throwIfAborted();
        size += JSON.stringify(event).length;
        if (size > 65_536) fail("The Google model test exceeded its response limit. Nothing was saved.");
        if (event.type === "text_delta") text += event.delta;
        if (event.type === "finish") finish = event.reason;
        if (event.type === "tool_call_delta") {
          const call = calls.get(event.index) ?? { id: "", name: "", arguments: "" };
          call.id += event.idDelta; call.name += event.nameDelta; call.arguments += event.argumentsDelta;
          calls.set(event.index, call);
        }
      }
      return { text, calls: [...calls.values()], finish };
    }
    const first = await complete(), call = first.calls[0];
    if (first.calls.length !== 1 || !call?.id || call.name !== "connection_check" || first.finish !== "tool_calls")
      fail("This model did not complete the tool-call check. Try another model; nothing was saved.");
    try { if (JSON.parse(call!.arguments).value !== "ready") throw new Error(); }
    catch { fail("This model returned an invalid test tool call. Nothing was saved."); }
    messages.push({ role: "assistant", content: first.text || null, toolCalls: first.calls }, { role: "tool", toolCallId: call!.id, content: '{"result":"ready"}' });
    const second = await complete();
    if (!second.text.trim() || second.calls.length || second.finish !== "stop")
      fail("This model did not complete the tool-result check. Try another model; nothing was saved.");
  }
  private async checked(key: string, id: unknown, signal: AbortSignal) {
    const { models } = await this.catalog(key, signal);
    const selected = models.find(model => model.id === id);
    if (!selected) fail("Choose a model returned by Check key.");
    await this.probe(key, selected!, signal);
    signal.throwIfAborted();
    return selected!;
  }
  test(key: unknown, id: unknown) {
    return this.run(key, async (key, signal) => { await this.checked(key, id, signal); return { message: "Streaming and the tool round trip passed. Test key not saved." }; });
  }
  save(key: unknown, id: unknown, remember: unknown, target: unknown) {
    if (remember !== true) return Promise.reject(new Error("Saving requires your explicit permission to store this key locally."));
    return this.run(key, async (key, signal) => {
      const selected = await this.checked(key, id, signal);
      const config = loadConfig({ userConfigPath: this.options.configPath, includeProject: false, env: {} }).config;
      const existing = target === "provider" ? config.provider : typeof target === "string" ? config.additionalProviders?.[target] : undefined;
      if (target !== "new:google" && (!existing || !isGoogleAI(existing))) fail("That Google provider changed. Reopen its settings and try again.");
      let name = String(target);
      if (target === "new:google") {
        name = !config.provider.model ? "provider" : "google";
        for (let n = 2; name !== "provider" && config.additionalProviders?.[name]; n++) name = `google${n}`;
      }
      const profile = { id: existing?.id ?? GOOGLE_AI_LABEL, url: GOOGLE_AI_URL, auth: null, auth_profile: null,
        api_key: key, model: selected.id, allowed_models: [selected.id], context_window: selected.contextWindow,
        max_output_tokens: selected.maxOutputTokens, include_usage: true, reasoning_effort: null, vision: false };
      signal.throwIfAborted();
      let backup: string | null = null;
      try {
        backup = updateUserConfig(this.options.configPath, name === "provider" ? { provider: profile } : { additional_providers: { [name]: profile } }).backup;
      } catch { fail("Could not finish saving Google settings. Check file permissions and refresh Providers before retrying."); }
      let warning: string | undefined;
      try { (this.options.scrubBackup ?? scrubGoogleBackup)(backup); }
      catch { warning = "The key was saved, but an old Google key may remain in the configuration backup (.bak). Remove that backup's Google key or revoke the old key in AI Studio."; }
      return { model: selected.id, label: profile.id, ...(warning ? { warning } : {}) };
    });
  }
}

/** Config writes normally back up the previous document, including credentials.
 * Never leave an old Google key in that backup after replacement/disconnect. */
export function scrubGoogleBackup(path: string | null) {
  if (!path || !existsSync(path)) return;
  const document = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const profiles = [document.provider, ...(isRecord(document.additional_providers) ? Object.values(document.additional_providers) : [])];
  for (const profile of profiles) if (isRecord(profile) && typeof profile.url === "string" && profile.url.replace(/\/$/, "") === GOOGLE_AI_URL) delete profile.api_key;
  const temporary = `${path}.google-cleanup.tmp`;
  try { writeFileSync(temporary, renderConfigDocument(document), { mode: 0o600 }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) rmSync(temporary); }
}
