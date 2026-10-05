import { CodexAuth, defaultModel, type CodexAccountStatus, type CodexModel } from "@demesne/codex";
import { loadConfig, updateUserConfig } from "@demesne/config";

export type CodexAccountAuth = Pick<CodexAuth, "status" | "beginLogin" | "logout" | "listModels" | "close">;
export const CODEX_ACCOUNT_LABEL = "Codex · ChatGPT account";

const modelSlug = (model: CodexModel) => model.model || model.id;
const modelId = (slug: string) => `codex/${slug}`;

/// Codex owns its credentials in Demesne's data directory. The configuration
/// names only the provider and model; it never imports another app's tokens.
export function configureCodex(options: {
  configPath: string; models: readonly CodexModel[]; model?: string; contextWindow?: number; key?: string;
}) {
  const requested = options.model?.replace(/^codex\//, "");
  const chosen = requested ?? defaultModel([...options.models]);
  const selected = options.models.find(model => modelSlug(model) === chosen);
  if (!selected) throw new Error("Choose a model from this Codex account's catalog.");
  const contextWindow = options.contextWindow ?? selected.contextWindow ?? 272_000;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 2048) throw new Error("Context window must be an integer of at least 2048 tokens.");
  const maxOutputTokens = Math.min(16_384, Math.floor(contextWindow / 4));
  const current = loadConfig({ userConfigPath: options.configPath, includeProject: false, env: {} }).config;
  const model = modelId(modelSlug(selected));
  const profile = {
    id: "Codex", auth: "codex", model, context_window: contextWindow, max_output_tokens: maxOutputTokens,
    url: null, api_key: null, auth_profile: null, runtime_profile: null, allowed_models: null,
    reasoning_effort: null, openrouter_ignore: null, allow_http_endpoint: null,
  };
  const key = options.key ?? Object.entries(current.additionalProviders ?? {}).find(([, provider]) => provider.auth === "codex")?.[0] ?? "codex";
  const primary = options.key === "provider" || !current.provider.model || current.provider.auth === "codex";
  if (options.key === "provider" && current.provider.model && current.provider.auth !== "codex") throw new Error("Codex sign-in cannot replace another primary provider.");
  const redundant = Object.fromEntries(Object.entries(current.additionalProviders ?? {}).filter(([, provider]) => provider.auth === "codex").map(([key]) => [key, null]));
  const { backup } = updateUserConfig(options.configPath, primary
    ? { provider: profile, additional_providers: redundant } : { additional_providers: { [key]: profile } });
  return { backup, model, contextWindow, maxOutputTokens };
}

function requireChatGPTAccount(account: CodexAccountStatus): void {
  if (!account.signedIn || account.authMode !== "chatgpt") throw new Error("Sign in to Codex with a ChatGPT account. API key credentials are not used by this provider.");
}

export async function connectCodex(options: {
  auth: CodexAccountAuth; signal: AbortSignal; onLogin: (url: string) => Promise<void>;
}): Promise<{ account: CodexAccountStatus; models: CodexModel[] }> {
  const login = await options.auth.beginLogin({ signal: options.signal });
  try {
    options.signal.throwIfAborted();
    await options.onLogin(login.url);
    const account = await login.complete;
    options.signal.throwIfAborted();
    requireChatGPTAccount(account);
    const models = await options.auth.listModels(options.signal);
    options.signal.throwIfAborted();
    if (!models.length) throw new Error("This Codex account has no available models.");
    return { account, models };
  } finally { await login.cancel(); }
}

export async function runCodexAuthCommand(command: string[], options: {
  configPath: string; dataDirectory: string; open: (url: string) => Promise<boolean>; auth?: CodexAccountAuth;
  reload?: () => Promise<"reloaded" | "stopped">;
}) {
  const action = command[1];
  if (!["login", "status", "logout"].includes(action ?? "")) throw new Error("Usage: demesne auth <login|status|logout> codex [--model codex/<id>] [--no-browser]");
  const auth = options.auth ?? new CodexAuth(options.dataDirectory);
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  const option = (name: string) => {
    const index = command.indexOf(name);
    if (index < 0) return undefined;
    const value = command[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    return value;
  };
  try {
    if (action === "status") {
      const account = await auth.status(controller.signal);
      console.log(account.signedIn && account.authMode === "chatgpt"
        ? `${CODEX_ACCOUNT_LABEL} · signed in${account.email ? ` as ${account.email}` : ""}${account.planType ? ` · ${account.planType}` : ""}`
        : "Codex is signed out. Run demesne auth login codex.");
      return;
    }
    if (action === "logout") {
      await auth.logout(controller.signal);
      console.log("Signed out of Demesne’s Codex account. New Codex requests require sign-in.");
      if (options.reload) {
        try { if (await options.reload() === "reloaded") console.log("The running daemon has updated its providers."); }
        catch (error) { console.log(`Credentials removed, but the daemon could not reload providers: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return;
    }
    const requestedModel = option("--model"), context = option("--context-window");
    const requestedContext = context === undefined ? undefined : Number(context);
    if (requestedContext !== undefined && (!Number.isSafeInteger(requestedContext) || requestedContext < 2048)) throw new Error("Context window must be an integer of at least 2048 tokens.");
    const { account, models } = await connectCodex({ auth, signal: controller.signal, onLogin: async url => {
      console.log(`Continue with ChatGPT for Codex:\n${url}`);
      if (!command.includes("--no-browser")) await options.open(url);
    } });
    controller.signal.throwIfAborted();
    const result = configureCodex({ configPath: options.configPath, models, model: requestedModel, contextWindow: requestedContext });
    console.log(`Connected ${CODEX_ACCOUNT_LABEL}${account.email ? ` · ${account.email}` : ""}\nModel: ${result.model}`);
    console.log(`Using a ${result.contextWindow.toLocaleString()} token context planning budget; adjust context_window if needed.`);
    if (options.reload) {
      try { console.log(await options.reload() === "reloaded" ? `The daemon has updated its providers. Select /model ${result.model}.` : `Start Demesne, then select /model ${result.model}.`); }
      catch (error) { console.log(`Codex is connected, but the daemon could not reload providers: ${error instanceof Error ? error.message : String(error)}\nRestart the daemon after current work finishes, then select /model ${result.model}.`); }
    } else console.log(`Restart the daemon, then select /model ${result.model}.`);
  } finally {
    process.removeListener("SIGINT", cancel);
    await auth.close();
  }
}
