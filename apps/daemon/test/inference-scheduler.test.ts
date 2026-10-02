import { describe, expect, test } from "bun:test";
import { InferenceScheduler, type InferenceBoundaryHook } from "../src/inference-scheduler.ts";

describe("InferenceScheduler", () => {
  test("grants one slot in strict FIFO order", async () => {
    const scheduler = new InferenceScheduler(1);
    const signal = new AbortController().signal;
    const order: string[] = [];
    const first = await scheduler.acquire("first", signal);
    const secondPromise = scheduler.acquire("second", signal).then((lease) => { order.push("second"); return lease; });
    const thirdPromise = scheduler.acquire("third", signal).then((lease) => { order.push("third"); return lease; });

    expect(scheduler.activeCount).toBe(1);
    expect(scheduler.queuedCount).toBe(2);
    first.release({ turnContinues: false });
    const second = await secondPromise;
    expect(order).toEqual(["second"]);
    second.release({ turnContinues: false });
    const third = await thirdPromise;
    expect(order).toEqual(["second", "third"]);
    third.release({ turnContinues: false });
    expect(scheduler.activeCount).toBe(0);
  });

  test("removes a cancelled waiter without leaking the slot", async () => {
    const scheduler = new InferenceScheduler(1);
    const first = await scheduler.acquire("first", new AbortController().signal);
    const cancelled = new AbortController();
    const reason = new Error("cancelled while queued");
    const secondPromise = scheduler.acquire("second", cancelled.signal);
    const thirdPromise = scheduler.acquire("third", new AbortController().signal);

    cancelled.abort(reason);
    await expect(secondPromise).rejects.toBe(reason);
    expect(scheduler.queuedCount).toBe(1);
    first.release({ turnContinues: false });
    const third = await thirdPromise;
    expect(scheduler.activeCount).toBe(1);
    third.release({ turnContinues: false });
    expect(scheduler.activeCount).toBe(0);
  });

  test("reports queue duration separately and releases idempotently", async () => {
    let now = 10;
    const scheduler = new InferenceScheduler(1, () => now);
    const signal = new AbortController().signal;
    const first = await scheduler.acquire("first", signal);
    const secondPromise = scheduler.acquire("second", signal);

    now = 35;
    first.release({ turnContinues: false });
    first.release({ turnContinues: true });
    const second = await secondPromise;

    expect(second.queueDurationMs).toBe(25);
    expect(scheduler.activeCount).toBe(1);
    second.release({ turnContinues: false });
  });

  test("validates capacity and rejects pre-cancelled acquisition", async () => {
    expect(() => new InferenceScheduler(0)).toThrow("between 1 and 1024");
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(new InferenceScheduler().acquire("turn", controller.signal)).rejects.toThrow("already cancelled");
    await expect(new InferenceScheduler().acquire("", new AbortController().signal)).rejects.toThrow("turn ID cannot be empty");
  });

  test("awaits a quiescent boundary hook without changing FIFO order", async () => {
    let now = 10;
    let resumeBoundary: (() => void) | undefined;
    const boundary = new Promise<void>((resolve) => { resumeBoundary = resolve; });
    const snapshots: Array<{
      activeCount: 0;
      queuedCount: number;
      settledLeaseCount: number;
      pendingContinuationTurnCount: number;
      continuationDrainActive: boolean;
    }> = [];
    const scheduler = new InferenceScheduler(1, () => now, async (snapshot) => {
      snapshots.push(snapshot);
      if (snapshot.settledLeaseCount === 1) await boundary;
    });
    const signal = new AbortController().signal;
    const order: string[] = [];
    const first = await scheduler.acquire("first", signal);
    const secondPromise = scheduler.acquire("second", signal).then((lease) => { order.push("second"); return lease; });
    const thirdPromise = scheduler.acquire("third", signal).then((lease) => { order.push("third"); return lease; });

    now = 20;
    first.release({ turnContinues: false });
    await Promise.resolve();
    expect(snapshots).toEqual([{
      activeCount: 0,
      queuedCount: 2,
      settledLeaseCount: 1,
      pendingContinuationTurnCount: 0,
      continuationDrainActive: false,
    }]);
    expect(scheduler.activeCount).toBe(0);
    expect(order).toEqual([]);

    now = 35;
    resumeBoundary!();
    const second = await secondPromise;
    expect(second.queueDurationMs).toBe(25);
    expect(order).toEqual(["second"]);
    second.release({ turnContinues: false });
    const third = await thirdPromise;
    expect(order).toEqual(["second", "third"]);
    expect(snapshots.at(-1)).toEqual({
      activeCount: 0,
      queuedCount: 1,
      settledLeaseCount: 2,
      pendingContinuationTurnCount: 0,
      continuationDrainActive: false,
    });
    third.release({ turnContinues: false });
    await scheduler.close();
  });

  test("fails closed when boundary maintenance fails", async () => {
    const failure = new Error("recycle verification failed");
    const scheduler = new InferenceScheduler(1, undefined, async () => { throw failure; });
    const first = await scheduler.acquire("first", new AbortController().signal);
    const secondPromise = scheduler.acquire("second", new AbortController().signal);
    first.release({ turnContinues: false });

    await expect(secondPromise).rejects.toBe(failure);
    await expect(scheduler.acquire("third", new AbortController().signal)).rejects.toBe(failure);
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.queuedCount).toBe(0);
  });

  test("shutdown aborts boundary maintenance and rejects queued work", async () => {
    let maintenanceSignal: AbortSignal | undefined;
    const scheduler = new InferenceScheduler(1, undefined, async (_snapshot, signal) => {
      maintenanceSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const first = await scheduler.acquire("first", new AbortController().signal);
    const queued = scheduler.acquire("second", new AbortController().signal);
    first.release({ turnContinues: false });
    await Promise.resolve();

    const reason = new Error("benchmark closing");
    await scheduler.close(reason);
    await expect(queued).rejects.toBe(reason);
    expect(maintenanceSignal?.aborted).toBe(true);
    expect(scheduler.queuedCount).toBe(0);
  });

  test("defers a pending boundary until all multi-round turns settle", async () => {
    const snapshots: Array<{ settledLeaseCount: number; queuedCount: number }> = [];
    const scheduler = new InferenceScheduler(1, undefined, async (snapshot) => {
      snapshots.push({ settledLeaseCount: snapshot.settledLeaseCount, queuedCount: snapshot.queuedCount });
    });
    const signal = new AbortController().signal;
    const order: string[] = [];
    const firstA = await scheduler.acquire("a", signal);
    const firstBPromise = scheduler.acquire("b", signal).then((lease) => { order.push("b1"); return lease; });

    firstA.release({ turnContinues: true });
    const firstB = await firstBPromise;
    const secondAPromise = scheduler.acquire("a", signal).then((lease) => { order.push("a2"); return lease; });
    firstB.release({ turnContinues: true });
    const secondA = await secondAPromise;
    const secondBPromise = scheduler.acquire("b", signal).then((lease) => { order.push("b2"); return lease; });
    secondA.release({ turnContinues: false });
    const secondB = await secondBPromise;
    secondB.release({ turnContinues: false });

    const nextPromise = scheduler.acquire("next", signal).then((lease) => { order.push("next"); return lease; });
    const next = await nextPromise;

    expect(order).toEqual(["b1", "a2", "b2", "next"]);
    expect(snapshots).toEqual([{ settledLeaseCount: 4, queuedCount: 1 }]);
    next.release({ turnContinues: false });
    await scheduler.close();
  });

  test("terminal cleanup releases a deferred boundary after cancellation during tool work", async () => {
    const snapshots: number[] = [];
    const scheduler = new InferenceScheduler(1, undefined, async (snapshot) => {
      snapshots.push(snapshot.settledLeaseCount);
    });
    const signal = new AbortController().signal;
    const first = await scheduler.acquire("continuing", signal);
    const unrelatedPromise = scheduler.acquire("unrelated", signal);
    first.release({ turnContinues: true });
    const unrelated = await unrelatedPromise;
    const nextPromise = scheduler.acquire("next", signal);

    scheduler.finishTurn("continuing");
    unrelated.release({ turnContinues: false });
    const next = await nextPromise;

    expect(snapshots).toEqual([2]);
    next.release({ turnContinues: false });
    await scheduler.close();
  });

  test("drain mode prioritizes started-turn continuations over fresh FIFO waiters", async () => {
    const snapshots: Array<{ pending: number; active: boolean; settled: number }> = [];
    const hook: InferenceBoundaryHook = async (snapshot) => {
      snapshots.push({
        pending: snapshot.pendingContinuationTurnCount,
        active: snapshot.continuationDrainActive,
        settled: snapshot.settledLeaseCount,
      });
      if (snapshot.pendingContinuationTurnCount > 0) {
        return { action: "drain_continuations", timeoutMs: 1_000 };
      }
    };
    hook.supportsContinuationDrain = true;
    const scheduler = new InferenceScheduler(1, undefined, hook);
    const signal = new AbortController().signal;
    const order: string[] = [];
    const first = await scheduler.acquire("started", signal);
    const freshPromise = scheduler.acquire("fresh", signal).then((lease) => { order.push("fresh"); return lease; });

    first.release({ turnContinues: true });
    await Promise.resolve();
    expect(order).toEqual([]);
    const continuationPromise = scheduler.acquire("started", signal).then((lease) => { order.push("continuation"); return lease; });
    const continuation = await continuationPromise;
    continuation.release({ turnContinues: false });
    const fresh = await freshPromise;

    expect(order).toEqual(["continuation", "fresh"]);
    expect(snapshots).toEqual([
      { pending: 1, active: false, settled: 1 },
      { pending: 0, active: true, settled: 2 },
    ]);
    fresh.release({ turnContinues: false });
    await scheduler.close();
  });

  test("cancelling a pending continuation completes the drain before fresh work", async () => {
    const snapshots: number[] = [];
    const hook: InferenceBoundaryHook = async (snapshot) => {
      snapshots.push(snapshot.pendingContinuationTurnCount);
      if (snapshot.pendingContinuationTurnCount > 0) {
        return { action: "drain_continuations", timeoutMs: 1_000 };
      }
    };
    hook.supportsContinuationDrain = true;
    const scheduler = new InferenceScheduler(1, undefined, hook);
    const signal = new AbortController().signal;
    const first = await scheduler.acquire("cancelled", signal);
    const freshPromise = scheduler.acquire("fresh", signal);

    first.release({ turnContinues: true });
    await Promise.resolve();
    scheduler.finishTurn("cancelled");
    const fresh = await freshPromise;

    expect(snapshots).toEqual([1, 0]);
    fresh.release({ turnContinues: false });
    await scheduler.close();
  });

  test("drain timeout resumes fresh work and reports the timeout", async () => {
    let timedOut = 0;
    let evaluations = 0;
    const hook: InferenceBoundaryHook = async (snapshot) => {
      evaluations += 1;
      if (snapshot.pendingContinuationTurnCount > 0) {
        return {
          action: "drain_continuations",
          timeoutMs: 10,
          onTimeout: () => { timedOut += 1; },
        };
      }
    };
    hook.supportsContinuationDrain = true;
    const scheduler = new InferenceScheduler(1, undefined, hook);
    const signal = new AbortController().signal;
    const first = await scheduler.acquire("stalled", signal);
    const freshPromise = scheduler.acquire("fresh", signal);

    first.release({ turnContinues: true });
    const fresh = await freshPromise;

    expect(timedOut).toBe(1);
    expect(evaluations).toBe(1);
    scheduler.finishTurn("stalled");
    fresh.release({ turnContinues: false });
    await scheduler.close();
  });

  test("shutdown cancels an active continuation drain and rejects fresh work", async () => {
    let timedOut = 0;
    const hook: InferenceBoundaryHook = async (snapshot) => snapshot.pendingContinuationTurnCount > 0
      ? { action: "drain_continuations", timeoutMs: 20, onTimeout: () => { timedOut += 1; } }
      : undefined;
    hook.supportsContinuationDrain = true;
    const scheduler = new InferenceScheduler(1, undefined, hook);
    const first = await scheduler.acquire("stalled", new AbortController().signal);
    const fresh = scheduler.acquire("fresh", new AbortController().signal);
    first.release({ turnContinues: true });
    await Promise.resolve();

    const reason = new Error("shutdown during drain");
    await scheduler.close(reason);
    await expect(fresh).rejects.toBe(reason);
    await Bun.sleep(25);
    expect(timedOut).toBe(0);
  });
});

test("checkpoint reviews get the next slot without interrupting active work or starving normal work",async()=>{
  const scheduler=new InferenceScheduler(1),signal=new AbortController().signal,order:string[]=[];
  const active=await scheduler.acquire("active",signal);
  const worker=scheduler.acquire("worker",signal).then(lease=>{order.push("worker");return lease;});
  const first=scheduler.acquire("review-a",signal,{reviewFor:"active"}).then(lease=>{order.push("review-a");return lease;});
  const second=scheduler.acquire("review-b",signal,{reviewFor:"other"}).then(lease=>{order.push("review-b");return lease;});
  expect(scheduler.activeCount).toBe(1);expect(order).toEqual([]);
  expect(scheduler.queuePosition("review-a")).toBe(1);expect(scheduler.queuePosition("worker")).toBe(2);
  active.release({turnContinues:true});const review=await first;expect(order).toEqual(["review-a"]);
  review.release({turnContinues:false});const coding=await worker;expect(order).toEqual(["review-a","worker"]);
  coding.release({turnContinues:false});(await second).release({turnContinues:false});expect(scheduler.activeCount).toBe(0);await scheduler.close();
});

test("a worker has at most one queued or active review and cancellation releases the reservation",async()=>{
  const scheduler=new InferenceScheduler(1),signal=new AbortController().signal,abort=new AbortController();
  const active=await scheduler.acquire("worker",signal);
  const pending=scheduler.acquire("review",abort.signal,{reviewFor:"worker"});
  await expect(scheduler.acquire("duplicate",signal,{reviewFor:"worker"})).rejects.toThrow("already queued");
  abort.abort();await expect(pending).rejects.toThrow();
  const next=scheduler.acquire("retry",signal,{reviewFor:"worker"});active.release({turnContinues:true});const review=await next;
  await expect(scheduler.acquire("duplicate-active",signal,{reviewFor:"worker"})).rejects.toThrow("already queued");
  review.release({turnContinues:false});(await scheduler.acquire("last",signal,{reviewFor:"worker"})).release({turnContinues:false});await scheduler.close();
});
