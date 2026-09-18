import { expect, test } from "bun:test";
import type { OllamaRunnerProcess } from "../src/ollama-runtime.ts";
import { validateRunnerTransitionChain } from "../src/scheduling-recycle-benchmark.ts";

const first = runner(100);
const second = runner(200);
const third = runner(300);

test("scheduling recycle report accepts a complete multi-runner transition chain", () => {
  expect(validateRunnerTransitionChain([first], [third], [
    { runnersBefore: [first], runnersAfter: [second] },
    { runnersBefore: [second], runnersAfter: [third] },
  ], 2)).toEqual({ runnerReplaced: true, runnerLifecycleValid: true });
});

test("scheduling recycle report rejects a broken or miscounted transition chain", () => {
  expect(validateRunnerTransitionChain([first], [third], [
    { runnersBefore: [first], runnersAfter: [second] },
    { runnersBefore: [first], runnersAfter: [third] },
  ], 2)).toEqual({ runnerReplaced: true, runnerLifecycleValid: false });
  expect(validateRunnerTransitionChain([first], [second], [
    { runnersBefore: [first], runnersAfter: [second] },
  ], 2).runnerLifecycleValid).toBe(false);
});

function runner(pid: number): OllamaRunnerProcess {
  return { pid, commandLine: `llama-server --model test-${pid}` };
}
