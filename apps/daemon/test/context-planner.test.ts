import { describe, expect, test } from "bun:test";
import type { ProviderMessage } from "@demesne/providers";
import {
  planCacheAwareContextRequest,
  planContextRequest,
  planDelayedHardContextRequest,
  planRawContextRequest,
} from "../src/context-planner.ts";

describe("context planner", () => {
  test("raw planning preserves historical messages without reduction", () => {
    const content = Array.from({ length: 90 }, (_, index) => `${index}: ${"raw history ".repeat(20)}`).join("\n");
    const messages: ProviderMessage[] = [
      { role: "system", content: "System" },
      { role: "assistant", content: null, toolCalls: [{ id: "read", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "read", content },
      { role: "user", content: "Continue" },
    ];

    const planned = planRawContextRequest({
      messages,
      tools: [],
      historicalTurns: [{ id: "history", startMessageIndex: 1, endMessageIndex: 3 }],
      capacityTokens: 512,
      outputReserveTokens: 128,
    });

    expect(planned.messages).toEqual(messages);
    expect(planned.messages).not.toBe(messages);
    expect(planned.plan.actions).toEqual([]);
    expect(planned.droppedHistoricalTurnIds).toEqual([]);
    expect(planned.plan.estimatedInputTokens).toBe(planned.plan.originalEstimatedInputTokens);
    expect(planned.plan.budgetStatus).toBe("over_capacity");
  });

  test("delayed-hard planning preserves raw history through the soft-hard band", () => {
    const history = `history:${" cache-stable".repeat(500)}`;
    const messages: ProviderMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: history },
      { role: "assistant", content: "Historical answer" },
      { role: "user", content: "Continue" },
    ];
    const base = {
      messages,
      tools: [],
      historicalTurns: [{ id: "history", startMessageIndex: 1, endMessageIndex: 3 }],
      outputReserveTokens: 128,
    };
    const rawEstimate = planRawContextRequest(base).plan.originalEstimatedInputTokens;

    const planned = planDelayedHardContextRequest({
      ...base,
      capacityTokens: rawEstimate + 128,
    });

    expect(planned.plan.originalEstimatedInputTokens).toBeGreaterThan(planned.plan.maximumPlannedInputTokens!);
    expect(planned.plan.originalEstimatedInputTokens).toBeLessThanOrEqual(planned.plan.hardInputLimitTokens!);
    expect(planned.messages).toEqual(messages);
    expect(planned.plan.actions).toEqual([]);
    expect(planned.droppedHistoricalTurnIds).toEqual([]);
  });

  test("cache-aware planning preserves raw history through the soft-hard band", () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: `history:${" cache-stable".repeat(500)}` },
      { role: "assistant", content: "Historical answer" },
      { role: "user", content: "Continue" },
    ];
    const base = {
      messages,
      tools: [],
      historicalTurns: [{ id: "history", startMessageIndex: 1, endMessageIndex: 3 }],
      outputReserveTokens: 128,
    };
    const rawEstimate = planRawContextRequest(base).plan.originalEstimatedInputTokens;

    const planned = planCacheAwareContextRequest({
      ...base,
      capacityTokens: rawEstimate + 128,
    });

    expect(planned.plan.originalEstimatedInputTokens).toBeGreaterThan(planned.plan.maximumPlannedInputTokens!);
    expect(planned.messages).toEqual(messages);
    expect(planned.plan.actions).toEqual([]);
  });

  test("delayed-hard planning activates production reduction at hard plus one", () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: `old:${"a".repeat(6_000)}` },
      { role: "assistant", content: "Historical answer" },
      { role: "user", content: "Continue" },
    ];
    const base = {
      messages,
      tools: [],
      historicalTurns: [{ id: "history", startMessageIndex: 1, endMessageIndex: 3 }],
      outputReserveTokens: 128,
    };
    const rawEstimate = planRawContextRequest(base).plan.originalEstimatedInputTokens;

    const planned = planDelayedHardContextRequest({
      ...base,
      capacityTokens: rawEstimate + 128 - 1,
    });

    expect(planned.plan.originalEstimatedInputTokens).toBe(planned.plan.hardInputLimitTokens! + 1);
    expect(planned.plan.actions).toEqual([expect.objectContaining({ kind: "drop_historical_turn", turnId: "history" })]);
    expect(planned.plan.estimatedInputTokens).toBeLessThanOrEqual(planned.plan.hardInputLimitTokens!);
  });

  test("delayed-hard planning rejects an unknown hard limit", () => {
    expect(() => planDelayedHardContextRequest({
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
      historicalTurns: [],
      capacityTokens: 8_192,
    })).toThrow("requires a known hard input limit");
  });

  test("delayed-hard planning rejects irreducible protected content above hard", () => {
    expect(() => planDelayedHardContextRequest({
      messages: [{ role: "user", content: "z".repeat(6_000) }],
      tools: [],
      historicalTurns: [],
      capacityTokens: 512,
      outputReserveTokens: 128,
    })).toThrow("could not satisfy the hard input limit");
  });

  test("deterministically compacts only historical tool output and records the action", () => {
    const longOutput = Array.from({ length: 40 }, (_, index) => `${index}: ${"x".repeat(80)}`).join("\n");
    const messages: ProviderMessage[] = [
      { role: "system", content: "System" },
      { role: "assistant", content: null, toolCalls: [{ id: "old", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "old", content: longOutput },
      { role: "assistant", content: null, toolCalls: [{ id: "current", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "current", content: longOutput },
    ];
    const original = structuredClone(messages);
    const baseInput = {
      messages,
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
      historicalTurns: [{ id: "old-turn", startMessageIndex: 1, endMessageIndex: 3 }],
      outputReserveTokens: 1_536,
    };
    const rawEstimate = planRawContextRequest(baseInput).plan.estimatedInputTokens;
    const input = { ...baseInput, capacityTokens: rawEstimate + 1_536 + 768 + 512 - 1 };

    const first = planContextRequest(input);
    const second = planContextRequest(input);

    expect(first).toEqual(second);
    expect(messages).toEqual(original);
    expect(first.messages[2]?.content).toContain("15 lines truncated in conversation history");
    expect(first.messages[4]).toEqual(messages[4]);
    expect(first.plan.actions).toEqual([expect.objectContaining({
      kind: "truncate_historical_tool_output",
      messageIndex: 2,
      removedLines: 15,
    })]);
    expect(first.plan.originalEstimatedInputTokens).toBeGreaterThan(first.plan.estimatedInputTokens);
    expect(first.plan.actions.reduce((total, action) => total + action.estimatedTokensSaved, 0)).toBe(
      first.plan.originalEstimatedInputTokens - first.plan.estimatedInputTokens,
    );
    expect(first.plan.estimatedToolDefinitionTokens).toBeGreaterThan(0);
    expect(first.plan.budgetStatus).toBe("within_soft_limit");
  });

  test("reports unknown and exhausted budgets without dropping protected messages", () => {
    const messages: ProviderMessage[] = [{ role: "user", content: "z".repeat(3_000) }];

    const unknown = planContextRequest({ messages, tools: [], historicalTurns: [], capacityTokens: 512 });
    const exhausted = planContextRequest({
      messages,
      tools: [],
      historicalTurns: [],
      capacityTokens: 512,
      outputReserveTokens: 128,
    });

    expect(unknown.plan.budgetStatus).toBe("capacity_unknown");
    expect(unknown.plan.maximumPlannedInputTokens).toBeNull();
    expect(exhausted.plan.budgetStatus).toBe("over_capacity");
    expect(exhausted.messages).toEqual(messages);
    expect(exhausted.plan.actions).toEqual([]);
  });

  test("preserves historical context while the original request is within the soft limit", () => {
    const content = Array.from({ length: 50 }, (_, index) => `${index}: ${"cache-stable ".repeat(4)}`).join("\n");
    const messages: ProviderMessage[] = [
      { role: "system", content: "System" },
      { role: "assistant", content: null, toolCalls: [{ id: "read", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "read", content },
      { role: "user", content: "Continue" },
    ];

    const planned = planContextRequest({
      messages,
      tools: [],
      historicalTurns: [{ id: "history", startMessageIndex: 1, endMessageIndex: 3 }],
      capacityTokens: 8_192,
      outputReserveTokens: 1_536,
    });

    expect(planned.plan.originalEstimatedInputTokens).toBeLessThanOrEqual(planned.plan.maximumPlannedInputTokens!);
    expect(planned.messages).toEqual(messages);
    expect(planned.plan.actions).toEqual([]);
  });

  test("does not replace historical output when the marker would increase its estimate", () => {
    const sparseOutput = Array.from({ length: 31 }, () => "x").join("\n") + " ".repeat(2_050);
    const message: ProviderMessage = { role: "tool", toolCallId: "sparse", content: sparseOutput };

    const result = planContextRequest({
      messages: [message],
      tools: [],
      historicalTurns: [{ id: "old-turn", startMessageIndex: 0, endMessageIndex: 1 }],
      capacityTokens: 8_192,
      outputReserveTokens: 1_536,
    });

    expect(sparseOutput.length).toBeGreaterThan(2_048);
    expect(result.messages).toEqual([message]);
    expect(result.plan.actions).toEqual([]);
    expect(result.plan.estimatedInputTokens).toBe(result.plan.originalEstimatedInputTokens);
  });

  test("compacts newline-bearing fields in production JSON tool results", () => {
    const content = Array.from({ length: 90 }, (_, index) => `${index + 1}: ${"record".repeat(12)}`).join("\n");
    const toolResult = JSON.stringify({
      path: "data/history.txt",
      totalLines: 90,
      range: { from: 1, to: 90 },
      content,
      truncated: false,
      remainingLines: 0,
    });
    const message: ProviderMessage = { role: "tool", toolCallId: "read-history", content: toolResult };

    const historyMessages: ProviderMessage[] = [{ role: "system", content: "System" }, message];
    const baseInput = {
      messages: historyMessages,
      tools: [],
      historicalTurns: [{ id: "old-turn", startMessageIndex: 1, endMessageIndex: 2 }],
      outputReserveTokens: 1_536,
    };
    const rawEstimate = planRawContextRequest(baseInput).plan.estimatedInputTokens;
    const result = planContextRequest({ ...baseInput, capacityTokens: rawEstimate + 1_536 + 768 + 512 - 1 });
    const compactedMessage = result.messages[1];
    expect(compactedMessage?.role).toBe("tool");
    const compacted = JSON.parse(compactedMessage?.content ?? "") as { content: string };

    expect(result.plan.actions).toEqual([expect.objectContaining({
      kind: "truncate_historical_tool_output",
      messageIndex: 1,
      removedLines: 65,
    })]);
    expect(compacted.content).toContain("1: record");
    expect(compacted.content).toContain("15: record");
    expect(compacted.content).toContain("81: record");
    expect(compacted.content).toContain("90: record");
    expect(compacted.content).toContain("65 lines truncated in conversation history");
    expect(result.plan.actions[0]?.estimatedTokensSaved).toBeGreaterThan(0);
    expect(JSON.parse(message.content)).toEqual(expect.objectContaining({ content }));
  });

  test("deduplicates only exact older historical file reads and preserves tool-result pairing", () => {
    const content = `1: ${"same file bytes ".repeat(70)}`;
    const result = JSON.stringify({
      path: "src/repeated.ts",
      totalLines: 1,
      range: { from: 1, to: 1 },
      content,
      truncated: false,
      remainingLines: 0,
    });
    const messages: ProviderMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "Read it first" },
      { role: "assistant", content: null, toolCalls: [{ id: "older-read", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "older-read", content: result },
      { role: "assistant", content: "First read complete" },
      { role: "user", content: "Read it again" },
      { role: "assistant", content: null, toolCalls: [{ id: "newer-read", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "newer-read", content: result },
      { role: "assistant", content: "Second read complete" },
      { role: "user", content: "Continue" },
    ];
    const original = structuredClone(messages);

    const baseInput = {
      messages,
      tools: [],
      historicalTurns: [
        { id: "older", startMessageIndex: 1, endMessageIndex: 5 },
        { id: "newer", startMessageIndex: 5, endMessageIndex: 9 },
      ],
      outputReserveTokens: 1_536,
    };
    const rawEstimate = planRawContextRequest(baseInput).plan.estimatedInputTokens;
    const planned = planContextRequest({ ...baseInput, capacityTokens: rawEstimate + 1_536 + 768 + 512 - 1 });

    expect(messages).toEqual(original);
    expect(planned.messages).toHaveLength(messages.length);
    expect(planned.messages[2]).toEqual(messages[2]);
    expect(planned.messages[7]).toEqual(messages[7]);
    const olderResult = planned.messages[3];
    expect(olderResult?.role).toBe("tool");
    expect(olderResult?.role === "tool" ? olderResult.toolCallId : null).toBe("older-read");
    expect(JSON.parse(olderResult?.role === "tool" ? olderResult.content : "").content).toContain(
      "matched tool result newer-read before compaction",
    );
    expect(planned.messages[7]).toEqual(messages[7]);
    expect(planned.plan.actions).toEqual([expect.objectContaining({
      kind: "deduplicate_historical_file_content",
      messageIndex: 3,
      retainedMessageIndex: 7,
      toolCallId: "older-read",
      retainedToolCallId: "newer-read",
      path: "src/repeated.ts",
    })]);
    expect(planned.droppedHistoricalTurnIds).toEqual([]);
  });

  test("cache-aware hard compaction retains the oldest duplicate and rewrites the newer result", () => {
    const content = `1: ${"same file bytes ".repeat(400)}`;
    const result = JSON.stringify({
      path: "src/repeated.ts",
      totalLines: 1,
      range: { from: 1, to: 1 },
      content,
      truncated: false,
      remainingLines: 0,
    });
    const messages: ProviderMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "Read it first" },
      { role: "assistant", content: null, toolCalls: [{ id: "older-read", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "older-read", content: result },
      { role: "assistant", content: "First read complete" },
      { role: "user", content: "Read it again" },
      { role: "assistant", content: null, toolCalls: [{ id: "newer-read", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "newer-read", content: result },
      { role: "assistant", content: "Second read complete" },
      { role: "user", content: "Continue" },
    ];
    const base = {
      messages,
      tools: [],
      historicalTurns: [
        { id: "older", startMessageIndex: 1, endMessageIndex: 5 },
        { id: "newer", startMessageIndex: 5, endMessageIndex: 9 },
      ],
      outputReserveTokens: 128,
    };
    const rawEstimate = planRawContextRequest(base).plan.originalEstimatedInputTokens;
    const planned = planCacheAwareContextRequest({
      ...base,
      capacityTokens: rawEstimate + 128 - 1,
    });

    expect(planned.messages[3]).toEqual(messages[3]);
    expect(planned.plan.actions[0]).toEqual(expect.objectContaining({
      kind: "deduplicate_historical_file_content",
      messageIndex: 7,
      retainedMessageIndex: 3,
      toolCallId: "newer-read",
      retainedToolCallId: "older-read",
    }));
  });

  test("compacts older current-turn tool output while preserving the newest result batch", () => {
    const oldOutput = Array.from({ length: 200 }, (_, index) => `${index}: ${"old evidence ".repeat(20)}`).join("\n");
    const newestOutput = Array.from({ length: 60 }, (_, index) => `${index}: ${"fresh evidence ".repeat(10)}`).join("\n");
    const messages: ProviderMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "Inspect the project" },
      { role: "assistant", content: null, toolCalls: [{ id: "old", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "old", content: oldOutput },
      { role: "assistant", content: null, toolCalls: [{ id: "fresh", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "fresh", content: newestOutput },
    ];
    const base = { messages, tools: [], historicalTurns: [], outputReserveTokens: 128 };
    const rawEstimate = planRawContextRequest(base).plan.originalEstimatedInputTokens;

    const planned = planCacheAwareContextRequest({
      ...base,
      capacityTokens: rawEstimate + 128 - 1,
    });

    expect(planned.plan.estimatedInputTokens).toBeLessThanOrEqual(planned.plan.hardInputLimitTokens!);
    expect(planned.plan.actions).toContainEqual(expect.objectContaining({
      kind: "truncate_historical_tool_output",
      scope: "current_turn",
      messageIndex: 3,
    }));
    expect(planned.messages[3]?.content).toContain("lines truncated in conversation history");
    expect(planned.messages[5]).toEqual(messages[5]);
  });

  test("does not deduplicate changed file content or an active current-turn result", () => {
    const fileResult = (content: string) => JSON.stringify({
      path: "src/changing.ts",
      totalLines: 1,
      range: { from: 1, to: 1 },
      content,
      truncated: false,
      remainingLines: 0,
    });
    const messages: ProviderMessage[] = [
      { role: "system", content: "System" },
      { role: "assistant", content: null, toolCalls: [{ id: "old", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "old", content: fileResult("old content ".repeat(80)) },
      { role: "assistant", content: null, toolCalls: [{ id: "new", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "new", content: fileResult("new content ".repeat(80)) },
      { role: "assistant", content: null, toolCalls: [{ id: "active", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "active", content: fileResult("old content ".repeat(80)) },
    ];

    const planned = planContextRequest({
      messages,
      tools: [],
      historicalTurns: [
        { id: "old", startMessageIndex: 1, endMessageIndex: 3 },
        { id: "new", startMessageIndex: 3, endMessageIndex: 5 },
      ],
      capacityTokens: 8_192,
      outputReserveTokens: 1_536,
    });

    expect(planned.messages).toEqual(messages);
    expect(planned.plan.actions).toEqual([]);
  });

  test("deduplicates read_files entries only when their complete metadata also matches", () => {
    const file = {
      path: "src/batch.ts",
      totalLines: 1,
      range: { from: 1, to: 1 },
      content: `1: ${"batch content ".repeat(70)}`,
      truncated: true,
      remainingLines: 0,
      note: "content truncated by batch budget",
    };
    const batchResult = (note: string) => JSON.stringify({ results: [{ ...file, note }] });
    const messages: ProviderMessage[] = [
      { role: "system", content: "System" },
      { role: "assistant", content: null, toolCalls: [{ id: "old-batch", name: "read_files", arguments: "{}" }] },
      { role: "tool", toolCallId: "old-batch", content: batchResult(file.note) },
      { role: "assistant", content: null, toolCalls: [{ id: "new-batch", name: "read_files", arguments: "{}" }] },
      { role: "tool", toolCallId: "new-batch", content: batchResult(file.note) },
      { role: "user", content: "Continue" },
    ];
    const baseInput = {
      messages,
      tools: [],
      historicalTurns: [
        { id: "old", startMessageIndex: 1, endMessageIndex: 3 },
        { id: "new", startMessageIndex: 3, endMessageIndex: 5 },
      ],
      outputReserveTokens: 1_536,
    };
    const rawEstimate = planRawContextRequest(baseInput).plan.estimatedInputTokens;
    const input = { ...baseInput, capacityTokens: rawEstimate + 1_536 + 768 + 512 - 1 };

    const exact = planContextRequest(input);
    const compacted = exact.messages[2];
    const parsed = JSON.parse(compacted?.role === "tool" ? compacted.content : "") as {
      results: Array<{ content: string; note: string }>;
    };
    expect(exact.plan.actions).toEqual([expect.objectContaining({
      kind: "deduplicate_historical_file_content",
      messageIndex: 2,
      retainedMessageIndex: 4,
      path: "src/batch.ts",
    })]);
    expect(parsed.results[0]?.content).toContain("matched tool result new-batch before compaction");
    expect(parsed.results[0]?.note).toBe(file.note);

    const differentMetadata = structuredClone(messages);
    const newer = differentMetadata[4];
    if (newer?.role === "tool") newer.content = batchResult("different truncation reason");
    expect(planContextRequest({ ...input, messages: differentMetadata }).plan.actions).toEqual([]);

    const malformedMetadata = structuredClone(messages);
    for (const index of [2, 4]) {
      const message = malformedMetadata[index];
      if (message?.role !== "tool") continue;
      const malformed = JSON.parse(message.content) as { results: Array<{ totalLines: number }> };
      malformed.results[0]!.totalLines = -1;
      message.content = JSON.stringify(malformed);
    }
    expect(planContextRequest({ ...input, messages: malformedMetadata }).plan.actions.some(
      (action) => action.kind === "deduplicate_historical_file_content",
    )).toBe(false);
  });

  test("orders deduplication, truncation, and complete-turn removal while preserving changed content", () => {
    const stableContent = Array.from({ length: 90 }, (_, index) => `${index + 1}: ${"stable".repeat(12)}`).join("\n");
    const changingA = Array.from({ length: 20 }, (_, index) => `${index + 1}: version-a`).join("\n");
    const changingB = Array.from({ length: 20 }, (_, index) => `${index + 1}: version-b`).join("\n");
    const readValue = (path: string, content: string, totalLines: number) => ({
      path,
      totalLines,
      range: { from: 1, to: totalLines },
      content,
      truncated: false,
      remainingLines: 0,
    });
    const batch = (changing: string) => JSON.stringify({ results: [
      readValue("data/stable.txt", stableContent, 90),
      readValue("data/changing.txt", changing, 20),
    ] });
    const firstTurn: ProviderMessage[] = [
      { role: "user", content: "Read version A" },
      { role: "assistant", content: null, toolCalls: [{ id: "read-a", name: "read_files", arguments: "{}" }] },
      { role: "tool", toolCallId: "read-a", content: batch(changingA) },
      { role: "assistant", content: "Read A" },
    ];
    const secondTurn: ProviderMessage[] = [
      { role: "user", content: "Read version B" },
      { role: "assistant", content: null, toolCalls: [{ id: "read-b", name: "read_files", arguments: "{}" }] },
      { role: "tool", toolCallId: "read-b", content: batch(changingB) },
      { role: "assistant", content: "Read B" },
    ];
    const system: ProviderMessage = { role: "system", content: "System" };
    const current: ProviderMessage = { role: "user", content: `Continue ${"padding ".repeat(200)}` };
    const messages = [system, ...firstTurn, ...secondTurn, current];
    const historicalTurns = [
      { id: "first", startMessageIndex: 1, endMessageIndex: 5 },
      { id: "second", startMessageIndex: 5, endMessageIndex: 9 },
    ];
    const deterministic = planContextRequest({ messages, tools: [], historicalTurns });
    const retainedOnly = planContextRequest({
      messages: [system, ...secondTurn, current],
      tools: [],
      historicalTurns: [{ id: "second", startMessageIndex: 1, endMessageIndex: 5 }],
    });
    const outputReserveTokens = 128;
    const reducedWithoutDrop = planContextRequest({
      messages,
      tools: [],
      historicalTurns,
      capacityTokens: retainedOnly.plan.estimatedInputTokens + outputReserveTokens + 768 + 512,
      outputReserveTokens,
    });
    const planned = planContextRequest({
      messages,
      tools: [],
      historicalTurns,
      capacityTokens: reducedWithoutDrop.plan.estimatedInputTokens + outputReserveTokens + 768 + 512 - 1,
      outputReserveTokens,
    });

    expect(deterministic.plan.actions).toEqual([]);
    expect(deterministic.messages).toEqual(messages);
    expect(planned.plan.actions.map((action) => action.kind)).toEqual([
      "deduplicate_historical_file_content",
      "truncate_historical_tool_output",
      "drop_historical_turn",
    ]);
    expect(planned.droppedHistoricalTurnIds).toEqual(["first"]);
    expect(planned.messages).toHaveLength(6);
    expect(planned.messages[2]).toEqual(secondTurn[1]);
    const retainedResult = planned.messages[3];
    expect(retainedResult?.role).toBe("tool");
    expect(retainedResult?.role === "tool" ? retainedResult.toolCallId : null).toBe("read-b");
    const parsed = JSON.parse(retainedResult?.role === "tool" ? retainedResult.content : "") as {
      results: Array<{ path: string; content: string }>;
    };
    expect(parsed.results.find((entry) => entry.path === "data/changing.txt")?.content).toBe(changingB);
    expect(parsed.results.find((entry) => entry.path === "data/stable.txt")?.content).toContain(
      "lines truncated in conversation history",
    );
    expect(planned.plan.actions.reduce((total, action) => total + action.estimatedTokensSaved, 0)).toBe(
      planned.plan.originalEstimatedInputTokens - planned.plan.estimatedInputTokens,
    );
  });

  test("drops complete oldest turns one at a time until the calibrated soft limit is met", () => {
    const firstTurn: ProviderMessage[] = [
      { role: "user", content: `first:${"a".repeat(1_500)}` },
      { role: "assistant", content: "first answer" },
    ];
    const secondTurn: ProviderMessage[] = [
      { role: "user", content: `second:${"b".repeat(1_500)}` },
      { role: "assistant", content: "second answer" },
    ];
    const system: ProviderMessage = { role: "system", content: "System" };
    const current: ProviderMessage = { role: "user", content: "Current request" };
    const retainedEstimate = planContextRequest({
      messages: [system, ...secondTurn, current],
      tools: [],
      historicalTurns: [{ id: "second", startMessageIndex: 1, endMessageIndex: 3 }],
    }).plan.estimatedInputTokens;
    const outputReserveTokens = 128;
    const messages = [system, ...firstTurn, ...secondTurn, current];

    const planned = planContextRequest({
      messages,
      tools: [],
      historicalTurns: [
        { id: "first", startMessageIndex: 1, endMessageIndex: 3 },
        { id: "second", startMessageIndex: 3, endMessageIndex: 5 },
      ],
      capacityTokens: retainedEstimate + outputReserveTokens + 768 + 512,
      outputReserveTokens,
    });

    expect(planned.droppedHistoricalTurnIds).toEqual(["first"]);
    expect(planned.messages).toEqual([system, ...secondTurn, current]);
    expect(planned.plan.budgetStatus).toBe("within_soft_limit");
    expect(planned.plan.actions).toEqual([expect.objectContaining({
      kind: "drop_historical_turn",
      turnId: "first",
      messageStartIndex: 1,
      messageCount: 2,
    })]);
    expect(planned.plan.actions.reduce((total, action) => total + action.estimatedTokensSaved, 0)).toBe(
      planned.plan.originalEstimatedInputTokens - planned.plan.estimatedInputTokens,
    );
  });
});
