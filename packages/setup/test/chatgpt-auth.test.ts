import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGPTAuth } from "@demesne/chatgpt-auth";
import { loadConfig, updateUserConfig } from "@demesne/config";
import { configureChatGPT, discoverChatGPT} from "../src/chatgpt-auth.ts";
import { writeSetupConfig } from "../src/setup.ts";
import { initialWizard, reduceWizard, wizardChatGPTConnected } from "../src/setup-wizard.ts";
const account = { id: "fixture-account", label: "person@example.test", signedIn: true, planEnabled: true, acknowledged: true };
const models = [{ id: "account-model", displayName: "Account model", provider: "ChatGPT", contextWindow: 65536 }];
const catalog = () => Response.json({ models: [{ slug: "account-model", display_name: "Account model", visibility: "list", context_window: 65536 }] });
function savedAccount(root: string, options: { acknowledged?: boolean; scopes?: string[] } = {}) {
  mkdirSync(join(root, "auth"), { mode: 0o700 });
  writeFileSync(join(root, "auth/chatgpt.json"), JSON.stringify({ version: 1, hostId: "urn:uuid:cli-fixture", accounts: [{
    id: account.id, clientId: "oaiapp_fixture", issuer: "https://auth.openai.com", subject: "fixture-subject", email: account.label,
    accessToken: "fixture-token", refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000,
    scopes: options.scopes ?? ["resource.invoke", "chatgpt.tokens.use.direct"], acknowledged: options.acknowledged ?? true,
  }] }), { mode: 0o600 });
  return new ChatGPTAuth(root);
}
function verification() {
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-6.1-sol", status: "completed", output: [{
    id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK.", annotations: [] }],
  }] } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

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

test("ChatGPT discovery does not run inference for the default or a listed model", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-discovery-"));
  try {
    const auth = savedAccount(root), requests: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      requests.push(String(input));
      expect(String(input)).toBe("https://api.openai.com/v1/models");
      return catalog();
    }) as unknown as typeof fetch;
    for (const model of [undefined, "account-model"]) {
      expect((await discoverChatGPT(auth, account.id, { fetch: fetcher, model })).models).toEqual(models);
    }
    expect(requests).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an explicit omitted Sol model is verified with the selected account and appended after the catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-discovery-"));
  try {
    const auth = savedAccount(root), requests: string[] = [];
    const result = await discoverChatGPT(auth, account.id, { model: "gpt-6.1-sol", fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input));
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-token");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (String(input).endsWith("/models")) return catalog();
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true });
      expect(body).not.toHaveProperty("tools");
      return verification();
    }) as unknown as typeof fetch });
    expect(requests).toEqual(["https://api.openai.com/v1/models", "https://api.openai.com/v1/responses"]);
    expect(result.models.map(model => model.id)).toEqual(["account-model", "gpt-6.1-sol"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup selects account-specific models in server order and shows the first-use notice only until acknowledged", () => {
  const provider = { target: { id: "ChatGPT", label: "ChatGPT", url: "https://api.openai.com/v1" }, reachable: true, models: [models[0]!, { id: "larger", provider: "ChatGPT", contextWindow: 200000 }] };
  let state = wizardChatGPTConnected(initialWizard("/test/config.toml"), { ...account, acknowledged: false }, provider);
  expect(state.step).toBe("plan"); expect(reduceWizard(state, { name: "return" }).effect?.kind).toBe("acknowledge-plan");
  state = wizardChatGPTConnected(state, account, provider); expect(state.step).toBe("model"); expect(state.modelIndex).toBe(0);
  state = reduceWizard(state, { name: "down" }).state; expect(state.modelIndex).toBe(1);
});
