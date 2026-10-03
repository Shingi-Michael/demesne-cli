import { describe, expect, test } from "bun:test";
import { DEFAULT_PROBE_TARGETS, probeProvider, probeTargets, targetForUrl } from "../src/provider-probe.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("probeProvider", () => {
  test("reports reachable providers with their models", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ data: [{ id: "qwen3.8-8k-b256", context_length: 8192 }] })) as unknown as typeof fetch;
    const result = await probeProvider(
      { id: "lmstudio", label: "LM Studio", url: "http://127.0.0.1:1234/v1" },
      { fetch: fetchImpl },
    );
    expect(result.reachable).toBe(true);
    expect(result.models).toEqual([{
      id: "qwen3.8-8k-b256",
      provider: "lmstudio",
      contextWindow: 8192,
      reasoningLevels: ["off", "on"],
      defaultReasoningLevel: "on",
    }]);
  });

  test("reports unreachable providers without throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await probeProvider(
      { id: "ollama", label: "Ollama", url: "http://127.0.0.1:11434/v1" },
      { fetch: fetchImpl },
    );
    expect(result.reachable).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toContain("ECONNREFUSED");
  });

  test("probes every target concurrently", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requested.push(new URL(String(input)).port);
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;
    const results = await probeTargets(DEFAULT_PROBE_TARGETS, { fetch: fetchImpl });
    expect(results).toHaveLength(3);
    expect(new Set(requested)).toEqual(new Set(["11434", "11436", "1234"]));
  });
});

describe("targetForUrl", () => {
  test("matches a known target with or without a trailing slash", () => {
    expect(targetForUrl("http://127.0.0.1:11434/v1").id).toBe("ollama");
    expect(targetForUrl("http://127.0.0.1:11434/v1/").id).toBe("ollama");
  });

  test("synthesizes a generic target for unknown endpoints", () => {
    const target = targetForUrl("https://models.example.com/v1");
    expect(target.id).toBe("openai-compatible");
    expect(target.label).toBe("models.example.com");
    expect(target.url).toBe("https://models.example.com/v1/");
  });
});
