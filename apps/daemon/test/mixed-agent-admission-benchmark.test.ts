import { expect, test } from "bun:test";
import type { ProviderMessage } from "@demesne/providers";
import {
  MIXED_AGENT_SCENARIOS,
  runMixedAgentAdmissionBenchmark,
} from "../src/mixed-agent-admission-benchmark.ts";
import type { TurnProcessor } from "../src/processor.ts";

test("mixed-agent admission benchmark validates all scenarios with rolling refill", async () => {
  const providerEntries: string[] = [];
  const processor: TurnProcessor = {
    providerId: "scripted-mixed",
    modelId: "scripted-model",
    contextCapacity: 8_192,
    maxOutputTokens: 256,
    temperature: 0,
    seed: 42,
    async listModels() {
      return [{ id: this.modelId, provider: this.providerId, contextWindow: this.contextCapacity }];
    },
    async *stream(messages) {
      const prompt = lastUser(messages);
      const toolResult = messages.findLast((message) => message.role === "tool")?.content;
      providerEntries.push(prompt);
      if (prompt === promptFor("read-only-completion")) {
        if (!toolResult) {
          yield toolCall("read-input", "read_file", { path: "input.txt" });
          return;
        }
        yield { type: "text_delta", delta: "Inspected deterministic input. READ_ONLY_COMPLETE" };
        return;
      }
      if (prompt === promptFor("approved-edit-completion")) {
        const toolResults = messages.filter((message) => message.role === "tool");
        if (toolResults.length === 0) {
          yield toolCall("read-approved-before", "read_file", { path: "approved.txt" });
          return;
        }
        if (toolResults.length === 1) {
          yield toolCall("edit-approved", "edit_file", { path: "approved.txt", oldText: "0", newText: "1" });
          return;
        }
        if (toolResults.length === 2) {
          yield toolCall("read-approved-after", "read_file", { path: "approved.txt" });
          return;
        }
        yield { type: "text_delta", delta: "The edit is verified. APPROVED_EDIT_COMPLETE" };
        return;
      }
      if (prompt === promptFor("recoverable-tool-failure")) {
        const toolResults = messages.filter((message) => message.role === "tool");
        if (toolResults.length === 0) {
          yield toolCall("missing-read", "read_file", { path: "missing.txt" });
          return;
        }
        if (toolResults.length === 1) {
          expect(toolResult).toContain("NOT_FOUND");
          yield toolCall("recovery-read", "read_file", { path: "recovery.txt" });
          return;
        }
        expect(toolResult).toContain("unchanged");
        yield { type: "text_delta", delta: "RECOVERED_AFTER_TOOL_FAILURE" };
        return;
      }
      if (prompt === promptFor("permission-wait-cancellation")) {
        if (!toolResult) {
          yield toolCall("read-cancelled-before", "read_file", { path: "cancelled.txt" });
          return;
        }
        yield { type: "text_delta", delta: "Starting the requested edit." };
        yield toolCall("edit-cancelled", "edit_file", { path: "cancelled.txt", oldText: "0", newText: "1" });
        return;
      }
      throw new Error(`Queued cancellation entered the provider: ${prompt}`);
    },
  };
  const memorySnapshots = [memory("before"), memory("after")];
  const powerSnapshots = [power("before"), power("after")];
  const runnerSnapshots = [runner("before"), runner("after")];

  const report = await runMixedAgentAdmissionBenchmark({
    maximumInFlightTasks: 2,
    repetitions: 1,
    timeoutMs: 10_000,
  }, {
    processor,
    memorySnapshot: () => memorySnapshots.shift() ?? null,
    powerSnapshot: () => powerSnapshots.shift() ?? null,
    runnerSnapshot: () => runnerSnapshots.shift() ?? null,
  });

  expect(report.schemaVersion).toBe(1);
  expect(report.tasks).toHaveLength(5);
  expect(report.tasks.every((task) => task.success)).toBe(true);
  expect(report.tasks.map((task) => [task.scenarioId, task.status])).toEqual([
    ["read-only-completion", "completed"],
    ["queued-cancellation", "cancelled"],
    ["approved-edit-completion", "completed"],
    ["recoverable-tool-failure", "completed"],
    ["permission-wait-cancellation", "cancelled"],
  ]);
  expect(report.tasks.map((task) => task.providerStartCount)).toEqual([2, 0, 4, 3, 2]);
  expect(report.tasks.find((task) => task.scenarioId === "approved-edit-completion")?.finalWorkspace)
    .toEqual([{ path: "approved.txt", content: "1\n" }]);
  expect(report.admissions.map((admission) => ({
    order: admission.admissionOrder,
    inFlight: admission.inFlightCount,
    terminals: admission.terminalCountAtAdmission,
  }))).toEqual([
    { order: 0, inFlight: 1, terminals: 0 },
    { order: 1, inFlight: 2, terminals: 0 },
    { order: 2, inFlight: 2, terminals: 1 },
    { order: 3, inFlight: 2, terminals: 2 },
    { order: 4, inFlight: 2, terminals: 3 },
  ]);
  expect(providerEntries).not.toContain(promptFor("queued-cancellation"));
  expect(report.summary).toEqual({
    successfulScenarios: 5,
    totalScenarios: 5,
    scenarioSuccess: true,
    eventIntegrityValid: true,
    rollingAdmissionValid: true,
    expectedCancellationFailureValid: true,
    functionalValid: true,
    memoryEligible: true,
    experimentValid: true,
  });
});

test("mixed-agent admission validates repetitions before deriving the task bound", async () => {
  const processor: TurnProcessor = {
    providerId: "unused",
    modelId: "unused",
    async listModels() { return []; },
    async *stream() {},
  };

  await expect(runMixedAgentAdmissionBenchmark({
    maximumInFlightTasks: 2,
    repetitions: 0,
    timeoutMs: 1_000,
  }, { processor })).rejects.toThrow("repetitions must be an integer between 1 and 10");
});

function promptFor(id: (typeof MIXED_AGENT_SCENARIOS)[number]["id"]): string {
  const scenario = MIXED_AGENT_SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Unknown mixed-agent scenario: ${id}`);
  return scenario.prompt;
}

function lastUser(messages: ProviderMessage[]): string {
  return messages.findLast((message) => message.role === "user")?.content ?? "missing";
}

function toolCall(id: string, name: string, argumentsValue: unknown) {
  return {
    type: "tool_call_delta" as const,
    index: 0,
    idDelta: id,
    nameDelta: name,
    argumentsDelta: JSON.stringify(argumentsValue),
  };
}

function memory(observedAt: string) {
  return {
    observedAt,
    availablePercent: 50,
    swapUsedBytes: 0,
    pageSizeBytes: 4_096,
    pageOuts: 0,
    swapOuts: 0,
  };
}

function power(observedAt: string) {
  return {
    observedAt,
    source: "ac" as const,
    batteryPercent: 100,
    batteryStatus: "charged",
    currentPowerMode: 2,
    batteryPowerMode: 1,
    acPowerMode: 2,
  };
}

function runner(observedAt: string) {
  return { observedAt, processes: [{ pid: 123, commandLine: "scripted-runner" }] };
}
