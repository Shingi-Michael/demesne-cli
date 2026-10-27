import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, updateUserConfig } from "@demesne/config";
import type { ModelDescriptor } from "@demesne/protocol";
import { configureCodex, connectCodex, type CodexAccountAuth } from "../src/codex-auth.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const model = (slug: string, contextWindow?: number): ModelDescriptor => ({ id: `codex/${slug}`, displayName: slug, provider: "Codex", contextWindow, reasoningLevels: ["low", "high"], defaultReasoningLevel: "low" });
const path = () => { const root = mkdtempSync(join(tmpdir(), "codex-config-")); roots.push(root); return join(root, "config.toml"); };
const read = (configPath: string) => loadConfig({ userConfigPath: configPath, includeProject: false, env: {} }).config;

test("Codex prefers Sol from the live catalog, keeps the codex/ ids and leaves other providers alone", () => {
  const configPath = path();
  updateUserConfig(configPath, { theme: "light", provider: { id: "Local", url: "http://127.0.0.1:1234/v1", model: "local-model", api_key: "local-fixture", context_window: 32768, max_output_tokens: 8192 },
    additional_providers: { chatgpt: { id: "ChatGPT", auth: "chatgpt", auth_profile: "fixture-account", url: "https://api.openai.com/v1", model: "gpt-6-astra", context_window: 32768, max_output_tokens: 8192 } } });
  const before = read(configPath);
  expect(configureCodex({ configPath, models: [model("gpt-6-astra"), model("gpt-6.1-sol", 272_000)] }).model).toBe("codex/gpt-6.1-sol");
  const config = read(configPath);
  expect(config.provider).toEqual(before.provider);
  expect(config.additionalProviders?.chatgpt).toEqual(before.additionalProviders?.chatgpt);
  expect(config.additionalProviders?.codex).toEqual({ id: "Codex", auth: "codex", model: "codex/gpt-6.1-sol", contextWindow: 272000, maxOutputTokens: 16384 });
  expect(config.theme).toBe("light");
  expect(configureCodex({ configPath, models: [model("first"), model("second")] }).model).toBe("codex/first");
});

test("Codex takes an empty primary, clears incompatible keys and rejects unlisted choices before editing", () => {
  const configPath = path();
  updateUserConfig(configPath, { provider: { url: "http://127.0.0.1:1234/v1", api_key: "fixture-key", auth_profile: "fixture-account", runtime_profile: "local-profile" } });
  configureCodex({ configPath, models: [model("sol")], model: "codex/sol", contextWindow: 65536 });
  expect(read(configPath).provider).toEqual({ id: "Codex", auth: "codex", model: "codex/sol", contextWindow: 65536, maxOutputTokens: 16384 });
  const before = readFileSync(configPath, "utf8");
  expect(() => configureCodex({ configPath, models: [model("sol")], model: "codex/unlisted" })).toThrow("catalog");
  expect(() => configureCodex({ configPath, models: [model("sol")], contextWindow: 1024 })).toThrow("2048");
  expect(readFileSync(configPath, "utf8")).toBe(before);
});

test("asking for primary replaces another primary and drops the redundant Codex entry", () => {
  const configPath = path();
  updateUserConfig(configPath, { provider: { id: "ChatGPT", auth: "chatgpt", auth_profile: "fixture-account", url: "https://api.openai.com/v1", model: "gpt-6.1-sol", context_window: 272000, max_output_tokens: 16384 },
    additional_providers: { codex: { id: "Codex", auth: "codex", model: "codex/sol", context_window: 32768, max_output_tokens: 8192 } } });
  expect(() => configureCodex({ configPath, models: [model("sol")], key: "provider" })).toThrow("cannot replace");
  configureCodex({ configPath, models: [model("sol")], primary: true });
  expect(read(configPath).provider).toMatchObject({ auth: "codex", model: "codex/sol" });
  expect(read(configPath).additionalProviders?.codex).toBeUndefined();
});

test("connectCodex skips the browser for an account that is already signed in and reads the catalog through the provider", async () => {
  const events: string[] = [];
  const auth: CodexAccountAuth = {
    status: async () => ({ signedIn: true, email: "person@example.test", accountId: "acct-1" }),
    beginLogin: async () => { events.push("login"); throw new Error("unused"); },
    logout: async () => {}, accessToken: async () => "access", accountId: async () => "acct-1",
  };
  const { account, models } = await connectCodex({ auth, signal: new AbortController().signal, onLogin: async () => { events.push("open"); },
    fetch: (async (url: string | URL | Request) => { events.push(String(url)); return Response.json({ models: [{ slug: "gpt-6.1-sol", visibility: "list", context_window: 272_000 }] }); }) as unknown as typeof fetch });
  expect(account.email).toBe("person@example.test");
  expect(models.map(m => m.id)).toEqual(["codex/gpt-6.1-sol"]);
  expect(events).toEqual(["https://chatgpt.com/backend-api/codex/models?client_version=0.164.0"]);
});
