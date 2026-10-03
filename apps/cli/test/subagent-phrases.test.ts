import { expect, test } from "bun:test";
import { SUBAGENT_PHRASE_MS, subagentPhrase, subagentStatus } from "../src/workbench/subagent-phrases.ts";

test("phrases mix bad intentions and gremlin energy with pokes at the sub-agent's model", () => {
  const cycle = (model: string) => new Set(Array.from({ length: 40 }, (_, tick) => subagentPhrase(0, tick * SUBAGENT_PHRASE_MS, model)));
  const qwen = cycle("qwen3.8-27b"), astra = cycle("gpt-6-astra"), other = cycle("llama-3");
  expect(qwen.has("Dreaming about rm -rf") && qwen.has("Licking the semicolons") && qwen.has("Qwen-ing it")).toBe(true);
  expect(qwen.has("Burning plan credits")).toBe(false);
  expect(astra.has("Consulting the stars") && !astra.has("Heating up your PC")).toBe(true);
  expect([...other].some((phrase) => /Qwen|stars|plan credits/.test(phrase))).toBe(false);
  // A phrase holds for a tick, and parallel cards never say the same thing.
  expect(subagentPhrase(0, 10, "qwen")).toBe(subagentPhrase(0, SUBAGENT_PHRASE_MS - 10, "qwen"));
  for (let tick = 0; tick < 60; tick++) {
    const now = tick * SUBAGENT_PHRASE_MS + 5;
    expect(new Set([0, 1, 2, 3, 4].map((slot) => subagentPhrase(slot, now, "qwen3.8-27b"))).size).toBe(5);
  }
});

test("status-only progress lines are told apart from real steps", () => {
  expect(subagentStatus("starting")).toEqual({});
  expect(subagentStatus("qwen3.8-27b · thinking · 3 tool calls")).toEqual({ model: "qwen3.8-27b" });
  expect(subagentStatus("writing report")).toEqual({});
  expect(subagentStatus("read src/app.ts")).toBeNull();
  expect(subagentStatus("qwen3.8-27b · read src/app.ts")).toBeNull();
});
