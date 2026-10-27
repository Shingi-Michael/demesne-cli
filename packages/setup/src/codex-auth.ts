import { CodexAuth, type CodexAccountStatus } from "@demesne/codex-auth";
import { loadConfig, updateUserConfig } from "@demesne/config";
import { CodexProvider } from "@demesne/providers";
import type { ModelDescriptor } from "@demesne/protocol";

export type CodexAccountAuth = Pick<CodexAuth, "status" | "beginLogin" | "logout" | "accessToken" | "accountId">;
export const CODEX_ACCOUNT_LABEL = "Codex · ChatGPT account";
const PREFERRED = "codex/gpt-6.1-sol";

/// The provider entry for Codex: no endpoint, key or profile, since the
/// backend and the sign-in are Codex's own, kept in Demesne's data directory.
export function codexProfile(model: string, contextWindow: number, reserve: number) {
  return { id: "Codex", auth: "codex", model, context_window: contextWindow, max_output_tokens: reserve,
    url: null, api_key: null, auth_profile: null, runtime_profile: null, allowed_models: null, reasoning_effort: null, openrouter_ignore: null, allow_http_endpoint: null };
}
export function defaultCodexModel(models: readonly ModelDescriptor[]): string {
  const model = models.find(m => m.id === PREFERRED) ?? models[0];
  if (!model) throw new Error("This Codex account has no available models.");
  return model.id;
}
/// Writes the Codex provider: as primary when `primary` is asked for or
/// nothing else is primary yet, else as an additional provider.
export function configureCodex(options: { configPath: string; models: readonly ModelDescriptor[]; model?: string; contextWindow?: number; key?: string; primary?: boolean }) {
  const chosen = options.model ?? defaultCodexModel(options.models);
  const selected = options.models.find(m => m.id === chosen);
  if (!selected) throw new Error("Choose a model from this Codex account's catalog.");
  const contextWindow = options.contextWindow ?? selected.contextWindow ?? 272_000;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 2048) throw new Error("Context window must be an integer of at least 2048 tokens.");
  const maxOutputTokens = Math.min(16_384, Math.floor(contextWindow / 4));
  const current = loadConfig({ userConfigPath: options.configPath, includeProject: false, env: {} }).config;
  const profile = codexProfile(selected.id, contextWindow, maxOutputTokens);
  const key = options.key ?? Object.entries(current.additionalProviders ?? {}).find(([, provider]) => provider.auth === "codex")?.[0] ?? "codex";
  const primary = options.primary || options.key === "provider" || !current.provider.model || current.provider.auth === "codex";
  if (options.key === "provider" && !options.primary && current.provider.model && current.provider.auth !== "codex") throw new Error("Codex sign-in cannot replace another primary provider.");
  const redundant = Object.fromEntries(Object.entries(current.additionalProviders ?? {}).filter(([, provider]) => provider.auth === "codex").map(([key]) => [key, null]));
  const { backup } = updateUserConfig(options.configPath, primary ? { provider: profile, additional_providers: redundant } : { additional_providers: { [key]: profile } });
  return { backup, model: selected.id, contextWindow, maxOutputTokens };
}
/// The signed-in account's catalog, through the provider itself.
export async function discoverCodex(auth: CodexAccountAuth, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<ModelDescriptor[]> {
  const provider = new CodexProvider({ accountId: "codex", accessToken: signal => auth.accessToken(signal), billingAccount: () => auth.accountId(), fetch: options.fetch });
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
  const models = await provider.listModels(signal);
  if (!models.length) throw new Error("This Codex account has no available models.");
  return models;
}
/// Browser sign-in as Codex, then the catalog. An account already signed in
/// (including one carried over from the earlier Codex home) skips the browser.
export async function connectCodex(options: { auth: CodexAccountAuth; signal: AbortSignal; fetch?: typeof fetch; reauthorize?: boolean; onLogin: (url: string) => Promise<void> }): Promise<{ account: CodexAccountStatus; models: ModelDescriptor[] }> {
  let account = await options.auth.status();
  if (options.reauthorize || !account.signedIn) {
    const login = await options.auth.beginLogin({ signal: options.signal });
    try { await options.onLogin(login.url); account = await login.account; }
    finally { await login.close(); }
  }
  options.signal.throwIfAborted();
  const models = await discoverCodex(options.auth, { fetch: options.fetch, signal: options.signal });
  return { account, models };
}
