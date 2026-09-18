import type { InferenceBoundaryHook, InferenceBoundarySnapshot } from "./inference-scheduler.ts";
import type { HostMemorySnapshot } from "./provider-benchmark.ts";

export interface InferenceRecycleDecision {
  observedAt: string;
  scheduler: InferenceBoundarySnapshot;
  completedRequestsSinceRecycle: number;
  memory: HostMemorySnapshot;
  runnerEpoch: number;
  workThreshold: number;
  availablePercentThreshold: number;
  eligible: boolean;
  drainRequested: boolean;
  drainTimedOut: boolean;
  recycled: boolean;
  recycleDurationMs: number | null;
  reason: "work_threshold" | "pressure_threshold" | "recycle_limit" | "continuation_drain" | "recycled" | "recycle_failed";
  error: string | null;
}

export interface InferenceRecycleController {
  hook: InferenceBoundaryHook;
  report(): {
    workThreshold: number;
    subsequentWorkThreshold: number;
    availablePercentThreshold: number;
    maximumRecycles: number;
    maximumContinuationDrainMs: number;
    recycleCount: number;
    drainTimeoutCount: number;
    decisions: InferenceRecycleDecision[];
  };
}

export function createInferenceRecycleController(options: {
  workThreshold: number;
  subsequentWorkThreshold?: number;
  availablePercentThreshold: number;
  maximumRecycles: number;
  maximumContinuationDrainMs?: number;
  memorySnapshot: () => HostMemorySnapshot | null;
  recycle: (signal: AbortSignal) => Promise<void>;
  now?: () => number;
  observedAt?: () => Date;
}): InferenceRecycleController {
  boundedInteger(options.workThreshold, "workThreshold", 1, 10_000);
  const subsequentWorkThreshold = options.subsequentWorkThreshold ?? options.workThreshold;
  boundedInteger(subsequentWorkThreshold, "subsequentWorkThreshold", 1, 10_000);
  boundedInteger(options.availablePercentThreshold, "availablePercentThreshold", 1, 100);
  boundedInteger(options.maximumRecycles, "maximumRecycles", 1, 100);
  const maximumContinuationDrainMs = options.maximumContinuationDrainMs ?? 120_000;
  boundedInteger(maximumContinuationDrainMs, "maximumContinuationDrainMs", 1, 10 * 60_000);
  const now = options.now ?? (() => performance.now());
  const observedAt = options.observedAt ?? (() => new Date());
  const decisions: InferenceRecycleDecision[] = [];
  let settledAtLastRecycle = 0;
  let recycleCount = 0;
  let drainTimeoutCount = 0;

  const hook: InferenceBoundaryHook = async (scheduler, signal) => {
    if (signal.aborted) throw signal.reason;
    const memory = options.memorySnapshot();
    if (!memory || memory.availablePercent === null) {
      throw new Error("Inference recycle decision requires an available-memory snapshot");
    }
    const completedRequestsSinceRecycle = scheduler.settledLeaseCount - settledAtLastRecycle;
    const workThreshold = recycleCount === 0 ? options.workThreshold : subsequentWorkThreshold;
    const workEligible = completedRequestsSinceRecycle >= workThreshold;
    const pressureEligible = memory.availablePercent <= options.availablePercentThreshold;
    const limitEligible = recycleCount < options.maximumRecycles;
    const base = {
      observedAt: observedAt().toISOString(),
      scheduler: structuredClone(scheduler),
      completedRequestsSinceRecycle,
      memory: structuredClone(memory),
      runnerEpoch: recycleCount,
      workThreshold,
      availablePercentThreshold: options.availablePercentThreshold,
    };
    if (!workEligible) {
      decisions.push({ ...base, eligible: false, drainRequested: false, drainTimedOut: false, recycled: false, recycleDurationMs: null, reason: "work_threshold", error: null });
      return;
    }
    if (!pressureEligible) {
      decisions.push({ ...base, eligible: false, drainRequested: false, drainTimedOut: false, recycled: false, recycleDurationMs: null, reason: "pressure_threshold", error: null });
      return;
    }
    if (!limitEligible) {
      decisions.push({ ...base, eligible: false, drainRequested: false, drainTimedOut: false, recycled: false, recycleDurationMs: null, reason: "recycle_limit", error: null });
      return;
    }
    if (scheduler.pendingContinuationTurnCount > 0) {
      const decision: InferenceRecycleDecision = {
        ...base,
        eligible: false,
        drainRequested: true,
        drainTimedOut: false,
        recycled: false,
        recycleDurationMs: null,
        reason: "continuation_drain",
        error: null,
      };
      decisions.push(decision);
      return {
        action: "drain_continuations",
        timeoutMs: maximumContinuationDrainMs,
        onTimeout: () => {
          decision.drainTimedOut = true;
          drainTimeoutCount += 1;
        },
      };
    }
    const started = now();
    try {
      await options.recycle(signal);
      if (signal.aborted) throw signal.reason;
      recycleCount += 1;
      settledAtLastRecycle = scheduler.settledLeaseCount;
      decisions.push({
        ...base,
        eligible: true,
        drainRequested: false,
        drainTimedOut: false,
        recycled: true,
        recycleDurationMs: Math.max(0, now() - started),
        reason: "recycled",
        error: null,
      });
    } catch (error) {
      decisions.push({
        ...base,
        eligible: true,
        drainRequested: false,
        drainTimedOut: false,
        recycled: false,
        recycleDurationMs: Math.max(0, now() - started),
        reason: "recycle_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  hook.supportsContinuationDrain = true;

  return {
    hook,
    report: () => ({
      workThreshold: options.workThreshold,
      subsequentWorkThreshold,
      availablePercentThreshold: options.availablePercentThreshold,
      maximumRecycles: options.maximumRecycles,
      maximumContinuationDrainMs,
      recycleCount,
      drainTimeoutCount,
      decisions: structuredClone(decisions),
    }),
  };
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}
