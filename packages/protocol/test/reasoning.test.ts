import { expect, test } from "bun:test";
import { defaultThinkingLevel, resolveReasoningLevel, parseUpdateSessionRequest } from "../src/index.ts";

test("medium defaults only where supported; valid explicit effort wins", () => {
  const model = { reasoningLevels: ["none", "low", "medium", "high"], defaultReasoningLevel: "none" };
  expect(resolveReasoningLevel(model)).toBe("medium");
  expect(resolveReasoningLevel(model, "high")).toBe("high");
  expect(resolveReasoningLevel(model, "none")).toBe("none");
  expect(resolveReasoningLevel(model, "unsupported")).toBe("medium");
  expect(defaultThinkingLevel(["off", "on"])).toBe("off");
  expect(defaultThinkingLevel(["low", "high"])).toBe("low");
  expect(defaultThinkingLevel(["low", "high"], "high")).toBe("high");
  expect(defaultThinkingLevel([])).toBeUndefined();
  expect(defaultThinkingLevel(undefined)).toBeUndefined();
});

test("session API accepts effort alone, paired effort, and reset; rejects malformed values", () => {
  for (const preferredReasoning of ["medium", "high", "off", null]) {
    expect(parseUpdateSessionRequest({ preferredReasoning })).toEqual({ preferredReasoning });
    expect(parseUpdateSessionRequest({ preferredModel: "model", preferredReasoning })).toEqual({ preferredModel: "model", preferredReasoning });
  }
  for (const preferredReasoning of ["", "Medium", "x".repeat(17), 42, false, {}, []])
    expect(() => parseUpdateSessionRequest({ preferredReasoning })).toThrow("preferredReasoning");
});
