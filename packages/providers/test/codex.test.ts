import { expect, test } from "bun:test";
import { CodexProvider, type ProviderRequest } from "../src/index.ts";
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
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.164.0");
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
  expect(bodies[0]).toEqual({ model: "gpt-6.1-sol", store: false, stream: true, instructions: "Be helpful", tool_choice: "auto", parallel_tool_calls: true, prompt_cache_key: "session-1",
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
