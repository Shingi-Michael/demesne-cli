import { chatGPTProfile } from "./chatgpt-auth.ts";
import { assertProviderUrl, loadConfig, updateUserConfig } from "@demesne/config";

/// Writes the provider the desktop's first-run setup chose into the user
/// config, keeping a backup of the previous file.

interface SetupChoices {
  authProfile?: string;
  providerUrl: string;
  providerId: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  theme?: "dark" | "light" | "auto";
}

export function writeSetupConfig(configPath: string, choices: SetupChoices, apiKey?: string): { backup: string | null } {
  if (!Number.isSafeInteger(choices.contextWindow) || choices.contextWindow <= 0) {
    throw new Error("context window must be a positive integer");
  }
  if (!Number.isSafeInteger(choices.maxOutputTokens) || choices.maxOutputTokens <= 0) {
    throw new Error("max output tokens must be a positive integer");
  }
  if (choices.maxOutputTokens >= choices.contextWindow) {
    throw new Error("max output tokens must be smaller than the context window");
  }
  assertProviderUrl(choices.providerUrl, "provider.url");
  const current = loadConfig({ userConfigPath: configPath, includeProject: false, env: {} }).config;
  // Setup makes ChatGPT primary. Remove an earlier CLI-added ChatGPT route so
  // one model slug never resolves to two registrations after the restart.
  const redundant = choices.authProfile ? Object.fromEntries(Object.entries(current.additionalProviders ?? {}).filter(([, p]) => p.auth === "chatgpt").map(([id]) => [id, null])) : {};
  const { backup } = updateUserConfig(configPath, {
    ...(Object.keys(redundant).length ? { additional_providers: redundant } : {}),
    ...(choices.theme ? { theme: choices.theme } : {}),
    provider: choices.authProfile ? chatGPTProfile(choices.authProfile, choices.model, choices.contextWindow, choices.maxOutputTokens) : {
      auth: "api-key",
      auth_profile: null,
      url: choices.providerUrl,
      id: choices.providerId,
      model: choices.model,
      context_window: choices.contextWindow,
      max_output_tokens: choices.maxOutputTokens,
      ...(apiKey ? { api_key: apiKey } : {}),
    },
  });
  return { backup };
}
