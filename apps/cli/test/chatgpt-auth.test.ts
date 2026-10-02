import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, updateUserConfig } from "@demesne/config";
import { configureChatGPT } from "../src/chatgpt-auth.ts";
import { writeSetupConfig } from "../src/setup.ts";
import { initialWizard, reduceWizard, wizardChatGPTConnected } from "../src/setup-wizard.ts";
const account = { id: "fixture-account", label: "person@example.test", signedIn: true, planEnabled: true, acknowledged: true };
const models = [{ id: "account-model", displayName: "Account model", provider: "ChatGPT", contextWindow: 65536 }];

test("CLI login adds ChatGPT while preserving a local provider; setup clears incompatible primary credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-config-")), path = join(root, "config.toml");
  try {
    updateUserConfig(path, { theme: "light", provider: { id: "local", url: "http://127.0.0.1:1234/v1", model: "local-model", context_window: 32768, max_output_tokens: 1536, api_key: "old-key", runtime_profile: "local-profile" } });
    configureChatGPT({ configPath: path, account, models });
    let config = loadConfig({ userConfigPath: path, includeProject: false, env: {} }).config;
    expect(config.provider.model).toBe("local-model"); expect(config.provider.apiKey).toBe("old-key"); expect(config.additionalProviders?.chatgpt).toMatchObject({ auth: "chatgpt", authProfile: account.id, model: "account-model" });
    writeSetupConfig(path, { providerUrl: "https://api.openai.com/v1", providerId: "ChatGPT", authProfile: account.id, model: "account-model", contextWindow: 65536, maxOutputTokens: 8192 });
    config = loadConfig({ userConfigPath: path, includeProject: false, env: {} }).config;
    expect(config.additionalProviders?.chatgpt).toBeUndefined(); expect(config.provider.auth).toBe("chatgpt"); expect(config.provider.apiKey).toBeUndefined(); expect(config.provider.runtimeProfile).toBeUndefined(); expect(config.theme).toBe("light");
    writeSetupConfig(path, { providerUrl: "http://127.0.0.1:1234/v1", providerId: "local", model: "local", contextWindow: 32768, maxOutputTokens: 1536 });
    config = loadConfig({ userConfigPath: path, includeProject: false, env: {} }).config;
    expect(config.provider.auth).toBe("api-key"); expect(config.provider.authProfile).toBeUndefined(); expect(readFileSync(path, "utf8")).not.toContain("old-key");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects unlisted models and unacknowledged plan usage before changing config", () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-config-")), path = join(root, "config.toml");
  try {
    expect(() => configureChatGPT({ configPath: path, account, models, model: "unlisted" })).toThrow("catalog");
    expect(() => configureChatGPT({ configPath: path, account: { ...account, acknowledged: false }, models })).toThrow("Acknowledge");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup selects account-specific models in server order and shows the first-use notice only until acknowledged", () => {
  const provider = { target: { id: "ChatGPT", label: "ChatGPT", url: "https://api.openai.com/v1" }, reachable: true, models: [models[0]!, { id: "larger", provider: "ChatGPT", contextWindow: 200000 }] };
  let state = wizardChatGPTConnected(initialWizard("/test/config.toml"), { ...account, acknowledged: false }, provider);
  expect(state.step).toBe("plan"); expect(reduceWizard(state, { name: "return" }).effect?.kind).toBe("acknowledge-plan");
  state = wizardChatGPTConnected(state, account, provider); expect(state.step).toBe("model"); expect(state.modelIndex).toBe(0);
  state = reduceWizard(state, { name: "down" }).state; expect(state.modelIndex).toBe(1);
});
