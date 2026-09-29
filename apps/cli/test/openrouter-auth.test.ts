import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@demesne/config";
import { beginOpenRouterLogin, configureOpenRouter, DEFAULT_OPENROUTER_MODEL, OPENROUTER_URL } from "../src/openrouter-auth.ts";

test("OpenRouter login exchanges a one-use callback with the matching S256 verifier", async () => {
  const requests: { url: string; body: Record<string, string> }[] = [];
  const login = beginOpenRouterLogin({ fetch: (async (input, init) => {
    expect(init?.redirect).toBe("manual");
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ key: "test-private-key" });
  }) as typeof fetch });
  try {
    const authorization = new URL(login.url);
    expect(authorization.origin).toBe("https://openrouter.ai");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(authorization.searchParams.get("callback_url")!);
    expect(callback.hostname).toBe("localhost");
    expect((await fetch(new URL("/wrong-callback?code=forged", callback))).status).toBe(404);
    expect((await fetch(callback)).status).toBe(400);
    callback.searchParams.set("code", "one-use-code");
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("test-private-key");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await login.key).toBe("test-private-key");
    expect((await fetch(callback)).status).toBe(409);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${OPENROUTER_URL}/auth/keys`);
    const body = requests[0]!.body;
    expect(body.code).toBe("one-use-code");
    expect(body.code_challenge_method).toBe("S256");
    expect(createHash("sha256").update(body.code_verifier!).digest("base64url")).toBe(authorization.searchParams.get("code_challenge")!);
    expect(login.url).not.toContain(body.code_verifier!);
  } finally { await login.close(); }
});

test.each(["cancel", "decline", "exchange-failure"] as const)("OpenRouter %s closes without returning a credential", async (failure) => {
  const controller = new AbortController();
  const login = beginOpenRouterLogin({ signal: controller.signal,
    fetch: (async () => new Response("do not echo secret response", { status: 403 })) as unknown as typeof fetch });
  try {
    if (failure === "cancel") controller.abort();
    else {
      const callback = new URL(new URL(login.url).searchParams.get("callback_url")!);
      callback.searchParams.set(failure === "decline" ? "error" : "code", "test");
      expect((await fetch(callback)).ok).toBe(false);
    }
    await expect(login.key).rejects.toThrow(failure === "cancel" ? "cancelled" : failure === "decline" ? "declined" : "HTTP 403");
  } finally { await login.close(); }
});

test.each([true, false])("OpenRouter credentials persist privately and preserve local configuration (existing=%s)", async (existing) => {
  const root = mkdtempSync(join(tmpdir(), "demesne-openrouter-"));
  const configPath = join(root, "config.toml");
  const original = '[provider]\nurl = "http://localhost:1234/v1"\nmodel = "local"\n[additional_providers.pc]\nurl = "http://localhost:1235/v1"\nmodel = "qwen-pc"\ncontext_window = 262144\nmax_output_tokens = 8192\n[ui]\nintro = false\n';
  if (existing) writeFileSync(configPath, original, { mode: 0o600 });
  try {
    const result = await configureOpenRouter({ apiKey: "test-private-key", configPath, fetch: (async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-private-key");
      return String(input).endsWith("/key") ? Response.json({ data: { limit: 10 } })
        : Response.json({ data: [{ id: DEFAULT_OPENROUTER_MODEL, context_length: 1000000,
          top_provider: { max_completion_tokens: 131072 } }] });
    }) as typeof fetch });
    const { config } = loadConfig({ userConfigPath: configPath, env: {}, projectConfigPath: null });
    const provider = existing ? config.additionalProviders?.openrouter : config.provider;
    expect(provider).toMatchObject({ url: OPENROUTER_URL, id: "OpenRouter", model: DEFAULT_OPENROUTER_MODEL,
      apiKey: "test-private-key", contextWindow: 262144, maxOutputTokens: 131072 });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain("test-private-key");
    if (existing) {
      expect(config.provider.model).toBe("local");
      expect(config.additionalProviders?.pc?.model).toBe("qwen-pc");
      expect(config.ui.intro).toBe(false);
      expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(original);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid keys do not change the existing config or echo provider response bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-openrouter-"));
  const configPath = join(root, "config.toml");
  writeFileSync(configPath, "theme = \"dark\"\n");
  try {
    await expect(configureOpenRouter({ apiKey: "bad-key", configPath,
      fetch: (async () => new Response("bad-key", { status: 401 })) as unknown as typeof fetch })).rejects.toThrow("HTTP 401");
    expect(readFileSync(configPath, "utf8")).toBe("theme = \"dark\"\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each([
  { context: 32768, output: 4096, expectedContext: 32768, expectedOutput: 4096 },
  { context: 1000000, output: 262144, expectedContext: 524288, expectedOutput: 262144 },
  { context: 8192, output: null, expectedContext: 8192, expectedOutput: 2048 },
  { context: 262144, output: -1, expectedContext: 262144, expectedOutput: 16384 },
])("OpenRouter discovers output capacity and retains input headroom ($context/$output)", async ({ context, output, expectedContext, expectedOutput }) => {
  const root = mkdtempSync(join(tmpdir(), "demesne-openrouter-capacity-"));
  const configPath = join(root, "config.toml");
  writeFileSync(configPath, '[provider]\nurl = "https://openrouter.ai/api/v1"\nmodel = "old"\nreasoning_effort = "high"\n');
  try {
    await configureOpenRouter({ apiKey: "test-key", configPath, model: "test/model", fetch: (async (input) => String(input).endsWith("/key")
      ? Response.json({ data: {} }) : Response.json({ data: [{ id: "test/model", context_length: context,
        top_provider: { max_completion_tokens: output } }] })) as typeof fetch });
    expect(loadConfig({ userConfigPath: configPath, env: {}, projectConfigPath: null }).config.provider).toMatchObject({
      model: "test/model", contextWindow: expectedContext, maxOutputTokens: expectedOutput, reasoningEffort: "high",
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
