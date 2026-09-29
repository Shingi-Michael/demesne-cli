import { describe, expect, test } from "bun:test";
import { OpenAICompatibleProvider, ProviderError } from "../src/index.ts";

describe("OpenAICompatibleProvider", () => {
  test("discovers models and decodes streamed UTF-8 across chunk boundaries", async () => {
    let requestBody: unknown;
    let authorization: string | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        authorization = request.headers.get("authorization");
        if (url.pathname === "/v1/models") {
          return Response.json({ data: [{ id: "local-model", owned_by: "local", max_context_length: 32_768 }] });
        }
        if (url.pathname === "/v1/chat/completions") {
          requestBody = await request.json();
          const source = [
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "brief thought" } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: "hé" } }] })}\r\n\r\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: "llo" } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [], usage: {
              prompt_tokens: 4,
              completion_tokens: 2,
              total_tokens: 6,
              prompt_tokens_details: { cached_tokens: 3 },
            } })}\n\n`,
            "data: [DONE]\n\n",
          ].join("");
          const bytes = new TextEncoder().encode(source);
          const split = bytes.indexOf(0xc3) + 1;
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, split));
              controller.enqueue(bytes.slice(split, split + 7));
              controller.enqueue(bytes.slice(split + 7));
              controller.close();
            },
          }), { headers: { "Content-Type": "text/event-stream" } });
        }
        return new Response(null, { status: 404 });
      },
    });

    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: new URL("/v1/", server.url).href,
        apiKey: "secret",
        providerId: "lm-studio",
        reasoningEffort: "none",
      });
      const models = await provider.listModels();
      const events = [];
      for await (const event of provider.stream(
        {
          model: "local-model",
          messages: [{ role: "user", content: "Hello" }],
          maxOutputTokens: 128,
          temperature: 0,
          seed: 42,
        },
        new AbortController().signal,
      )) events.push(event);

      expect(models).toEqual([{
        id: "local-model",
        provider: "lm-studio",
        ownedBy: "local",
        contextWindow: 32_768,
      }]);
      expect(events).toEqual([
        { type: "reasoning_delta", delta: "brief thought" },
        { type: "text_delta", delta: "hé" },
        { type: "text_delta", delta: "llo" },
        { type: "finish", reason: "stop" },
        { type: "usage", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedInputTokens: 3 } },
      ]);
      expect(String(authorization)).toBe("Bearer secret");
      expect(requestBody).toEqual({
        model: "local-model",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
        reasoning_effort: "none",
        max_tokens: 128,
        temperature: 0,
        seed: 42,
        stream_options: { include_usage: true },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("prefers Ollama's loaded runtime context length", async () => {
    let showRequest: unknown;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "qwen3:14b" }] });
        if (url.pathname === "/api/ps") {
          return Response.json({ models: [{ name: "qwen3:14b", context_length: 8_192 }] });
        }
        if (url.pathname === "/api/show") {
          showRequest = await request.json();
          return Response.json({ model_info: { "qwen3.context_length": 40_960 } });
        }
        return new Response(null, { status: 404 });
      },
    });
    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: new URL("/v1/", server.url).href,
        providerId: "ollama",
      });

      expect(await provider.listModels()).toEqual([{
        id: "qwen3:14b",
        provider: "ollama",
        contextWindow: 8_192,
      }]);
      expect(showRequest).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("falls back to Ollama model capacity when the model is not loaded", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:11434/v1",
      providerId: "ollama",
      fetch: (async (input: string | URL | Request) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        if (path === "/v1/models") return Response.json({ data: [{ id: "qwen3:14b" }] });
        if (path === "/api/ps") return Response.json({ models: [] });
        if (path === "/api/show") return Response.json({ model_info: { "qwen3.context_length": 40_960 } });
        return new Response(null, { status: 404 });
      }) as unknown as typeof fetch,
    });

    expect(await provider.listModels()).toEqual([{
      id: "qwen3:14b",
      provider: "ollama",
      contextWindow: 40_960,
    }]);
  });

  test("rejects unbounded model inventories", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:1234/v1",
      fetch: (() => Promise.resolve(Response.json({
        data: Array.from({ length: 1_001 }, (_, index) => ({ id: `model-${index}` })),
      }))) as unknown as typeof fetch,
    });
    await expect(provider.listModels()).rejects.toThrow("1000 model limit");
  });

  test.each(["http", "stream"])("surfaces OpenRouter upstream rate limits from %s errors", async (transport) => {
    const error = { message: "Provider returned error", code: 429, metadata: { provider_name: "ModelRun",
      raw: "qwen/qwen3.8-27b:free is temporarily rate-limited upstream. Please retry shortly." } };
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://openrouter.ai/api/v1", providerId: "OpenRouter",
      fetch: (async () => transport === "http" ? Response.json({ error }, { status: 429 })
        : new Response(`data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`)) as unknown as typeof fetch });
    let caught: unknown;
    try {
      for await (const _event of provider.stream({ model: "qwen/qwen3.8-27b:free", messages: [] }, AbortSignal.timeout(2000))) { /* consume */ }
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({ status: 429, code: "429",
      message: "OpenRouter / ModelRun (HTTP 429): qwen/qwen3.8-27b:free is temporarily rate-limited upstream. Please retry shortly." });
  });

  test("extracts nested upstream messages without exposing the surrounding metadata envelope", async () => {
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://openrouter.ai/api/v1", providerId: "OpenRouter",
      fetch: (async () => Response.json({ error: { message: "Provider returned error", code: "context_length_exceeded",
        metadata: { provider_name: "Upstream", raw: JSON.stringify({ error: { message: "Maximum context length exceeded" }, request: "must not appear" }) } } },
      { status: 400 })) as unknown as typeof fetch });
    await expect(provider.listModels()).rejects.toMatchObject({ status: 400, code: "context_length_exceeded",
      message: "OpenRouter / Upstream (HTTP 400): Maximum context length exceeded" });
  });

  test("rejects a stream that ends without a completion marker", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:1234/v1",
      fetch: (() => Promise.resolve(new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
        { status: 200 },
      ))) as unknown as typeof fetch,
    });

    const consume = async () => {
      for await (const _event of provider.stream(
        { model: "model", messages: [{ role: "user", content: "test" }] },
        new AbortController().signal,
      )) {
        // Consume the full stream to validate its terminal marker.
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(ProviderError);
    await expect(consume()).rejects.toThrow("completion marker");
  });

  test("preserves a length stop and the trailing usage instead of treating DONE as normal completion", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:1234/v1",
      fetch: (async () => new Response([
        { choices: [{ delta: { reasoning_content: "Working through the problem" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
        { choices: [], usage: { prompt_tokens: 76664, completion_tokens: 1536, total_tokens: 78200 } },
      ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n")) as unknown as typeof fetch,
    });
    const events = [];
    for await (const event of provider.stream({ model: "qwen", messages: [{ role: "user", content: "Continue" }], maxOutputTokens: 1536 }, AbortSignal.timeout(2000))) events.push(event);
    expect(events).toEqual([
      { type: "reasoning_delta", delta: "Working through the problem" },
      { type: "finish", reason: "length" },
      { type: "usage", usage: { inputTokens: 76664, outputTokens: 1536, totalTokens: 78200 } },
    ]);
  });

  test("allows a turn to disable configured thinking", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:1234/v1",
      providerId: "ollama",
      reasoningEffort: "high",
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response([
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "leaked thought" } }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""));
      }) as unknown as typeof fetch,
    });

    const events = [];
    for await (const _event of provider.stream({
      model: "model",
      messages: [{ role: "user", content: "Be concise" }],
      thinkingEnabled: false,
    }, new AbortController().signal)) {
      events.push(_event);
    }

    expect(body?.reasoning_effort).toBe("none");
    expect(body?.think).toBe(false);
    expect(events).toEqual([]);
  });

  test.each(["stop", "tool_calls"])("normalizes OpenRouter's repeated %s finish reason while retaining final usage", async (reason) => {
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://openrouter.ai/api/v1", fetch: (async () => new Response([
      { choices: [{ delta: { content: "Ready" }, finish_reason: reason }] },
      { choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n")) as unknown as typeof fetch });
    const events = [];
    for await (const event of provider.stream({ model: "qwen/test", messages: [{ role: "user", content: "Check" }] }, AbortSignal.timeout(2000))) events.push(event);
    expect(events).toEqual([{ type: "text_delta", delta: "Ready" }, { type: "finish", reason },
      { type: "usage", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }]);
  });

  test("contradictory stream finish reasons still fail", async () => {
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://openrouter.ai/api/v1", fetch: (async () => new Response([
      { choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [{ delta: {}, finish_reason: "length" }] },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n")) as unknown as typeof fetch });
    await expect((async () => {
      for await (const _event of provider.stream({ model: "qwen/test", messages: [] }, AbortSignal.timeout(2000))) { /* consume */ }
    })()).rejects.toThrow("conflicting finish reasons");
  });

  test("allows a turn to enable thinking over a disabled daemon default", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:1234/v1",
      reasoningEffort: "none",
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("data: [DONE]\n\n");
      }) as unknown as typeof fetch,
    });

    for await (const _event of provider.stream({
      model: "model",
      messages: [{ role: "user", content: "Think carefully" }],
      thinkingEnabled: true,
    }, new AbortController().signal)) {
      // Consume the request.
    }

    expect(body?.reasoning_effort).toBe("low");
  });

  test("rejects cleartext non-loopback endpoints", () => {
    expect(() => new OpenAICompatibleProvider({ baseUrl: "http://192.168.1.10:1234/v1" }))
      .toThrow("restricted to loopback");
  });

  test.each([true, false, undefined])("OpenRouter authenticates model discovery and streams with its reasoning controls (%s)", async (thinkingEnabled) => {
    const bodies: Record<string, unknown>[] = [];
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "private-key", providerId: "OpenRouter",
      fetch: (async (input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer private-key");
        expect(headers.get("x-openrouter-title")).toBe("Demesne");
        if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "qwen/test", context_length: 262144,
          top_provider: { max_completion_tokens: 131072 } }] });
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('data: {"choices":[{"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      }) as typeof fetch });
    expect((await provider.listModels())[0]).toMatchObject({ contextWindow: 262144, maxOutputTokens: 131072 });
    const events = [];
    for await (const event of provider.stream({ model: "qwen/test", messages: [{ role: "user", content: "Hello" }], thinkingEnabled,
      maxOutputTokens: 131072 }, AbortSignal.timeout(2000))) events.push(event);
    expect(bodies[0]?.max_tokens).toBe(131072);
    expect(bodies[0]?.reasoning_effort).toBeUndefined();
    expect(bodies[0]?.reasoning).toEqual(thinkingEnabled === undefined ? undefined : thinkingEnabled ? { enabled: true } : { effort: "none" });
    expect(events).toEqual([{ type: "text_delta", delta: "Ready" }, { type: "finish", reason: "stop" }]);
  });

  test.each([
    { baseUrl: "https://openrouter.ai/api/v1", ignored: ["reka"], expected: { ignore: ["reka"] } },
    { baseUrl: "https://openrouter.ai/api/v1", ignored: [], expected: undefined },
    { baseUrl: "http://localhost:1234/v1", ignored: ["reka"], expected: undefined },
  ])("routing exclusions apply only to OpenRouter and preserve the model, budget and reasoning ($baseUrl/$ignored)", async ({ baseUrl, ignored, expected }) => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleProvider({ baseUrl, openRouterIgnore: ignored,
      fetch: (async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response('data: {"choices":[{"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      }) as typeof fetch });
    for await (const _event of provider.stream({ model: "qwen/qwen3.8-27b", messages: [{ role: "user", content: "Hello" }],
      maxOutputTokens: 131072 }, AbortSignal.timeout(2000))) { /* consume the response */ }
    expect(body?.provider).toEqual(expected);
    expect(body?.model).toBe("qwen/qwen3.8-27b");
    expect(body?.max_tokens).toBe(131072);
    expect(body?.reasoning).toBeUndefined();
    expect(body?.reasoning_effort).toBeUndefined();
  });

  test("does not follow provider redirects", async () => {
    let redirectMode: RequestRedirect | undefined;
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:1234/v1",
      fetch: ((_input: string | URL | Request, init?: RequestInit) => {
        redirectMode = init?.redirect;
        return Promise.resolve(new Response(null, {
          status: 307,
          headers: { Location: "http://192.168.1.10:1234/v1/models" },
        }));
      }) as unknown as typeof fetch,
    });

    await expect(provider.listModels()).rejects.toBeInstanceOf(ProviderError);
    expect(redirectMode).toBe("manual");
  });

  test("serializes tools and assembles streamed tool call fragments", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:1234/v1",
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const stream = [
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-", function: { name: "read_", arguments: "{\"path\":" } }] } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "1", function: { name: "file", arguments: "\"a.txt\"}" } }] } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join("");
        return new Response(stream);
      }) as unknown as typeof fetch,
    });

    const events = [];
    for await (const event of provider.stream({
      model: "model",
      messages: [
        { role: "assistant", content: null, toolCalls: [{ id: "prior", name: "read_file", arguments: "{}" }] },
        { role: "tool", toolCallId: "prior", content: "result" },
      ],
      tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
    }, new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { type: "tool_call_delta", index: 0, idDelta: "call-", nameDelta: "read_", argumentsDelta: "{\"path\":" },
      { type: "tool_call_delta", index: 0, idDelta: "1", nameDelta: "file", argumentsDelta: "\"a.txt\"}" },
      { type: "finish", reason: "tool_calls" },
    ]);
    expect(body?.tools).toEqual([{
      type: "function",
      function: { name: "read_file", description: "Read", parameters: { type: "object" } },
    }]);
    expect(body?.messages).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "prior", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "prior", content: "result" },
    ]);
  });
});
