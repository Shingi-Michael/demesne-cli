import { expect, test } from "bun:test";
import { subagentPhrase } from "../src/subagent-phrases.ts";
import { subagentStatus } from "../src/subagent-status.ts";

test("status-only progress lines are told apart from real steps", () => {
  expect(subagentStatus("starting")).toEqual({});
  expect(subagentStatus("qwen3.8-27b · thinking · 3 tool calls")).toEqual({ model: "qwen3.8-27b" });
  expect(subagentStatus("writing report")).toEqual({});
  expect(subagentStatus("read src/app.ts")).toBeNull();
  expect(subagentStatus("qwen3.8-27b · read src/app.ts")).toBeNull();
});

test("a working sub-agent's saying cycles on one clock, offset per agent, through every phrase", () => {
  const seen = new Set<string>();
  for (let tick = 0; tick < 40; tick++) seen.add(subagentPhrase(0, tick * 4000));
  expect(seen.size).toBeGreaterThan(10);
  expect(subagentPhrase(0, 0)).not.toBe(subagentPhrase(1, 0));
  expect(subagentPhrase(0, 1000)).toBe(subagentPhrase(0, 3999));
  const qwen = Array.from({ length: 40 }, (_, tick) => subagentPhrase(0, tick * 4000, "qwen3.8-27b"));
  expect(["Qwen-ing it", "Locally overthinking", "Heating up your PC"].some((poke) => qwen.includes(poke))).toBe(true);
});
