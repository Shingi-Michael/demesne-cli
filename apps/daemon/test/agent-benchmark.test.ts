import { expect, test } from "bun:test";
import type { TurnProcessor } from "../src/processor.ts";
import { runAgentBenchmark } from "../src/agent-benchmark.ts";

const BENCHMARK_PROCESSOR_DEFAULTS = { maxOutputTokens: 512, temperature: 0, seed: 42 } as const;

test("agent benchmark scores a read-only diagnosis through the complete daemon loop", async () => {
  const processor: TurnProcessor = {
    ...BENCHMARK_PROCESSOR_DEFAULTS,
    providerId: "test-provider",
    modelId: "test-model",
    contextCapacity: 8_192,
    maxOutputTokens: 512,
    async listModels() {
      return [{ id: "test-model", provider: "test-provider", contextWindow: 8_192 }];
    },
    async *stream(messages) {
      const toolResult = messages.find((message) => message.role === "tool");
      if (!toolResult) {
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
      yield { type: "text_delta", delta: "The reducer subtracts instead of adding.\nBUG: total - price should be total + price" };
      yield { type: "usage", usage: { inputTokens: 150, outputTokens: 20, totalTokens: 170 } };
    },
  };

  const report = await runAgentBenchmark({
    fixtureId: "read-only-arithmetic-diagnosis-v1",
    model: "test-model",
    warmupRuns: 0,
    measuredRuns: 1,
    timeoutMs: 10_000,
    maxOutputTokens: 512,
    temperature: 0,
    seed: 42,
  }, {
    processor,
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });

  expect(report.summary).toMatchObject({
    measuredRuns: 1,
    successfulRuns: 1,
    successRate: 1,
    medianModelRounds: 2,
    medianToolCalls: 1,
  });
  expect(report.schemaVersion).toBe(12);
  expect(report.observations[0]).toMatchObject({
    status: "completed",
    success: true,
    expectedMarkerFound: true,
    requiredToolsObserved: true,
    workspaceValid: true,
    requiredCommandSucceeded: true,
    modelRounds: 2,
    toolCalls: 1,
    toolNames: ["read_file"],
    inputTokens: 250,
    outputTokens: 30,
  });
  expect(report.observations[0]?.providerRounds).toHaveLength(2);
  expect(report.observations[0]?.providerRounds.map((round) => ({
    inputTokens: round.inputTokens,
    outputTokens: round.outputTokens,
  }))).toEqual([
    { inputTokens: 100, outputTokens: 10 },
    { inputTokens: 150, outputTokens: 20 },
  ]);
  expect(report.observations[0]?.providerRounds.map((round) => ({
    shape: round.shape,
    plan: round.contextPlan?.schemaVersion,
    usage: round.usage?.inputTokens,
    eligible: round.calibration.eligible,
  }))).toEqual([
    { shape: "tool_selection", plan: 3, usage: 100, eligible: true },
    { shape: "tool_follow_up", plan: 3, usage: 150, eligible: true },
  ]);
  expect(new Set(report.observations[0]?.providerRounds.map((round) => round.providerCallId)).size).toBe(2);
  expect(report.summary.calibration).toMatchObject({ eligibleRounds: 2, excludedRounds: 0 });
  expect(report.runtime.profileStatus.state).toBe("unconfigured");
});

test("agent benchmark calibrates a direct answer without tool calls", async () => {
  const processor: TurnProcessor = {
    ...BENCHMARK_PROCESSOR_DEFAULTS,
    providerId: "test-provider",
    modelId: "test-model",
    contextCapacity: 8_192,
    maxOutputTokens: 512,
    async listModels() {
      return [{ id: this.modelId, provider: this.providerId, contextWindow: this.contextCapacity }];
    },
    async *stream() {
      yield { type: "text_delta", delta: "CALIBRATION: direct answer" };
      yield { type: "usage", usage: { inputTokens: 200, outputTokens: 8, totalTokens: 208 } };
    },
  };

  const report = await runAgentBenchmark(benchmarkConfig("direct-answer-calibration-v1"), {
    processor,
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });

  expect(report.observations[0]).toMatchObject({
    success: true,
    toolCalls: 0,
    maximumToolCallsObserved: true,
  });
  expect(report.observations[0]?.providerRounds[0]).toMatchObject({
    turnIndex: 0,
    roundIndex: 0,
    shape: "direct",
    usage: { inputTokens: 200 },
    calibration: { eligible: true, exclusionReason: null },
  });
});

test("agent benchmark rejects an invalid context policy", async () => {
  const processor: TurnProcessor = {
    ...BENCHMARK_PROCESSOR_DEFAULTS,
    providerId: "test-provider",
    modelId: "test-model",
    contextCapacity: 8_192,
    async listModels() {
      return [];
    },
    async *stream() {
      throw new Error("unused");
    },
  };

  await expect(runAgentBenchmark({
    ...benchmarkConfig("direct-answer-calibration-v1"),
    contextPolicy: "invalid" as "schema3",
  }, { processor })).rejects.toThrow("contextPolicy is invalid");
});

test("agent benchmark measures planned input growth across one persistent session", async () => {
  const processor: TurnProcessor = {
    ...BENCHMARK_PROCESSOR_DEFAULTS,
    providerId: "test-provider",
    modelId: "test-model",
    contextCapacity: 8_192,
    maxOutputTokens: 512,
    async listModels() {
      return [{ id: this.modelId, provider: this.providerId, contextWindow: this.contextCapacity }];
    },
    async *stream(messages) {
      const lastUser = messages.findLast((message) => message.role === "user");
      const turn = /calibration turn (\d)/.exec(lastUser?.content ?? "")?.[1] ?? "0";
      const inputTokens = messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
      yield { type: "text_delta", delta: `CALIBRATION: growing turn ${turn}` };
      yield { type: "usage", usage: { inputTokens, outputTokens: 8, totalTokens: inputTokens + 8 } };
    },
  };

  const report = await runAgentBenchmark(benchmarkConfig("growing-session-calibration-v1"), {
    processor,
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });
  const rounds = report.observations[0]?.providerRounds ?? [];
  const estimates = rounds.map((round) => round.contextPlan?.estimatedInputTokens ?? 0);

  expect(report.observations[0]).toMatchObject({ success: true, modelRounds: 4, toolCalls: 0 });
  expect(rounds.map((round) => round.turnIndex)).toEqual([0, 1, 2, 3]);
  expect(rounds.every((round) => round.shape === "growing_session" && round.calibration.eligible)).toBe(true);
  expect(estimates[1]).toBeGreaterThan(estimates[0]!);
  expect(estimates[2]).toBeGreaterThan(estimates[1]!);
  expect(estimates[3]).toBeGreaterThan(estimates[2]!);
  expect(report.summary.calibration.eligibleRounds).toBe(4);
});

test("agent benchmark requires real historical tool-output compaction", async () => {
  const processor: TurnProcessor = {
    ...BENCHMARK_PROCESSOR_DEFAULTS,
    providerId: "test-provider",
    modelId: "test-model",
    contextCapacity: 8_192,
    async listModels() {
      return [{ id: this.modelId, provider: this.providerId, contextWindow: this.contextCapacity }];
    },
    async *stream(messages) {
      const lastUser = messages.findLast((message) => message.role === "user");
      const inputTokens = messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
      if (lastUser?.role === "user" && lastUser.content.includes("historical source loaded")) {
        const currentToolResult = messages.findLast((message) => message.role === "tool");
        if (!currentToolResult) {
          yield toolCall("read-history", "read_file", { path: "data/history.txt", offset: 1, limit: 90 });
          yield { type: "usage", usage: { inputTokens, outputTokens: 8, totalTokens: inputTokens + 8 } };
          return;
        }
        yield { type: "text_delta", delta: "CALIBRATION: historical source loaded" };
        yield { type: "usage", usage: { inputTokens, outputTokens: 8, totalTokens: inputTokens + 8 } };
        return;
      }
      yield { type: "text_delta", delta: "CALIBRATION: historical context compacted" };
      yield { type: "usage", usage: { inputTokens, outputTokens: 8, totalTokens: inputTokens + 8 } };
    },
  };

  const report = await runAgentBenchmark(benchmarkConfig("historical-tool-output-calibration-v1"), {
    processor,
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });
  const rounds = report.observations[0]?.providerRounds ?? [];

  expect(report.observations[0]).toMatchObject({
    success: true,
    modelRounds: 3,
    toolCalls: 1,
    requiredCompactionObserved: true,
  });
  expect(rounds.map((round) => round.shape)).toEqual(["tool_selection", "tool_follow_up", "historical_compaction"]);
  expect(rounds.map((round) => round.contextPlan?.actions.length)).toEqual([0, 0, 1]);
  expect(rounds[2]?.contextPlan?.actions[0]).toEqual(expect.objectContaining({
    kind: "truncate_historical_tool_output",
    messageIndex: 3,
    removedLines: 65,
  }));
  expect(rounds[2]?.contextPlan?.actions[0]?.estimatedTokensSaved).toBeGreaterThan(0);
  expect(report.summary.calibration).toMatchObject({ eligibleRounds: 3, excludedRounds: 0 });
});

test("agent benchmark validates schema-3 reduction ordering across changed and unchanged file reads", async () => {
  const processor = schema3BenchmarkProcessor();

  const report = await runAgentBenchmark({
    ...benchmarkConfig("schema3-long-session-calibration-v1"),
    maxOutputTokens: 1_536,
    measuredRuns: 2,
  }, {
    processor,
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });
  const observation = report.observations[0];
  const rounds = observation?.providerRounds ?? [];
  const reductionPlan = rounds[4]?.contextPlan;

  expect(observation).toMatchObject({
    success: true,
    modelRounds: 5,
    toolCalls: 2,
    exactToolCallsObserved: true,
    exactModelRoundsObserved: true,
    workspaceTransitionsValid: true,
    requiredContextReductionObserved: true,
    providerUsageCalibrationValid: true,
  });
  expect(rounds.map((round) => round.shape)).toEqual([
    "tool_selection",
    "tool_follow_up",
    "tool_selection",
    "tool_follow_up",
    "schema3_reduction",
  ]);
  expect(reductionPlan?.actions.map((action) => action.kind)).toEqual([
    "deduplicate_historical_file_content",
    "truncate_historical_tool_output",
    "drop_historical_turn",
  ]);
  expect(reductionPlan?.actions).toContainEqual(expect.objectContaining({
    kind: "deduplicate_historical_file_content",
    path: "data/stable.txt",
  }));
  expect(reductionPlan?.actions).not.toContainEqual(expect.objectContaining({
    kind: "deduplicate_historical_file_content",
    path: "data/changing.txt",
  }));
  expect(report.observations.every((candidate) => candidate.success && candidate.workspaceTransitionsValid)).toBe(true);
  expect(rounds.every((round) => round.calibration.eligible)).toBe(true);
  expect(report.summary.calibration).toMatchObject({ eligibleRounds: 10, excludedRounds: 0 });
});

test("delayed-hard agent benchmark preserves output capacity with mandatory production reduction", async () => {
  const report = await runAgentBenchmark({
    ...benchmarkConfig("schema3-long-session-calibration-v1"),
    maxOutputTokens: 1_536,
    contextPolicy: "delayed-hard",
  }, {
    processor: schema3BenchmarkProcessor(),
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });
  const observation = report.observations[0];
  const reductionPlan = observation?.providerRounds[4]?.contextPlan;

  expect(observation).toMatchObject({ success: true, requiredContextReductionObserved: true });
  expect(reductionPlan?.originalEstimatedInputTokens).toBeGreaterThan(reductionPlan?.hardInputLimitTokens ?? Infinity);
  expect(reductionPlan?.estimatedInputTokens).toBeLessThanOrEqual(reductionPlan?.hardInputLimitTokens ?? -1);
  expect(reductionPlan?.actions.map((action) => action.kind)).toEqual([
    "deduplicate_historical_file_content",
    "truncate_historical_tool_output",
    "drop_historical_turn",
  ]);
});

test("schema-3 benchmark rejects a run when any provider round lacks calibration usage", async () => {
  const report = await runAgentBenchmark({
    ...benchmarkConfig("schema3-long-session-calibration-v1"),
    maxOutputTokens: 1_536,
  }, {
    processor: schema3BenchmarkProcessor(0),
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });

  expect(report.observations[0]).toMatchObject({
    success: false,
    requiredContextReductionObserved: true,
    providerUsageCalibrationValid: false,
  });
  expect(report.summary).toMatchObject({ successfulRuns: 0, successRate: 0 });
});

test("stress fixtures remain near but below the hard 8K input budget", async () => {
  const fixtures = [
    ["multilingual-context-calibration-v1", "CALIBRATION: multilingual context", "multilingual"],
    ["escaped-json-calibration-v1", "CALIBRATION: escaped JSON", "escaped_json"],
    ["dense-code-calibration-v1", "CALIBRATION: dense code", "dense_code"],
  ] as const;
  for (const [fixtureId, marker, shape] of fixtures) {
    const processor: TurnProcessor = {
      ...BENCHMARK_PROCESSOR_DEFAULTS,
      providerId: "test-provider",
      modelId: "test-model",
      contextCapacity: 8_192,
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId, contextWindow: this.contextCapacity }];
      },
      async *stream(_messages) {
        yield { type: "text_delta", delta: marker };
        yield { type: "usage", usage: { inputTokens: 3_000, outputTokens: 8, totalTokens: 3_008 } };
      },
    };
    const report = await runAgentBenchmark(benchmarkConfig(fixtureId), {
      processor,
      memorySnapshot: () => null,
      powerSnapshot: () => null,
    });
    const round = report.observations[0]?.providerRounds[0];

    expect(report.observations[0]?.success).toBe(true);
    expect(round?.shape).toBe(shape);
    expect(round?.contextPlan?.estimatedInputTokens).toBeGreaterThan(4_000);
    expect(round?.contextPlan?.estimatedInputTokens).toBeLessThanOrEqual(6_656);
  }
});

test("agent benchmark approves and validates a scoped single-file edit", async () => {
  const processor: TurnProcessor = {
    ...BENCHMARK_PROCESSOR_DEFAULTS,
    providerId: "test-provider",
    modelId: "test-model",
    async listModels() {
      return [{ id: "test-model", provider: "test-provider", contextWindow: 8_192 }];
    },
    async *stream(messages) {
      const toolResults = messages.filter((message) => message.role === "tool").length;
      if (toolResults === 0) {
        yield toolCall("read-greeting", "read_file", { path: "src/greeting.ts" });
        return;
      }
      if (toolResults === 1) {
        yield toolCall("edit-greeting", "edit_file", {
          path: "src/greeting.ts",
          oldText: "Hello, ${name}.",
          newText: "Hello, ${name}!",
        });
        return;
      }
      yield { type: "text_delta", delta: "Updated the punctuation.\nEDIT: greeting uses an exclamation mark" };
    },
  };

  const report = await runAgentBenchmark(benchmarkConfig("single-file-greeting-edit-v1"), {
    processor,
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });

  expect(report.summary).toMatchObject({ successfulRuns: 1, successRate: 1, medianModelRounds: 3 });
  expect(report.observations[0]).toMatchObject({
    success: true,
    expectedMarkerFound: true,
    requiredToolsObserved: true,
    workspaceValid: true,
    requiredCommandSucceeded: true,
    toolNames: ["read_file", "edit_file"],
  });
});

test("agent benchmark validates an edited source file and successful test command", async () => {
  const processor: TurnProcessor = {
    ...BENCHMARK_PROCESSOR_DEFAULTS,
    providerId: "test-provider",
    modelId: "test-model",
    async listModels() {
      return [{ id: "test-model", provider: "test-provider", contextWindow: 8_192 }];
    },
    async *stream(messages) {
      const toolResults = messages.filter((message) => message.role === "tool").length;
      if (toolResults === 0) {
        yield toolCall("test-failing", "run_command", { argv: ["bun", "test"] });
        return;
      }
      if (toolResults === 1) {
        yield toolCall("read-source", "read_file", { path: "src/calculate-total.ts" });
        return;
      }
      if (toolResults === 2) {
        yield toolCall("edit-source", "edit_file", {
          path: "src/calculate-total.ts",
          oldText: "total - price",
          newText: "total + price",
        });
        return;
      }
      if (toolResults === 3) {
        yield toolCall("test-passing", "run_command", { argv: ["bun", "test"] });
        return;
      }
      yield { type: "text_delta", delta: "The arithmetic repair is verified.\nREPAIR: tests pass" };
    },
  };

  const report = await runAgentBenchmark(benchmarkConfig("failed-test-arithmetic-repair-v1"), {
    processor,
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });

  expect(report.summary).toMatchObject({ successfulRuns: 1, successRate: 1, medianModelRounds: 5 });
  expect(report.observations[0]).toMatchObject({
    success: true,
    requiredToolsObserved: true,
    workspaceValid: true,
    requiredCommandSucceeded: true,
    toolNames: ["run_command", "read_file", "edit_file", "run_command"],
    inputTokens: null,
    outputTokens: null,
  });
  expect(report.observations[0]?.providerRounds.every((round) =>
    !round.calibration.eligible && round.calibration.exclusionReason === "provider input usage is missing or invalid"
  )).toBe(true);
  expect(report.summary.calibration).toMatchObject({ eligibleRounds: 0, excludedRounds: 5 });
});

test("repair calibration rejects a passing-only command sequence", async () => {
  const processor: TurnProcessor = {
    ...BENCHMARK_PROCESSOR_DEFAULTS,
    providerId: "test-provider",
    modelId: "test-model",
    async listModels() {
      return [{ id: this.modelId, provider: this.providerId, contextWindow: 8_192 }];
    },
    async *stream(messages) {
      const toolResults = messages.filter((message) => message.role === "tool").length;
      if (toolResults === 0) {
        yield toolCall("read-source", "read_file", { path: "src/calculate-total.ts" });
        return;
      }
      if (toolResults === 1) {
        yield toolCall("edit-source", "edit_file", {
          path: "src/calculate-total.ts",
          oldText: "total - price",
          newText: "total + price",
        });
        return;
      }
      if (toolResults === 2) {
        yield toolCall("test-passing", "run_command", { argv: ["bun", "test"] });
        return;
      }
      yield { type: "text_delta", delta: "REPAIR: tests pass" };
    },
  };

  const report = await runAgentBenchmark(benchmarkConfig("failed-test-arithmetic-repair-v1"), {
    processor,
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });

  expect(report.observations[0]).toMatchObject({
    success: false,
    requiredToolsObserved: true,
    requiredCommandSucceeded: false,
    workspaceValid: true,
  });
  expect(report.summary.calibration).toMatchObject({ eligibleRounds: 0, excludedRounds: 4 });
});

test("repair calibration rejects inspection after the edit", async () => {
  const processor: TurnProcessor = {
    ...BENCHMARK_PROCESSOR_DEFAULTS,
    providerId: "test-provider",
    modelId: "test-model",
    async listModels() {
      return [{ id: this.modelId, provider: this.providerId, contextWindow: 8_192 }];
    },
    async *stream(messages) {
      const toolResults = messages.filter((message) => message.role === "tool").length;
      if (toolResults === 0) {
        yield toolCall("test-failing", "run_command", { argv: ["bun", "test"] });
        return;
      }
      if (toolResults === 1) {
        yield toolCall("edit-source", "edit_file", {
          path: "src/calculate-total.ts",
          oldText: "total - price",
          newText: "total + price",
        });
        return;
      }
      if (toolResults === 2) {
        yield toolCall("read-after-edit", "read_file", { path: "src/calculate-total.ts" });
        return;
      }
      if (toolResults === 3) {
        yield toolCall("test-passing", "run_command", { argv: ["bun", "test"] });
        return;
      }
      yield { type: "text_delta", delta: "REPAIR: tests pass" };
    },
  };

  const report = await runAgentBenchmark(benchmarkConfig("failed-test-arithmetic-repair-v1"), {
    processor,
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });

  expect(report.observations[0]).toMatchObject({
    success: false,
    requiredToolsObserved: true,
    requiredCommandSucceeded: false,
    workspaceValid: true,
  });
  expect(report.summary.calibration).toMatchObject({ eligibleRounds: 0, excludedRounds: 5 });
});

test("agent benchmark denies writes outside the fixture allowlist", async () => {
  const processor: TurnProcessor = {
    ...BENCHMARK_PROCESSOR_DEFAULTS,
    providerId: "test-provider",
    modelId: "test-model",
    async listModels() {
      return [{ id: "test-model", provider: "test-provider", contextWindow: 8_192 }];
    },
    async *stream(messages) {
      const toolResults = messages.filter((message) => message.role === "tool").length;
      if (toolResults === 0) {
        yield toolCall("read-greeting", "read_file", { path: "src/greeting.ts" });
        return;
      }
      if (toolResults === 1) {
        yield toolCall("unsafe-edit", "edit_file", {
          path: "outside.txt",
          oldText: "",
          newText: "not allowed",
        });
        return;
      }
      yield { type: "text_delta", delta: "EDIT: greeting uses an exclamation mark" };
    },
  };

  const report = await runAgentBenchmark(benchmarkConfig("single-file-greeting-edit-v1"), {
    processor,
    memorySnapshot: () => null,
    powerSnapshot: () => null,
  });

  expect(report.summary).toMatchObject({ successfulRuns: 0, successRate: 0 });
  expect(report.observations[0]).toMatchObject({
    success: false,
    requiredToolsObserved: true,
    workspaceValid: false,
  });
});

function benchmarkConfig(fixtureId: string) {
  return {
    fixtureId,
    model: "test-model",
    warmupRuns: 0,
    measuredRuns: 1,
    timeoutMs: 10_000,
    maxOutputTokens: 512,
    temperature: 0,
    seed: 42,
  };
}

function schema3BenchmarkProcessor(omitUsageRound = -1): TurnProcessor {
  let providerRound = 0;
  return {
    ...BENCHMARK_PROCESSOR_DEFAULTS,
    providerId: "test-provider",
    modelId: "test-model",
    contextCapacity: 8_192,
    maxOutputTokens: 1_536,
    async listModels() {
      return [{ id: this.modelId, provider: this.providerId, contextWindow: this.contextCapacity }];
    },
    async *stream(messages) {
      const currentRound = providerRound++;
      const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
      const lastUser = messages[lastUserIndex];
      const inputTokens = messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
      const usage = { type: "usage" as const, usage: { inputTokens, outputTokens: 8, totalTokens: inputTokens + 8 } };
      const currentToolResult = messages.slice(lastUserIndex + 1).some((message) => message.role === "tool");
      if (lastUser?.role === "user" && lastUser.content.includes("CALIBRATION: read set")) {
        const version = lastUser.content.includes("read set A") ? "A" : "B";
        if (!currentToolResult) {
          yield toolCall(`read-set-${version}`, "read_files", {
            files: [
              { path: "data/stable.txt", offset: 1, limit: 90 },
              { path: "data/changing.txt", offset: 1, limit: 90 },
            ],
          });
          if (currentRound !== omitUsageRound) yield usage;
          return;
        }
        yield { type: "text_delta" as const, delta: `CALIBRATION: read set ${version}` };
        if (currentRound !== omitUsageRound) yield usage;
        return;
      }
      yield { type: "text_delta" as const, delta: "CALIBRATION: schema 3 reduction" };
      if (currentRound !== omitUsageRound) yield usage;
    },
  };
}

function toolCall(id: string, name: string, input: Record<string, unknown>) {
  return {
    type: "tool_call_delta" as const,
    index: 0,
    idDelta: id,
    nameDelta: name,
    argumentsDelta: JSON.stringify(input),
  };
}
