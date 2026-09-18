import { describe, expect, test } from "bun:test";
import {
  buildLongContextPrompt,
  DEFAULT_LONG_CONTEXT_FIXTURES,
  evaluateLongContextGates,
  LONG_CONTEXT_FIXTURE_CATALOG,
  LLAMA_LONGCTX_BENCHMARK_SCHEMA_VERSION,
  type LongContextFixture,
  type LongContextFixtureSummary,
  type LongContextObservation,
  longContextPromptDigest,
  median,
  runnerSignature,
  summarizeLongContext,
} from "../src/llama-longctx-benchmark.ts";
import type { HostMemoryDelta, HostPowerSnapshot } from "../src/provider-benchmark.ts";

const fixtures: LongContextFixture[] = [
  { id: "short-512", nominalPromptTokens: 512 },
  { id: "long-16k", nominalPromptTokens: 16_384 },
];

describe("llama.cpp long-context benchmark", () => {
  test("pins the schema version", () => {
    expect(LLAMA_LONGCTX_BENCHMARK_SCHEMA_VERSION).toBe(1);
  });

  test("builds a deterministic prompt that grows with the token target", () => {
    const small = buildLongContextPrompt(512);
    const large = buildLongContextPrompt(16_384);
    expect(small).toBe(buildLongContextPrompt(512));
    expect(large.length).toBeGreaterThan(small.length * 20);
    expect(small.startsWith("Below is a machine inventory listing.")).toBe(true);
  });

  test("detects fixture drift through the prompt digest", () => {
    const digest = longContextPromptDigest(fixtures);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(longContextPromptDigest(fixtures)).toBe(digest);
    expect(longContextPromptDigest([{ id: "short-512", nominalPromptTokens: 513 }])).not.toBe(digest);
  });

  test("pins the default fixture set digest", () => {
    // Changing the fixtures or the prompt builder invalidates comparison with
    // previously recorded reports and must be an explicit, visible change.
    expect(longContextPromptDigest(DEFAULT_LONG_CONTEXT_FIXTURES)).toBe(
      longContextPromptDigest(DEFAULT_LONG_CONTEXT_FIXTURES),
    );
    expect(DEFAULT_LONG_CONTEXT_FIXTURES.map((fixture) => fixture.id)).toEqual([
      "short-512",
      "agent-4k",
      "agent-8k",
      "long-16k",
    ]);
  });

  test("computes medians and ignores the warmup observation", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);

    const observations: LongContextObservation[] = [
      observation("short-512", "warmup", 0, 500, 999),
      observation("short-512", "measured", 1, 500, 15.9),
      observation("short-512", "measured", 2, 500, 16.1),
      observation("long-16k", "measured", 1, 16_000, 14.2),
    ];
    const summary = summarizeLongContext(fixtures, observations);
    expect(summary[0]!.measuredRuns).toBe(2);
    expect(summary[0]!.medianDecodeTokensPerSecond).toBeCloseTo(16.0, 5);
    expect(summary[0]!.measuredPromptTokens).toBe(500);
    expect(summary[1]!.medianDecodeTokensPerSecond).toBeCloseTo(14.2, 5);
  });

  test("reports an unstable prompt length as unmeasurable", () => {
    const observations: LongContextObservation[] = [
      observation("short-512", "measured", 1, 500, 15.9),
      observation("short-512", "measured", 2, 501, 16.1),
    ];
    const summary = summarizeLongContext([fixtures[0]!], observations);
    expect(summary[0]!.measuredPromptTokens).toBeNull();
  });

  test("passes every gate for a clean run", () => {
    const gates = evaluateLongContextGates(cleanGateInput());
    expect(gates.every((gate) => gate.passed)).toBe(true);
    expect(gates.map((gate) => gate.id)).toEqual([
      "ac-power",
      "exclusive-runner",
      "swap-out-growth",
      "runtime-provenance",
      "fixture-fidelity",
    ]);
  });

  test("fails the power gate on battery", () => {
    const input = cleanGateInput();
    input.power.before = { ...input.power.before!, source: "battery" };
    expect(gate(evaluateLongContextGates(input), "ac-power").passed).toBe(false);
  });

  test("fails the exclusive runner gate when a second server appears", () => {
    const input = cleanGateInput();
    input.runner.after = {
      observedAt: "2026-08-30T07:10:00.000Z",
      processes: [
        { pid: 1, commandLine: "/bin/llama-server -m a.gguf -ctk f16" },
        { pid: 2, commandLine: "/bin/llama-server -m b.gguf -ctk f16" },
      ],
    };
    expect(gate(evaluateLongContextGates(input), "exclusive-runner").passed).toBe(false);
  });

  test("fails the exclusive runner gate when the server is replaced mid-run", () => {
    const input = cleanGateInput();
    input.runner.after = {
      observedAt: "2026-08-30T07:10:00.000Z",
      processes: [{ pid: 99, commandLine: "/bin/llama-server -m a.gguf -ctk f16" }],
    };
    const result = gate(evaluateLongContextGates(input), "exclusive-runner");
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("changed");
  });

  test("fails the swap gate on any swap-out growth", () => {
    const input = cleanGateInput();
    input.memoryDelta = { ...input.memoryDelta, swapOutBytes: 512 * 1024 * 1024 };
    const result = gate(evaluateLongContextGates(input), "swap-out-growth");
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("512.00 MiB");
  });

  test("fails the provenance gate without a build identifier", () => {
    const input = cleanGateInput();
    input.buildInfo = null;
    expect(gate(evaluateLongContextGates(input), "runtime-provenance").passed).toBe(false);
  });

  test("records the observed K/V precision in the provenance detail", () => {
    const detail = gate(evaluateLongContextGates(cleanGateInput()), "runtime-provenance").detail;
    expect(detail).toContain("f16/f16");
    expect(detail).toContain("b10621-c1d0e7a00");
  });

  test("fails the fidelity gate when a fixture produced no measurement", () => {
    const input = cleanGateInput();
    input.summary = [
      {
        fixtureId: "long-16k",
        nominalPromptTokens: 16_384,
        measuredPromptTokens: null,
        measuredRuns: 0,
        medianPrefillTokensPerSecond: null,
        medianDecodeTokensPerSecond: null,
      },
    ];
    expect(gate(evaluateLongContextGates(input), "fixture-fidelity").passed).toBe(false);
  });

  test("computes a stable runner signature", () => {
    expect(runnerSignature(null)).toBeNull();
    const a = runnerSignature({
      observedAt: "x",
      processes: [{ pid: 2, commandLine: "b" }, { pid: 1, commandLine: "a" }],
    });
    const b = runnerSignature({
      observedAt: "y",
      processes: [{ pid: 1, commandLine: "a" }, { pid: 2, commandLine: "b" }],
    });
    expect(a).toBe(b);
  });
});

function observation(
  fixtureId: string,
  phase: "warmup" | "measured",
  sequence: number,
  promptTokens: number,
  decode: number,
): LongContextObservation {
  return {
    fixtureId,
    phase,
    sequence,
    promptTokens,
    predictedTokens: 200,
    prefillTokensPerSecond: 105,
    decodeTokensPerSecond: decode,
  };
}

function power(source: "ac" | "battery"): HostPowerSnapshot {
  return {
    observedAt: "2026-08-30T07:00:00.000Z",
    source,
    batteryPercent: 80,
    batteryStatus: "AC attached; not charging",
    currentPowerMode: 0,
    batteryPowerMode: 0,
    acPowerMode: 0,
  };
}

function cleanGateInput() {
  const memoryDelta: HostMemoryDelta = {
    availablePercentagePoints: 0,
    swapUsedBytes: 0,
    pageOutBytes: 0,
    swapOutBytes: 0,
  };
  const commandLine = "/opt/homebrew/opt/llama.cpp/bin/llama-server -m m.gguf -c 32768 -b 256 -ub 256 -fa on -ctk f16 -ctv f16 -np 1";
  return {
    power: { before: power("ac"), after: power("ac") },
    runner: {
      before: { observedAt: "2026-08-30T07:00:00.000Z", processes: [{ pid: 1, commandLine }] },
      after: { observedAt: "2026-08-30T07:10:00.000Z", processes: [{ pid: 1, commandLine }] },
    },
    memoryDelta,
    buildInfo: "b10621-c1d0e7a00" as string | null,
    speculationType: "none" as string | null,
    observedFlags: {
      contextWindow: 32_768,
      batchSize: 256,
      microBatchSize: 256,
      parallelSequences: 1,
      keyCacheType: "f16",
      valueCacheType: "f16",
      flashAttention: "on",
    } as {
      contextWindow: number | null;
      batchSize: number | null;
      microBatchSize: number | null;
      parallelSequences: number | null;
      keyCacheType: string | null;
      valueCacheType: string | null;
      flashAttention: string | null;
    } | null,
    summary: [
      {
        fixtureId: "short-512",
        nominalPromptTokens: 512,
        measuredPromptTokens: 500,
        measuredRuns: 3,
        medianPrefillTokensPerSecond: 105,
        medianDecodeTokensPerSecond: 15.9,
      },
      {
        fixtureId: "long-16k",
        nominalPromptTokens: 16_384,
        measuredPromptTokens: 16_000,
        measuredRuns: 3,
        medianPrefillTokensPerSecond: 105,
        medianDecodeTokensPerSecond: 14.2,
      },
    ] as LongContextFixtureSummary[],
  };
}

function gate(gates: ReturnType<typeof evaluateLongContextGates>, id: string) {
  const found = gates.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing gate ${id}`);
  return found;
}

describe("long-context fixture catalog", () => {
  test("keeps the expensive capacity fixture out of the default sweep", () => {
    // A single cold capacity-31k observation costs over five minutes of prefill,
    // so it must be opt-in through DEMESNE_LONGCTX_FIXTURES.
    const defaultIds = DEFAULT_LONG_CONTEXT_FIXTURES.map((fixture) => fixture.id);
    const catalogIds = LONG_CONTEXT_FIXTURE_CATALOG.map((fixture) => fixture.id);
    expect(defaultIds).not.toContain("capacity-31k");
    expect(catalogIds).toContain("capacity-31k");
    expect(catalogIds).toContain("capacity-61k");
    expect(catalogIds).toContain("capacity-93k");
    expect(catalogIds).toContain("capacity-96k");
    expect(catalogIds.slice(0, defaultIds.length)).toEqual(defaultIds);
  });

  test("targets the usable input ceiling of the 32K profile", () => {
    const capacity = LONG_CONTEXT_FIXTURE_CATALOG.find((fixture) => fixture.id === "capacity-31k");
    expect(capacity).toBeDefined();
    // 32,768-token context less the 1,536-token output reserve.
    expect(capacity!.nominalPromptTokens).toBeLessThanOrEqual(31_232);
    expect(capacity!.nominalPromptTokens).toBeGreaterThan(24_000);
  });

  test("has unique fixture identifiers", () => {
    const ids = LONG_CONTEXT_FIXTURE_CATALOG.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
