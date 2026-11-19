import { expect, test } from "bun:test";
import { CACHE_LIFE_MS, CodexProvider, isOwnMachine, keepsCacheLong, type ProviderRequest } from "../src/index.ts";
import { reasoning, responseStream, tool } from "./chatgpt-fixture.ts";

const request: ProviderRequest = { model: "codex/gpt-6.1-sol", cacheKey: "session-1", messages: [{ role: "system", content: "Be helpful" }, { role: "user", content: "Inspect input.txt" }],
  tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] };
const { namespace: _namespace, ...codexTool } = tool;
/// Codex's backend sends function calls without a namespace.
function codexStream(options: Parameters<typeof responseStream>[0] = {}) {
  const text = responseStream(options);
  return (async () => new Response((await text.text()).replaceAll(',"namespace":"demesne"', ""), { headers: { "Content-Type": "text/event-stream", "x-codex-primary-used-percent": "12", "x-codex-plan-type": "pro" } }))();
}
const collect = async (p: CodexProvider, r = request) => Array.fromAsync(p.stream(r, new AbortController().signal));

test("lists Codex's catalog under codex/ ids with its thinking levels", async () => {
  const p = new CodexProvider({ accountId: "acct-1", accessToken: async () => "access", fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.170.0");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access");
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("acct-1");
    return Response.json({ models: [
      { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", context_window: 272_000, default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }] },
      { slug: "codex-auto-review", visibility: "hide" },
    ] });
  }) as unknown as typeof fetch });
  expect(await p.listModels()).toEqual([{ id: "codex/gpt-6.1-sol", displayName: "GPT-6.1-Sol", provider: "Codex", contextWindow: 272_000, maxOutputTokens: undefined, reasoningLevels: ["low", "high", "xhigh"], defaultReasoningLevel: "low" }]);
});

test("sends the slug, Codex's headers, system text as instructions and plain function tools; keeps reasoning and plan usage", async () => {
  const bodies: Record<string, unknown>[] = [];
  const headers: Headers[] = [];
  const p = new CodexProvider({ accountId: "acct-1", accessToken: async () => "access", fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
    headers.push(new Headers(init?.headers)); bodies.push(JSON.parse(String(init?.body)));
    return codexStream({ tool: bodies.length === 1 });
  }) as unknown as typeof fetch });
  const first = await collect(p);
  expect(headers[0]!.get("chatgpt-account-id")).toBe("acct-1"); expect(headers[0]!.get("session_id")).toBe("session-1"); expect(headers[0]!.get("originator")).toBe("codex_cli_rs");
  expect(bodies[0]).toEqual({ model: "gpt-6.1-sol", store: false, stream: true, instructions: "Be helpful", tool_choice: "auto", parallel_tool_calls: true, prompt_cache_key: "session-1", prompt_cache_options: { ttl: "12h" },
    input: [{ role: "user", content: "Inspect input.txt" }], include: ["reasoning.encrypted_content"],
    tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: request.tools![0]!.inputSchema, strict: false }] });
  expect(first.find(e => e.type === "tool_call_delta")).toMatchObject({ nameDelta: "read_file", idDelta: "call_1" });
  expect(first.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
  const state = first.find(e => e.type === "response_state");
  expect(state).toMatchObject({ state: { accountId: "acct-1", model: "codex/gpt-6.1-sol", output: [reasoning, codexTool] } });
  expect(p.planLimits()).toMatchObject({ provider: "Codex", plan: "pro", primary: { usedPercent: 12 } });
  // The next round replays the retained output and the tool result, still without a namespace.
  await collect(p, { ...request, messages: [...request.messages, { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: tool.arguments }], responses: (state as { state: { accountId: string; model: string; output: Record<string, unknown>[] } }).state },
    { role: "tool", toolCallId: "call_1", content: "Tool result" }] });
  expect(bodies[1]!.input).toEqual([{ role: "user", content: "Inspect input.txt" }, reasoning, codexTool, { type: "function_call_output", call_id: "call_1", output: "Tool result" }]);
  expect(JSON.stringify(bodies[1])).not.toContain("namespace");
});

test("Codex's usage-limit error names the plan and Manage usage, and a namespaced call is rejected", async () => {
  const limited = new CodexProvider({ accountId: "acct-1", accessToken: async () => "access", fetch: (async () => Response.json({ error: { type: "usage_limit_reached", message: "do not echo", plan_type: "pro", resets_in_seconds: 600 } }, { status: 429 })) as unknown as typeof fetch });
  await expect(collect(limited)).rejects.toMatchObject({ code: "usage_limit_reached", status: 429, message: expect.stringContaining("Codex plan") });
  await expect(collect(limited)).rejects.not.toThrow(/do not echo/);
  const namespaced = new CodexProvider({ accountId: "acct-1", accessToken: async () => "access", fetch: (async () => responseStream({ tool: true })) as unknown as typeof fetch });
  await expect(collect(namespaced)).rejects.toThrow(/unknown tool call/);
});

test("tool calls whose arguments arrive whole, with no deltas, and several calls in one round", async () => {
  const call = (id: string, args: string) => ({ type: "function_call", id: `fc_${id}`, call_id: id, name: "read_file", arguments: args, status: "completed" });
  const a = call("call_a", '{"path": "a.txt"}'), b = call("call_b", '{"path":"b.txt"}');
  const events = [
    // Codex's route sent this call's arguments only in the done events.
    { type: "response.output_item.added", output_index: 0, item: { ...a, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: a.id, arguments: a.arguments },
    { type: "response.output_item.done", output_index: 0, item: a },
    // A streamed part, the rest only in output_item.done.
    { type: "response.output_item.added", output_index: 1, item: { ...b, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":' },
    { type: "response.output_item.done", output_index: 1, item: b },
    { type: "response.completed", response: { status: "completed", output: [a, b], usage: { input_tokens: 20, output_tokens: 15, total_tokens: 35 } } },
  ];
  const p = new CodexProvider({ accountId: "acct-1", accessToken: async () => "access", fetch: (async () => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch });
  const out = await collect(p);
  const args = new Map<number, string>();
  for (const e of out) if (e.type === "tool_call_delta") args.set(e.index, (args.get(e.index) ?? "") + e.argumentsDelta);
  expect([...args.entries()]).toEqual([[0, a.arguments], [1, b.arguments]]);
  expect(out.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
  // Done text that contradicts what was streamed is still refused.
  const bad = [events[3], { ...events[4], delta: '{"file":' }, events[5], events[6]];
  const q = new CodexProvider({ accountId: "acct-1", accessToken: async () => "access", fetch: (async () => new Response(bad.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch });
  await expect(collect(q)).rejects.toThrow("conflicting tool call data");
});

test("Codex's prefixed model uses medium by default on the wire, and honors an explicit effort", async () => {
  const bodies: Record<string, any>[] = [];
  const p = new CodexProvider({ accountId: "acct", accessToken: async () => "access", fetch: (async (url, init) => {
    if (String(url).includes("/models?")) return Response.json({ models: [{ slug: "gpt-6.1-sol", visibility: "list", supports_reasoning_summaries: true,
      supported_reasoning_levels: ["low", "medium", "high"].map(effort => ({ effort })) }] });
    bodies.push(JSON.parse(String(init?.body))); return codexStream();
  }) as typeof fetch });
  expect((await p.listModels())[0]?.defaultReasoningLevel).toBe("medium");
  await collect(p);
  await collect(p, { ...request, reasoningLevel: "low" });
  expect(bodies.map(body => body.reasoning)).toEqual([{ effort: "medium", summary: "auto" }, { effort: "low", summary: "auto" }]);
});

test("asks for the 12-hour cache, and stops asking on a route that refuses it", async () => {
  // A route that takes the option: asked every time, and the cache is said to live 12 hours.
  const taken: Record<string, unknown>[] = [];
  const takes = new CodexProvider({ accountId: "acct-1", accessToken: async () => "access", fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
    taken.push(JSON.parse(String(init?.body)));
    return codexStream();
  }) as unknown as typeof fetch });
  expect(takes.cacheLifeMs("codex/gpt-6.1-sol")).toBe(CACHE_LIFE_MS.gpt);
  await collect(takes); await collect(takes);
  expect(taken.map((body) => body.prompt_cache_options)).toEqual([{ ttl: "12h" }, { ttl: "12h" }]);
  expect(takes.cacheLifeMs("codex/gpt-6.1-sol")).toBe(CACHE_LIFE_MS.long);
  // Models from before the long lifetimes are not asked for it.
  expect(takes.cacheLifeMs("codex/gpt-5.2")).toBe(CACHE_LIFE_MS.short);

  // A route that refuses it: the same request goes out once more without, and it is not asked again.
  const refused: Record<string, unknown>[] = [];
  const refuses = new CodexProvider({ accountId: "acct-1", accessToken: async () => "access", fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    refused.push(body);
    return body.prompt_cache_options ? Response.json({ detail: "Unsupported parameter: prompt_cache_options" }, { status: 400 }) : codexStream();
  }) as unknown as typeof fetch });
  expect((await collect(refuses)).at(-1)).toEqual({ type: "finish", reason: "stop" });
  await collect(refuses);
  expect(refused.map((body) => "prompt_cache_options" in body)).toEqual([true, false, false]);
  expect(refuses.cacheLifeMs("codex/gpt-6.1-sol")).toBe(CACHE_LIFE_MS.gpt);

  // A failure that is not about the option is not retried, and nothing is concluded from it.
  let calls = 0;
  const full = new CodexProvider({ accountId: "acct-1", accessToken: async () => "access", fetch: (async () => {
    calls++;
    return Response.json({ error: { type: "usage_limit_reached" } }, { status: 429 });
  }) as unknown as typeof fetch });
  await expect(collect(full)).rejects.toThrow("usage limit");
  expect(calls).toBe(1);
});

test("which models keep a cache long, and which hosts are your own machine", () => {
  expect(["gpt-6.1-sol", "codex/gpt-6-astra", "openai/gpt-5.6", "gpt-5.10"].map(keepsCacheLong)).toEqual([true, true, true, true]);
  expect(["gpt-5.5", "gpt-5", "gpt-4.1", "claude-sonnet-5", "qwen3-coder", "my-gpt-6-clone"].map(keepsCacheLong)).toEqual([false, false, false, false, false, false]);
  expect(["localhost", "127.0.0.1", "192.168.1.20", "100.101.4.9", "studio.local", "10.0.0.3"].map(isOwnMachine)).toEqual([true, true, true, true, true, true]);
  expect(["openrouter.ai", "api.openai.com", "172.15.0.1", "100.128.0.1"].map(isOwnMachine)).toEqual([false, false, false, false]);
});

test("a route that refuses the 12-hour cache inside the stream is asked once, too", async () => {
  const bodies: Record<string, unknown>[] = [];
  const p = new CodexProvider({ accountId: "acct-1", accessToken: async () => "access", fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return body.prompt_cache_options
      ? new Response(`data: ${JSON.stringify({ type: "response.failed", response: { error: { code: "invalid_request_error", message: "Unknown parameter" } } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
      : codexStream();
  }) as unknown as typeof fetch });
  expect((await collect(p)).at(-1)).toEqual({ type: "finish", reason: "stop" });
  await collect(p);
  expect(bodies.map((body) => "prompt_cache_options" in body)).toEqual([true, false, false]);
});

test("an asking request that fails for no nameable reason can't keep failing", async () => {
  const bodies: Record<string, unknown>[] = [];
  const p = new CodexProvider({ accountId: "acct-1", accessToken: async () => "access", fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    // A route that takes the option and then never completes a response that carries it.
    return body.prompt_cache_options
      ? new Response(`data: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete" } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
      : codexStream();
  }) as unknown as typeof fetch });
  await expect(collect(p)).rejects.toThrow();
  // The next goes out without the option, the one after asks once more, and then never again.
  await collect(p);
  await expect(collect(p)).rejects.toThrow();
  await collect(p); await collect(p);
  expect(bodies.map((body) => "prompt_cache_options" in body)).toEqual([true, false, true, false, false]);
});
