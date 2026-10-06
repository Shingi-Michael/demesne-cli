import { homedir } from "node:os";
import { join } from "node:path";
import { ChatGPTAuth, CHATGPT_API, CHATGPT_USAGE, type ChatGPTAccount } from "@demesne/chatgpt-auth";
import { loadConfig, updateUserConfig } from "@demesne/config";
import { ChatGPTProvider } from "@demesne/providers";
import type { ModelDescriptor } from "@demesne/protocol";
import type { ProbeResult } from "./provider-probe.ts";

export const CHATGPT_PLAN_NOTICE = "You’re using your ChatGPT plan. Eligible requests from Demesne count toward your ChatGPT plan usage and available credits.";
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

export async function runChatGPTAuthCommand(command: string[], options: { configPath: string; dataDirectory: string; open: (url: string) => Promise<boolean>; acknowledge: () => Promise<boolean>; fetch?: typeof fetch }) {
  const auth = new ChatGPTAuth(options.dataDirectory, { fetch: options.fetch });
  const option = (name: string) => { const i = command.indexOf(name); if (i < 0) return undefined; const value = command[i + 1]; if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`); return value; };
  const action = command[1];
  const accounts = await auth.accounts();
  const id = option("--account") ?? configuredChatGPTAccount(options.configPath) ?? (accounts.length === 1 ? accounts[0]!.id : undefined);
  if (action === "status" || action === "accounts") {
    console.log(accounts.length ? accounts.map(a => `${a.id === id ? "●" : "○"} ${a.id}  ${a.label}  ${a.planEnabled ? "Using ChatGPT plan" : a.signedIn ? "Plan use not enabled" : "Signed out"}`).join("\n") : "No ChatGPT accounts. Run demesne auth login chatgpt.");
    console.log(`Manage usage: ${CHATGPT_USAGE}`); return;
  }
  if (action === "logout") {
    if (!id) throw new Error("Choose an account with --account <id>. List them with demesne auth accounts chatgpt.");
    const result = await auth.logout(id);
    console.log("Signed out of ChatGPT. Demesne will require sign-in for new requests with this account.");
    if (!result.revoked) console.log("Local credentials were removed, but remote revocation could not be confirmed. Remove Demesne in ChatGPT’s connected-app settings.");
    return;
  }
  if (action !== "login" && action !== "use") throw new Error("Usage: demesne auth <login|accounts|status|use|logout> chatgpt [--account <id>] [--new-account] [--model <id>] [--no-browser]");
  if (command.includes("--new-account") && option("--account")) throw new Error("Choose either --account or --new-account.");
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  let login: Awaited<ReturnType<ChatGPTAuth["beginLogin"]>> | undefined;
  try {
    let account = action === "use" ? accounts.find(a => a.id === id) : undefined;
    if (action === "use" && !account) throw new Error("Choose a saved ChatGPT account with --account <id>.");
    if (!account) {
      login = await auth.beginLogin({ accountId: command.includes("--new-account") ? undefined : id, consent: command.includes("--consent"), signal: controller.signal });
      console.log(`Continue with ChatGPT:\n${login.url}`);
      if (!command.includes("--no-browser")) await options.open(login.url);
      account = await login.account;
    }
    if (!account.planEnabled) throw new Error("Signed in, but ChatGPT plan use is not enabled. Run login again with --account " + account.id + " --consent.");
    if (!account.acknowledged) {
      console.log(`${CHATGPT_PLAN_NOTICE}\nManage usage: ${CHATGPT_USAGE}`);
      if (!command.includes("--accept-plan-usage") && !await options.acknowledge()) throw new Error("Account saved. Run login or use with --accept-plan-usage after reviewing the plan notice.");
      await auth.acknowledge(account.id); account = { ...account, acknowledged: true };
    }
    const model = option("--model");
    const catalog = await discoverChatGPT(auth, account.id, { fetch: options.fetch, signal: controller.signal, model });
    const result = configureChatGPT({ configPath: options.configPath, account, models: catalog.models, model, contextWindow: option("--context-window") ? Number(option("--context-window")) : undefined });
    console.log(`Connected ${account.label} · Using ChatGPT plan\nModel: ${result.model}`);
    if (!result.detected) console.log(`Using a conservative ${result.contextWindow.toLocaleString()} token context budget; adjust context_window if needed.`);
    console.log(`Restart the daemon, then select /model ${result.model}. Manage usage: ${CHATGPT_USAGE}`);
  } finally { process.removeListener("SIGINT", cancel); await login?.close(); }
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
