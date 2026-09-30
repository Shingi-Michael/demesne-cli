import { describe, expect, test } from "bun:test";
import { createPainter, visibleLength } from "@demesne/brand";
import type { EventEnvelope, EventType } from "@demesne/protocol";
import { CliContextRail } from "../src/context-rail.ts";

describe("CLI context rail", () => {
  test("compaction switches the estimate while keeping the actual summarizer usage separate", () => {
    const rail = new CliContextRail({ id: "model", provider: "local", contextWindow: 100000 }, "/project");
    const paint = createPainter(false);
    rail.apply(event("model.usage", { inputTokens: 15000, outputTokens: 500, totalTokens: 15500 }));
    rail.apply(event("session.compacted", { checkpoint: { contextPlan: {
      schemaVersion: 3, estimator: { method: "openai-json-utf8-bytes-divisor-3", version: 2, safetyFactor: 1.2 },
      capacityTokens: 100000, reserves: { outputTokens: 8192, toolResultTokens: 768, safetyTokens: 512, totalTokens: 9472 },
      maximumPlannedInputTokens: 90528, hardInputLimitTokens: 91808, originalEstimatedInputTokens: 2000,
      estimatedInputTokens: 2000, estimatedMessageTokens: 1500, estimatedToolDefinitionTokens: 500, budgetStatus: "within_soft_limit", actions: [],
    } } }));
    expect(rail.contextSnapshot).toEqual({ used: 2000, capacity: 100000, estimated: true });
    expect(rail.contextSummary(paint)).toBe("Context ~2k/100k · 2%");
    expect(rail.lines(80, 60, paint).join("\n")).toContain("15k in · 500 out");
  });
  test("generation speed waits for provider measurements and excludes first-token latency", () => {
    const rail = new CliContextRail({ id: "model", provider: "local" }, "/project");
    expect(rail.tokensPerSecond).toBeNull();
    rail.apply(event("message.delta", { delta: "a stream chunk is not a token" }));
    expect(rail.tokensPerSecond).toBeNull();
    rail.apply(event("model.usage", { outputTokens: 120 }));
    expect(rail.tokensPerSecond).toBeNull();
    rail.apply(event("model.metrics", { durationMs: 10_000, timeToFirstTokenMs: 2_000 }));
    expect(rail.tokensPerSecond).toBe(15);
    rail.apply(event("turn.completed", {}));
    expect(rail.tokensPerSecond).toBe(15);
    rail.begin(true);
    expect(rail.tokensPerSecond).toBeNull();
    rail.apply(event("model.request_started", {}));
    rail.apply(event("model.metrics", { durationMs: 2_000 }));
    expect(rail.tokensPerSecond).toBeNull();
    rail.apply(event("model.usage", { outputTokens: 40 }));
    expect(rail.tokensPerSecond).toBe(20);
  });
  test("compact context counts distinguish unknown usage from last reported usage", () => {
    const rail = new CliContextRail({ id: "model", provider: "local", contextWindow: 100_000 }, "/project");
    const paint = createPainter(false);
    expect(rail.contextSummary(paint)).toBe("Context —/100k");
    rail.apply(event("model.usage", { inputTokens: 3_900, outputTokens: 100, totalTokens: 4_000 }));
    expect(rail.contextSummary(paint)).toBe("Context last 4k/100k · 4%");
    rail.apply(event("model.request_started", { model: "model" }));
    expect(rail.contextSummary(paint)).toBe("Context —/100k");
  });
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
    expect(output).toMatch(/LAST REQUEST +reported by provider/);
    expect(output).toContain("8.2k total");
    expect(output).toContain("7k in · 1.2k out");
    expect(output).toMatch(/thinking +off/);
    expect(output).toContain("6.5k cached");
    for (const field of ["queue 350ms", "first token 240ms", "request 1.3s"]) expect(output).toContain(field);
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
    expect(output).toContain("6.5k cached");
    for (const field of ["queue 350ms", "first token 240ms", "request 1.3s"]) expect(output).toContain(field);
  });

  test("pairs usage and metrics into a throughput sparkline", () => {
    const rail = new CliContextRail({ id: "qwen3:14b", provider: "ollama", contextWindow: 32_768 }, "/tmp/project");
    rail.begin(false);
    rail.apply(event("model.usage", { inputTokens: 1_000, outputTokens: 300, totalTokens: 1_300, providerCallId: "call-a" }));
    rail.apply(event("model.metrics", { durationMs: 1_000, timeToFirstTokenMs: 200, providerCallId: "call-a" }));
    rail.apply(event("model.usage", { inputTokens: 1_000, outputTokens: 600, totalTokens: 1_600, providerCallId: "call-b" }));
    rail.apply(event("model.metrics", { durationMs: 2_000, timeToFirstTokenMs: 200, providerCallId: "call-b" }));

    const output = rail.lines(48, 30, createPainter(false)).join("\n");
    expect(output).toContain("tok/s");
    expect(output).toContain("2 rounds");
    // The newest rate wins the label: 600 tokens over 2s.
    expect(output).toContain("300.0 tok/s");

    // A round without its counterpart never contributes a rate.
    rail.apply(event("model.usage", { inputTokens: 1, outputTokens: 10, totalTokens: 11, providerCallId: "call-c" }));
    const pending = rail.lines(48, 30, createPainter(false)).join("\n");
    expect(pending).toContain("2 rounds");
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
    expect(rail.statusLine(80, createPainter(false))).toBe("ctx 32.8k · no request yet");
    rail.apply(event("model.usage", { inputTokens: 7_000, outputTokens: 1_192, totalTokens: 8_192 }));
    expect(rail.statusLine(80, createPainter(false))).toBe("last 8.2k/32.8k · ▰▱▱▱▱ 25%");

    // Turn 2 begins: prior usage must not be attributed to the new provider request.
    rail.begin(false);
    rail.apply(event("model.request_started", { model: "qwen3:14b" }));
    expect(rail.statusLine(80, createPainter(false))).toBe("ctx 32.8k · no request yet");
    expect(rail.lines(40, 30, createPainter(false)).join("\n")).toMatch(/LAST REQUEST +reported by provider\nusage pending/);

    // Turn 2 provider usage arrives and updates context counts
    rail.apply(event("model.usage", { inputTokens: 9_000, outputTokens: 1_000, totalTokens: 10_000 }));
    expect(rail.statusLine(80, createPainter(false))).toBe("last 10k/32.8k · ▰▰▱▱▱ 31%");

    const unknown = new CliContextRail({ id: "m", provider: "local" }, "/tmp/project");
    unknown.apply(event("model.usage", { inputTokens: 10, outputTokens: 5, totalTokens: 15 }));
    expect(unknown.statusLine(80, createPainter(false))).toBe("last 15");
  });

  test("does not repeat the workspace branch, which the header already carries", () => {
    const rail = new CliContextRail({ id: "qwen", provider: "llama.cpp", contextWindow: 32_768 }, "/tmp/project");
    rail.setBranch("feature/durable-sessions");
    expect(rail.statusLine(100, createPainter(false))).toBe("ctx 32.8k · no request yet");
    // The branch is still available for the header to render.
    expect(rail.workspaceBranch).toBe("feature/durable-sessions");
  });

  test("drops the verbose counts before the meter as the footer narrows", () => {
    const rail = new CliContextRail({ id: "qwen3.8-q4_0-100k-b256", provider: "llama.cpp", contextWindow: 100_000 }, "/tmp/project");
    rail.apply(event("model.usage", { inputTokens: 3_400, outputTokens: 120, totalTokens: 3_520 }));

    // Wide: the absolute counts and the meter.
    expect(rail.statusLine(200, createPainter(false))).toBe("last 3.5k/100k · ▱▱▱▱▱ 4%");

    // Narrow: the meter is the last thing standing, because the warning outranks
    // the verbose counts.
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

  test("exposes verified speculation for the header, not the footer", () => {
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
    // The runtime is identity, so the header renders it and the footer does not.
    expect(rail.runtimeSummary).toEqual({ label: "✓ ngram-mod", state: "verified" });
    expect(rail.statusLine(100, createPainter(false))).not.toContain("ngram-mod");
    expect(rail.statusLine(100, createPainter(false))).not.toContain("qwen");
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
    expect(output).toMatch(/CONTEXT PLAN +estimated before request/);
    expect(output).toMatch(/~10k of \S+ · 31%/);
    // The stacked bar's legend carries the breakdown.
    expect(output).toContain("Messages ~7.6k");
    expect(output).toContain("Tool definitions ~2.4k");
    expect(output).toMatch(/reserves +output 2k · results 768 · safety 512/);
    expect(output).toContain("within soft limit · soft limit 29.4k");
    expect(output).toContain("1 applied · saved ~2k");
    expect(output).toContain("10.2k total");
    expect(rail.statusLine(80, createPainter(false))).toBe("est ~10k/32.8k · ▰▰▱▱▱ 31%");
    expect(rail.contextSummary(createPainter(false))).toBe("Context ~10k/32.8k · 31%");
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

  test("Context distinguishes approval, stopped commands, denial and unknown exits", () => {
    const rail = new CliContextRail({ id: "model", provider: "local" }, "/project");
    const output = () => rail.lines(80, 40, createPainter(false)).join("\n");
    rail.begin(true);
    rail.apply(event("tool.call_requested", { toolCallId: "check", name: "run_command", arguments: { argv: ["bun", "test"] } }));
    rail.apply(event("permission.requested", { toolCallId: "check" }));
    expect(output()).toContain("bun test · awaiting approval");
    rail.apply(event("permission.resolved", { toolCallId: "check", decision: "allow_once" }));
    rail.apply(event("tool.call_started", { toolCallId: "check" }));
    expect(output()).not.toContain("bun test · awaiting approval");
    rail.apply(event("tool.call_cancelled", { toolCallId: "check", exitCode: 130 }));
    rail.apply(event("turn.cancelled", {}));
    expect(output()).toContain("■ bun test · stopped (130)");
    expect(output()).not.toContain("failed");
    rail.apply(event("tool.call_requested", { toolCallId: "deny", name: "run_command", arguments: { argv: ["bun", "run", "lint"] } }));
    rail.apply(event("tool.call_denied", { toolCallId: "deny" }));
    expect(output()).toContain("bun run lint · denied");
    rail.apply(event("tool.call_requested", { toolCallId: "unknown", name: "run_command", arguments: { argv: ["bun", "run", "typecheck"] } }));
    rail.apply(event("tool.call_completed", { toolCallId: "unknown" }));
    expect(output()).toContain("· bun run typecheck · unknown");
    expect(output()).not.toContain("✓ bun run typecheck");
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
