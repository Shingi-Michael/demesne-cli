import { expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest } from "@demesne/providers";
import { runProviderBenchmark } from "../src/provider-benchmark.ts";

test("provider benchmark separates warmup runs and summarizes measured observations", async () => {
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    id: "test-provider",
    async listModels() {
      return [{ id: "test-model", provider: "test-provider", contextWindow: 8_192 }];
    },
    async *stream(request) {
      requests.push(request);
      yield { type: "text_delta", delta: "output" };
      yield {
        type: "usage",
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      };
    },
  };
  const times = [0, 100, 1_100, 2_000, 2_100, 3_100];
  const memorySnapshots = [
    {
      observedAt: "before",
      availablePercent: 80,
      swapUsedBytes: 100,
      pageSizeBytes: 16_384,
      pageOuts: 10,
      swapOuts: 5,
    },
    {
      observedAt: "after",
      availablePercent: 20,
      swapUsedBytes: 200,
      pageSizeBytes: 16_384,
      pageOuts: 12,
      swapOuts: 5,
    },
  ];

  const report = await runProviderBenchmark(provider, {
    fixtureId: "fixture-v1",
    prompt: "Fixed prompt",
    model: "test-model",
    warmupRuns: 1,
    measuredRuns: 1,
    maxOutputTokens: 128,
    temperature: 0,
    seed: 42,
    thinkingEnabled: false,
  }, new AbortController().signal, {
    now: () => times.shift()!,
    memorySnapshot: () => memorySnapshots.shift()!,
    powerSnapshot: () => null,
    runtime: { endpoint: "http://localhost/v1", backendVersion: "1.2.3" },
  });

  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    maxOutputTokens: 128,
    temperature: 0,
    seed: 42,
    thinkingEnabled: false,
  });
  expect(report.schemaVersion).toBe(3);
  expect(report.modelBeforeRun.contextWindow).toBe(8_192);
  expect(report.model.contextWindow).toBe(8_192);
  expect(report.runtime).toEqual({ endpoint: "http://localhost/v1", backendVersion: "1.2.3" });
  expect(report.memory.delta).toEqual({
    availablePercentagePoints: -60,
    swapUsedBytes: 100,
    pageOutBytes: 32_768,
    swapOutBytes: 0,
  });
  expect(report.observations.map((observation) => observation.phase)).toEqual(["warmup", "measured"]);
  expect(report.observations[1]).toMatchObject({
    durationMs: 1_100,
    timeToFirstOutputMs: 100,
    postFirstOutputDurationMs: 1_000,
    endToEndOutputTokensPerSecond: 10 / 1.1,
    postFirstOutputTokensPerSecondEstimate: 9,
  });
  expect(report.summary).toMatchObject({
    measuredRuns: 1,
    medianDurationMs: 1_100,
    medianTimeToFirstOutputMs: 100,
    medianEndToEndOutputTokensPerSecond: 10 / 1.1,
    medianPostFirstOutputTokensPerSecondEstimate: 9,
  });
});

test("provider benchmark rejects an unavailable model", async () => {
  const provider: ProviderAdapter = {
    id: "test-provider",
    async listModels() {
      return [];
    },
    async *stream() {
      // The benchmark must fail before starting a stream.
    },
  };

  await expect(runProviderBenchmark(provider, {
    fixtureId: "fixture-v1",
    prompt: "Fixed prompt",
    model: "missing-model",
    warmupRuns: 0,
    measuredRuns: 1,
    maxOutputTokens: 128,
    temperature: 0,
    seed: 42,
    thinkingEnabled: false,
  }, new AbortController().signal, {
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  })).rejects.toThrow("not available");
});
