import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, updateUserConfig } from "@demesne/config";
import { GoogleAIConnection, GOOGLE_AI_URL } from "../google-ai.ts";
import { ProviderAccounts } from "../providers.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const KEY = "fixture-key-not-a-real-google-secret";
const nativeModel = (id = "gemini-test-flash") => ({ name: `models/${id}`, supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 });
function stream(delta: unknown, finish: string) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}
function fixture(options: { failRoundTrip?: boolean; prefixed?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "google-ai-test-")); roots.push(root);
  const configPath = join(root, "config.toml");
  const requests: { url: string; body: any }[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    expect(url).not.toContain(KEY);
    expect(init?.redirect).toBe("manual");
    if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?")) {
      expect(headers.get("x-goog-api-key")).toBe(KEY);
      return Response.json({ models: [nativeModel(), nativeModel("gemini-test-image"), { ...nativeModel("gemini-embedding"), supportedGenerationMethods: ["embedContent"] }] });
    }
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    if (url.endsWith("/models")) return Response.json({ data: [{ id: `${options.prefixed ? "models/" : ""}gemini-test-flash` }, { id: "gemini-test-image" }] });
    expect(url).toBe(`${GOOGLE_AI_URL}/chat/completions`);
    if (body.messages.length === 1) {
      expect(body.tools[0].function.name).toBe("connection_check");
      expect(body.stream).toBe(true);
      return stream({ tool_calls: [{ index: 0, id: "call-test", function: { name: "connection_check", arguments: '{"value":"ready"}' } }] }, "tool_calls");
    }
    expect(body.messages[1].tool_calls[0]).toMatchObject({ id: "call-test", function: { name: "connection_check", arguments: '{"value":"ready"}' } });
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "call-test", content: '{"result":"ready"}' });
    if (options.failRoundTrip) return Response.json({ error: { message: `Rejected missing model metadata ${KEY}` } }, { status: 400 });
    return stream({ content: "OK" }, "stop");
  }) as unknown as typeof fetch;
  return { root, configPath, requests, fake, connection: new GoogleAIConnection({ configPath, fetch: fake }) };
}

test("discovery and a streamed tool round trip do not create files or return the test key", async () => {
  const f = fixture();
  const catalog = await f.connection.discover(KEY);
  expect(catalog).toEqual({ models: [{ id: "gemini-test-flash", contextWindow: 262144, maxOutputTokens: 16384 }] });
  expect(f.requests.some(r => r.body)).toBe(false);
  const result = await f.connection.test(KEY, catalog.models[0]!.id);
  expect(result.message).toContain("not saved");
  expect(JSON.stringify([catalog, result])).not.toContain(KEY);
  expect(readdirSync(f.root)).toEqual([]);
  expect(f.requests.filter(r => r.body)).toHaveLength(2);
});

test("only an explicit save stores a checked model and preserves other providers", async () => {
  const f = fixture();
  updateUserConfig(f.configPath, { provider: { id: "Local", model: "local-model" }, additional_providers: { google: { id: "Other", url: "https://example.com/v1", model: "other", context_window: 32768, max_output_tokens: 8192 } } });
  const before = readFileSync(f.configPath, "utf8");
  await expect(f.connection.save(KEY, "gemini-test-flash", false, "new:google")).rejects.toThrow("explicit permission");
  expect(f.requests).toHaveLength(0);
  expect(readFileSync(f.configPath, "utf8")).toBe(before);
  await f.connection.save(KEY, "gemini-test-flash", true, "new:google");
  const config = loadConfig({ userConfigPath: f.configPath, includeProject: false, env: {} }).config;
  expect(config.provider).toMatchObject({ id: "Local", model: "local-model" });
  expect(config.additionalProviders?.google).toMatchObject({ id: "Other", model: "other" });
  expect(config.additionalProviders?.google2).toMatchObject({ id: "Google AI Studio", apiKey: KEY, model: "gemini-test-flash", allowedModels: ["gemini-test-flash"], vision: false });
  expect(statSync(f.configPath).mode & 0o777).toBe(0o600);
  expect(readFileSync(`${f.configPath}.bak`, "utf8")).not.toContain(KEY);
});

test("an empty setup can become the primary; prefixed catalog IDs survive model filtering", async () => {
  const f = fixture({ prefixed: true });
  await f.connection.save(KEY, "models/gemini-test-flash", true, "new:google");
  const config = loadConfig({ userConfigPath: f.configPath, includeProject: false, env: {} }).config;
  expect(config.provider.model).toBe("models/gemini-test-flash");
  expect(config.provider.allowedModels).toEqual(["models/gemini-test-flash"]);
});

test("a model that lists successfully but fails tool continuity cannot be saved", async () => {
  const f = fixture({ failRoundTrip: true });
  expect((await f.connection.discover(KEY)).models).toHaveLength(1);
  try { await f.connection.save(KEY, "gemini-test-flash", true, "new:google"); throw new Error("unexpected success"); }
  catch (error) { expect(String(error)).toContain("rejected"); expect(String(error)).not.toContain(KEY); }
  expect(existsSync(f.configPath)).toBe(false);
});

test("replacement and disconnect remove old Google keys from the config backup", async () => {
  const f = fixture();
  await f.connection.save(KEY, "gemini-test-flash", true, "new:google");
  updateUserConfig(f.configPath, { provider: { api_key: "old-google-fixture-key" } });
  await f.connection.save(KEY, "gemini-test-flash", true, "provider");
  expect(readFileSync(`${f.configPath}.bak`, "utf8")).not.toMatch(/old-google-fixture-key|fixture-key-not-a-real-google-secret/);
  const accounts = new ProviderAccounts({ configPath: f.configPath, dataDirectory: f.root, open: async () => {} });
  const entries = await accounts.list("Google AI Studio");
  expect(entries.find(p => p.kind === "google")).toMatchObject({ key: "provider", status: "signed-in", active: true });
  expect(JSON.stringify(entries)).not.toContain(KEY);
  await accounts.signOut("provider");
  expect(readFileSync(f.configPath, "utf8")).not.toContain(KEY);
  expect(readFileSync(`${f.configPath}.bak`, "utf8")).not.toContain(KEY);
  const config = loadConfig({ userConfigPath: f.configPath, includeProject: false, env: {} }).config;
  expect(config.provider.model).toBe("gemini-test-flash");
  expect(config.provider.apiKey).toBeUndefined();
});

test("cancelled discovery cannot publish late results or save a key", async () => {
  const f = fixture(), deferred = Promise.withResolvers<Response>();
  const connection = new GoogleAIConnection({ configPath: f.configPath, fetch: (() => deferred.promise) as unknown as typeof fetch });
  const result = connection.discover(KEY);
  connection.cancel();
  deferred.resolve(Response.json({ models: [nativeModel()] }));
  await expect(result).rejects.toThrow("cancelled");
  expect(readdirSync(f.root)).toEqual([]);
});

for (const [status, words] of [[401, "rejected"], [403, "denied"], [429, "quota"], [503, "temporarily"]] as const) {
  test(`Google HTTP ${status} is actionable without echoing upstream data`, async () => {
    const f = fixture();
    const connection = new GoogleAIConnection({ configPath: f.configPath, fetch: (async () => Response.json({ error: { message: KEY } }, { status })) as unknown as typeof fetch });
    const error = await connection.discover(KEY).catch(error => String(error));
    expect(error).toContain(words);
    expect(error).not.toContain(KEY);
    expect(readdirSync(f.root)).toEqual([]);
  });
}

test("redirects and transport errors cannot forward or leak a key", async () => {
  const f = fixture();
  for (const impl of [async () => new Response(null, { status: 302, headers: { location: `https://example.com/${KEY}` } }), async () => { throw new Error(KEY); }]) {
    const connection = new GoogleAIConnection({ configPath: f.configPath, fetch: impl as unknown as typeof fetch });
    expect(await connection.discover(KEY).catch(error => String(error))).not.toContain(KEY);
  }
});

test("unavailable models and wrong provider targets leave the existing configuration intact", async () => {
  const f = fixture();
  writeFileSync(f.configPath, '[provider]\nid = "Local"\nmodel = "local-model"\n');
  const before = readFileSync(f.configPath, "utf8");
  await expect(f.connection.save(KEY, "not-listed", true, "new:google")).rejects.toThrow("Choose a model");
  await expect(f.connection.save(KEY, "gemini-test-flash", true, "provider")).rejects.toThrow("provider changed");
  expect(readFileSync(f.configPath, "utf8")).toBe(before);
});

test("cancelling a pending save during its final probe leaves configuration untouched", async () => {
  const f = fixture(), ready = Promise.withResolvers<void>(), delayed = Promise.withResolvers<Response>();
  const connection = new GoogleAIConnection({ configPath: f.configPath, fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body?.messages?.length === 3) { ready.resolve(); return delayed.promise; }
    return f.fake(url, init);
  }) as typeof fetch });
  const saving = connection.save(KEY, "gemini-test-flash", true, "new:google");
  await ready.promise;
  connection.cancel();
  delayed.resolve(stream({ content: "OK" }, "stop"));
  await expect(saving).rejects.toThrow("cancelled");
  expect(readdirSync(f.root)).toEqual([]);
});

test("backup cleanup failure reports committed save/removal so the host can still reload", async () => {
  const f = fixture();
  updateUserConfig(f.configPath, { provider: { id: "Local", model: "local-model" } });
  const connection = new GoogleAIConnection({ configPath: f.configPath, fetch: f.fake, scrubBackup: () => { throw new Error(KEY); } });
  const saved = await connection.save(KEY, "gemini-test-flash", true, "new:google");
  expect(saved.warning).toContain("key was saved");
  expect(saved.warning).toContain("backup");
  expect(JSON.stringify(saved)).not.toContain(KEY);
  const accounts = new ProviderAccounts({ configPath: f.configPath, dataDirectory: f.root, open: async () => {}, scrubGoogleBackup: () => { throw new Error(KEY); } });
  const removed = await accounts.signOut("google");
  expect(removed.warning).toContain("removed from active configuration");
  expect(removed.warning).toContain("backup");
  expect(JSON.stringify(removed)).not.toContain(KEY);
  const config = loadConfig({ userConfigPath: f.configPath, includeProject: false, env: {} }).config;
  expect(config.additionalProviders?.google?.apiKey).toBeUndefined();
  expect(readFileSync(`${f.configPath}.bak`, "utf8")).toContain(KEY); // warning is truthful
});
test("an unexpected failure names its step and cause without the key", async () => {
  const f = fixture();
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/chat/completions"))
      return new Response(`data: ${JSON.stringify({ error: { message: `Thought signature missing for ${KEY}` } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    return f.fake(input, init);
  }) as unknown as typeof fetch;
  const connection = new GoogleAIConnection({ configPath: f.configPath, fetch: fake });
  const error = await connection.save(KEY, "gemini-test-flash", true, "new:google").catch(error => String(error));
  expect(error).toContain("testing a tool call");
  expect(error).toContain("Thought signature missing");
  expect(error).not.toContain(KEY);
  expect(error).not.toContain("network");
  expect(existsSync(f.configPath)).toBe(false);
});

test("a tool call that finishes with stop still passes", async () => {
  const f = fixture();
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body?.messages?.length === 1)
      return stream({ tool_calls: [{ id: "call-test", function: { name: "connection_check", arguments: '{"value":"ready"}' } }] }, "stop");
    return f.fake(input, init);
  }) as unknown as typeof fetch;
  const connection = new GoogleAIConnection({ configPath: f.configPath, fetch: fake });
  expect((await connection.test(KEY, "gemini-test-flash")).message).toContain("passed");
});
