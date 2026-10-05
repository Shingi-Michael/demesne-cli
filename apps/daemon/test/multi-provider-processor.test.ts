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

test("a call for another configured model routes to its provider and keeps per-call overrides", async () => {
  const router = new MultiProviderProcessor([processor("cloud", "astra", 262144), processor("pc", "qwen3.8-27b", 262144)], []);
  const local = router.createTurnInference(false, { model: "qwen3.8-27b", maxOutputTokens: 128 });
  expect([local.providerId, local.modelId, local.maxOutputTokens]).toEqual(["pc", "qwen3.8-27b", 128]);
  // The selected model is unchanged, and its own overrides are no longer dropped.
  expect(router.modelId).toBe("astra");
  expect(router.createTurnInference(false, { maxOutputTokens: 100 }).maxOutputTokens).toBe(100);
  const events = [];
  for await (const event of local.stream([], [], new AbortController().signal)) events.push(event);
  expect(events).toEqual([{ type: "text_delta", delta: "pc/qwen3.8-27b" }]);
  expect(() => router.createTurnInference(false, { model: "missing" })).toThrow("Unknown model");
});

test("replace keeps the selected model while its provider stays, else moves to a local one", () => {
  const chatgpt = processor("ChatGPT", "gpt-6-astra", 272000), qwen = processor("Qwen on PC", "qwen3.8-27b", 32768), openrouter = processor("OpenRouter", "z-ai/glm", 128000);
  const router = new MultiProviderProcessor([qwen, chatgpt, openrouter], []);
  router.setModel("gpt-6-astra", "high");
  // Signing in to another provider keeps the current choice and its thinking level.
  const kept = router.replace([processor("Qwen on PC", "qwen3.8-27b", 32768), chatgpt, openrouter], [], [true, false, false]);
  expect(kept).toMatchObject({ switched: false, model: "gpt-6-astra", provider: "ChatGPT" });
  expect(router.modelId).toBe("gpt-6-astra");
  // Signing out of ChatGPT moves to the local provider, not the first hosted one.
  const moved = router.replace([openrouter, qwen], [], [false, true]);
  expect(moved).toMatchObject({ switched: true, model: "qwen3.8-27b", provider: "Qwen on PC", previous: { model: "gpt-6-astra", provider: "ChatGPT" } });
  expect(router.availableModels().map((item) => item.id).sort()).toEqual(["qwen3.8-27b", "z-ai/glm"]);
  expect(() => router.setModel("gpt-6-astra")).toThrow(/Unknown model/);
});
