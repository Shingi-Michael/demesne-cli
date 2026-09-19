import { describe, expect, test } from "bun:test";
import { createPainter, visibleLength } from "@demesne/brand";
import type { EventEnvelope, EventType } from "@demesne/protocol";
import { CliContextRail } from "../src/context-rail.ts";

describe("CLI context rail", () => {
  test("shows reported context usage and thinking mode", () => {
    const rail = new CliContextRail({ id: "qwen3:14b", provider: "ollama", contextWindow: 32_768 }, "/tmp/project");
    rail.begin(false);
    rail.apply(event("model.usage", {
      inputTokens: 7_000,
      outputTokens: 1_192,
      totalTokens: 8_192,
      cachedInputTokens: 6_500,
    }));
    rail.apply(event("model.metrics", { queueDurationMs: 350, durationMs: 1_250, timeToFirstTokenMs: 240 }));

    const output = rail.lines(48, 30, createPainter(false)).join("\n");
    expect(output).toContain("32.8k token capacity");
    expect(output).toContain("LAST REQUEST · PROVIDER REPORTED");
    expect(output).toContain("8.2k total");
    expect(output).toContain("7k in · 1.2k out");
    expect(output).toContain("thinking off");
    expect(output).toContain("6.5k cached input");
    expect(output).toContain("queue 350ms · TTFT 240ms · request 1.3s");
  });

  test("keeps context usage pending until exact provider usage arrives", () => {
    const rail = new CliContextRail({ id: "qwen3:14b", provider: "ollama", contextWindow: 32_768 }, "/tmp/project");
    rail.begin(true);
    rail.apply(event("model.request_started", { model: "qwen3:14b" }));
    rail.apply(event("message.delta", { delta: "x".repeat(400) }));

    const pendingOutput = rail.lines(32, 30, createPainter(false)).join("\n");
    expect(pendingOutput).toContain("usage pending");
    expect(pendingOutput).not.toContain("provider estimated");

    rail.apply(event("model.usage", { inputTokens: 8_192, outputTokens: 100, totalTokens: 8_292 }));
    const exactOutput = rail.lines(32, 30, createPainter(false)).join("\n");
    expect(exactOutput).toContain("8.3k total");
    expect(exactOutput).toContain("8.2k in · 100 out");
    expect(exactOutput).not.toContain("~");
  });

  test("prints exact provider counts in the permanent post-turn summary", () => {
    const rail = new CliContextRail({ id: "qwen3:14b", provider: "ollama", contextWindow: 32_768 }, "/tmp/project");
    rail.begin(true);
    rail.apply(event("model.usage", {
      inputTokens: 7_000,
      outputTokens: 1_192,
      totalTokens: 8_192,
      cachedInputTokens: 6_500,
    }));
    rail.apply(event("model.metrics", { queueDurationMs: 350, durationMs: 1_250, timeToFirstTokenMs: 240 }));

    const output = rail.lines(40, 30, createPainter(false)).join("\n");
    expect(output).toContain("6.5k cached input");
    expect(output).toContain("queue 350ms · TTFT 240ms · request 1.3s");
  });

  test("does not infer remaining capacity from last-call usage", () => {
    const rail = new CliContextRail({ id: "small-model", provider: "local", contextWindow: 4_096 }, "/tmp/project");
    rail.begin(true);
    rail.apply(event("model.usage", { inputTokens: 4_500, outputTokens: 500, totalTokens: 5_000 }));

    const output = rail.lines(32, 30, createPainter(false)).join("\n");
    expect(output).toContain("5k total");
    expect(output).not.toContain("tokens left");
  });

  test("renders a persistent one-line context status", () => {
    const rail = new CliContextRail({ id: "qwen3:14b", provider: "ollama", contextWindow: 32_768 }, "/tmp/project");
    rail.begin(false);
    expect(rail.statusLine(80, createPainter(false))).toBe("qwen3:14b · ctx 32.8k · no request yet");
    rail.apply(event("model.usage", { inputTokens: 7_000, outputTokens: 1_192, totalTokens: 8_192 }));
    expect(rail.statusLine(80, createPainter(false))).toBe("qwen3:14b · last 8.2k/32.8k · ▰▱▱▱▱ 25%");

    // Turn 2 begins: prior usage must not be attributed to the new provider request.
    rail.begin(false);
    rail.apply(event("model.request_started", { model: "qwen3:14b" }));
    expect(rail.statusLine(80, createPainter(false))).toBe("qwen3:14b · ctx 32.8k · no request yet");
    expect(rail.lines(40, 30, createPainter(false)).join("\n")).toContain("LAST REQUEST · PROVIDER REPORTED\nusage pending");

    // Turn 2 provider usage arrives and updates context counts
    rail.apply(event("model.usage", { inputTokens: 9_000, outputTokens: 1_000, totalTokens: 10_000 }));
    expect(rail.statusLine(80, createPainter(false))).toBe("qwen3:14b · last 10k/32.8k · ▰▰▱▱▱ 31%");

    const unknown = new CliContextRail({ id: "m", provider: "local" }, "/tmp/project");
    unknown.apply(event("model.usage", { inputTokens: 10, outputTokens: 5, totalTokens: 15 }));
    expect(unknown.statusLine(80, createPainter(false))).toBe("m · last 15");
  });

  test("does not repeat the workspace branch, which the header already carries", () => {
    const rail = new CliContextRail({ id: "qwen", provider: "llama.cpp", contextWindow: 32_768 }, "/tmp/project");
    rail.setBranch("feature/durable-sessions");
    expect(rail.statusLine(100, createPainter(false))).toBe("qwen · ctx 32.8k · no request yet");
    // The branch is still available for the header to render.
    expect(rail.workspaceBranch).toBe("feature/durable-sessions");
  });

  test("drops the verbose counts before the identity as the footer narrows", () => {
    const rail = new CliContextRail({ id: "qwen3.8-q4_0-100k-b256", provider: "llama.cpp", contextWindow: 100_000 }, "/tmp/project");
    rail.setRuntime({
      profile: "llama-ngram-mod-f16-kv-100k-b256-32gb",
      state: "verified",
      expected: null,
      observed: {
        model: "qwen3.8-q4_0-100k-b256",
        contextWindow: 100_000,
        batchSize: 256,
        microBatchSize: 256,
        parallelSequences: 1,
        keyCacheType: "f16",
        valueCacheType: "f16",
        flashAttention: "on",
        loadedModels: 1,
        runnerProcesses: 1,
        speculationType: "ngram-mod",
      },
      mismatches: [],
      observedAt: "2026-08-30T00:00:00.000Z",
    });
    rail.apply(event("model.usage", { inputTokens: 3_400, outputTokens: 120, totalTokens: 3_520 }));

    // Wide: everything, including the absolute counts.
    const wide = rail.statusLine(200, createPainter(false));
    expect(wide).toBe("✓ ngram-mod · qwen3.8-q4_0-100k-b256 · last 3.5k/100k · ▱▱▱▱▱ 4%");

    // Typical 110-column terminal: the absolute counts go, the meter stays.
    const typical = rail.statusLine(110, createPainter(false));
    expect(typical).toBe("✓ ngram-mod · qwen3.8-q4_0-100k-b256 · ▱▱▱▱▱ 4%");
    expect(typical).not.toContain("last");

    // Narrow: the meter is the last thing standing.
    expect(rail.statusLine(24, createPainter(false))).toBe("▱▱▱▱▱ 4%");
  });

  test("never exceeds the space the footer gives its right side", () => {
    const rail = new CliContextRail({ id: "a-very-long-model-identifier-that-will-not-fit", provider: "llama.cpp", contextWindow: 100_000 }, "/tmp/project");
    rail.apply(event("model.usage", { inputTokens: 50_000, outputTokens: 120, totalTokens: 50_120 }));
    for (const width of [20, 30, 40, 60, 80, 100, 140]) {
      const line = rail.statusLine(width, createPainter(false));
      // formatFooterLine hands this side ~55% of the width and then truncates.
      expect(visibleLength(line)).toBeLessThanOrEqual(Math.max(20, Math.floor(width * 0.55)));
    }
  });

  test("surfaces verified speculation in the persistent status", () => {
    const rail = new CliContextRail({ id: "qwen", provider: "llama.cpp", contextWindow: 32_768 }, "/tmp/project");
    rail.setRuntime({
      profile: "llama-ngram-mod-f16-kv-32k-b256-32gb",
      state: "verified",
      expected: null,
      observed: {
        model: "qwen",
        contextWindow: 32_768,
        batchSize: 256,
        microBatchSize: 256,
        parallelSequences: 1,
        keyCacheType: "f16",
        valueCacheType: "f16",
        flashAttention: "on",
        loadedModels: 1,
        runnerProcesses: 1,
        speculationType: "ngram-mod",
      },
      mismatches: [],
      observedAt: "2026-08-30T00:00:00.000Z",
    });
    expect(rail.statusLine(100, createPainter(false))).toContain("✓ ngram-mod · qwen · ctx 32.8k");
    expect(rail.statusLine(30, createPainter(false))).toStartWith("✓ ngram-mod");
  });

  test("hydrates exact context and workspace when resuming a session", () => {
    const rail = new CliContextRail({ id: "model", provider: "local", contextWindow: 32_768 }, "/tmp/old");
    rail.hydrate({
      provider: "local",
      model: "model",
      contextPlan: null,
      usage: { inputTokens: 10_000, outputTokens: 500, totalTokens: 10_500 },
      metrics: { queueDurationMs: 450, durationMs: 2_000, timeToFirstTokenMs: 300 },
    }, true, "/tmp/resumed");

    const output = rail.lines(40, 30, createPainter(false)).join("\n");
    expect(output).toContain("local · resumed");
    expect(rail.statusLine(80, createPainter(false))).toContain("last 10.5k/32.8k · ▰▰▱▱▱ 32%");
  });

  test("separates the estimated context plan from provider-reported usage", () => {
    const rail = new CliContextRail({ id: "model", provider: "local", contextWindow: 32_768 }, "/tmp/project");
    rail.begin(true);
    rail.apply(event("model.request_started", {
      model: "model",
      contextPlan: {
        schemaVersion: 3,
        estimator: { method: "openai-json-utf8-bytes-divisor-3", version: 2, safetyFactor: 1.2 },
        capacityTokens: 32_768,
        reserves: { outputTokens: 2_048, toolResultTokens: 768, safetyTokens: 512, totalTokens: 3_328 },
        maximumPlannedInputTokens: 29_440,
        hardInputLimitTokens: 30_720,
        originalEstimatedInputTokens: 12_000,
        estimatedInputTokens: 10_000,
        estimatedMessageTokens: 7_642,
        estimatedToolDefinitionTokens: 2_358,
        budgetStatus: "within_soft_limit",
        actions: [{
          kind: "truncate_historical_tool_output",
          scope: "historical",
          messageIndex: 2,
          originalCharacters: 8_000,
          compactedCharacters: 2_000,
          removedLines: 80,
          estimatedTokensSaved: 2_000,
        }],
      },
    }));
    rail.apply(event("model.usage", { inputTokens: 9_800, outputTokens: 400, totalTokens: 10_200 }));

    const output = rail.lines(48, 40, createPainter(false)).join("\n");
    expect(output).toContain("CONTEXT PLAN · ESTIMATED");
    expect(output).toContain("~10k input · 31% of capacity");
    expect(output).toContain("messages ~7.6k · tool definitions ~2.4k");
    expect(output).toContain("reserves output 2k · results 768 · safety 512");
    expect(output).toContain("within soft limit · soft limit 29.4k");
    expect(output).toContain("1 context reduction · saved ~2k");
    expect(output).toContain("10.2k total");
    expect(rail.statusLine(80, createPainter(false))).toBe("model · est ~10k/32.8k · ▰▰▱▱▱ 31%");
  });

  test("tracks changed files and validation outcomes", () => {
    const rail = new CliContextRail({ id: "model", provider: "local" }, "/tmp/project");
    rail.begin(true);
    rail.apply(event("tool.call_requested", {
      toolCallId: "edit",
      name: "edit_file",
      arguments: JSON.stringify({ path: "src/main.ts" }),
    }));
    rail.apply(event("tool.call_completed", {
      toolCallId: "edit",
      name: "edit_file",
      path: "src/main.ts",
      created: false,
    }));
    rail.apply(event("tool.call_requested", {
      toolCallId: "test",
      name: "run_command",
      arguments: JSON.stringify({ argv: ["bun", "test"] }),
    }));
    rail.apply(event("tool.call_completed", {
      toolCallId: "test",
      name: "run_command",
      exitCode: 0,
    }));

    const output = rail.lines(32, 30, createPainter(false)).join("\n");
    expect(output).toContain("✓ M src/main.ts");
    expect(output).toContain("✓ bun test (0)");
  });

  test("bounds untrusted model, workspace, and activity labels", () => {
    const rail = new CliContextRail(
      { id: "模型模型模型-model-with-a-long-suffix\x1b[2J", provider: "provider\x1b]0;owned\x07", contextWindow: 32_768 },
      "/tmp/a/deliberately/long/workspace-name\nspoof",
    );
    rail.begin(true);
    rail.apply(event("tool.call_requested", {
      toolCallId: "edit",
      name: "edit_file",
      arguments: { path: "src/a-deliberately-long-name\x1b]0;owned\x07.ts" },
    }));
    const lines = rail.lines(40, 40, createPainter(false));
    expect(Math.max(...lines.map(visibleLength))).toBeLessThanOrEqual(40);
    expect(lines.join("\n")).not.toContain("\x1b");
  });
});

function event(type: EventType, payload: Record<string, unknown>): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: 1,
    type,
    occurredAt: "2026-08-24T00:00:00Z",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    agentRunId: null,
    payload,
  };
}
