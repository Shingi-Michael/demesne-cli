import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderAccounts } from "../providers.ts";
import { loadConfig, updateUserConfig } from "@demesne/config";
import { fakeChatGPT } from "../../../packages/chatgpt-auth/test/fixture.ts";
import { eventually } from "./fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("lists providers with their sign-in state and signs out of OpenRouter by removing only its key", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "providers-")));
  roots.push(root);
  const configPath = join(root, "config.toml");
  writeFileSync(configPath, [
    "[provider]", 'id = "Qwen on PC"', 'url = "http://100.115.125.89:8081/v1"', 'allow_http_endpoint = "http://100.115.125.89:8081/v1"', 'model = "qwen3.8-27b"', "context_window = 32768", "max_output_tokens = 8192", "",
    "[additional_providers.openrouter]", 'id = "OpenRouter"', 'url = "https://openrouter.ai/api/v1"', 'api_key = "sk-or-test"', 'model = "z-ai/glm"', "context_window = 128000", "max_output_tokens = 16000", "",
  ].join("\n"));
  const accounts = new ProviderAccounts({ configPath, dataDirectory: root, open: async () => {} });
  const before = await accounts.list("Qwen on PC");
  expect(before.map((item) => [item.key, item.kind, item.status, item.active])).toEqual([
    ["provider", "local", "local", true],
    ["openrouter", "openrouter", "signed-in", false],
    ["new:chatgpt", "chatgpt", "signed-out", false],
  ]);
  expect(await accounts.signOut("openrouter")).toEqual({ label: "OpenRouter" });
  const config = readFileSync(configPath, "utf8");
  expect(config).not.toContain("sk-or-test");
  expect(config).toContain('model = "z-ai/glm"');
  expect((await accounts.list("Qwen on PC")).find((item) => item.key === "openrouter")).toMatchObject({ status: "signed-out", detail: "Signed out" });
  await expect(accounts.signOut("provider")).rejects.toThrow(/no account/);
});

test("ChatGPT signs in and out independently while keeping its model choice and local primary", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chatgpt-providers-"))); roots.push(root);
  const configPath = join(root, "config.toml"), fake = await fakeChatGPT();
  const accountDataDirectory = join(root, "machine-data"), dataDirectory = join(root, "project-data");
  updateUserConfig(configPath, { provider: { id: "Local", url: "http://127.0.0.1:1234/v1", model: "local-model", context_window: 32768, max_output_tokens: 8192 } });
  const accounts = new ProviderAccounts({ configPath, dataDirectory, accountDataDirectory, fetch: fake.fetch, open: async url => { expect((await fake.callback(url)).status).toBe(200); } });
  expect((await accounts.list("Local")).find(entry => entry.kind === "chatgpt")).toMatchObject({ key: "new:chatgpt", label: "ChatGPT", status: "signed-out" });
  expect(await accounts.signIn("new:chatgpt")).toEqual({ label: "ChatGPT" });
  expect(existsSync(join(accountDataDirectory, "auth/chatgpt.json"))).toBe(true);
  expect(existsSync(join(dataDirectory, "auth"))).toBe(false);
  expect((await accounts.list("ChatGPT")).find(entry => entry.kind === "chatgpt")).toMatchObject({ key: "chatgpt", status: "signed-in", active: true, detail: "Signed in as person@example.test" });
  updateUserConfig(configPath, { additional_providers: { chatgpt: { model: "gpt-6.1-sol", context_window: 272000 } } });
  expect(await accounts.signOut("chatgpt")).toEqual({ label: "ChatGPT", revoked: true });
  expect((await accounts.list("Local")).find(entry => entry.kind === "chatgpt")).toMatchObject({ key: "chatgpt", status: "signed-out", active: false });
  expect(await accounts.signIn("chatgpt")).toEqual({ label: "ChatGPT" });
  const config = loadConfig({ userConfigPath: configPath, includeProject: false, env: {} }).config;
  expect(config.provider.model).toBe("local-model");
  expect(config.additionalProviders?.chatgpt).toMatchObject({ auth: "chatgpt", model: "gpt-6.1-sol", contextWindow: 272000 });
  expect((await accounts.list("ChatGPT")).find(entry => entry.kind === "chatgpt")).toMatchObject({ status: "signed-in", active: true });
  expect(readFileSync(configPath, "utf8")).not.toMatch(/access-secret|refresh-secret|eyJ/);
});

test("cancelling ChatGPT browser sign-in cannot apply provider configuration", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chatgpt-cancel-"))); roots.push(root);
  const configPath = join(root, "config.toml"), fake = await fakeChatGPT();
  updateUserConfig(configPath, { provider: { id: "Local", url: "http://127.0.0.1:1234/v1", model: "local-model", context_window: 32768, max_output_tokens: 8192 } });
  const original = readFileSync(configPath, "utf8");
  const accounts = new ProviderAccounts({ configPath, dataDirectory: root, fetch: fake.fetch, open: async () => { accounts.cancel(); } });
  await expect(accounts.signIn("new:chatgpt")).rejects.toThrow("cancelled");
  expect(fake.requests).toHaveLength(0);
  expect(accounts.signingIn).toBeNull();
  expect(readFileSync(configPath, "utf8")).toBe(original);
});

test("cancelling during ChatGPT catalog discovery cannot apply a completed sign-in", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chatgpt-discovery-cancel-"))); roots.push(root);
  const configPath = join(root, "config.toml"), fake = await fakeChatGPT(), catalog = Promise.withResolvers<Response>();
  updateUserConfig(configPath, { provider: { id: "Local", model: "local-model" } });
  const original = readFileSync(configPath, "utf8");
  let discovering = false;
  const accounts = new ProviderAccounts({ configPath, dataDirectory: root, open: async url => { await fake.callback(url); }, fetch: (async (url, init) => {
    if (String(url).endsWith("/v1/models")) { discovering = true; return catalog.promise; }
    return fake.fetch(url, init);
  }) as typeof fetch });
  const flow = accounts.signIn("new:chatgpt");
  await eventually(() => discovering);
  accounts.cancel();
  // Even a transport completing after cancellation cannot commit the provider.
  catalog.resolve(Response.json({ models: [{ slug: "model-fixture", visibility: "list" }] }));
  await expect(flow).rejects.toThrow("cancelled");
  expect(accounts.signingIn).toBeNull();
  expect(readFileSync(configPath, "utf8")).toBe(original);
});

test("a cancelled ChatGPT flow finishing later cannot clear a newer browser sign-in", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chatgpt-overlap-"))); roots.push(root);
  const configPath = join(root, "config.toml"), fake = await fakeChatGPT(), firstOpen = Promise.withResolvers<void>();
  updateUserConfig(configPath, { provider: { id: "Local", url: "http://127.0.0.1:1234/v1", model: "local-model", context_window: 32768, max_output_tokens: 8192 } });
  const original = readFileSync(configPath, "utf8");
  let opens = 0;
  const accounts = new ProviderAccounts({ configPath, dataDirectory: root, fetch: fake.fetch, open: async () => { if (++opens === 1) await firstOpen.promise; } });
  const first = accounts.signIn("new:chatgpt");
  await eventually(() => opens === 1);
  const second = accounts.signIn("new:chatgpt");
  await eventually(() => opens === 2);
  firstOpen.resolve();
  await expect(first).rejects.toThrow("cancelled");
  expect(accounts.signingIn).toBe("new:chatgpt");
  accounts.cancel();
  await expect(second).rejects.toThrow("cancelled");
  expect(accounts.signingIn).toBeNull();
  expect(fake.requests).toHaveLength(0);
  expect(readFileSync(configPath, "utf8")).toBe(original);
});
