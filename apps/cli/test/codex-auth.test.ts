import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, updateUserConfig } from "@demesne/config";
import type { CodexModel } from "@demesne/codex";
import { configureCodex, runCodexAuthCommand, type CodexAccountAuth } from "../src/codex-auth.ts";
import { loadAccountSettings, loadCliSettings } from "../src/cli-config.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const model = (slug: string, isDefault = false): CodexModel => ({ id: slug, model: slug, displayName: slug, reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium", inputModalities: ["text"], isDefault });
const path = () => { const root = mkdtempSync(join(tmpdir(), "codex-config-")); roots.push(root); return join(root, "config.toml"); };
const read = (configPath: string) => loadConfig({ userConfigPath: configPath, includeProject: false, env: {} }).config;

test("Codex account settings use machine credentials and daemon even when the project overrides them", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-machine-")); roots.push(root);
  const home = join(root, "home"), workspace = join(root, "project"), configPath = join(home, ".demesne/config.toml");
  mkdirSync(workspace);
  updateUserConfig(configPath, { data_dir: join(root, "machine-data"), server: "http://127.0.0.1:7437" });
  updateUserConfig(join(workspace, ".demesne/config.toml"), { data_dir: join(root, "project-data"), server: "http://127.0.0.1:7537" });
  const settings = loadCliSettings({ env: {}, home, workspaceRoot: workspace });
  expect(settings.dataDirectory).toBe(join(root, "project-data"));
  expect(settings.accountDataDirectory).toBe(join(root, "machine-data"));
  expect(loadAccountSettings({ env: {}, home })).toEqual({ configPath, dataDirectory: join(root, "machine-data"), server: "http://127.0.0.1:7437" });
  const env = { DEMESNE_CONFIG_FILE: join(root, "new-config.toml"), DEMESNE_DATA_DIR: join(root, "environment-data"), DEMESNE_SERVER: "http://127.0.0.1:7637" };
  expect(loadAccountSettings({ home, env })).toEqual({ configPath: env.DEMESNE_CONFIG_FILE, dataDirectory: env.DEMESNE_DATA_DIR, server: env.DEMESNE_SERVER });
  expect(loadAccountSettings({ home, env, serverOverride: "http://127.0.0.1:7737" }).server).toBe("http://127.0.0.1:7737");
  writeFileSync(join(workspace, ".demesne/config.toml"), "broken = true\n");
  expect(loadCliSettings({ env: {}, home, workspaceRoot: workspace, includeProject: false }).dataDirectory).toBe(join(root, "machine-data"));
});

test("Codex selects Sol 6.1 only from the live catalog, namespaces it, and preserves existing providers", () => {
  const configPath = path();
  updateUserConfig(configPath, { theme: "light", provider: { id: "Local", url: "http://127.0.0.1:1234/v1", model: "local-model", api_key: "local-fixture", context_window: 32768, max_output_tokens: 8192 },
    additional_providers: { chatgpt: { id: "ChatGPT", auth: "chatgpt", auth_profile: "fixture-account", url: "https://api.openai.com/v1", model: "gpt-6-astra", context_window: 32768, max_output_tokens: 8192 } } });
  const before = read(configPath);
  expect(configureCodex({ configPath, models: [model("gpt-6-astra", true), model("gpt-6.1-sol")] }).model).toBe("codex/gpt-6.1-sol");
  const config = read(configPath);
  expect(config.provider).toEqual(before.provider);
  expect(config.additionalProviders?.chatgpt).toEqual(before.additionalProviders?.chatgpt);
  expect(config.additionalProviders?.codex).toEqual({ id: "Codex", auth: "codex", model: "codex/gpt-6.1-sol", contextWindow: 272000, maxOutputTokens: 16384 });
  expect(config.theme).toBe("light");
  expect(configureCodex({ configPath, models: [model("first"), model("upstream-default", true)] }).model).toBe("codex/upstream-default");
  expect(configureCodex({ configPath, models: [model("first"), model("second")] }).model).toBe("codex/first");
});

test("Codex clears incompatible credentials from an empty primary and rejects unlisted choices before editing", () => {
  const configPath = path();
  updateUserConfig(configPath, { provider: { url: "http://127.0.0.1:1234/v1", api_key: "fixture-key", auth_profile: "fixture-account", runtime_profile: "local-profile" } });
  configureCodex({ configPath, models: [model("sol")], model: "codex/sol", contextWindow: 65536 });
  expect(read(configPath).provider).toEqual({ id: "Codex", auth: "codex", model: "codex/sol", contextWindow: 65536, maxOutputTokens: 16384 });
  const before = readFileSync(configPath, "utf8");
  expect(() => configureCodex({ configPath, models: [model("sol")], model: "unlisted" })).toThrow("catalog");
  expect(() => configureCodex({ configPath, models: [model("sol")], contextWindow: 1024 })).toThrow("2048");
  expect(readFileSync(configPath, "utf8")).toBe(before);
});

test("moving Codex to an empty primary removes a redundant account entry", () => {
  const configPath = path();
  updateUserConfig(configPath, { additional_providers: { codex: { id: "Codex", auth: "codex", model: "codex/sol", context_window: 32768, max_output_tokens: 8192 } } });
  configureCodex({ configPath, models: [model("sol")] });
  expect(read(configPath).provider.model).toBe("codex/sol");
  expect(read(configPath).additionalProviders?.codex).toBeUndefined();
});

test("CLI Codex login, status, and logout use the owned auth client and close it", async () => {
  const configPath = path(), events: string[] = [];
  const account = { signedIn: true, authMode: "chatgpt" as const, requiresOpenaiAuth: true, email: "person@example.test" };
  const auth: CodexAccountAuth = {
    status: async () => { events.push("status"); return account; },
    beginLogin: async () => { events.push("login"); return { loginId: "fixture-login", url: "https://auth.openai.com/fixture", complete: Promise.resolve(account), cancel: async () => { events.push("cancel"); } }; },
    logout: async () => { events.push("logout"); },
    listModels: async () => { events.push("models"); return [model("gpt-6.1-sol")]; },
    close: async () => { events.push("close"); },
  };
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runCodexAuthCommand(["auth", "login", "codex"], { configPath, dataDirectory: join(configPath, ".."), auth, open: async url => { expect(url).toBe("https://auth.openai.com/fixture"); events.push("open"); return true; }, reload: async () => { events.push("reload"); return "reloaded"; } });
    expect(events).toEqual(["login", "open", "models", "cancel", "reload", "close"]);
    expect(read(configPath).provider.model).toBe("codex/gpt-6.1-sol");
    await runCodexAuthCommand(["auth", "status", "codex"], { configPath, dataDirectory: "/unused", auth, open: async () => false });
    await runCodexAuthCommand(["auth", "logout", "codex"], { configPath, dataDirectory: "/unused", auth, open: async () => false });
    expect(events.slice(-4)).toEqual(["status", "close", "logout", "close"]);
  } finally { log.mockRestore(); }
});
