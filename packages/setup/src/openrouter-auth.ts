import { createHash, randomBytes } from "node:crypto";
import { loadConfig, updateUserConfig } from "@demesne/config";
import { isRecord } from "@demesne/protocol";
import { OpenAICompatibleProvider } from "@demesne/providers";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "qwen/qwen3.8-27b";

/** A one-use loopback callback. Only the challenge goes to the browser; the
 * verifier and returned API key stay in this process. */
export function beginOpenRouterLogin(options: { fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const path = `/openrouter/callback/${randomBytes(24).toString("hex")}`;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 600000), ...(options.signal ? [options.signal] : [])]);
  let resolve!: (key: string) => void;
  let reject!: (error: Error) => void;
  const key = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  // The browser can finish before the caller starts awaiting the promise.
  void key.catch(() => undefined);
  let exchanging = false;
  const reply = (text: string, status = 200) => new Response(text, { status, headers: {
    "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== path || url.host !== `localhost:${server.port}`) return reply("Not found", 404);
    if (request.method !== "GET") return reply("Method not allowed", 405);
    if (exchanging) return reply("Authorization already received. Return to Demesne.", 409);
    if (url.searchParams.has("error")) {
      reject(new Error("OpenRouter authorization was declined. Run login again to retry."));
      return reply("Authorization declined. Return to Demesne.", 400);
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 4096) return reply("Missing or invalid authorization code", 400);
    exchanging = true;
    try {
      const result = await (options.fetch ?? fetch)(`${OPENROUTER_URL}/auth/keys`, {
        method: "POST", headers: { "Content-Type": "application/json" }, redirect: "manual", signal,
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
      });
      if (!result.ok) throw new Error(`OpenRouter authorization exchange failed (HTTP ${result.status}). Run login again.`);
      const body = await readAuthJson(result);
      if (!isRecord(body) || typeof body.key !== "string" || !body.key.trim() || body.key.length > 4096) throw new Error("OpenRouter returned an invalid API key");
      resolve(body.key.trim());
      return reply("OpenRouter authorization received. Return to Demesne to finish connecting.");
    } catch (error) {
      reject(error instanceof Error ? error : new Error("OpenRouter authorization failed"));
      return reply("OpenRouter authorization failed. Return to Demesne and try again.", 502);
    }
  } });
  const abort = () => { reject(new Error("OpenRouter login cancelled or timed out. Run login again.")); void server.stop(true); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const callback = `http://localhost:${server.port}${path}`;
  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("callback_url", callback);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("key_label", "Demesne");
  return { url: url.href, key, async close() {
    signal.removeEventListener("abort", abort);
    controller.abort();
    reject(new Error("OpenRouter login closed"));
    await server.stop(true);
  } };
}

/** Validate the credential, discover the selected model's capacity, then merge
 * just the OpenRouter profile into the private user config. Never return keys. */
export async function discoverOpenRouter(options: { apiKey: string; fetch?: typeof fetch; signal?: AbortSignal }) {
  const apiKey = options.apiKey.trim();
  if (!apiKey || apiKey.length > 4096 || /\s/.test(apiKey)) throw new Error("Invalid OpenRouter API key");
  const fetchImpl = options.fetch ?? fetch;
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(options.signal ? [options.signal] : [])]);
  const response = await fetchImpl(`${OPENROUTER_URL}/key`, { headers: { Authorization: `Bearer ${apiKey}` }, redirect: "manual", signal });
  if (!response.ok) throw new Error(`OpenRouter rejected the API key (HTTP ${response.status})`);
  const body = await readAuthJson(response);
  if (!isRecord(body) || !isRecord(body.data)) throw new Error("OpenRouter returned invalid key metadata");
  const provider = new OpenAICompatibleProvider({ baseUrl: OPENROUTER_URL, providerId: "OpenRouter", apiKey, fetch: fetchImpl });
  return provider.listModels(signal);
}

export async function configureOpenRouter(options: { apiKey: string; configPath: string; model?: string; fetch?: typeof fetch; signal?: AbortSignal }) {
  const models = await discoverOpenRouter(options);
  const apiKey = options.apiKey.trim();
  const model = options.model ?? DEFAULT_OPENROUTER_MODEL;
  const selected = models.find((entry) => entry.id === model);
  if (!selected?.contextWindow) throw new Error(`OpenRouter model not found or has no context capacity: ${model}`);
  // Use the advertised completion ceiling, leaving input headroom when the
  // model's total context permits it. Older catalogs retain the fallback.
  const contextWindow = Math.min(selected.contextWindow, Math.max(262144, (selected.maxOutputTokens ?? 0) * 2));
  const maxOutputTokens = selected.maxOutputTokens ?? Math.min(16384, Math.floor(contextWindow / 4));
  if (maxOutputTokens >= contextWindow) throw new Error(`OpenRouter model output limit must be smaller than its context capacity: ${model}`);
  const current = loadConfig({ userConfigPath: options.configPath, projectConfigPath: null, env: {} }).config;
  const profile = {
    id: "OpenRouter", url: OPENROUTER_URL, api_key: apiKey, model,
    context_window: contextWindow, max_output_tokens: maxOutputTokens,
  };
  const { backup } = updateUserConfig(options.configPath, !current.provider.model || current.provider.url?.replace(/\/$/, "") === OPENROUTER_URL
    ? { provider: profile } : { additional_providers: { openrouter: profile } });
  return { configPath: options.configPath, backup, model, contextWindow, maxOutputTokens };
}

async function readAuthJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("OpenRouter returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new Error("OpenRouter authorization response exceeded its size limit");
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("OpenRouter returned invalid authorization JSON"); }
  } finally { await reader.cancel().catch(() => undefined); }
}
