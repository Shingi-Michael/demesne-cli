/// What a provider by key is asked so that it caches a chat: a key that keeps
/// the chat on one machine, and for the models that do not cache by
/// themselves, the ask itself (docs/caching.md, "Every provider").
import { expect, test } from "bun:test";
import { markForCache, OpenAICompatibleProvider, openRouterCacheAsk, type ProviderMessage } from "../src/index.ts";

const CHAT: ProviderMessage[] = [
  { role: "system", content: "Be careful." },
  { role: "user", content: "Read the file." },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
  { role: "tool", toolCallId: "c1", content: "the file" },
];

/// Sends one request and returns each body the provider posted.
async function bodies(baseUrl: string, model: string, answer: (body: Record<string, unknown>, sent: number) => Response = () => new Response("data: [DONE]\n\n"),
  provider?: OpenAICompatibleProvider, cacheKey: string | undefined = "chat-1") {
  const sent: Record<string, unknown>[] = [];
  provider ??= new OpenAICompatibleProvider({ baseUrl, fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return answer(sent.at(-1)!, sent.length);
  }) as unknown as typeof fetch });
  for await (const _event of provider.stream({ model, messages: CHAT, ...(cacheKey ? { cacheKey } : {}) }, new AbortController().signal)) { /* consume */ }
  return { sent, provider };
}

test("which OpenRouter models must be asked to cache", () => {
  expect(openRouterCacheAsk("anthropic/claude-sonnet-5")).toBe("top");
  expect(["qwen/qwen3-coder-plus", "qwen/qwen3.6-plus:nitro", "deepseek/deepseek-v3.2"].map(openRouterCacheAsk)).toEqual(["marks", "marks", "marks"]);
  // These cache by themselves, and dated Qwen snapshots do not take the marks.
  expect(["openai/gpt-6", "google/gemini-3-pro", "qwen/qwen3.5-plus-02-15", "qwen/qwen3-coder-plus-extra", "x-ai/grok-5"].map(openRouterCacheAsk)).toEqual([null, null, null, null, null]);
});

test("OpenRouter gets the chat's key so the chat stays on the provider that holds its cache", async () => {
  const { sent } = await bodies("https://openrouter.ai/api/v1", "openai/gpt-6");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.session_id).toBe("chat-1");
  expect(sent[0]).not.toHaveProperty("cache_control");
  expect((sent[0]!.messages as { content: unknown }[]).every((message) => typeof message.content === "string")).toBe(true);
  // No key, no field; and a model on your own machine is never sent one.
  expect((await bodies("https://openrouter.ai/api/v1", "openai/gpt-6", undefined, undefined, "")).sent[0]).not.toHaveProperty("session_id");
  expect((await bodies("http://localhost:8081/v1", "qwen3.8-27b")).sent[0]).not.toHaveProperty("session_id");
});

test("Claude on OpenRouter is asked with one field at the top; its messages are left as they are", async () => {
  const { sent } = await bodies("https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5");
  expect(sent[0]!.cache_control).toEqual({ type: "ephemeral" });
  expect(sent[0]!.session_id).toBe("chat-1");
  expect((sent[0]!.messages as { content: unknown }[])[0]!.content).toBe("Be careful.");
});

test("Qwen on OpenRouter gets its instructions and its newest message marked", async () => {
  const { sent } = await bodies("https://openrouter.ai/api/v1", "qwen/qwen3-coder-plus");
  const messages = sent[0]!.messages as Record<string, unknown>[];
  expect(sent[0]).not.toHaveProperty("cache_control");
  expect(messages[0]!.content).toEqual([{ type: "text", text: "Be careful.", cache_control: { type: "ephemeral" } }]);
  expect(messages[1]!.content).toBe("Read the file.");
  expect(messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "the file", cache_control: { type: "ephemeral" } }] });
});

test("the mark moves to the newest message, and never onto one without text", () => {
  const marks = (messages: Record<string, unknown>[]) => markForCache(messages).map((message) => Array.isArray(message.content));
  expect(marks([{ role: "system", content: "S" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }])).toEqual([true, true, false]);
  expect(marks([{ role: "system", content: "S" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }])).toEqual([true, false, false, true]);
  // A message that is only pictures is already in parts, and an empty one has nothing to mark.
  const pictures = [{ role: "user", content: "a" }, { role: "tool", content: "" }, { role: "user", content: [{ type: "text", text: "A picture" }] }];
  expect(markForCache(pictures)[0]!.content).toEqual([{ type: "text", text: "a", cache_control: { type: "ephemeral" } }]);
  expect(markForCache(pictures).slice(1)).toEqual(pictures.slice(1));
});

test("a model that refuses the ask is sent the same request without it, and is not asked again", async () => {
  const refuse = (body: Record<string, unknown>) => body.cache_control
    ? Response.json({ error: { message: "Unknown field cache_control", code: 400 } }, { status: 400 }) : new Response("data: [DONE]\n\n");
  const first = await bodies("https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5", refuse);
  expect(first.sent.map((body) => "cache_control" in body)).toEqual([true, false]);
  // The key is not part of the ask: it stays.
  expect(first.sent[1]!.session_id).toBe("chat-1");
  const sent: Record<string, unknown>[] = [];
  const provider = new OpenAICompatibleProvider({ baseUrl: "https://openrouter.ai/api/v1", fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return refuse(sent.at(-1)!);
  }) as unknown as typeof fetch });
  for (let ask = 0; ask < 2; ask++) for await (const _event of provider.stream({ model: "anthropic/claude-sonnet-5", messages: CHAT, cacheKey: "chat-1" }, new AbortController().signal)) { /* consume */ }
  expect(sent.map((body) => "cache_control" in body)).toEqual([true, false, false]);
});

test("a request that fails with or without the ask reports its own error, and the model is still asked next time", async () => {
  const sent: Record<string, unknown>[] = [];
  let failing = true;
  const provider = new OpenAICompatibleProvider({ baseUrl: "https://openrouter.ai/api/v1", providerId: "OpenRouter", fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return failing ? Response.json({ error: { message: "Maximum context length exceeded", code: "context_length_exceeded" } }, { status: 400 }) : new Response("data: [DONE]\n\n");
  }) as unknown as typeof fetch });
  const run = async () => { for await (const _event of provider.stream({ model: "anthropic/claude-sonnet-5", messages: CHAT, cacheKey: "chat-1" }, new AbortController().signal)) { /* consume */ } };
  await expect(run()).rejects.toMatchObject({ status: 400, code: "context_length_exceeded" });
  expect(sent.map((body) => "cache_control" in body)).toEqual([true, false]);
  failing = false;
  await run();
  expect("cache_control" in sent[2]!).toBe(true);
});

test("OpenAI by key gets the chat's key; other providers by key are sent nothing new", async () => {
  expect((await bodies("https://api.openai.com/v1", "gpt-5.4")).sent[0]!.prompt_cache_key).toBe("chat-1");
  // Longer than OpenAI takes: left out, not cut, so two chats never share one.
  expect((await bodies("https://api.openai.com/v1", "gpt-5.4", undefined, undefined, "k".repeat(65))).sent[0]).not.toHaveProperty("prompt_cache_key");
  const other = (await bodies("https://generativelanguage.googleapis.com/v1beta/openai", "gemini-3-pro")).sent[0]!;
  for (const field of ["prompt_cache_key", "session_id", "cache_control"]) expect(other).not.toHaveProperty(field);
});
