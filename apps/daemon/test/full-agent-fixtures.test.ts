import { expect, test } from "bun:test";
import { PAIRED_FULL_AGENT_FIXTURE_IDS, runAgentBenchmark } from "../src/agent-benchmark.ts";
import type { TurnProcessor } from "../src/processor.ts";

test("paired full-agent fixtures validate real tools and discriminate compaction timing", async () => {
  const processor = scriptedProcessor();
  for (const fixtureId of PAIRED_FULL_AGENT_FIXTURE_IDS) {
    const reports = await Promise.all(["schema3", "delayed-hard"].map(async (contextPolicy) => runAgentBenchmark({
        fixtureId,
        model: "test-model",
        warmupRuns: 0,
        measuredRuns: 1,
        timeoutMs: 30_000,
        maxOutputTokens: 1_536,
        temperature: 0,
        seed: 42,
        contextPolicy: contextPolicy as "schema3" | "delayed-hard",
      }, {
        processor,
        memorySnapshot: () => null,
        powerSnapshot: () => null,
        systemPromptNonce: `fixture-${fixtureId}`,
      })));

    for (const report of reports) {
      expect(report.observations[0]).toMatchObject({
        status: "completed",
        success: true,
        expectedMarkerFound: true,
        requiredToolsObserved: true,
        maximumToolCallsObserved: true,
        workspaceValid: true,
        requiredCommandSucceeded: true,
        workspaceTransitionsValid: true,
        providerUsageCalibrationValid: true,
      });
    }
    if (fixtureId === "full-agent-multi-file-feature-v1") {
      const [schema3, delayed] = reports.map((report) => report.observations[0]!.providerRounds);
      expect(schema3.some((round) => (round.contextPlan?.actions.length ?? 0) > 0)).toBe(true);
      expect(delayed.some((round) => {
        const plan = round.contextPlan;
        return plan !== null && plan.maximumPlannedInputTokens !== null && plan.hardInputLimitTokens !== null
          && plan.originalEstimatedInputTokens > plan.maximumPlannedInputTokens
          && plan.originalEstimatedInputTokens <= plan.hardInputLimitTokens
          && plan.actions.length === 0;
      })).toBe(true);
    }
  }
});

function scriptedProcessor(): TurnProcessor {
  let callId = 0;
  return {
    providerId: "test-provider",
    modelId: "test-model",
    contextCapacity: 8_192,
    maxOutputTokens: 1_536,
    temperature: 0,
    seed: 42,
    async listModels() {
      return [{ id: "test-model", provider: "test-provider", contextWindow: 8_192 }];
    },
    async *stream(messages) {
      const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
      const prompt = lastUserIndex >= 0 && messages[lastUserIndex]?.role === "user"
        ? messages[lastUserIndex].content
        : "";
      const currentToolNames = messages.slice(lastUserIndex + 1).flatMap((message) =>
        message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.name) : []
      );
      const next = scriptedStep(prompt, currentToolNames);
      if (next.tool) {
        callId += 1;
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: `scripted-${callId}`,
          nameDelta: next.tool.name,
          argumentsDelta: JSON.stringify(next.tool.arguments),
        };
      } else {
        yield { type: "text_delta", delta: next.text };
      }
      yield { type: "usage", usage: { inputTokens: 500, outputTokens: 10, totalTokens: 510 } };
    },
  };
}

function scriptedStep(
  prompt: string,
  currentToolNames: string[],
): { tool: { name: string; arguments: Record<string, unknown> }; text?: never }
  | { tool?: never; text: string } {
  if (prompt.includes("docs/architecture.txt")) {
    if (currentToolNames.length === 0) {
      return { tool: { name: "read_file", arguments: { path: "docs/architecture.txt", offset: 1, limit: 48 } } };
    }
    return { text: "HISTORY: architecture loaded" };
  }
  if (prompt.includes("src/runtime.ts and package.json")) {
    if (currentToolNames.length === 0) {
      return { tool: { name: "read_files", arguments: { files: [{ path: "src/runtime.ts" }, { path: "package.json" }] } } };
    }
    return { text: "INSPECTION: balanced-32gb uses 8192 context and one inference slot" };
  }
  if (prompt.includes("DIAGNOSIS: default cache port is wrong")) {
    if (currentToolNames.length === 0) return command(["bun", "test", "test/cache.test.ts"]);
    if (currentToolNames.length === 1) {
      return { tool: { name: "read_files", arguments: { files: [{ path: "src/cache.ts" }, { path: "docs/cache-debug.log" }] } } };
    }
    return { text: "DIAGNOSIS: default cache port is wrong" };
  }
  if (prompt.includes("REPAIR: cache tests pass")) {
    if (currentToolNames.length === 0) {
      return { tool: { name: "edit_file", arguments: { path: "src/cache.ts", oldText: "options.port ?? 3000", newText: "options.port ?? 7337" } } };
    }
    if (currentToolNames.length === 1) return command(["bun", "test", "test/cache.test.ts"]);
    return { text: "REPAIR: cache tests pass" };
  }
  if (prompt.includes("DIAGNOSIS: runtime feature needs three source edits")) {
    if (currentToolNames.length === 0) return command(["bun", "test", "test/runtime-info.test.ts"]);
    if (currentToolNames.length === 1) {
      return { tool: { name: "read_files", arguments: { files: [
        { path: "docs/runtime-feature.txt" },
        { path: "packages/protocol/src/index.ts" },
        { path: "apps/daemon/src/app.ts" },
        { path: "apps/cli/src/main.ts" },
      ] } } };
    }
    return { text: "DIAGNOSIS: runtime feature needs three source edits" };
  }
  if (prompt.includes("FEATURE: runtime route and command pass")) {
    if (currentToolNames.length === 0) {
      return { tool: { name: "edit_file", arguments: {
        path: "packages/protocol/src/index.ts",
        oldText: 'const RUNTIME_INFO_TYPE = "RuntimeInfo";',
        newText: 'export const RUNTIME_INFO_TYPE = "RuntimeInfo";',
      } } };
    }
    if (currentToolNames.length === 1) {
      return { tool: { name: "edit_file", arguments: {
        path: "apps/daemon/src/app.ts",
        oldText: 'path === "/v1/run"',
        newText: 'path === "/v1/runtime"',
      } } };
    }
    if (currentToolNames.length === 2) {
      return { tool: { name: "edit_file", arguments: {
        path: "apps/cli/src/main.ts",
        oldText: '"/runtim"',
        newText: '"/runtime"',
      } } };
    }
    if (currentToolNames.length === 3) return command(["bun", "test", "test/runtime-info.test.ts"]);
    return { text: "FEATURE: runtime route and command pass" };
  }
  if (prompt.includes("QUALITY HISTORY: loaded")) {
    if (currentToolNames.length === 0) {
      return { tool: { name: "read_file", arguments: { path: "docs/quality-ledger.txt", offset: 1, limit: 80 } } };
    }
    return { text: "QUALITY HISTORY: loaded" };
  }
  if (prompt.includes("QUALITY RECALL: owner=daemon")) {
    return { text: "QUALITY RECALL: owner=daemon middle=1536 old_port=3000 current_port=7337" };
  }
  if (prompt.includes("QUALITY DIAGNOSIS: reserves and admission disagree")) {
    if (currentToolNames.length === 0) return command(["bun", "test", "test/context-budget.test.ts"]);
    if (currentToolNames.length === 1) {
      return { tool: { name: "read_files", arguments: { files: [
        { path: "docs/context-contract.txt" },
        { path: "src/budget.ts" },
        { path: "src/admission.ts" },
        { path: "test/context-budget.test.ts" },
      ] } } };
    }
    return { text: "QUALITY DIAGNOSIS: reserves and admission disagree" };
  }
  if (prompt.includes("QUALITY REPAIR: context budget tests pass")) {
    if (currentToolNames.length === 0) {
      return { tool: { name: "edit_file", arguments: {
        path: "src/budget.ts",
        oldText: "limits.capacityTokens - limits.outputReserveTokens",
        newText: "limits.capacityTokens - limits.outputReserveTokens - limits.toolReserveTokens - limits.safetyReserveTokens",
      } } };
    }
    if (currentToolNames.length === 1) {
      return { tool: { name: "edit_file", arguments: {
        path: "src/admission.ts",
        oldText: 'import { type ContextLimits } from "./budget.ts";\nexport function canAdmit(estimatedInputTokens: number, limits: ContextLimits): boolean {\n  return estimatedInputTokens <= limits.capacityTokens;\n}',
        newText: 'import { softInputLimit, type ContextLimits } from "./budget.ts";\nexport function canAdmit(estimatedInputTokens: number, limits: ContextLimits): boolean {\n  return estimatedInputTokens <= softInputLimit(limits);\n}',
      } } };
    }
    if (currentToolNames.length === 2) return command(["bun", "test", "test/context-budget.test.ts"]);
    return { text: "QUALITY REPAIR: context budget tests pass" };
  }
  throw new Error(`Unexpected full-agent fixture prompt: ${prompt}`);
}

function command(argv: string[]): { tool: { name: string; arguments: Record<string, unknown> } } {
  return { tool: { name: "run_command", arguments: { argv } } };
}
