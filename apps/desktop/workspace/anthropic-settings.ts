import { AnthropicProvider, isAnthropicEndpoint } from "../../../packages/providers/src/index.ts";
import { loadConfig, updateUserConfig } from "@demesne/config";
import { scrubProviderBackup } from "./google-ai.ts";

export async function anthropicSettings(path: string, args: Record<string, unknown>, save: boolean, signal: AbortSignal, transport?: typeof fetch) {
  const key = typeof args.apiKey === "string" ? args.apiKey.trim() : "";
  if (!key || /\s/.test(key) || key.length > 4096) throw new Error("Enter an Anthropic API key without spaces.");
  if (save && args.remember !== true) throw new Error("Choose whether to save the key locally first.");
  const models = await new AnthropicProvider(key, "Anthropic", transport).listModels(signal).catch(() => { throw new Error("Could not list Claude models. Check your Anthropic API key and network connection."); });
  if (!models.length) throw new Error("This key has no available Claude models.");
  if (!save) return { models };
  const model = models.find(m => m.id === args.model);
  if (!model) throw new Error("Check the key again and select an available model.");
  signal.throwIfAborted();
  const cfg = loadConfig({userConfigPath:path, includeProject:false, env:{}}).config;
  let name = String(args.key);
  const existing = name === "provider" ? cfg.provider : cfg.additionalProviders?.[name];
  if (name === "new:anthropic") {
    if ([cfg.provider, ...Object.values(cfg.additionalProviders ?? {})].some(p => isAnthropicEndpoint(p.url))) throw new Error("Anthropic is already configured. Open its Manage action instead.");
    name = cfg.provider.model ? "anthropic" : "provider";
    for (let n = 2; name !== "provider" && cfg.additionalProviders?.[name]; n++) name = `anthropic${n}`;
  } else if (!existing || !isAnthropicEndpoint(existing.url)) throw new Error("This provider changed. Reopen Anthropic settings.");
  const profile = { id: existing?.id ?? "Anthropic", url:"https://api.anthropic.com/v1", model:model.id, allowed_models:[model.id], api_key:key, context_window:existing?.contextWindow ?? 200000, max_output_tokens:existing?.maxOutputTokens ?? 8192 };
  let backup;
  try { ({backup} = updateUserConfig(path, name === "provider" ? {provider:profile} : {additional_providers:{[name]:profile}})); }
  catch { throw new Error("Could not save Anthropic settings. Check local configuration permissions."); }
  let message = `Saved Anthropic key for ${model.id}.`;
  try { scrubProviderBackup(backup, isAnthropicEndpoint); } catch { message += " An old key may remain in the configuration backup."; }
  return { message };
}
