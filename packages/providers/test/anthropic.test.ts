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
