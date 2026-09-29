import { expect, test } from "bun:test";
import { createPainter, visibleLength } from "@demesne/brand";
import type { ContextPlan } from "@demesne/protocol";
import { contextUsageStack } from "../src/context-usage.ts";

const plan = (): ContextPlan => ({ schemaVersion: 3, estimator: { method: "openai-json-utf8-bytes-divisor-3", version: 2, safetyFactor: 1.2 },
  capacityTokens: 100, estimatedMessageTokens: 20, estimatedToolDefinitionTokens: 10, estimatedInputTokens: 30, originalEstimatedInputTokens: 30,
  reserves: { outputTokens: 20, toolResultTokens: 5, safetyTokens: 5, totalTokens: 30 }, maximumPlannedInputTokens: 70, hardInputLimitTokens: 80, budgetStatus: "within_soft_limit", actions: [] });

test("stack accounts for input components, reserved capacity and free space without double counting", () => {
  const rows = contextUsageStack(plan(), 10, createPainter(false));
  expect(rows[0]).toBe("MMTRRR····");
  expect(rows.slice(1)).toEqual(["M Messages ~20", "T Tool definitions ~10", "R Reserved ~30", "· Available ~40"]);
  for (const width of [1, 3, 16, 31, 80]) for (const theme of ["demesne", "demesne-light", "nord"]) {
    expect(visibleLength(contextUsageStack(plan(), width, createPainter(true, theme))[0]!)).toBe(width);
  }
});

test("over-capacity plans saturate without negative space and remain visibly over budget", () => {
  const p = plan(); p.estimatedMessageTokens = 90; p.estimatedInputTokens = 100;
  const rows = contextUsageStack(p, 10, createPainter(false));
  expect(rows[0]).toBe("MMMMMMMMMT"); expect(rows).toContain("· Available ~0"); expect(rows.at(-1)).toBe("Over capacity by ~30");
});

test("unknown or inconsistent plans do not invent available context", () => {
  const p = plan(); p.capacityTokens = null;
  expect(contextUsageStack(p, 20, createPainter(false)).join("\n")).toContain("capacity unknown");
  p.capacityTokens = 100; p.reserves.totalTokens = null;
  expect(contextUsageStack(p, 20, createPainter(false)).join("\n")).toContain("breakdown unknown");
  p.reserves.totalTokens = 30; p.estimatedMessageTokens = 80;
  expect(contextUsageStack(p, 20, createPainter(false)).join("\n")).toContain("inconsistent plan");
});
