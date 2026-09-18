import { expect, test } from "bun:test";
import { createInferenceRecycleController } from "../src/inference-recycle-controller.ts";

test("inference recycle controller requires both work and pressure thresholds", async () => {
  let availablePercent = 30;
  let now = 100;
  let recycles = 0;
  const controller = createInferenceRecycleController({
    workThreshold: 2,
    subsequentWorkThreshold: 1,
    availablePercentThreshold: 20,
    maximumRecycles: 1,
    memorySnapshot: () => memory(availablePercent),
    recycle: async () => {
      recycles += 1;
      now += 14_000;
    },
    now: () => now,
    observedAt: () => new Date("2026-08-28T00:00:00.000Z"),
  });
  const signal = new AbortController().signal;

  await controller.hook(snapshot(1, 1), signal);
  availablePercent = 19;
  await controller.hook(snapshot(2, 2), signal);
  await controller.hook(snapshot(4, 1), signal);

  expect(recycles).toBe(1);
  expect(controller.report()).toEqual({
    workThreshold: 2,
    subsequentWorkThreshold: 1,
    availablePercentThreshold: 20,
    maximumRecycles: 1,
    maximumContinuationDrainMs: 120_000,
    recycleCount: 1,
    drainTimeoutCount: 0,
    decisions: [
      expect.objectContaining({ runnerEpoch: 0, completedRequestsSinceRecycle: 1, eligible: false, reason: "work_threshold" }),
      expect.objectContaining({
        completedRequestsSinceRecycle: 2,
        eligible: true,
        recycled: true,
        recycleDurationMs: 14_000,
        reason: "recycled",
      }),
      expect.objectContaining({ runnerEpoch: 1, workThreshold: 1, completedRequestsSinceRecycle: 2, eligible: false, reason: "recycle_limit" }),
    ],
  });
});

test("inference recycle controller applies a separate subsequent-epoch work gate", async () => {
  let availablePercent = 19;
  let recycles = 0;
  const controller = createInferenceRecycleController({
    workThreshold: 3,
    subsequentWorkThreshold: 2,
    availablePercentThreshold: 20,
    maximumRecycles: 2,
    memorySnapshot: () => memory(availablePercent),
    recycle: async () => { recycles += 1; },
  });
  const signal = new AbortController().signal;

  await controller.hook(snapshot(3, 1), signal);
  availablePercent = 18;
  await controller.hook(snapshot(4, 1), signal);
  await controller.hook(snapshot(5, 1), signal);

  expect(recycles).toBe(2);
  expect(controller.report().decisions.map((decision) => ({
    epoch: decision.runnerEpoch,
    threshold: decision.workThreshold,
    completed: decision.completedRequestsSinceRecycle,
    recycled: decision.recycled,
  }))).toEqual([
    { epoch: 0, threshold: 3, completed: 3, recycled: true },
    { epoch: 1, threshold: 2, completed: 1, recycled: false },
    { epoch: 1, threshold: 2, completed: 2, recycled: true },
  ]);
});

test("inference recycle controller records pressure skips and fails closed without memory", async () => {
  const pressureSkip = createInferenceRecycleController({
    workThreshold: 1,
    availablePercentThreshold: 20,
    maximumRecycles: 1,
    memorySnapshot: () => memory(21),
    recycle: async () => { throw new Error("must not recycle"); },
  });
  await pressureSkip.hook(
    snapshot(1, 1),
    new AbortController().signal,
  );
  expect(pressureSkip.report().decisions[0]).toMatchObject({ eligible: false, reason: "pressure_threshold" });

  const unavailable = createInferenceRecycleController({
    workThreshold: 1,
    availablePercentThreshold: 20,
    maximumRecycles: 1,
    memorySnapshot: () => null,
    recycle: async () => {},
  });
  await expect(unavailable.hook(
    snapshot(1, 1),
    new AbortController().signal,
  )).rejects.toThrow("requires an available-memory snapshot");
});

test("inference recycle controller records and propagates recycle failure", async () => {
  const controller = createInferenceRecycleController({
    workThreshold: 1,
    availablePercentThreshold: 20,
    maximumRecycles: 1,
    memorySnapshot: () => memory(10),
    recycle: async () => { throw new Error("replacement was not verified"); },
  });

  await expect(controller.hook(
    snapshot(1, 1),
    new AbortController().signal,
  )).rejects.toThrow("replacement was not verified");
  expect(controller.report()).toMatchObject({
    recycleCount: 0,
    decisions: [{ eligible: true, recycled: false, reason: "recycle_failed", error: "replacement was not verified" }],
  });
});

test("inference recycle controller requests and reports a bounded continuation drain", async () => {
  let recycles = 0;
  const controller = createInferenceRecycleController({
    workThreshold: 2,
    availablePercentThreshold: 100,
    maximumRecycles: 1,
    maximumContinuationDrainMs: 5_000,
    memorySnapshot: () => memory(40),
    recycle: async () => { recycles += 1; },
  });
  const signal = new AbortController().signal;

  const request = await controller.hook(snapshot(2, 3, 2), signal);
  expect(request).toMatchObject({ action: "drain_continuations", timeoutMs: 5_000 });
  await controller.hook(snapshot(5, 1, 0, true), signal);

  expect(recycles).toBe(1);
  expect(controller.report()).toMatchObject({
    maximumContinuationDrainMs: 5_000,
    drainTimeoutCount: 0,
    decisions: [
      { reason: "continuation_drain", drainRequested: true, drainTimedOut: false, recycled: false },
      { reason: "recycled", drainRequested: false, drainTimedOut: false, recycled: true },
    ],
  });
});

test("inference recycle controller records continuation drain timeout", async () => {
  const controller = createInferenceRecycleController({
    workThreshold: 1,
    availablePercentThreshold: 100,
    maximumRecycles: 1,
    maximumContinuationDrainMs: 10,
    memorySnapshot: () => memory(40),
    recycle: async () => { throw new Error("must not recycle"); },
  });

  const request = await controller.hook(snapshot(1, 1, 1), new AbortController().signal);
  if (!request || request.action !== "drain_continuations") throw new Error("Expected continuation drain request");
  request.onTimeout?.();

  expect(controller.report()).toMatchObject({
    recycleCount: 0,
    drainTimeoutCount: 1,
    decisions: [{ reason: "continuation_drain", drainTimedOut: true }],
  });
});

function memory(availablePercent: number) {
  return {
    observedAt: "2026-08-28T00:00:00.000Z",
    availablePercent,
    swapUsedBytes: 0,
    pageSizeBytes: 4_096,
    pageOuts: 0,
    swapOuts: 0,
  };
}

function snapshot(settledLeaseCount: number, queuedCount: number, pendingContinuationTurnCount = 0, continuationDrainActive = false) {
  return {
    activeCount: 0 as const,
    queuedCount,
    settledLeaseCount,
    pendingContinuationTurnCount,
    continuationDrainActive,
  };
}
