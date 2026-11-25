import { expect, test } from "bun:test";
import { AnthropicProvider, isAnthropicEndpoint } from "../src/index.ts";

const model = "test-model";
const signal = new AbortController().signal;
function transport(fn: (r: Request) => Response | Promise<Response>) {
  return ((url, init) => fn(new Request(url, init))) as typeof fetch;
}
function sse(events: { type: string; [key: string]: unknown }[]) {
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("native tool round-trip, moving cache breakpoint and inclusive usage", async () => {
  const provider = new AnthropicProvider("test-key", "Claude", transport(async r => {
    expect(r.url).toBe("https://api.anthropic.com/v1/messages");
    expect(r.headers.get("authorization")).toBe("Bearer test-key");
    const body = await r.json();
    expect(body.cache_control).toEqual({type:"ephemeral"});
    expect(body.system).toEqual([{type:"text",text:"Stable"}]);
    expect(body.tools[0].input_schema.type).toBe("object");
    expect(body.messages[1].content[0]).toEqual({type:"tool_use", id:"a", name:"look", input:{}});
    expect(body.messages[2].content[0]).toEqual({type:"tool_result", tool_use_id:"a", content:"ok"});
    return sse([{type:"message_start",message:{usage:{input_tokens:4,cache_creation_input_tokens:32,cache_read_input_tokens:100,output_tokens:1}}},
      {type:"content_block_delta",index:0,delta:{type:"text_delta",text:"hello"}},
      {type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:7}}, {type:"message_stop"}]);
  }));
  const events = [];
  for await (const e of provider.stream({ model, tools:[{name:"look",description:"inspect",inputSchema:{type:"object"}}],messages:[{role:"system",content:"Stable"},{role:"user",content:"check"},{role:"assistant",content:null,toolCalls:[{id:"a",name:"look",arguments:"{}"}]},{role:"tool",toolCallId:"a",content:"ok"}] }, signal)) events.push(e);
  expect(events).toEqual([{type:"text_delta",delta:"hello"},{type:"usage",usage:{inputTokens:136,cachedInputTokens:100,cacheWriteTokens:32,outputTokens:7,totalTokens:143}},{type:"finish",reason:"stop"}]);
});

test("discovers models only at the native endpoint", async () => {
  expect(isAnthropicEndpoint("https://api.anthropic.com/v1/")).toBe(true);
  expect(isAnthropicEndpoint("https://api.anthropic.com.example/v1")).toBe(false);
  const provider = new AnthropicProvider("test", "Claude", transport(r => {
    expect(new URL(r.url).pathname).toBe("/v1/models");
    return Response.json({data:[{id:model}],has_more:false});
  }));
  expect(await provider.listModels(signal)).toEqual([{id:model,provider:"Claude"}]);
});

test("truncated stream does not report success", async () => {
  const provider = new AnthropicProvider("test", "Claude", transport(() => sse([{type:"ping"}])));
  expect(async () => { for await (const _ of provider.stream({model,messages:[{role:"user",content:"hello"}]},signal)) {} }).toThrow("message_stop");
});

const yes = { supported: true }, no = { supported: false };
const caps = (effort: Record<string, unknown> | null, types: Record<string, unknown>) => ({
  effort: effort ? { supported: true, low: yes, medium: yes, high: yes, max: no, xhigh: null, ...effort } : { supported: false, low: no, medium: no, high: no, max: no, xhigh: null },
  thinking: { supported: true, types: { adaptive: no, enabled: no, disabled: no, between_tools: no, ...types } },
});
const listed = (data: unknown[]) => transport(r => new URL(r.url).pathname === "/v1/models" ? Response.json({ data, has_more: false }) : new Response("unexpected", { status: 500 }));

test("models list their thinking levels from Claude's capabilities", async () => {
  const provider = new AnthropicProvider("test", "Claude", listed([
    { id: "claude-opus-5", capabilities: caps({ max: yes, xhigh: yes }, { adaptive: yes, disabled: yes }) },
    { id: "claude-sonnet-4-5", capabilities: caps(null, { enabled: yes, disabled: yes }) },
    { id: "claude-3-haiku", capabilities: { effort: { supported: false }, thinking: { supported: false, types: { adaptive: no, enabled: no, disabled: no } } } },
    { id: "claude-unknown", capabilities: null },
  ]));
  expect(await provider.listModels(signal)).toEqual([
    { id: "claude-opus-5", provider: "Claude", reasoningLevels: ["off", "low", "medium", "high", "xhigh", "max"], defaultReasoningLevel: "medium" },
    { id: "claude-sonnet-4-5", provider: "Claude", reasoningLevels: ["off", "low", "medium", "high"], defaultReasoningLevel: "medium" },
    { id: "claude-3-haiku", provider: "Claude" },
    { id: "claude-unknown", provider: "Claude" },
  ]);
});

async function sent(capabilities: unknown, request: Partial<Parameters<AnthropicProvider["stream"]>[0]>, reply: { type: string; [key: string]: unknown }[] = []) {
  let body: Record<string, any> = {};
  const provider = new AnthropicProvider("test", "Claude", transport(async r => {
    if (new URL(r.url).pathname === "/v1/models") return Response.json({ data: [{ id: model, capabilities }], has_more: false });
    body = await r.json();
    return sse([{ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } }, ...reply, { type: "message_delta", delta: { stop_reason: reply.some(e => (e.content_block as any)?.type === "tool_use") ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } }, { type: "message_stop" }]);
  }));
  await provider.listModels(signal);
  const events = [];
  for await (const e of provider.stream({ model, messages: [{ role: "user", content: "hi" }], ...request }, signal)) events.push(e);
  return { body, events };
}

test("a chosen level becomes adaptive thinking with that effort, and the thinking streams", async () => {
  const { body, events } = await sent(caps({ max: yes }, { adaptive: yes, disabled: yes }), { reasoningLevel: "high" }, [
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Weighing it." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } },
  ]);
  expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  expect(body.output_config).toEqual({ effort: "high" });
  expect(body.max_tokens).toBe(32000);
  expect(events.slice(0, 2)).toEqual([{ type: "reasoning_delta", delta: "Weighing it." }, { type: "text_delta", delta: "Done." }]);
});

test("off turns thinking off; an older model thinks by budget; a model without thinking sends nothing", async () => {
  const off = await sent(caps(null, { adaptive: yes, disabled: yes }), { reasoningLevel: "off" });
  expect(off.body.thinking).toEqual({ type: "disabled" });
  expect(off.body.output_config).toBeUndefined();
  const budget = await sent(caps(null, { enabled: yes, disabled: yes }), { reasoningLevel: "high" });
  expect(budget.body.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
  expect(budget.body.max_tokens).toBe(16384 + 8192);
  const none = await sent(null, { reasoningLevel: "high" });
  expect(none.body.thinking).toBeUndefined();
  expect(none.body.output_config).toBeUndefined();
  expect(none.body.max_tokens).toBe(4096);
});

test("thinking in a tool loop goes back to Claude with its signature", async () => {
  const first = await sent(caps(null, { adaptive: yes, disabled: yes }), { reasoningLevel: "medium" }, [
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Look first." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "look", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
  ]);
  const call = first.events.find((e) => e.type === "tool_call_delta" && e.idDelta === "t1") as { extra?: unknown };
  expect(call.extra).toEqual({ anthropicThinking: [{ type: "thinking", thinking: "Look first.", signature: "sig-1" }] });
  const second = await sent(caps(null, { adaptive: yes, disabled: yes }), { reasoningLevel: "medium", messages: [
    { role: "user", content: "check" },
    { role: "assistant", content: null, toolCalls: [{ id: "t1", name: "look", arguments: "{}", extra: call.extra }] },
    { role: "tool", toolCallId: "t1", content: "ok" },
  ] });
  expect(second.body.messages[1].content).toEqual([
    { type: "thinking", thinking: "Look first.", signature: "sig-1" },
    { type: "tool_use", id: "t1", name: "look", input: {} },
  ]);
});

test("a level chosen before the list loaded looks the model up once", async () => {
  const asked: string[] = [];
  let body: Record<string, any> = {};
  const provider = new AnthropicProvider("test", "Claude", transport(async r => {
    const path = new URL(r.url).pathname;
    asked.push(path);
    if (path === `/v1/models/${model}`) return Response.json({ id: model, capabilities: caps({}, { adaptive: yes, disabled: yes }) });
    body = await r.json();
    return sse([{ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }]);
  }));
  for (let i = 0; i < 2; i++) for await (const _ of provider.stream({ model, messages: [{ role: "user", content: "hi" }], reasoningLevel: "low" }, signal)) {}
  expect(body.output_config).toEqual({ effort: "low" });
  expect(asked.filter((path) => path === `/v1/models/${model}`)).toHaveLength(1);
});
