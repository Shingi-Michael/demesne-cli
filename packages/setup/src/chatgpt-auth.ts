import { homedir } from "node:os";
import { join } from "node:path";
import { ChatGPTAuth, CHATGPT_API, type ChatGPTAccount } from "@demesne/chatgpt-auth";
import { loadConfig, updateUserConfig } from "@demesne/config";
import { ChatGPTProvider } from "@demesne/providers";
import type { ModelDescriptor } from "@demesne/protocol";
import type { ProbeResult } from "./provider-probe.ts";
export function chatGPTAuthForConfig(configPath: string, options: { fetch?: typeof fetch; dataDirectory?: string; env?: Record<string, string | undefined>; home?: string } = {}) {
  const config = loadConfig({ userConfigPath: configPath, includeProject: false, env: options.env ?? process.env }).config;
  return new ChatGPTAuth(options.dataDirectory ?? config.dataDir ?? join(options.home ?? homedir(), ".demesne"), { fetch: options.fetch });
}
export function configuredChatGPTAccount(configPath: string): string | undefined {
  const config = loadConfig({ userConfigPath: configPath, includeProject: false, env: {} }).config;
  return [config.provider, ...Object.values(config.additionalProviders ?? {})].find(p => p.auth === "chatgpt")?.authProfile;
}
export async function discoverChatGPT(auth: ChatGPTAuth, accountId: string, options: { fetch?: typeof fetch; signal?: AbortSignal; model?: string } = {}): Promise<ProbeResult> {
  const provider = new ChatGPTProvider({ accountId, accessToken: signal => auth.accessToken(accountId, signal), fetch: options.fetch });
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
  const models = await provider.listModels(signal);
  if (options.model && !models.some(model => model.id === options.model)) models.push(await provider.verifyModel(options.model, signal));
  if (!models.length) throw new Error("This ChatGPT account has no available models. Choose another account.");
  return { target: { id: "ChatGPT", label: "ChatGPT", url: CHATGPT_API }, reachable: true, models };
}
export function chatGPTProfile(accountId: string, model: string, contextWindow: number, reserve: number) {
  return { id: "ChatGPT", url: CHATGPT_API, auth: "chatgpt", auth_profile: accountId, model,
    context_window: contextWindow, max_output_tokens: reserve,
    api_key: null, runtime_profile: null, allowed_models: null, reasoning_effort: null, openrouter_ignore: null, allow_http_endpoint: null };
}
export function configureChatGPT(options: { configPath: string; account: ChatGPTAccount; models: ModelDescriptor[]; model?: string; contextWindow?: number }) {
  if (!options.account.planEnabled) throw new Error("ChatGPT plan usage is not enabled. Sign in again with --consent.");
  if (!options.account.acknowledged) throw new Error("Acknowledge ChatGPT plan usage before connecting.");
  const selected = options.model ? options.models.find(m => m.id === options.model) : options.models[0];
  if (!selected) throw new Error("Choose a model from this ChatGPT account's catalog.");
  const contextWindow = options.contextWindow ?? selected.contextWindow ?? 32_768;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 2048) throw new Error("Context window must be an integer of at least 2048 tokens.");
  const maxOutputTokens = Math.min(16_384, Math.floor(contextWindow / 4));
  const current = loadConfig({ userConfigPath: options.configPath, includeProject: false, env: {} }).config;
  const profile = chatGPTProfile(options.account.id, selected.id, contextWindow, maxOutputTokens);
  const { backup } = updateUserConfig(options.configPath, !current.provider.model || current.provider.auth === "chatgpt"
    ? { provider: profile } : { additional_providers: { chatgpt: profile } });
  return { backup, model: selected.id, contextWindow, maxOutputTokens, detected: !!selected.contextWindow };
}

export async function connectChatGPT(options: {
  auth: ChatGPTAuth; accountId?: string; reauthorize?: boolean; signal: AbortSignal; fetch?: typeof fetch;
  onLogin: (url: string) => Promise<void>;
  onAccount?: (account: ChatGPTAccount) => void;
}): Promise<{ account: ChatGPTAccount; provider: ProbeResult }> {
  let account = (await options.auth.accounts()).find(a => a.id === options.accountId);
  if (options.reauthorize || !account?.planEnabled) {
    const login = await options.auth.beginLogin({ accountId: options.accountId, consent: !!account && !account.planEnabled, signal: options.signal });
    try { await options.onLogin(login.url); account = await login.account; }
    finally { await login.close(); }
  }
  options.onAccount?.(account);
  if (!account.planEnabled) throw new Error("Signed in, but ChatGPT plan use is not enabled. Retry to authorize plan usage.");
  const provider = await discoverChatGPT(options.auth, account.id, { fetch: options.fetch, signal: options.signal });
  return { account, provider };
}
