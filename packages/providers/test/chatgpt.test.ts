import { expect, test } from "bun:test";
import { ChatGPTProvider, type ProviderRequest, type ProviderStreamEvent } from "../src/index.ts";
import { reasoning, tool, responseStream } from "./chatgpt-fixture.ts";
const request: ProviderRequest = { model: "model-fixture", messages: [{ role: "system", content: "Be helpful" }, { role: "user", content: "Inspect input.txt" }], tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }], maxOutputTokens: 42, temperature: 0.5, seed: 1 };
const collect = async (p: ChatGPTProvider, r = request) => Array.fromAsync(p.stream(r, new AbortController().signal));

test("uses the account catalog's order, visibility, slugs and display names", async () => {
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.openai.com/v1/models"); expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access"); expect(init?.redirect).toBe("manual");
    return Response.json({ models: [{ slug: "first", display_name: "First", visibility: "list" }, { slug: "hidden", visibility: "hide" }, { slug: "second", display_name: "Second", visibility: "list", context_window: 65536 }, { slug: "first", visibility: "list" }] });
  }) as unknown as typeof fetch });
  expect((await p.listModels()).map(m => [m.id, m.displayName])).toEqual([["first", "First"], ["second", "Second"]]);
});

test("only explicitly configured Sol is retained when omitted, with no inference during discovery", async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    calls.push(String(url));
    expect(String(url)).toBe("https://api.openai.com/v1/models");
    return Response.json({ models: [{ slug: "first", display_name: "First", visibility: "list" }, { slug: "second", visibility: "list" }] });
  }) as unknown as typeof fetch;
  for (const configuredModel of [undefined, "gpt-6-sol", "some-model", "gpt-6.1-sol"]) {
    const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", configuredModel, fetch: fetcher });
    const models = await p.listModels();
    expect(models.map(model => model.id)).toEqual(configuredModel === "gpt-6.1-sol" ? ["first", "second", "gpt-6.1-sol"] : ["first", "second"]);
    if (configuredModel === "gpt-6.1-sol") expect(models[2]).toEqual({ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", provider: "ChatGPT", contextWindow: 1_050_000, maxOutputTokens: 128_000,
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"], defaultReasoningLevel: "medium" });
  }
  expect(calls).toHaveLength(4);
});

test("a listed Sol keeps the account's display name, metadata and position", async () => {
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", configuredModel: "gpt-6.1-sol", fetch: (async () => Response.json({ models: [
    { slug: "first", visibility: "list" },
    { slug: "gpt-6.1-sol", visibility: "list", display_name: "Sol for this account", context_window: 272_000, max_output_tokens: 32_768,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "high" },
    { slug: "last", visibility: "list" },
  ] })) as unknown as typeof fetch });
  const models = await p.listModels();
  expect(models.map(model => model.id)).toEqual(["first", "gpt-6.1-sol", "last"]);
  expect(models[1]).toEqual({ id: "gpt-6.1-sol", displayName: "Sol for this account", provider: "ChatGPT", contextWindow: 272_000, maxOutputTokens: 32_768,
    reasoningLevels: ["low", "high"], defaultReasoningLevel: "high" });
});

test("explicit Sol verification requires completed inference and caches only this provider instance", async () => {
  const bodies: Record<string, unknown>[] = [];
  const signal = new AbortController().signal;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return Response.json({ models: [{ slug: "first", visibility: "list" }] });
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(init?.signal).toBe(signal);
    bodies.push(JSON.parse(String(init?.body)));
    return responseStream({ model: "gpt-6.1-sol" });
  }) as unknown as typeof fetch;
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: fetcher });
  expect((await p.listModels()).map(model => model.id)).toEqual(["first"]);
  const verified = await p.verifyModel("gpt-6.1-sol", signal);
  expect(verified).toMatchObject({ id: "gpt-6.1-sol", provider: "ChatGPT", contextWindow: 1_050_000 });
  expect(bodies).toEqual([{ model: "gpt-6.1-sol", store: false, stream: true, reasoning: { effort: "low" },
    input: [{ role: "user", content: "Reply exactly: OK." }], include: ["reasoning.encrypted_content"] }]);
  // A cached verification is copied, so callers cannot mutate later discovery.
  verified.reasoningLevels!.push("ultra");
  expect((await p.verifyModel("gpt-6.1-sol", signal)).reasoningLevels).not.toContain("ultra");
  expect(bodies).toHaveLength(1);
  expect((await p.listModels()).map(model => model.id)).toEqual(["first", "gpt-6.1-sol"]);
  const other = new ChatGPTProvider({ accountId: "b", accessToken: async () => "other-access", fetch: fetcher });
  expect((await other.listModels()).map(model => model.id)).toEqual(["first"]);
});

test.each(["missing-model", "different-model", "incomplete", "invalid-terminal", "failed", "interrupted"] as const)("Sol verification does not cache %s responses", async failure => {
  let attempts = 0;
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: (async (url: string | URL | Request) => {
    if (String(url).endsWith("/models")) return Response.json({ models: [] });
    attempts++;
    if (failure === "incomplete") return new Response(`data: ${JSON.stringify({ type: "response.incomplete", response: { model: "gpt-6.1-sol", status: "incomplete" } })}\n\n`);
    if (failure === "invalid-terminal") return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-6.1-sol", status: "incomplete", output: [] } })}\n\n`);
    return responseStream({ ...(failure === "missing-model" ? {} : { model: failure === "different-model" ? "gpt-6-sol" : "gpt-6.1-sol" }),
      ...(failure === "failed" ? { failure: "subscription_sharing_usage_unavailable" } : {}), ...(failure === "interrupted" ? { complete: false } : {}) });
  }) as unknown as typeof fetch });
  await expect(p.verifyModel("gpt-6.1-sol")).rejects.toThrow();
  expect(await p.listModels()).toEqual([]);
  await expect(p.verifyModel("gpt-6.1-sol")).rejects.toThrow();
  expect(attempts).toBe(2);
});

test("unlisted unsupported model IDs are not probed and invalid Sol efforts never reach inference", async () => {
  let calls = 0;
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: (async () => { calls++; return responseStream({ model: "gpt-6.1-sol" }); }) as unknown as typeof fetch });
  await expect(p.verifyModel("gpt-6-sol")).rejects.toThrow("only gpt-6.1-sol");
  for (const reasoningLevel of ["ultra", "none", "minimal"]) await expect(collect(p, { model: "gpt-6.1-sol", messages: [], reasoningLevel })).rejects.toThrow(`does not support the ${reasoningLevel} reasoning effort`);
  expect(calls).toBe(0);
  await collect(p, { model: "gpt-6.1-sol", messages: [], reasoningLevel: "max" });
  expect(calls).toBe(1);
});

test("configured Sol never asks for a reasoning summary without current catalog support", async () => {
  const bodies: Record<string, unknown>[] = [];
  let catalogCalls = 0;
  const p = new ChatGPTProvider({ accountId: "a", configuredModel: "gpt-6.1-sol", accessToken: async () => "access", fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return Response.json({ models: catalogCalls++ === 0 ? [{ slug: "gpt-6.1-sol", visibility: "list", supports_reasoning_summaries: true }] : [] });
    bodies.push(JSON.parse(String(init?.body))); return responseStream({ model: "gpt-6.1-sol" });
  }) as unknown as typeof fetch });
  await p.listModels();
  await collect(p, { model: "gpt-6.1-sol", messages: [], reasoningLevel: "medium" });
  expect(bodies[0].reasoning).toEqual({ effort: "medium", summary: "auto" });
  await p.listModels();
  await collect(p, { model: "gpt-6.1-sol", messages: [], reasoningLevel: "medium" });
  expect(bodies[1].reasoning).toEqual({ effort: "medium" });
});

test("reasoning summary parts stream as separate paragraphs of thinking", async () => {
  const message = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] };
  const events = [
    { type: "response.reasoning_summary_part.added", summary_index: 0 }, { type: "response.reasoning_summary_text.delta", delta: "**Enumerating candidates**" },
    { type: "response.reasoning_summary_part.added", summary_index: 1 }, { type: "response.reasoning_summary_text.delta", delta: "**Checking the bound**" },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", delta: "Done." }, { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: (async () => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""))) as unknown as typeof fetch });
  const thinking = (await collect(p)).filter((e): e is Extract<ProviderStreamEvent, { type: "reasoning_delta" }> => e.type === "reasoning_delta").map(e => e.delta).join("");
  expect(thinking).toBe("**Enumerating candidates**\n\n**Checking the bound**");
  const hidden = await Array.fromAsync(p.stream({ ...request, thinkingEnabled: false }, new AbortController().signal));
  expect(hidden.some(e => e.type === "reasoning_delta")).toBe(false);
});

test("the catalog's thinking levels are listed, and a chosen level is sent with a reasoning summary", async () => {
  const bodies: any[] = [];
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return Response.json({ models: [
      { slug: "astra", visibility: "list", supports_reasoning_summaries: true, default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }] },
      { slug: "plain", visibility: "list" }] });
    bodies.push(JSON.parse(String(init?.body))); return responseStream();
  }) as unknown as typeof fetch });
  const models = await p.listModels();
  expect(models[0]).toMatchObject({ id: "astra", reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium" });
  expect(models[1]).not.toHaveProperty("reasoningLevels");
  await collect(p, { ...request, model: "astra", reasoningLevel: "xhigh" });
  expect(bodies[0].reasoning).toEqual({ effort: "xhigh", summary: "auto" });
  await collect(p, { ...request, model: "astra" });
  expect(bodies[1].reasoning).toEqual({ summary: "auto" });
  await collect(p, { ...request, model: "plain" });
  expect(bodies[2]).not.toHaveProperty("reasoning");
});

test.each([
  ["full", "model-fixture"], ["empty", "model-fixture"], ["full", "gpt-6.1-sol"], ["empty", "gpt-6.1-sol"],
] as const)("Responses request preserves streamed tools and reasoning with %s terminal output for %s", async (terminalOutput, model) => {
  const initial = { ...request, model };
  const bodies: any[] = [];
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.openai.com/v1/responses"); expect(init?.redirect).toBe("manual"); bodies.push(JSON.parse(String(init?.body))); return responseStream({ model, tool: bodies.length === 1, terminalOutput });
  }) as unknown as typeof fetch });
  const events = await collect(p, initial); const state = events.find((e): e is Extract<ProviderStreamEvent, { type: "response_state" }> => e.type === "response_state")!.state;
  expect(bodies[0].store).toBe(false); expect(bodies[0].stream).toBe(true); expect(bodies[0].input[0].role).toBe("developer");
  expect(bodies[0].tools[0]).toMatchObject({ type: "namespace", name: "demesne", tools: [{ type: "function", name: "read_file", strict: false }] });
  for (const field of ["max_output_tokens", "max_tokens", "temperature", "seed", "previous_response_id", "metadata"]) expect(bodies[0]).not.toHaveProperty(field);
  expect(events.filter(e => e.type === "tool_call_delta").map(e => e.index)).toEqual([0, 0]);
  expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
  const next: ProviderRequest = { ...initial, messages: [...initial.messages, { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "read_file", arguments: tool.arguments }], responses: state }, { role: "tool", toolCallId: "call_1", content: "file content" }] };
  expect(bodies[0]).not.toHaveProperty("prompt_cache_key");
  // Tool rounds of one conversation share a cache key, so the prefix is reused.
  await collect(p, { ...next, cacheKey: "session-1" });
  expect(bodies[1].prompt_cache_key).toBe("session-1");
  expect(bodies[1].input).toContainEqual(reasoning); expect(bodies[1].input).toContainEqual(tool); expect(bodies[1].input.at(-1)).toEqual({ type: "function_call_output", call_id: "call_1", output: "file content" });
  await collect(p, { ...next, model: "other-model" }); expect(JSON.stringify(bodies[2])).not.toContain("opaque-reasoning");
  const other = new ChatGPTProvider({ accountId: "b", accessToken: async () => "other", fetch: (async (_url: string | URL | Request, init?: RequestInit) => { expect(String(init?.body)).not.toContain("opaque-reasoning"); return responseStream({ model }); }) as unknown as typeof fetch });
  await collect(other, next);
});

test("interrupted streams never emit successful finish", async () => {
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: (async () => responseStream({ tool: true, complete: false })) as unknown as typeof fetch });
  const events: ProviderStreamEvent[] = [];
  await expect((async () => { for await (const event of p.stream(request, new AbortController().signal)) events.push(event); })()).rejects.toThrow("before response.completed");
  expect(events.some(e => e.type === "finish" || e.type === "response_state")).toBe(false);
});

test("late usage-limit errors offer Manage usage and do not replay the request", async () => {
  let calls = 0;
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: (async () => { calls++; return responseStream({ failure: "subscription_sharing_usage_limit_exceeded" }); }) as unknown as typeof fetch });
  await expect(collect(p)).rejects.toThrow("https://chatgpt.com/settings/usage"); expect(calls).toBe(1);
});

test("OAuth detail-only errors and redirects cannot leak bearer credentials", async () => {
  for (const status of [401, 302]) {
    const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "secret", fetch: (async () => Response.json({ detail: "Authorization: Bearer secret" }, { status, headers: { Location: "https://elsewhere.example" } })) as unknown as typeof fetch });
    try { await collect(p); throw new Error("expected failure"); } catch (error) { expect(String(error)).toContain(String(status)); expect(String(error)).not.toContain("secret"); }
  }
});

test("unknown namespaces and conflicting completed calls are rejected", async () => {
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: (async () => new Response(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...tool, namespace: "other" } })}\n\n`)) as unknown as typeof fetch });
  await expect(collect(p)).rejects.toThrow("unknown tool call");
});

test("empty terminal output retains completed assistant text for the next turn", async () => {
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: (async () => responseStream({ terminalOutput: "empty" })) as unknown as typeof fetch });
  const events = await collect(p);
  const state = events.find((e): e is Extract<ProviderStreamEvent, { type: "response_state" }> => e.type === "response_state")!.state;
  expect(state.output).toMatchObject([{ type: "message", content: [{ type: "output_text", text: "File inspected." }] }]);
  expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
});

for (const invalid of ["missing-done", "unfinished", "changed-arguments", "changed-identity", "duplicate-done"] as const) test(`empty terminal output still rejects ${invalid} tool items`, async () => {
  const events: unknown[] = [
    { type: "response.output_item.added", output_index: 0, item: { ...tool, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: tool.arguments },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: tool.id, arguments: tool.arguments },
  ];
  const done = { type: "response.output_item.done", output_index: 0, item: { ...tool,
    ...(invalid === "unfinished" ? { status: "in_progress" } : {}),
    ...(invalid === "changed-arguments" ? { arguments: '{"path":"other.txt"}' } : {}),
    ...(invalid === "changed-identity" ? { id: "fc_other" } : {}),
  } };
  if (invalid !== "missing-done") events.push(done);
  if (invalid === "duplicate-done") events.push(done);
  events.push({ type: "response.completed", response: { status: "completed", output: [] } });
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: (async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))) as unknown as typeof fetch });
  const seen: ProviderStreamEvent[] = [];
  await expect((async () => { for await (const e of p.stream(request, new AbortController().signal)) seen.push(e); })()).rejects.toThrow();
  expect(seen.some(e => e.type === "response_state" || e.type === "finish")).toBe(false);
});

test("completed items retain output-index order even if completion events are interleaved", async () => {
  const second = { ...tool, id: "fc_2", call_id: "call_2", arguments: '{"path":"second.txt"}' };
  const events: unknown[] = [
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: null } },
    { type: "response.output_item.added", output_index: 1, item: { ...tool, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: tool.arguments },
    { type: "response.output_item.added", output_index: 2, item: { ...second, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 2, delta: second.arguments },
    { type: "response.output_item.done", output_index: 2, item: second },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.done", output_index: 1, item: tool },
    { type: "response.completed", response: { status: "completed", output: [] } },
  ];
  const p = new ChatGPTProvider({ accountId: "a", accessToken: async () => "access", fetch: (async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))) as unknown as typeof fetch });
  const result = await collect(p);
  expect(result.find(e => e.type === "response_state")?.state.output).toEqual([reasoning, tool, second]);
  expect(result.flatMap(e => e.type === "tool_call_delta" && e.idDelta ? [e.idDelta] : [])).toEqual([tool.call_id, second.call_id]);
});
