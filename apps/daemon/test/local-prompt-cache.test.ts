import { expect, test } from "bun:test";
import { defaultConfig } from "@demesne/config";
import { createProcessor } from "../src/providers-from-config.ts";
import { planCacheAwareContextRequest, planContextRequest } from "../src/context-planner.ts";
import type { ProviderMessage } from "@demesne/providers";

test("local connections preserve cached history without a runtime profile", () => {
  for (const url of ["http://127.0.0.1:8081/v1", "https://10.0.0.191:8081/v1", "http://100.115.125.89:8081/v1"]) {
    const config = defaultConfig();
    config.provider = { id: "local", url, allowHttpEndpoint: url, model: "gemma-4-31b", contextWindow: 262144, maxOutputTokens: 2048 };
    const processor = createProcessor(config, ".", new Set())!;
    for (const thinking of [true, false]) {
      const inference = processor.createTurnInference!(thinking);
      expect(inference.preservesPromptCache).toBe(true);
      expect(inference.contextCapacity).toBe(262144);
      expect(inference.thinkingEnabled).toBe(thinking);
      const messages: ProviderMessage[] = [{ role: "system", content: "System" }, { role: "user", content: "Continue" }];
      const planner = inference.preservesPromptCache ? planCacheAwareContextRequest : planContextRequest;
      const planned = planner({ messages, tools: [], historicalTurns: [], capacityTokens: inference.contextCapacity, outputReserveTokens: 2048 });
      expect(planned.messages).toEqual(messages);
      expect(planned.plan.actions).toEqual([]);
    }
  }
});

test("a cloud endpoint by key keeps its cached start too: every provider caches a repeated prefix", () => {
  const config = defaultConfig();
  config.provider = { url: "https://api.example.com/v1", model: "cloud", contextWindow: 262144, maxOutputTokens: 2048 };
  expect(createProcessor(config, ".", new Set())!.createTurnInference!(true).preservesPromptCache).toBe(true);
});

