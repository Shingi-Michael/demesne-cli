import { expect, test } from "bun:test";
import type { OllamaRunnerProcess } from "../src/ollama-runtime.ts";
import { evaluateMixedAgentRecycleSummary } from "../src/mixed-agent-recycle-benchmark.ts";

const first = runner(100);
const second = runner(200);

test("mixed-agent recycle summary accepts a contiguous threshold recycle", () => {
  expect(evaluateMixedAgentRecycleSummary({
    mode: "threshold",
    maximumRecycles: 2,
    functionalValid: true,
    provenanceComplete: true,
    runnersBefore: [first],
    runnersAfter: [second],
    transitions: [{ runnersBefore: [first], runnersAfter: [second] }],
    recycleCount: 1,
    drainTimeoutCount: 0,
    swapOutBytes: 0,
  })).toEqual({
    functionalValid: true,
    provenanceComplete: true,
    contiguousRunnerLifecycleValid: true,
    recycleCountValid: true,
    zeroDrainTimeouts: true,
    zeroSwapOutGrowth: true,
    memoryEligible: true,
    experimentValid: true,
  });
});

test("mixed-agent recycle summary requires zero disabled transitions and complete gates", () => {
  const validDisabled = evaluateMixedAgentRecycleSummary({
    mode: "disabled",
    maximumRecycles: 1,
    functionalValid: true,
    provenanceComplete: true,
    runnersBefore: [first],
    runnersAfter: [first],
    transitions: [],
    recycleCount: 0,
    drainTimeoutCount: 0,
    swapOutBytes: 0,
  });
  const invalidDisabled = evaluateMixedAgentRecycleSummary({
    mode: "disabled",
    maximumRecycles: 1,
    functionalValid: true,
    provenanceComplete: true,
    runnersBefore: [first],
    runnersAfter: [second],
    transitions: [{ runnersBefore: [first], runnersAfter: [second] }],
    recycleCount: 1,
    drainTimeoutCount: 1,
    swapOutBytes: 4_096,
  });

  expect(validDisabled).toMatchObject({
    contiguousRunnerLifecycleValid: true,
    recycleCountValid: true,
    experimentValid: true,
  });
  expect(invalidDisabled).toMatchObject({
    recycleCountValid: false,
    zeroDrainTimeouts: false,
    zeroSwapOutGrowth: false,
    memoryEligible: false,
    experimentValid: false,
  });
});

function runner(pid: number): OllamaRunnerProcess {
  return { pid, commandLine: `llama-server --model test-${pid}` };
}
