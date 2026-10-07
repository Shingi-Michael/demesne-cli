import { expect, test } from "bun:test";
import type { ModelScore } from "@demesne/protocol";
import { scoreboardTable } from "../src/model-scoreboard.ts";

const score: ModelScore = { provider: "ollama", model: "qwen3-coder", local: true, turns: 12, finished: 9, failed: 1, toolCalls: 40, toolErrors: 2,
  tokensPerSecond: 41.6, firstTokenMs: 1250, checkedTurns: 4, passingTurns: 3, driveRuns: 2, driveLanded: 1, lastUsed: "2026-10-07T00:00:00Z" };

test("the scoreboard prints one aligned row per model, with dashes for what wasn't measured", () => {
  const table = scoreboardTable({ days: 30, workspace: null, models: [score, { ...score, provider: "openrouter", model: "big", local: false, toolCalls: 0, toolErrors: 0, tokensPerSecond: null, firstTokenMs: null, checkedTurns: 0, passingTurns: 0, driveRuns: 0, driveLanded: 0 }] });
  const lines = table.split("\n");
  expect(lines[0]).toBe("Models on your own work across your projects, last 30 days");
  expect(lines[2]).toMatch(/^MODEL\s+TURNS\s+FINISHED\s+TOOLS OK\s+TOK\/S\s+1ST TOKEN\s+CHECKS\s+DRIVE KEPT$/);
  expect(lines[3]).toMatch(/^ollama \/ qwen3-coder \(local\)\s+12\s+90%\s+95%\s+42\s+1\.3s\s+3\/4\s+1\/2$/);
  expect(lines[4]).toMatch(/^openrouter \/ big\s+12\s+90%\s+—\s+—\s+—\s+—\s+—$/);
  expect(lines[3]!.length).toBe(lines[2]!.length);
  expect(scoreboardTable({ days: 7, workspace: "/w", models: [] })).toBe("No recorded model work in /w in the last 7 days.");
});
