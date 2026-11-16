import { expect, test } from "bun:test";
import { configuredStreamLimits, createProcessor } from "../src/providers-from-config.ts";
import { withProviderDeadlines } from "../src/engine.ts";
import { providerStreamLimits } from "../src/provider-limits.ts";
import { defaultConfig } from "@demesne/config";

test("local endpoints allow long prefill and enough time for output", () => {
  for (const url of ["http://127.0.0.1:8081/v1", "http://10.0.0.191:8081/v1", "http://100.115.125.89:8081/v1"]) {
    const limits = providerStreamLimits(2048, {}, configuredStreamLimits({ url }));
    expect(limits.firstEventTimeoutMs).toBe(43_200_000);
    expect(limits.requestTimeoutMs).toBeGreaterThan(43_200_000);
  }
  expect(configuredStreamLimits({url: "https://api.example.com/v1"}).providerFirstEventTimeoutMs).toBe(180_000);
  expect(configuredStreamLimits({auth: "codex"}).providerFirstEventTimeoutMs).toBe(180_000);
});

test("explicit provider deadlines remain bounded and validated", () => {
  expect(configuredStreamLimits({url: "http://localhost:8081", firstEventTimeoutMs: 600000, requestTimeoutMs: 900000})).toEqual({providerFirstEventTimeoutMs: 600000, providerRequestTimeoutMs: 900000});
  expect(configuredStreamLimits({url: "http://localhost:8081", requestTimeoutMs: 1000}).providerFirstEventTimeoutMs).toBe(1000);
  expect(() => configuredStreamLimits({firstEventTimeoutMs: 2000, requestTimeoutMs: 1000})).toThrow("must not exceed");
});

test("selecting an additional provider snapshots that provider's deadlines", () => {
  const config = defaultConfig();
  config.provider = {id: "cloud", url: "https://api.example.com/v1", model: "cloud-model", contextWindow: 262144, maxOutputTokens: 2048};
  config.additionalProviders = {local: {id: "local", url: "http://127.0.0.1:8081/v1", model: "gemma-4-31b", contextWindow: 262144, maxOutputTokens: 2048}};
  const processor = createProcessor(config, ".", new Set())!;
  const local = processor.createTurnInference!(true, {model: "gemma-4-31b"});
  const cloud = processor.createTurnInference!(true, {model: "cloud-model"});
  expect(local.streamLimits?.providerFirstEventTimeoutMs).toBe(43_200_000);
  expect(cloud.streamLimits?.providerFirstEventTimeoutMs).toBe(180_000);
  expect(local.contextCapacity).toBe(262144);
  expect(local.thinkingEnabled).toBe(true);
});


test("Stop cancels a local request even during its long first-event allowance", async () => {
  const controller = new AbortController();
  const pending = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); yield "unreachable"; } };
  const limits = providerStreamLimits(2048, {}, configuredStreamLimits({url: "http://localhost:8081"}));
  const next = withProviderDeadlines(pending, controller, limits.firstEventTimeoutMs, limits.requestTimeoutMs).next();
  controller.abort(new Error("User stopped"));
  await expect(next).rejects.toThrow("User stopped");
});
