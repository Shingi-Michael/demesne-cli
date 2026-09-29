import { expect, test } from "bun:test";
import type { RuntimeProfileStatus } from "@demesne/protocol";
import type { ProviderMessage } from "@demesne/providers";
import {
  runRepositoryContextBenchmark,
  type RepositoryContextBenchmarkConfig,
} from "../src/repository-context-benchmark.ts";
import { createRepositoryContextFixtures } from "../src/repository-context-fixtures.ts";
import type { TurnProcessor } from "../src/processor.ts";

const GOLD = {
  inspection: {
    packageManager: "bun",
    workspaceGlobs: ["apps/*", "packages/*"],
    entrypoints: { cli: "apps/cli/src/main.ts", daemon: "apps/daemon/src/main.ts" },
    context: { schemaVersion: 3, capacityTokens: 8192, outputReserveTokens: 1536, toolDefinitionCount: 13 },
  },
  repair: {
    changedFiles: ["src/cache-key.ts"],
    publicFunction: "buildCacheKey",
    defaultPort: { before: 3000, after: 7337 },
    validation: { argv: ["bun", "test", "test/cache-key.test.ts"], exitCode: 0, passed: 20, failed: 0 },
  },
  feature: {
    changedFiles: ["apps/cli/src/main.ts", "apps/daemon/src/app.ts", "packages/protocol/src/index.ts"],
    http: { method: "GET", path: "/v1/runtime", responseType: "RuntimeInfo" },
    cliCommand: "/runtime",
    validation: { argv: ["bun", "test", "test/runtime-info.test.ts"], exitCode: 0, passed: 3, failed: 0 },
  },
};

test("repository context fixtures pin three distinct schema-3 projections", async () => {
  const fixtures = await createRepositoryContextFixtures();

  expect(fixtures.map((fixture) => ({
    id: fixture.id,
    kind: fixture.kind,
    fixtureSha256: fixture.fixtureSha256,
    manifestSha256: fixture.repositoryManifestSha256,
    raw: fixture.plan.originalEstimatedInputTokens,
    reduced: fixture.plan.estimatedInputTokens,
    actionKinds: fixture.plan.actions.map((action) => action.kind),
  }))).toEqual([
    {
      id: "repository-inspection-v1",
      kind: "inspection",
      fixtureSha256: "6ea24b9bdbb3d0cbc0768c1602c5112be4207bf478236d2a07796ce28f227ffc",
      manifestSha256: "4d903234a32b03c91c7a2757d259309558796d14219c3762ebafe5f48ea8e606",
      raw: 5_756,
      reduced: 4_802,
      actionKinds: [
        "deduplicate_historical_file_content",
        "deduplicate_historical_file_content",
        "deduplicate_historical_file_content",
        "truncate_historical_tool_output",
      ],
    },
    {
      id: "repository-single-file-repair-v1",
      kind: "single_file_repair",
      fixtureSha256: "51ee1d9cad28fdf3f57f67fbbb9fff3728dfff7ae607c608b542d2b941e693b7",
      manifestSha256: "08f32912d837036dc11e5661b61bad7ab4b2482faaf7a36bded4b1edc6a16be7",
      raw: 6_058,
      reduced: 3_982,
      actionKinds: ["drop_historical_turn"],
    },
    {
      id: "repository-multi-file-feature-v1",
      kind: "multi_file_feature",
      fixtureSha256: "b477683598066c1e99f7f0460c923df4d60ac963428fbef34d3220c9862d3031",
      manifestSha256: "3055ba5b2cb00ded3579140ba1d37f6bb9eeb71355cb0cf9fc61956b5be69d1f",
      raw: 6_650,
      reduced: 5_361,
      actionKinds: ["deduplicate_historical_file_content", "drop_historical_turn"],
    },
  ]);
  expect(fixtures.every((fixture) => fixture.plan.estimatedInputTokens <= 5_376)).toBe(true);
  expect(fixtures.every((fixture) => fixture.plan.originalEstimatedInputTokens <= 6_656)).toBe(true);

  const withoutNarration = fixtures.map((fixture) => JSON.stringify(fixture.rawMessages.map((message) => (
    message.role === "assistant" && typeof message.content === "string" ? { ...message, content: "" } : message
  ))));
  for (const fact of ["apps/cli/src/main.ts", "apps/daemon/src/main.ts", "packages/*", "8192", "1536"]) {
    expect(withoutNarration[0]).toContain(fact);
  }
  for (const fact of ["buildCacheKey", "3000", "7337", "20 pass, 0 fail", "test/cache-key.test.ts"]) {
    expect(withoutNarration[1]).toContain(fact);
  }
  for (const fact of ["/v1/runtime", "RuntimeInfo", "/runtime", "3 pass, 0 fail"]) {
    expect(withoutNarration[2]).toContain(fact);
  }
  const feature = fixtures[2]!;
  expect(feature.plan.actions).toEqual([
    expect.objectContaining({
      kind: "deduplicate_historical_file_content",
      messageIndex: 7,
      retainedMessageIndex: 15,
      path: "test/runtime-info.test.ts",
    }),
    expect.objectContaining({ kind: "drop_historical_turn", turnId: "feature-inspect" }),
  ]);
  expect(feature.reducedMessages.some((message) => message.role === "tool"
    && message.toolCallId === "read_test_contract"
    && message.content.includes("duplicate historical file content omitted"))).toBe(true);
});

test("repository context benchmark counterbalances every fixture and scores paired quality", async () => {
  const clock = { value: 0 };
  const report = await runRepositoryContextBenchmark(config(), dependencies(clock, true));

  expect(report.observations).toHaveLength(12);
  expect(report.observations.map((observation) => observation.fixtureKind)).toEqual([
    "inspection", "single_file_repair", "multi_file_feature",
    "single_file_repair", "multi_file_feature", "inspection",
    "multi_file_feature", "inspection", "single_file_repair",
    "inspection", "single_file_repair", "multi_file_feature",
  ]);
  for (const fixtureId of report.fixtures.map((fixture) => fixture.id)) {
    expect(report.observations.filter((observation) => observation.fixtureId === fixtureId).map((observation) => observation.order)).toEqual([
      ["raw", "reduced"],
      ["reduced", "raw"],
      ["raw", "reduced"],
      ["reduced", "raw"],
    ]);
  }
  expect(new Set(report.observations.map((observation) => observation.requestNonce)).size).toBe(12);
  expect(report.fixtureSummaries.every((fixture) => fixture.rawExactRate === 1 && fixture.reducedExactRate === 1)).toBe(true);
  expect(report.summary).toMatchObject({
    measuredPairs: 6,
    operationallyValidPairs: 6,
    experimentValid: true,
    provenanceComplete: true,
    repositoryQualityEligible: true,
    rawExactRate: 1,
    reducedExactRate: 1,
    reducedOnlyFailures: 0,
    rawOnlyFailures: 0,
    medianPairedTimeToFirstOutputSavingMs: 20,
    geometricMeanRawToReducedTimeToFirstOutputRatio: 1.6666666666666667,
    medianPairedDurationSavingMs: 20,
  });
});

test("repository context benchmark retains reduced-only failures as quality evidence", async () => {
  const clock = { value: 0 };
  const report = await runRepositoryContextBenchmark(config(), dependencies(clock, false));

  expect(report.summary).toMatchObject({
    measuredPairs: 6,
    operationallyValidPairs: 6,
    experimentValid: false,
    repositoryQualityEligible: false,
    rawExactRate: 1,
    reducedExactRate: 2 / 3,
    reducedOnlyFailures: 2,
  });
  expect(report.fixtureSummaries.find((fixture) => fixture.kind === "multi_file_feature")).toMatchObject({
    rawExactRate: 1,
    reducedExactRate: 0,
    reducedOnlyFailures: 2,
  });
});

test("repository context benchmark rejects incomplete provenance and inconsistent manifests before execution", async () => {
  const clock = { value: 0 };
  const complete = dependencies(clock, true);
  await expect(runRepositoryContextBenchmark(config(), { ...complete, sourceRevision: undefined })).rejects.toThrow(
    "requires complete runtime and source provenance",
  );

  const fixtures = await createRepositoryContextFixtures();
  fixtures[0]!.repositoryManifestSha256 = "0".repeat(64);
  await expect(runRepositoryContextBenchmark(config(), { ...complete, fixtures })).rejects.toThrow(
    "Repository context fixture is invalid",
  );
});

function config(): RepositoryContextBenchmarkConfig {
  return {
    model: "test-model",
    warmupPairsPerFixture: 2,
    measuredPairsPerFixture: 2,
    timeoutMs: 10_000,
    maxOutputTokens: 1_536,
    temperature: 0,
    seed: 42,
    contextWindow: 8_192,
    externalPowerContext: "controlled-test-power",
  };
}

function dependencies(clock: { value: number }, preserveFeatureQuality: boolean) {
  return {
    processor: processor(clock, preserveFeatureQuality),
    endpoint: "http://127.0.0.1:11435/v1",
    backendVersion: "test-backend",
    modelDigest: "test-digest",
    sourceRevision: "test-revision",
    now: () => clock.value,
    memorySnapshot: () => null,
    powerSnapshot: () => ({
      observedAt: "2026-08-28T00:00:00.000Z",
      source: "ac" as const,
      batteryPercent: 80,
      batteryStatus: "AC attached",
      currentPowerMode: 2,
      batteryPowerMode: 1,
      acPowerMode: 2,
    }),
    runnerSnapshot: () => ({
      observedAt: "2026-08-28T00:00:00.000Z",
      processes: [{ pid: 100, commandLine: "ollama runner --ctx-size 8192" }],
    }),
  };
}

function processor(clock: { value: number }, preserveFeatureQuality: boolean): TurnProcessor {
  const status: RuntimeProfileStatus = {
    profile: "balanced-32gb",
    state: "verified",
    expected: {
      contextWindow: 8_192,
      batchSize: 512,
      microBatchSize: 512,
      parallelSequences: 1,
      keyCacheType: "q8_0",
      valueCacheType: "q8_0",
      flashAttention: "on",
      loadedModels: 1,
    },
    observed: {
      model: "test-model",
      contextWindow: 8_192,
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
    observedAt: "2026-08-28T00:00:00.000Z",
  };
  return {
    providerId: "test-provider",
    modelId: "test-model",
    contextCapacity: 8_192,
    maxOutputTokens: 1_536,
    temperature: 0,
    seed: 42,
    runtimeStatus: () => status,
    async listModels() {
      return [{ id: this.modelId, provider: this.providerId, contextWindow: this.contextCapacity }];
    },
    async *stream(messages, _tools, _signal, _thinkingEnabled, onFirstProviderEvent) {
      const fixture = fixtureKind(messages);
      const reduced = fixture === "inspection"
        ? JSON.stringify(messages).includes("duplicate historical file content omitted")
        : fixture === "repair" ? messages.length < 16 : messages.length < 20;
      clock.value += reduced ? 30 : 50;
      onFirstProviderEvent?.();
      const gold = structuredClone(GOLD[fixture]) as Record<string, unknown>;
      if (fixture === "feature") (gold.changedFiles as string[]).reverse();
      if (fixture === "feature" && reduced && !preserveFeatureQuality) gold.cliCommand = "/runtim";
      const text = JSON.stringify(gold);
      yield { type: "text_delta" as const, delta: text };
      clock.value += 5;
      const inputTokens = inputTokenCount(fixture, reduced);
      yield { type: "usage" as const, usage: { inputTokens, outputTokens: 50, totalTokens: inputTokens + 50 } };
    },
  };
}

function fixtureKind(messages: ProviderMessage[]): keyof typeof GOLD {
  const system = messages[0]?.content ?? "";
  if (system.includes("parcel-agent")) return "inspection";
  if (system.includes("cache-key-service")) return "repair";
  return "feature";
}

function inputTokenCount(fixture: keyof typeof GOLD, reduced: boolean): number {
  const values = {
    inspection: [4_500, 3_700],
    repair: [4_700, 3_000],
    feature: [5_200, 4_000],
  } as const;
  return values[fixture][reduced ? 1 : 0];
}
