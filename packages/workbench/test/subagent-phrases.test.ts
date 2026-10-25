import { expect, test } from "bun:test";
import { subagentStatus } from "../src/subagent-phrases.ts";

test("status-only progress lines are told apart from real steps", () => {
  expect(subagentStatus("starting")).toEqual({});
  expect(subagentStatus("qwen3.8-27b · thinking · 3 tool calls")).toEqual({ model: "qwen3.8-27b" });
  expect(subagentStatus("writing report")).toEqual({});
  expect(subagentStatus("read src/app.ts")).toBeNull();
  expect(subagentStatus("qwen3.8-27b · read src/app.ts")).toBeNull();
});
