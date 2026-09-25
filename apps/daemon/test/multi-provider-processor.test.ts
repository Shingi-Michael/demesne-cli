import { expect, test } from "bun:test";
import { MultiProviderProcessor } from "../src/multi-provider-processor.ts";
import { ProviderTurnProcessor } from "../src/provider-processor.ts";

function processor(id: string, model: string, context: number, offline = false) {
  return new ProviderTurnProcessor({
    id,
    async listModels() {
      if (offline) throw new Error("offline");
      return [{ id: model, provider: id, contextWindow: context }];
    },
    async *stream(request) { yield { type: "text_delta" as const, delta: `${id}/${request.model}` }; },
  }, model, { maxOutputTokens: 512 }, undefined, context, [model]);
}

test("both models are selectable and queued inference retains its original provider", async () => {
  const router = new MultiProviderProcessor([processor("local", "local-qwen", 100000), processor("pc", "qwen3.8-27b", 262144)], []);
  expect((await router.listModels()).map((m) => m.id)).toEqual(["local-qwen", "qwen3.8-27b"]);
  const queued = router.createTurnInference(false);
  router.setModel("qwen3.8-27b");
  expect(router.providerId).toBe("pc");
  expect(router.contextCapacity).toBe(262144);
  const events = [];
  for await (const event of queued.stream([], [], new AbortController().signal)) events.push(event);
  expect(events).toEqual([{ type: "text_delta", delta: "local/local-qwen" }]);
  const pc = [];
  for await (const event of router.stream([], [], new AbortController().signal, false)) pc.push(event);
  expect(pc).toEqual([{ type: "text_delta", delta: "pc/qwen3.8-27b" }]);
  expect(() => router.setModel("unknown")).toThrow("Unknown model");
  router.setModel("local-qwen");
  expect(router.contextCapacity).toBe(100000);
});

test("offline provider does not hide reachable models", async () => {
  const router = new MultiProviderProcessor([processor("local", "a", 4096, true), processor("pc", "b", 8192)], []);
  expect((await router.listModels()).map((m) => m.id)).toEqual(["b"]);
});

test("duplicate model IDs fail closed rather than silently rerouting", () => {
  expect(() => new MultiProviderProcessor([processor("local", "qwen", 4096), processor("pc", "qwen", 8192)], []))
    .toThrow("Ambiguous model ID");
});
