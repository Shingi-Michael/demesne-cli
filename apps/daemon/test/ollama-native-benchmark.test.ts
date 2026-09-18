import { expect, test } from "bun:test";
import { createOllamaNativeBenchmarkFixture, runOllamaNativeBenchmark } from "../src/ollama-native-benchmark.ts";

test("native Ollama benchmark creates deterministic prefill fixtures", () => {
  const shortFixture = createOllamaNativeBenchmarkFixture(0);
  const longFixture = createOllamaNativeBenchmarkFixture(2);

  expect(shortFixture.fixtureId).toBe("ollama-native-throughput-v1");
  expect(longFixture.fixtureId).toBe("ollama-native-prefill-v1-2-blocks");
  expect(longFixture.prompt).toContain("Record 1:");
  expect(longFixture.prompt).toContain("Record 2:");
  expect(longFixture.prompt).not.toContain("Record 3:");
  expect(() => createOllamaNativeBenchmarkFixture(513)).toThrow("promptBlocks must be an integer between 0 and 512");
});

test("native Ollama benchmark records backend timings separately from warmup", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path === "/api/version") return Response.json({ version: "0.32.15" });
    if (path === "/api/ps") {
      return Response.json({ models: [{ name: "model", context_length: 32_768 }] });
    }
    if (path === "/api/generate") {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        response: "output",
        done_reason: "length",
        total_duration: 11_000_000_000,
        load_duration: 5_000_000,
        prompt_eval_count: 40,
        prompt_eval_duration: 500_000_000,
        eval_count: 128,
        eval_duration: 10_000_000_000,
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const times = [0, 11_100, 20_000, 31_100];

  const report = await runOllamaNativeBenchmark("http://localhost:11434/v1", {
    fixtureId: "native-v1",
    prompt: "Fixed prompt",
    model: "model",
    contextWindow: 32_768,
    warmupRuns: 1,
    measuredRuns: 1,
    maxOutputTokens: 128,
    temperature: 0,
    seed: 42,
    thinkingEnabled: false,
  }, new AbortController().signal, {
    fetch: fetchImplementation,
    now: () => times.shift()!,
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });

  expect(requestBodies).toHaveLength(2);
  expect(report.schemaVersion).toBe(2);
  expect(requestBodies[0]).toMatchObject({
    stream: false,
    think: false,
    options: { num_ctx: 32_768, num_predict: 128, temperature: 0, seed: 42 },
  });
  expect(report.runtime).toMatchObject({
    backendVersion: "0.32.15",
    contextBeforeRun: 32_768,
    contextAfterRun: 32_768,
  });
  expect(report.observations.map((observation) => observation.phase)).toEqual(["warmup", "measured"]);
  expect(report.observations[1]).toMatchObject({
    clientDurationMs: 11_100,
    promptTokensPerSecond: 80,
    outputTokensPerSecond: 12.8,
  });
  expect(report.summary).toMatchObject({
    measuredRuns: 1,
    medianClientDurationMs: 11_100,
    medianPromptTokensPerSecond: 80,
    medianOutputTokensPerSecond: 12.8,
  });
});
