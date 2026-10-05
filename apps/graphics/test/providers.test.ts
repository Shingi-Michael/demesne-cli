import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderAccounts } from "../providers.ts";
import { loadConfig, updateUserConfig } from "@demesne/config";
import type { CodexAccountAuth } from "../../cli/src/codex-auth.ts";
import type { CodexAccountStatus } from "@demesne/codex";
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
    ["new:codex", "codex", "signed-out", false],
    ["new:chatgpt", "chatgpt", "signed-out", false],
  ]);
  expect(await accounts.signOut("openrouter")).toEqual({ label: "OpenRouter" });
  const config = readFileSync(configPath, "utf8");
  expect(config).not.toContain("sk-or-test");
  expect(config).toContain('model = "z-ai/glm"');
  expect((await accounts.list("Qwen on PC")).find((item) => item.key === "openrouter")).toMatchObject({ status: "signed-out", detail: "Signed out" });
  await expect(accounts.signOut("provider")).rejects.toThrow(/no account/);
});

test("Codex provider signs in and out independently while keeping its catalog choice and local primary", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-providers-"))); roots.push(root);
  const configPath = join(root, "config.toml"), events: string[] = [];
  updateUserConfig(configPath, { provider: { id: "Local", url: "http://127.0.0.1:1234/v1", model: "local-model", context_window: 32768, max_output_tokens: 8192 } });
  let signedIn = false;
  const auth: CodexAccountAuth = {
    status: async () => ({ signedIn, authMode: signedIn ? "chatgpt" : undefined, requiresOpenaiAuth: true, ...(signedIn ? { email: "person@example.test" } : {}) }),
    beginLogin: async () => {
      signedIn = true;
      return { loginId: "fixture-login", url: "https://auth.openai.com/fixture", complete: Promise.resolve({ signedIn, authMode: "chatgpt", requiresOpenaiAuth: true }), cancel: async () => { events.push("cancel"); } };
    },
    logout: async () => { signedIn = false; events.push("logout"); },
    listModels: async () => [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", reasoningEfforts: ["medium"], defaultReasoningEffort: "medium", inputModalities: ["text"], isDefault: true }],
    close: async () => { events.push("close"); },
  };
  const accounts = new ProviderAccounts({ configPath, dataDirectory: root, codexAuth: () => auth, open: async () => { events.push("open"); } });
  expect((await accounts.list("Local")).find(entry => entry.kind === "codex")).toMatchObject({ key: "new:codex", label: "Codex · ChatGPT account", status: "signed-out" });
  expect(events).toEqual([]);
  expect(await accounts.signIn("new:codex")).toEqual({ label: "Codex" });
  expect(events).toEqual(["open", "cancel", "close"]);
  expect((await accounts.list("Codex")).find(entry => entry.kind === "codex")).toMatchObject({ key: "codex", status: "signed-in", active: true, detail: "Signed in as person@example.test" });
  expect(await accounts.signOut("codex")).toEqual({ label: "Codex" });
  const config = loadConfig({ userConfigPath: configPath, includeProject: false, env: {} }).config;
  expect(config.provider.model).toBe("local-model");
  expect(config.additionalProviders?.codex?.model).toBe("codex/gpt-6.1-sol");
  expect((await accounts.list("Local")).find(entry => entry.kind === "codex")).toMatchObject({ key: "codex", status: "signed-out", active: false });
});

test("a missing Codex binary leaves the configured provider visible with an actionable error", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-provider-error-"))); roots.push(root);
  const configPath = join(root, "config.toml");
  updateUserConfig(configPath, { additional_providers: { codex: { auth: "codex", model: "codex/gpt-6.1-sol", context_window: 32768, max_output_tokens: 8192 } } });
  const accounts = new ProviderAccounts({ configPath, dataDirectory: root, open: async () => {}, codexAuth: () => ({
    status: async () => { throw new Error("Install Codex or set DEMESNE_CODEX_BIN."); },
    beginLogin: async () => { throw new Error("unused"); }, logout: async () => {}, listModels: async () => [], close: async () => {},
  }) });
  expect((await accounts.list("Local")).find(entry => entry.kind === "codex")).toMatchObject({ key: "codex", status: "signed-out", detail: "Install Codex or set DEMESNE_CODEX_BIN." });
});

test("cancelling Codex browser sign-in cannot apply provider configuration", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-cancel-"))); roots.push(root);
  const configPath = join(root, "config.toml"), events: string[] = [];
  updateUserConfig(configPath, { provider: { id: "Local", url: "http://127.0.0.1:1234/v1", model: "local-model", context_window: 32768, max_output_tokens: 8192 } });
  const original = readFileSync(configPath, "utf8");
  const accounts = new ProviderAccounts({ configPath, dataDirectory: root, open: async () => { accounts.cancel(); }, codexAuth: () => ({
    status: async () => ({ signedIn: false, requiresOpenaiAuth: true }),
    beginLogin: async () => ({ loginId: "fixture-login", url: "https://auth.openai.com/fixture", complete: Promise.resolve({ signedIn: true, authMode: "chatgpt", requiresOpenaiAuth: true }), cancel: async () => { events.push("cancel"); } }),
    logout: async () => {}, listModels: async () => { events.push("models"); return []; }, close: async () => { events.push("close"); },
  }) });
  await expect(accounts.signIn("new:codex")).rejects.toThrow("cancelled");
  expect(events).toEqual(["cancel", "close"]);
  expect(accounts.signingIn).toBeNull();
  expect(readFileSync(configPath, "utf8")).toBe(original);
});

test("a cancelled Codex flow finishing close cannot cancel a newer owned auth client", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-overlap-"))); roots.push(root);
  const configPath = join(root, "config.toml"), closes: number[] = [];
  updateUserConfig(configPath, { provider: { id: "Local", url: "http://127.0.0.1:1234/v1", model: "local-model", context_window: 32768, max_output_tokens: 8192 } });
  const original = readFileSync(configPath, "utf8"), firstClose = Promise.withResolvers<void>();
  let clients = 0, opens = 0;
  const accounts = new ProviderAccounts({ configPath, dataDirectory: root, open: async () => { opens++; }, codexAuth: () => {
    const index = ++clients, login = Promise.withResolvers<CodexAccountStatus>();
    return {
      status: async () => ({ signedIn: false, requiresOpenaiAuth: true }),
      beginLogin: async ({ signal } = {}) => {
        signal?.addEventListener("abort", () => login.reject(new Error("Sign-in cancelled.")), { once: true });
        return { loginId: `fixture-${index}`, url: "https://auth.openai.com/fixture", complete: login.promise, cancel: async () => {} };
      },
      logout: async () => {}, listModels: async () => [], close: async () => { closes.push(index); if (index === 1) await firstClose.promise; },
    };
  } });
  const first = accounts.signIn("new:codex");
  await eventually(() => opens === 1);
  const second = accounts.signIn("new:codex");
  await eventually(() => opens === 2 && closes.includes(1));
  firstClose.resolve();
  await expect(first).rejects.toThrow("cancelled");
  expect(accounts.signingIn).toBe("new:codex");
  expect(closes).toEqual([1]);
  accounts.cancel();
  await expect(second).rejects.toThrow("cancelled");
  expect(closes).toEqual([1, 2]);
  expect(accounts.signingIn).toBeNull();
  expect(readFileSync(configPath, "utf8")).toBe(original);
});
