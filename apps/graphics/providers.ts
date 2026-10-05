import { ChatGPTAuth } from "@demesne/chatgpt-auth";
import { CodexAuth, type CodexAccountStatus } from "@demesne/codex";
import { loadConfig, updateUserConfig, type ProviderConfig } from "@demesne/config";
import { configureChatGPT, connectChatGPT } from "../cli/src/chatgpt-auth.ts";
import { CODEX_ACCOUNT_LABEL, configureCodex, connectCodex, type CodexAccountAuth } from "../cli/src/codex-auth.ts";
import { beginOpenRouterLogin, configureOpenRouter, DEFAULT_OPENROUTER_MODEL, OPENROUTER_URL } from "../cli/src/openrouter-auth.ts";

/// Settings › Providers: each provider with its sign-in state, and signing in
/// or out of the ones that have accounts (Codex, ChatGPT, OpenRouter). Signing out
/// keeps the provider's configuration, so signing back in is one step; the
/// daemon then reloads its providers without a restart.

export interface ProviderEntry {
  /// "provider" for the primary, an additional_providers key, or "new:chatgpt"
  /// / "new:codex" / "new:openrouter" for a provider not configured yet.
  key: string;
  label: string;
  kind: "codex" | "chatgpt" | "openrouter" | "local" | "api-key";
  status: "signed-in" | "signed-out" | "local" | "key";
  detail: string;
  /// The provider serving the selected model.
  active: boolean;
}

const isOpenRouter = (settings: ProviderConfig) => (settings.url ?? "").replace(/\/$/, "") === OPENROUTER_URL;
const isLocal = (settings: ProviderConfig) => {
  try {
    const host = new URL(settings.url ?? "http://127.0.0.1:1234/v1").hostname;
    return host === "localhost" || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || host === "[::1]";
  } catch { return false; }
};

export class ProviderAccounts {
  /// The key being signed in, while its browser flow is open.
  signingIn: string | null = null;
  private abort: AbortController | null = null;
  constructor(private readonly options: { configPath: string; dataDirectory: string; codexDataDirectory?: string; open: (url: string) => Promise<void>; fetch?: typeof fetch; codexAuth?: () => CodexAccountAuth }) {}

  private config() { return loadConfig({ userConfigPath: this.options.configPath, includeProject: false, env: {} }).config; }
  private auth() { return new ChatGPTAuth(this.options.dataDirectory, { fetch: this.options.fetch }); }
  private codexAuth() { return this.options.codexAuth?.() ?? new CodexAuth(this.options.codexDataDirectory ?? this.options.dataDirectory); }
  private configured() {
    const config = this.config();
    return [["provider", config.provider] as const, ...Object.entries(config.additionalProviders ?? {})]
      .filter(([, settings]) => settings.model) as Array<readonly [string, ProviderConfig]>;
  }

  async list(activeProvider: string): Promise<ProviderEntry[]> {
    const accounts = await this.auth().accounts().catch(() => []);
    const configured = this.configured();
    let codex: CodexAccountStatus | undefined, codexError: string | undefined;
    if (configured.some(([, settings]) => settings.auth === "codex")) {
      const auth = this.codexAuth();
      try { codex = await auth.status(); }
      catch (error) { codexError = error instanceof Error ? error.message : String(error); }
      finally { await auth.close(); }
    }
    const entries: ProviderEntry[] = configured.map(([key, settings]) => {
      if (settings.auth === "codex") {
        const active = activeProvider === "Codex";
        return codex?.signedIn && codex.authMode === "chatgpt"
          ? { key, label: CODEX_ACCOUNT_LABEL, kind: "codex", status: "signed-in", detail: `Signed in${codex.email ? ` as ${codex.email}` : ""}${codex.planType ? ` · ${codex.planType}` : ""}`, active }
          : { key, label: CODEX_ACCOUNT_LABEL, kind: "codex", status: "signed-out", detail: codexError ?? "Signed out · connects to your Codex models", active };
      }
      const label = settings.auth === "chatgpt" ? "ChatGPT" : settings.id ?? (isOpenRouter(settings) ? "OpenRouter" : "OpenAI-compatible");
      const active = label === activeProvider;
      if (settings.auth === "chatgpt") {
        const account = accounts.find((item) => item.id === settings.authProfile);
        return account?.signedIn
          ? { key, label, kind: "chatgpt", status: "signed-in", detail: `Signed in as ${account.email ?? account.label}`, active }
          : { key, label, kind: "chatgpt", status: "signed-out", detail: "Signed out", active };
      }
      if (isOpenRouter(settings)) return settings.apiKey
        ? { key, label, kind: "openrouter", status: "signed-in", detail: "Signed in", active }
        : { key, label, kind: "openrouter", status: "signed-out", detail: "Signed out", active };
      if (isLocal(settings)) return { key, label, kind: "local", status: "local", detail: `Local · ${settings.model} · no sign-in needed`, active };
      return { key, label, kind: "api-key", status: "key", detail: settings.apiKey ? "API key in config" : "No sign-in", active };
    });
    if (!entries.some((entry) => entry.kind === "codex"))
      entries.push({ key: "new:codex", label: CODEX_ACCOUNT_LABEL, kind: "codex", status: "signed-out", detail: "Not set up · browser sign-in for Codex models", active: false });
    if (!entries.some((entry) => entry.kind === "chatgpt"))
      entries.push({ key: "new:chatgpt", label: "ChatGPT", kind: "chatgpt", status: "signed-out", detail: "Not set up · ChatGPT plan sharing", active: false });
    if (!entries.some((entry) => entry.kind === "openrouter"))
      entries.push({ key: "new:openrouter", label: "OpenRouter", kind: "openrouter", status: "signed-out", detail: "Not set up · hosted models", active: false });
    return entries;
  }

  async signOut(key: string): Promise<{ label: string; revoked?: boolean }> {
    const settings = this.configured().find(([name]) => name === key)?.[1];
    if (!settings) throw new Error("That provider isn't configured.");
    if (settings.auth === "codex") {
      const auth = this.codexAuth();
      try { await auth.logout(); return { label: "Codex" }; }
      finally { await auth.close(); }
    }
    if (settings.auth === "chatgpt") {
      if (!settings.authProfile) throw new Error("This ChatGPT provider has no account.");
      const { revoked } = await this.auth().logout(settings.authProfile);
      return { label: "ChatGPT", revoked };
    }
    if (isOpenRouter(settings)) {
      // null removes the key; the rest of the provider stays for signing back in.
      updateUserConfig(this.options.configPath, key === "provider" ? { provider: { api_key: null } } : { additional_providers: { [key]: { api_key: null } } });
      return { label: settings.id ?? "OpenRouter" };
    }
    throw new Error("This provider has no account to sign out of.");
  }

  /// Runs the provider's browser sign-in and saves its credentials, adding
  /// the provider when it isn't configured. Never replaces your primary
  /// provider with another.
  async signIn(key: string): Promise<{ label: string }> {
    this.cancel();
    const abort = this.abort = new AbortController();
    this.signingIn = key;
    try {
      const settings = this.configured().find(([name]) => name === key)?.[1];
      if (key === "new:codex" || settings?.auth === "codex") {
        const auth = this.codexAuth();
        try {
          const { models } = await connectCodex({ auth, signal: abort.signal, onLogin: url => this.options.open(url) });
          abort.signal.throwIfAborted();
          const model = settings?.model && models.some(item => `codex/${item.model || item.id}` === settings.model) ? settings.model : undefined;
          configureCodex({ configPath: this.options.configPath, models, model, contextWindow: settings?.contextWindow, key: settings ? key : undefined });
          return { label: "Codex" };
        } finally { await auth.close(); }
      }
      const chatgpt = key === "new:chatgpt" || settings?.auth === "chatgpt";
      if (chatgpt) {
        const auth = this.auth();
        const { account, provider } = await connectChatGPT({ auth, accountId: settings?.authProfile, reauthorize: true, signal: abort.signal, fetch: this.options.fetch,
          onLogin: (url) => this.options.open(url) });
        // The row said signing in uses your ChatGPT plan; that's the acknowledgement.
        if (!account.acknowledged) await auth.acknowledge(account.id);
        if (!settings || settings.authProfile !== account.id)
          configureChatGPT({ configPath: this.options.configPath, account: { ...account, acknowledged: true }, models: provider.models, model: settings?.model });
        return { label: "ChatGPT" };
      }
      if (key === "new:openrouter" || (settings && isOpenRouter(settings))) {
        const login = beginOpenRouterLogin({ fetch: this.options.fetch, signal: abort.signal });
        try {
          await this.options.open(login.url);
          const apiKey = await login.key;
          // An existing entry gets its key back where it is; a new one is added.
          if (settings) updateUserConfig(this.options.configPath, key === "provider" ? { provider: { api_key: apiKey } } : { additional_providers: { [key]: { api_key: apiKey } } });
          else await configureOpenRouter({ apiKey, configPath: this.options.configPath, model: DEFAULT_OPENROUTER_MODEL, fetch: this.options.fetch, signal: abort.signal });
        } finally { await login.close(); }
        return { label: settings?.id ?? "OpenRouter" };
      }
      throw new Error("This provider has no account to sign in to.");
    } finally {
      if (this.abort === abort) { this.abort = null; this.signingIn = null; }
    }
  }

  cancel() { this.abort?.abort(new Error("Sign-in cancelled.")); this.abort = null; this.signingIn = null; }
}
