import { describe, expect, test } from "bun:test";
import {
  createRuntimeProfileVerifier,
  parseLlamaServerCommand,
  parseLlamaServerSpeculationType,
  parseOllamaRunnerCommand,
  runtimeProfileContextWindow,
  runtimeProfileMinimumFirstEventTimeoutMs,
} from "../src/ollama-runtime.ts";

const matchingCommand = [
  "/opt/homebrew/libexec/ollama/llama-server",
  "--model /models/model-blob",
  "-c 8192",
  "-np 1",
  "--cache-type-k q8_0",
  "--cache-type-v q8_0",
  "--flash-attn on",
  "-b 512",
  "-ub 512",
].join(" ");

describe("Ollama runtime profiles", () => {
  test("parses the runner settings used by the balanced profile", () => {
    expect(parseOllamaRunnerCommand(matchingCommand)).toEqual({
      contextWindow: 8192,
      batchSize: 512,
      microBatchSize: 512,
      parallelSequences: 1,
      keyCacheType: "q8_0",
      valueCacheType: "q8_0",
      flashAttention: "on",
    });
  });

  test("verifies matching post-load settings", async () => {
    const verifier = createVerifier();

    await verifier.verify("qwen3.8-8k-b512", verifier.capture());

    expect(verifier.status()).toEqual({
      profile: "balanced-32gb",
      state: "verified",
      expected: {
        contextWindow: 8192,
        batchSize: 512,
        microBatchSize: 512,
        parallelSequences: 1,
        keyCacheType: "q8_0",
        valueCacheType: "q8_0",
        flashAttention: "on",
        loadedModels: 1,
      },
      observed: {
        model: "qwen3.8-8k-b512:latest",
        contextWindow: 8192,
        batchSize: 512,
        microBatchSize: 512,
        parallelSequences: 1,
        keyCacheType: "q8_0",
        valueCacheType: "q8_0",
        flashAttention: "on",
        loadedModels: 1,
        runnerProcesses: 1,
      },
      mismatches: [],
      observedAt: "2026-08-28T01:00:00.000Z",
    });
  });

  test("strictly verifies the experimental q4 KV memory profile", async () => {
    const q4Command = matchingCommand
      .replace("--cache-type-k q8_0", "--cache-type-k q4_0")
      .replace("--cache-type-v q8_0", "--cache-type-v q4_0");
    const verifier = createRuntimeProfileVerifier({
      profile: "experimental-q4-kv-32gb",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11435/v1",
      dependencies: {
        fetch: loadedModelFetch(),
        runnerProcesses: () => [{ pid: 123, commandLine: q4Command }],
        serviceProcessIds: () => [100],
        parentProcessId: () => 100,
      },
    })!;

    await verifier.verify("qwen3.8-8k-b512:latest", verifier.capture());

    expect(verifier.status()).toMatchObject({
      profile: "experimental-q4-kv-32gb",
      state: "verified",
      expected: { keyCacheType: "q4_0", valueCacheType: "q4_0" },
      observed: { keyCacheType: "q4_0", valueCacheType: "q4_0" },
    });

    const mismatched = createRuntimeProfileVerifier({
      profile: "experimental-q4-kv-32gb",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11435/v1",
      dependencies: {
        fetch: loadedModelFetch(),
        runnerProcesses: () => [{ pid: 123, commandLine: matchingCommand }],
        serviceProcessIds: () => [100],
        parentProcessId: () => 100,
      },
    })!;
    await expect(mismatched.verify("qwen3.8-8k-b512:latest", mismatched.capture())).rejects.toThrow(
      "key cache type expected q4_0, observed q8_0",
    );
  });

  test("strictly verifies the experimental q4 KV batch-256 profile", async () => {
    const command = matchingCommand
      .replace("--cache-type-k q8_0", "--cache-type-k q4_0")
      .replace("--cache-type-v q8_0", "--cache-type-v q4_0")
      .replace("-b 512", "-b 256")
      .replace("-ub 512", "-ub 256");
    const verifier = createRuntimeProfileVerifier({
      profile: "experimental-q4-kv-b256-32gb",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11435/v1",
      dependencies: {
        fetch: loadedModelFetch("qwen3.8-8k-b256:latest"),
        runnerProcesses: () => [{ pid: 123, commandLine: command }],
        serviceProcessIds: () => [100],
        parentProcessId: () => 100,
      },
    })!;

    await verifier.verify("qwen3.8-8k-b256:latest", verifier.capture());

    expect(verifier.status()).toMatchObject({
      profile: "experimental-q4-kv-b256-32gb",
      state: "verified",
      expected: { batchSize: 256, microBatchSize: 256, keyCacheType: "q4_0", valueCacheType: "q4_0" },
      observed: { batchSize: 256, microBatchSize: 256, keyCacheType: "q4_0", valueCacheType: "q4_0" },
    });
  });

  test("rejects a reused runner with mismatched flags", async () => {
    const verifier = createVerifier(matchingCommand.replace("-b 512", "-b 1024"));

    await expect(verifier.verify("qwen3.8-8k-b512:latest", verifier.capture())).rejects.toThrow(
      "batch size expected 512, observed 1024",
    );
    expect(verifier.status().state).toBe("mismatch");
  });

  test("fails closed when local runner inspection is unavailable", async () => {
    const verifier = createRuntimeProfileVerifier({
      profile: "balanced-32gb",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      dependencies: {
        fetch: loadedModelFetch(),
        runnerProcesses: () => null,
        serviceProcessIds: () => [100],
        parentProcessId: () => 100,
      },
    })!;

    await expect(verifier.verify("qwen3.8-8k-b512:latest", verifier.capture())).rejects.toThrow("could not be verified");
    expect(verifier.status().state).toBe("unavailable");
  });

  test("rejects a runner replacement while a request starts", async () => {
    let commandLine = matchingCommand.replace("-b 512", "-b 1024");
    const verifier = createRuntimeProfileVerifier({
      profile: "balanced-32gb",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      dependencies: {
        fetch: loadedModelFetch(),
        runnerProcesses: () => [{ pid: commandLine === matchingCommand ? 124 : 123, commandLine }],
        serviceProcessIds: () => [100],
        parentProcessId: () => 100,
      },
    })!;
    const baseline = verifier.capture();
    commandLine = matchingCommand;

    await expect(verifier.verify("qwen3.8-8k-b512:latest", baseline)).rejects.toThrow(
      "runner changed while the provider request was starting",
    );
  });

  test("rejects a cold-load runner replacement during metadata inspection", async () => {
    let processReads = 0;
    const verifier = createRuntimeProfileVerifier({
      profile: "balanced-32gb",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      dependencies: {
        fetch: loadedModelFetch(),
        runnerProcesses: () => {
          processReads += 1;
          if (processReads === 1) return [];
          return [{ pid: processReads === 2 ? 123 : 124, commandLine: matchingCommand }];
        },
        serviceProcessIds: () => [100],
        parentProcessId: () => 100,
      },
    })!;
    const baseline = verifier.capture();

    await expect(verifier.verify("qwen3.8-8k-b512:latest", baseline)).rejects.toThrow(
      "runner changed while runtime metadata was inspected",
    );
  });

  test("treats duplicate or unsafe setting values as unknown", () => {
    expect(parseOllamaRunnerCommand(`${matchingCommand} -b 512`).batchSize).toBeNull();
    expect(parseOllamaRunnerCommand(matchingCommand.replace("q8_0", "/private/token")).keyCacheType).toBeNull();
  });

  test("does not use a runner owned by another local service", async () => {
    const verifier = createRuntimeProfileVerifier({
      profile: "balanced-32gb",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      dependencies: {
        fetch: loadedModelFetch(),
        runnerProcesses: () => [{ pid: 123, commandLine: matchingCommand }],
        serviceProcessIds: () => [100],
        parentProcessId: () => 200,
      },
    })!;

    await expect(verifier.verify("qwen3.8-8k-b512:latest", verifier.capture())).rejects.toThrow(
      "runner processes expected 1, observed 0",
    );
  });

  test("bounds runtime metadata by streamed bytes", async () => {
    const verifier = createRuntimeProfileVerifier({
      profile: "balanced-32gb",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      dependencies: {
        fetch: (async () => new Response(new Uint8Array(1024 * 1024 + 1))) as unknown as typeof fetch,
        runnerProcesses: () => [{ pid: 123, commandLine: matchingCommand }],
        serviceProcessIds: () => [100],
        parentProcessId: () => 100,
      },
    })!;

    await expect(verifier.verify("qwen3.8-8k-b512:latest", verifier.capture())).rejects.toThrow(
      "response was too large",
    );
    expect(verifier.status().state).toBe("unavailable");
  });

  test("rejects malformed loaded-model entries instead of undercounting them", async () => {
    const verifier = createRuntimeProfileVerifier({
      profile: "balanced-32gb",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      dependencies: {
        fetch: (async () => Response.json({
          models: [{ name: "qwen3.8-8k-b512:latest" }, {}],
        })) as unknown as typeof fetch,
        runnerProcesses: () => [{ pid: 123, commandLine: matchingCommand }],
        serviceProcessIds: () => [100],
        parentProcessId: () => 100,
      },
    })!;

    await expect(verifier.verify("qwen3.8-8k-b512:latest", verifier.capture())).rejects.toThrow(
      "invalid model entry",
    );
    expect(verifier.status().state).toBe("unavailable");
  });

  test("preserves cancellation without changing profile status", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by test");
    const verifier = createRuntimeProfileVerifier({
      profile: "balanced-32gb",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      dependencies: {
        fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
          throw init?.signal?.reason;
        }) as unknown as typeof fetch,
        runnerProcesses: () => [{ pid: 123, commandLine: matchingCommand }],
        serviceProcessIds: () => [100],
        parentProcessId: () => 100,
      },
    })!;
    const baseline = verifier.capture();
    controller.abort(reason);

    try {
      await verifier.verify("qwen3.8-8k-b512:latest", baseline, controller.signal);
      throw new Error("Expected verification to be cancelled");
    } catch (error) {
      expect(error).toBe(reason);
    }
    expect(verifier.status().state).toBe("pending");
  });

  test("restricts the strict profile to local Ollama", () => {
    expect(() => createRuntimeProfileVerifier({
      profile: "balanced-32gb",
      providerId: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
    })).toThrow("requires DEMESNE_PROVIDER_ID=ollama");
    expect(() => createRuntimeProfileVerifier({
      profile: "balanced-32gb",
      providerId: "ollama",
      baseUrl: "https://ollama.example.com/v1",
    })).toThrow("requires a local Ollama endpoint");
    expect(() => createRuntimeProfileVerifier({
      profile: "unknown",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
    })).toThrow("Unknown DEMESNE_RUNTIME_PROFILE");
  });
});

function createVerifier(commandLine = matchingCommand) {
  return createRuntimeProfileVerifier({
    profile: "balanced-32gb",
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    dependencies: {
      fetch: loadedModelFetch(),
      runnerProcesses: () => [{ pid: 123, commandLine }],
      serviceProcessIds: () => [100],
      parentProcessId: () => 100,
      now: () => new Date("2026-08-28T01:00:00.000Z"),
    },
  })!;
}

function loadedModelFetch(model = "qwen3.8-8k-b512:latest"): typeof fetch {
  return (async () => Response.json({
    models: [{ name: model, context_length: 8192 }],
  })) as unknown as typeof fetch;
}

// The exact command line used by `bun run model:llama` on the audited M1 Max.
const llamaCommand = [
  "/opt/homebrew/opt/llama.cpp/bin/llama-server",
  "-m /Users/x/.demesne/models/qwen3.8-27b-q4_0.gguf",
  "-mm /Users/x/.demesne/models/qwen3.8-mmproj.gguf",
  "-c 32768",
  "-b 256",
  "-ub 256",
  "-ngl all",
  "-fa on",
  "-ctk f16",
  "-ctv f16",
  "-np 1",
  "--fit off",
  "--load-mode none",
  "--no-repack",
  "--cache-ram 2048",
  "--ctx-checkpoints 4",
  "--jinja",
  "--reasoning off",
  "--host 127.0.0.1",
  "--port 11436",
  "--alias qwen3.8-q4_0-32k-b256",
  "--cors-origins localhost",
  "--no-webui",
].join(" ");

const LLAMA_MODEL = "qwen3.8-q4_0-32k-b256";

describe("llama.cpp runtime profiles", () => {
  test("parses the short flags used by a directly launched llama-server", () => {
    expect(parseLlamaServerCommand(llamaCommand)).toEqual({
      contextWindow: 32768,
      batchSize: 256,
      microBatchSize: 256,
      parallelSequences: 1,
      keyCacheType: "f16",
      valueCacheType: "f16",
      flashAttention: "on",
    });
  });

  test("treats an omitted speculation flag as none", () => {
    expect(parseLlamaServerSpeculationType(llamaCommand)).toBe("none");
    expect(parseLlamaServerSpeculationType(`${llamaCommand} --spec-type ngram-map-k4v`)).toBe("ngram-map-k4v");
  });

  test("rejects speculation under the non-speculative production profile", async () => {
    const verifier = createLlamaVerifier(`${llamaCommand} --spec-type ngram-mod`);
    await expect(verifier.verify(LLAMA_MODEL, verifier.capture())).rejects.toThrow(
      "speculation type expected none, observed ngram-mod",
    );
  });

  test("verifies each experimental ngram profile against its exact mode", async () => {
    const modes = ["ngram-simple", "ngram-map-k", "ngram-map-k4v", "ngram-mod"];
    for (const mode of modes) {
      const verifier = createLlamaVerifier(
        `${llamaCommand} --spec-type ${mode}`,
        {},
        `experimental-llama-${mode}-32gb`,
      );
      await verifier.verify(LLAMA_MODEL, verifier.capture());
      expect(verifier.status().state).toBe("verified");
    }
  });

  test("verifies text-only 64K and 100K profiles including served modality", async () => {
    for (const [profile, contextWindow] of [
      ["experimental-llama-ngram-mod-f16-kv-64k-b256-32gb", 65_536],
      ["experimental-llama-ngram-mod-f16-kv-100k-b256-32gb", 100_096],
    ] as const) {
      const baseCommand = llamaCommand.replace(/ -mm \S+/, "").replace("-c 32768", `-c ${contextWindow}`);
      const command = `${contextWindow === 100_096 ? baseCommand.replace("--load-mode none", "--load-mode mmap") : baseCommand} --spec-type ngram-mod`;
      const verifier = createLlamaVerifier(command, { vision: false, contextWindow }, profile);
      await verifier.verify(LLAMA_MODEL, verifier.capture());
      expect(verifier.status().state).toBe("verified");
      expect(verifier.status().observed?.visionEnabled).toBe(false);
    }
  });

  test("rejects non-mmap loading under the promoted 100K profile", async () => {
    const command = `${llamaCommand.replace(/ -mm \S+/, "").replace("-c 32768", "-c 100096")} --spec-type ngram-mod`;
    const verifier = createLlamaVerifier(
      command,
      { vision: false, contextWindow: 100_096 },
      "llama-ngram-mod-f16-kv-100k-b256-32gb",
    );
    await expect(verifier.verify(LLAMA_MODEL, verifier.capture())).rejects.toThrow(
      "load mode expected mmap, observed none",
    );
  });

  test("rejects a vision projector under a text-only long-context profile", async () => {
    const command = `${llamaCommand.replace("-c 32768", "-c 65536")} --spec-type ngram-mod`;
    const verifier = createLlamaVerifier(
      command,
      { vision: true, contextWindow: 65_536 },
      "experimental-llama-ngram-mod-f16-kv-64k-b256-32gb",
    );
    await expect(verifier.verify(LLAMA_MODEL, verifier.capture())).rejects.toThrow(
      "vision modality expected disabled, observed enabled",
    );
  });

  test("does not confuse -mm with -m or -ub with -b", () => {
    const parsed = parseLlamaServerCommand(llamaCommand);
    expect(parsed.batchSize).toBe(256);
    expect(parsed.microBatchSize).toBe(256);
    const wide = parseLlamaServerCommand(llamaCommand.replace("-ub 256", "-ub 512"));
    expect(wide.batchSize).toBe(256);
    expect(wide.microBatchSize).toBe(512);
  });

  test("accepts the long flag spellings for the same settings", () => {
    const long = [
      "/usr/local/bin/llama-server",
      "--model /models/m.gguf",
      "--ctx-size 32768",
      "--batch-size 256",
      "--ubatch-size 256",
      "--parallel 1",
      "--cache-type-k f16",
      "--cache-type-v f16",
      "--flash-attn on",
    ].join(" ");
    expect(parseLlamaServerCommand(long)).toEqual({
      contextWindow: 32768,
      batchSize: 256,
      microBatchSize: 256,
      parallelSequences: 1,
      keyCacheType: "f16",
      valueCacheType: "f16",
      flashAttention: "on",
    });
  });

  test("verifies the measured f16 32K profile", async () => {
    const verifier = createLlamaVerifier();
    await verifier.verify(LLAMA_MODEL, verifier.capture());
    const status = verifier.status();
    expect(status.state).toBe("verified");
    expect(status.mismatches).toEqual([]);
    expect(status.observed?.keyCacheType).toBe("f16");
    expect(status.observed?.contextWindow).toBe(32768);
    expect(status.observed?.runnerProcesses).toBe(1);
  });

  test("rejects q8_0 K/V served under an identical model alias", async () => {
    // Measured on build b10621: q8_0 K/V decoded 7.58 tok/s against 14.25 tok/s
    // for f16 at 14,734 tokens while reporting the same alias. The alias alone is
    // therefore not proof of configuration and must not verify.
    const verifier = createLlamaVerifier(
      llamaCommand.replace("-ctk f16", "-ctk q8_0").replace("-ctv f16", "-ctv q8_0"),
    );
    await expect(verifier.verify(LLAMA_MODEL, verifier.capture())).rejects.toThrow(
      "key cache type expected f16, observed q8_0",
    );
    const status = verifier.status();
    expect(status.state).toBe("mismatch");
    expect(status.observed?.model).toBe(LLAMA_MODEL);
    expect(status.mismatches).toContain("value cache type expected f16, observed q8_0");
  });

  test("rejects a command line that disagrees with the served context window", async () => {
    const verifier = createLlamaVerifier(llamaCommand.replace("-c 32768", "-c 16384"));
    await expect(verifier.verify(LLAMA_MODEL, verifier.capture())).rejects.toThrow(
      "context window command line 16384 disagrees with served 32768",
    );
  });

  test("rejects a sleeping model", async () => {
    const verifier = createLlamaVerifier(llamaCommand, { sleeping: true });
    await expect(verifier.verify(LLAMA_MODEL, verifier.capture())).rejects.toThrow(
      "llama-server reported a sleeping model",
    );
  });

  test("rejects a model alias the daemon did not request", async () => {
    const verifier = createLlamaVerifier(llamaCommand, { alias: "some-other-alias" });
    await expect(verifier.verify(LLAMA_MODEL, verifier.capture())).rejects.toThrow(
      `selected model ${LLAMA_MODEL} is not loaded`,
    );
  });

  test("fails closed when the listening process is not the inference server", async () => {
    // Consistent with the Ollama verifier: the endpoint is observable but no
    // inference server owns it, so this is a mismatch rather than unavailability.
    const verifier = createRuntimeProfileVerifier({
      profile: "llama-f16-kv-32k-b256-32gb",
      providerId: "llama.cpp",
      baseUrl: "http://127.0.0.1:11436/v1",
      dependencies: {
        fetch: llamaPropsFetch(),
        runnerProcesses: () => [{ pid: 777, commandLine: llamaCommand }],
        serviceProcessIds: () => [100],
        now: () => new Date("2026-08-30T07:00:00.000Z"),
      },
    })!;
    await expect(verifier.verify(LLAMA_MODEL, verifier.capture())).rejects.toThrow(
      "runner processes expected 1, observed 0",
    );
    expect(verifier.status().state).toBe("mismatch");
  });

  test("is unavailable when llama-server processes cannot be inspected", async () => {
    const verifier = createRuntimeProfileVerifier({
      profile: "llama-f16-kv-32k-b256-32gb",
      providerId: "llama.cpp",
      baseUrl: "http://127.0.0.1:11436/v1",
      dependencies: {
        fetch: llamaPropsFetch(),
        runnerProcesses: () => null,
        serviceProcessIds: () => [4242],
        now: () => new Date("2026-08-30T07:00:00.000Z"),
      },
    })!;
    await expect(verifier.verify(LLAMA_MODEL, verifier.capture())).rejects.toThrow(
      "could not be verified",
    );
    expect(verifier.status().state).toBe("unavailable");
  });

  test("restricts llama.cpp profiles to a local llama.cpp provider", () => {
    expect(() => createRuntimeProfileVerifier({
      profile: "llama-f16-kv-32k-b256-32gb",
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11436/v1",
    })).toThrow("requires DEMESNE_PROVIDER_ID=llama.cpp");
    expect(() => createRuntimeProfileVerifier({
      profile: "llama-f16-kv-32k-b256-32gb",
      providerId: "llama.cpp",
      baseUrl: "https://llama.example.com/v1",
    })).toThrow("requires a local llama.cpp endpoint");
  });

  test("exposes the measured context window for the profile", () => {
    expect(runtimeProfileContextWindow("llama-f16-kv-32k-b256-32gb")).toBe(32768);
    expect(runtimeProfileContextWindow("balanced-32gb")).toBe(8192);
    expect(runtimeProfileContextWindow("unknown")).toBeUndefined();
  });

  test("derives a cold-prefill first-event deadline from the verified capacity", () => {
    // A cold 31,149-token request emitted its first provider event at 320.8s, so
    // the 180,000 ms default would have aborted it. The derived floor must exceed
    // the measured need with margin, and must not be reported for 8K profiles
    // where the default already suffices.
    const thirtyTwoK = runtimeProfileMinimumFirstEventTimeoutMs("llama-f16-kv-32k-b256-32gb");
    expect(thirtyTwoK).toBeDefined();
    expect(thirtyTwoK!).toBeGreaterThan(320_800);
    expect(thirtyTwoK!).toBeLessThan(900_000);

    const eightK = runtimeProfileMinimumFirstEventTimeoutMs("balanced-32gb");
    expect(eightK).toBeDefined();
    expect(eightK!).toBeLessThan(180_000);

    expect(runtimeProfileMinimumFirstEventTimeoutMs("unknown")).toBeUndefined();
    expect(runtimeProfileMinimumFirstEventTimeoutMs(undefined)).toBeUndefined();
  });

  test("scales the derived deadline with context capacity", () => {
    const eightK = runtimeProfileMinimumFirstEventTimeoutMs("balanced-32gb")!;
    const thirtyTwoK = runtimeProfileMinimumFirstEventTimeoutMs("llama-f16-kv-32k-b256-32gb")!;
    expect(thirtyTwoK / eightK).toBeCloseTo(4, 1);
  });
});


function createLlamaVerifier(
  commandLine = llamaCommand,
  properties: { alias?: string; sleeping?: boolean; vision?: boolean; contextWindow?: number } = {},
  profile = "llama-f16-kv-32k-b256-32gb",
) {
  return createRuntimeProfileVerifier({
    profile,
    providerId: "llama.cpp",
    baseUrl: "http://127.0.0.1:11436/v1",
    dependencies: {
      fetch: llamaPropsFetch(properties),
      runnerProcesses: () => [{ pid: 4242, commandLine }],
      serviceProcessIds: () => [4242],
      now: () => new Date("2026-08-30T07:00:00.000Z"),
    },
  })!;
}

function llamaPropsFetch(
  properties: { alias?: string; sleeping?: boolean; vision?: boolean; contextWindow?: number } = {},
): typeof fetch {
  return (async () => Response.json({
    default_generation_settings: { n_ctx: properties.contextWindow ?? 32768 },
    total_slots: 1,
    model_alias: properties.alias ?? LLAMA_MODEL,
    model_path: "/Users/x/.demesne/models/qwen3.8-27b-q4_0.gguf",
    build_info: "b10621-c1d0e7a00",
    is_sleeping: properties.sleeping ?? false,
    modalities: { vision: properties.vision ?? true, video: properties.vision ?? true, audio: false },
  })) as unknown as typeof fetch;
}
