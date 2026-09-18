import { expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest } from "@demesne/providers";
import { runChatToolBenchmark } from "../src/chat-tool-benchmark.ts";

test("chat/tool benchmark measures deterministic two-round provider cycles", async () => {
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    id: "test-provider",
    async listModels() {
      return [{ id: "test-model", provider: "test-provider", contextWindow: 8_192 }];
    },
    async *stream(request) {
      requests.push(request);
      if (request.messages.length === 2) {
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: "read-1",
          nameDelta: "read_file",
          argumentsDelta: JSON.stringify({ path: "src/calculate-total.ts" }),
        };
        yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
        return;
      }
      yield { type: "text_delta", delta: "Found the subtraction bug.\nBUG: total - price should be total + price" };
      yield { type: "usage", usage: { inputTokens: 150, outputTokens: 20, totalTokens: 170 } };
    },
  };
  let time = 0;

  const report = await runChatToolBenchmark(provider, {
    model: "test-model",
    warmupRuns: 1,
    measuredRuns: 1,
    maxOutputTokens: 512,
    temperature: 0,
    seed: 42,
    promptPaddingBlocks: 0,
  }, new AbortController().signal, {
    now: () => {
      const current = time;
      time += 100;
      return current;
    },
    memorySnapshot: () => null,
    powerSnapshot: () => null,
    runnerSnapshot: () => null,
  });

  expect(requests).toHaveLength(4);
  expect(requests[0]?.messages.map((message) => message.role)).toEqual(["system", "user"]);
  expect(requests[1]?.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
  expect(requests[0]?.tools?.length).toBeGreaterThan(1);
  expect(report.schemaVersion).toBe(2);
  expect(report.observations.map((observation) => observation.phase)).toEqual(["warmup", "measured"]);
  expect(report.observations[1]).toMatchObject({
    durationMs: 700,
    success: true,
    toolCallValid: true,
    expectedMarkerFound: true,
    firstRound: {
      durationMs: 200,
      timeToFirstOutputMs: 100,
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    },
    secondRound: {
      durationMs: 200,
      timeToFirstOutputMs: 100,
      usage: { inputTokens: 150, outputTokens: 20, totalTokens: 170 },
    },
  });
  expect(report.summary).toEqual({
    measuredRuns: 1,
    successfulRuns: 1,
    successRate: 1,
    medianDurationMs: 700,
    medianFirstRoundDurationMs: 200,
    medianSecondRoundDurationMs: 200,
  });
});
