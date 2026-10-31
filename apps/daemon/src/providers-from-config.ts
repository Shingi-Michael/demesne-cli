/// The configured providers as turn processors: shared by the daemon and by
/// scripts that call the person's real model (scripts/eval-foundry-inference.ts).
import type { loadConfig, ProviderConfig } from "@demesne/config";
import { ChatGPTAuth } from "@demesne/chatgpt-auth";
import { CodexAuth } from "@demesne/codex-auth";
import { ChatGPTProvider, CodexProvider, OpenAICompatibleProvider } from "@demesne/providers";
import { MultiProviderProcessor } from "./multi-provider-processor.ts";
import {
  createRuntimeProfileVerifier,
  runtimeProfileDefaultMaxOutputTokens,
  runtimeProfileSupportsPromptCache,
} from "./ollama-runtime.ts";
import { ProviderTurnProcessor } from "./provider-processor.ts";

type DemesneConfig = ReturnType<typeof loadConfig>["config"];
const OPENROUTER_API = "https://openrouter.ai/api/v1";

/// A provider you've signed out of (ChatGPT without tokens, OpenRouter
/// without a key) isn't offered; nor is one that would only fail.
function signedOut(settings: ProviderConfig, chatgptSignedIn: Set<string>): boolean {
  if (settings.auth === "chatgpt") return !settings.authProfile || !chatgptSignedIn.has(settings.authProfile);
  if (settings.auth === "codex") return !chatgptSignedIn.has("codex");
  return (settings.url ?? "").replace(/\/$/, "") === OPENROUTER_API && !settings.apiKey;
}

/// Loopback, private and Tailscale addresses, and .local names: a model on
/// your own machines, preferred when the selected one goes away.
export function isLocalProvider(settings: ProviderConfig): boolean {
  if (settings.auth === "chatgpt" || settings.auth === "codex") return false;
  try {
    const host = new URL(settings.url ?? "http://127.0.0.1:1234/v1").hostname;
    return host === "localhost" || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || host === "[::1]";
  } catch { return false; }
}

export async function signedInAccounts(dataDirectory: string): Promise<Set<string>> {
  const signedIn = new Set<string>();
  try { for (const account of await new ChatGPTAuth(dataDirectory).accounts()) if (account.signedIn) signedIn.add(account.id); }
  catch { /* A signed-out account must not hide other providers. */ }
  try { if ((await new CodexAuth(dataDirectory).status()).signedIn) signedIn.add("codex"); }
  catch { /* Settings stays available to sign in to Codex. */ }
  return signedIn;
}

/// The configured providers you're signed in to. When none are, all are
/// kept, so a request explains what to do instead of finding no provider.
export function buildProviders(settings: DemesneConfig, dataDirectory: string, signedIn: Set<string>) {
  const all = [settings.provider, ...Object.values(settings.additionalProviders ?? {})];
  const available = all.filter((item) => !signedOut(item, signedIn));
  const configs = available.length ? available : all;
  const processors = configs.map((item) => createSingleProcessor(item, dataDirectory));
  return { configs, processors };
}

export function createProcessor(config: DemesneConfig, dataDirectory: string, signedIn: Set<string>): ProviderTurnProcessor | MultiProviderProcessor | undefined {
  const { configs, processors } = buildProviders(config, dataDirectory, signedIn);
  if (processors.length === 1 && !processors[0]) return undefined;
  if (processors.some((processor) => !processor)) throw new Error("Each configured provider requires a default model");
  return new MultiProviderProcessor(processors as ProviderTurnProcessor[], configs.map((item) => item.allowedModels ?? []));
}

function createSingleProcessor(settings: ProviderConfig, dataDirectory: string): ProviderTurnProcessor | undefined {
  const model = settings.model;
  const runtimeProfile = settings.runtimeProfile;
  if (!model && runtimeProfile) {
    throw new Error("provider.runtime_profile is set but provider.model is not: DEMESNE_RUNTIME_PROFILE requires DEMESNE_MODEL");
  }
  if (!model) return undefined;
  const baseUrl = settings.url ?? "http://127.0.0.1:1234/v1";
  const providerId = settings.auth === "chatgpt" ? "ChatGPT" : settings.auth === "codex" ? "Codex" : settings.id ?? "openai-compatible";
  const configuredContextCapacity = settings.contextWindow;
  const allowedModelIds = settings.allowedModels;
  const maxOutputTokens = settings.maxOutputTokens
    ?? runtimeProfileDefaultMaxOutputTokens(runtimeProfile);
  if (!configuredContextCapacity && !runtimeProfile) {
    throw new Error("provider.context_window is not set: DEMESNE_CONTEXT_WINDOW is required when provider.model is configured without a runtime profile");
  }
  if (!maxOutputTokens) {
    throw new Error("provider.max_output_tokens is not set: DEMESNE_MAX_OUTPUT_TOKENS is required when provider.model is configured without a profile default");
  }
  if (configuredContextCapacity && maxOutputTokens && maxOutputTokens >= configuredContextCapacity) {
    throw new Error("provider.max_output_tokens must be smaller than provider.context_window");
  }
  if (settings.auth === "chatgpt" && !settings.authProfile) throw new Error("ChatGPT requires an auth_profile. Sign in under Settings › Providers.");
  const auth = settings.auth === "chatgpt" ? new ChatGPTAuth(dataDirectory) : undefined;
  const codex = settings.auth === "codex" ? new CodexAuth(dataDirectory) : undefined;
  const provider = codex ? new CodexProvider({ accountId: "codex", accessToken: signal => codex.accessToken(signal), billingAccount: () => codex.accountId(), contextWindow: configuredContextCapacity, configuredModel: model })
    : auth ? new ChatGPTProvider({ accountId: settings.authProfile!, accessToken: signal => auth.accessToken(settings.authProfile!, signal), contextWindow: configuredContextCapacity, configuredModel: model }) : new OpenAICompatibleProvider({
    baseUrl,
    allowHttpEndpoint: settings.allowHttpEndpoint,
    apiKey: settings.apiKey,
    providerId,
    includeUsage: settings.includeUsage ?? true,
    reasoningEffort: settings.reasoningEffort,
    openRouterIgnore: settings.openRouterIgnore,
    contextWindow: configuredContextCapacity,
    vision: settings.vision,
  });
  const verifier = auth || codex ? undefined : createRuntimeProfileVerifier({
    profile: runtimeProfile,
    providerId,
    baseUrl,
    apiKey: settings.apiKey,
  });
  return new ProviderTurnProcessor(
    provider,
    model,
    { maxOutputTokens },
    verifier,
    configuredContextCapacity,
    allowedModelIds,
    settings.auth === "codex" || settings.auth === "chatgpt" || runtimeProfileSupportsPromptCache(runtimeProfile),
  );
}

