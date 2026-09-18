import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest } from "@demesne/providers";
import type { RuntimeProfileVerifier } from "../src/ollama-runtime.ts";
import { ProviderTurnProcessor } from "../src/provider-processor.ts";
import { snapshotTurnInference, type TurnProcessor } from "../src/processor.ts";

describe("ProviderTurnProcessor", () => {
  test("snapshots prompt-cache preservation as immutable inference policy", () => {
    const provider: ProviderAdapter = {
      id: "llama.cpp",
      async listModels() { return []; },
      async *stream() {},
    };
    const processor = new ProviderTurnProcessor(
      provider,
      "model",
      {},
      undefined,
      32_768,
      ["model"],
      true,
    );

    expect(processor.createTurnInference(false).preservesPromptCache).toBe(true);
    expect(snapshotTurnInference(processor, false).preservesPromptCache).toBe(true);
  });

  test("restricts discovery and switching to an explicit model allowlist", async () => {
    const provider: ProviderAdapter = {
      id: "test-provider",
      async listModels() {
        return [
          { id: "optimized", provider: this.id, contextWindow: 8_192 },
          { id: "other", provider: this.id, contextWindow: 4_096 },
        ];
      },
      async *stream() {},
    };
    const processor = new ProviderTurnProcessor(provider, "optimized", {}, undefined, 8_192, ["optimized"]);
    expect(await processor.listModels()).toEqual([{ id: "optimized", provider: "test-provider", contextWindow: 8_192 }]);
    expect(() => processor.setModel("other")).toThrow("not allowed");
    expect(() => new ProviderTurnProcessor(provider, "other", {}, undefined, 8_192, ["optimized"]))
      .toThrow("not in DEMESNE_ALLOWED_MODELS");
  });

  test("delegates messages, tools, and disabled thinking to the selected model", async () => {
    let received: ProviderRequest | undefined;
    const provider: ProviderAdapter = {
      id: "test-provider",
      async listModels() {
        return [{ id: "test-model", provider: this.id }];
      },
      async *stream(request) {
        received = request;
        yield { type: "text_delta", delta: "answer" };
      },
    };
    const messages = [
      { role: "system" as const, content: "Be precise." },
      { role: "user" as const, content: "Current question" },
    ];
    const tools = [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }];
    const processor = new ProviderTurnProcessor(provider, "test-model", {
      maxOutputTokens: 512,
      temperature: 0,
      seed: 42,
    });

    const output: unknown[] = [];
    for await (const event of processor.stream(messages, tools, new AbortController().signal, false)) {
      output.push(event);
    }

    expect(received).toEqual({
      model: "test-model",
      messages,
      tools,
      thinkingEnabled: false,
      maxOutputTokens: 512,
      temperature: 0,
      seed: 42,
    });
    expect(output).toEqual([{ type: "text_delta", delta: "answer" }]);
  });

  test("snapshots the smallest known context capacity and enforced output limit", async () => {
    const provider: ProviderAdapter = {
      id: "test-provider",
      async listModels() {
        return [{ id: "test-model", provider: this.id, contextWindow: 16_384 }];
      },
      async *stream() {},
    };
    const processor = new ProviderTurnProcessor(
      provider,
      "test-model",
      { maxOutputTokens: 1_536 },
      undefined,
      8_192,
    );

    await processor.listModels();
    const inference = processor.createTurnInference(undefined);

    expect(processor.contextCapacity).toBe(8_192);
    expect(processor.maxOutputTokens).toBe(1_536);
    expect(inference.contextCapacity).toBe(8_192);
    expect(inference.maxOutputTokens).toBe(1_536);
  });

  test("rejects an output limit that leaves no input capacity", async () => {
    const provider: ProviderAdapter = {
      id: "test-provider",
      async listModels() { return []; },
      async *stream() {},
    };
    const processor = new ProviderTurnProcessor(provider, "test-model", { maxOutputTokens: 8_192 }, undefined, 8_192);

    expect(() => processor.createTurnInference(undefined)).toThrow("smaller than the effective context capacity");
  });

  test("verifies the loaded runtime before yielding the first event", async () => {
    let providerStarted = false;
    let verified = false;
    const timingOrder: string[] = [];
    const provider: ProviderAdapter = {
      id: "ollama",
      async listModels() { return []; },
      async *stream() {
        providerStarted = true;
        yield { type: "text_delta", delta: "answer" };
      },
    };
    const verifier = verifierStub(async (model) => {
      expect(providerStarted).toBe(true);
      expect(model).toBe("profile-model");
      timingOrder.push("verified");
      verified = true;
    });
    const processor = new ProviderTurnProcessor(provider, "profile-model", {}, verifier);

    const output: unknown[] = [];
    for await (const event of processor.stream(
      [],
      [],
      new AbortController().signal,
      undefined,
      () => timingOrder.push("first-provider-event"),
    )) {
      expect(verified).toBe(true);
      timingOrder.push("yielded");
      output.push(event);
    }

    expect(output).toEqual([{ type: "text_delta", delta: "answer" }]);
    expect(timingOrder).toEqual(["first-provider-event", "verified", "yielded"]);
  });

  test("suppresses model output when runtime verification fails", async () => {
    let streamClosed = false;
    const provider: ProviderAdapter = {
      id: "ollama",
      async listModels() { return []; },
      async *stream() {
        try {
          yield { type: "text_delta", delta: "must not escape" };
        } finally {
          streamClosed = true;
        }
      },
    };
    const verifier = verifierStub(async () => {
      throw new Error("runtime mismatch");
    });
    const processor = new ProviderTurnProcessor(provider, "profile-model", {}, verifier);
    const output: unknown[] = [];

    await expect(async () => {
      for await (const event of processor.stream([], [], new AbortController().signal, undefined)) output.push(event);
    }).toThrow("runtime mismatch");

    expect(output).toEqual([]);
    expect(streamClosed).toBe(true);
  });

  test("keeps an active inference on its snapshotted model after selection changes", async () => {
    let releaseVerification!: () => void;
    let markVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { markVerificationStarted = resolve; });
    const verificationReleased = new Promise<void>((resolve) => { releaseVerification = resolve; });
    let resetCount = 0;
    const requestedModels: string[] = [];
    const provider: ProviderAdapter = {
      id: "ollama",
      async listModels() { return []; },
      async *stream(request) {
        requestedModels.push(request.model);
        yield { type: "text_delta", delta: "answer" };
      },
    };
    const verifier = verifierStub(async () => {
      markVerificationStarted();
      await verificationReleased;
    });
    verifier.reset = () => { resetCount += 1; };
    const processor = new ProviderTurnProcessor(provider, "first-model", {}, verifier);
    const firstInference = processor.createTurnInference(undefined);
    const output: unknown[] = [];
    const collecting = (async () => {
      for await (const event of firstInference.stream([], [], new AbortController().signal)) output.push(event);
    })();

    await verificationStarted;
    processor.setModel("second-model");
    releaseVerification();

    await collecting;
    const secondInference = processor.createTurnInference(undefined);
    for await (const event of secondInference.stream([], [], new AbortController().signal)) output.push(event);

    expect(firstInference.modelId).toBe("first-model");
    expect(secondInference.modelId).toBe("second-model");
    expect(requestedModels).toEqual(["first-model", "second-model"]);
    expect(output).toEqual([
      { type: "text_delta", delta: "answer" },
      { type: "text_delta", delta: "answer" },
    ]);
    expect(resetCount).toBe(2);
  });

  test("requires mutable processors to provide an immutable inference snapshot", async () => {
    let model = "first-model";
    const mutable: TurnProcessor = {
      providerId: "mutable",
      get modelId() { return model; },
      setModel(value) { model = value; },
      async listModels() { return []; },
      async *stream() { yield { type: "text_delta" as const, delta: model }; },
    };
    expect(() => snapshotTurnInference(mutable, undefined)).toThrow("must implement createTurnInference");

    const staticProcessor: TurnProcessor = {
      providerId: "static",
      get modelId() { return model; },
      async listModels() { return []; },
      async *stream() { yield { type: "text_delta" as const, delta: model }; },
    };
    const inference = snapshotTurnInference(staticProcessor, false);
    model = "second-model";
    expect(() => inference.stream([], [], new AbortController().signal)).toThrow("configuration changed");
  });
});

function verifierStub(verify: RuntimeProfileVerifier["verify"]): RuntimeProfileVerifier {
  return {
    verify,
    capture() { return []; },
    reset() {},
    status() {
      return {
        profile: "balanced-32gb",
        state: "pending",
        expected: null,
        observed: null,
        mismatches: [],
        observedAt: null,
      };
    },
  };
}
