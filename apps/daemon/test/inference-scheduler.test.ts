import { describe, expect, test } from "bun:test";
import { InferenceScheduler, InferenceSchedulers } from "../src/inference-scheduler.ts";

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
    first.release();
    const second = await secondPromise;
    expect(order).toEqual(["second"]);
    second.release();
    const third = await thirdPromise;
    expect(order).toEqual(["second", "third"]);
    third.release();
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
    first.release();
    const third = await thirdPromise;
    expect(scheduler.activeCount).toBe(1);
    third.release();
    expect(scheduler.activeCount).toBe(0);
  });

  test("reports queue duration separately and releases idempotently", async () => {
    let now = 10;
    const scheduler = new InferenceScheduler(1, () => now);
    const signal = new AbortController().signal;
    const first = await scheduler.acquire("first", signal);
    const secondPromise = scheduler.acquire("second", signal);

    now = 35;
    first.release();
    first.release();
    const second = await secondPromise;

    expect(second.queueDurationMs).toBe(25);
    expect(scheduler.activeCount).toBe(1);
    second.release();
  });

  test("validates capacity and rejects pre-cancelled acquisition", async () => {
    expect(() => new InferenceScheduler(0)).toThrow("between 1 and 1024");
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(new InferenceScheduler().acquire("turn", controller.signal)).rejects.toThrow("already cancelled");
    await expect(new InferenceScheduler().acquire("", new AbortController().signal)).rejects.toThrow("turn ID cannot be empty");
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
  active.release();const review=await first;expect(order).toEqual(["review-a"]);
  review.release();const coding=await worker;expect(order).toEqual(["review-a","worker"]);
  coding.release();(await second).release();expect(scheduler.activeCount).toBe(0);await scheduler.close();
});

test("a worker has at most one queued or active review and cancellation releases the reservation",async()=>{
  const scheduler=new InferenceScheduler(1),signal=new AbortController().signal,abort=new AbortController();
  const active=await scheduler.acquire("worker",signal);
  const pending=scheduler.acquire("review",abort.signal,{reviewFor:"worker"});
  await expect(scheduler.acquire("duplicate",signal,{reviewFor:"worker"})).rejects.toThrow("already queued");
  abort.abort();await expect(pending).rejects.toThrow();
  const next=scheduler.acquire("retry",signal,{reviewFor:"worker"});active.release();const review=await next;
  await expect(scheduler.acquire("duplicate-active",signal,{reviewFor:"worker"})).rejects.toThrow("already queued");
  review.release();(await scheduler.acquire("last",signal,{reviewFor:"worker"})).release();await scheduler.close();
});

test("each provider has its own slots, so one model server never waits behind another", async () => {
  const schedulers = new InferenceSchedulers(new InferenceScheduler(1), "cloud");
  const signal = new AbortController().signal;
  expect(schedulers.for("cloud")).toBe(schedulers.primary);
  expect(schedulers.for("pc")).toBe(schedulers.for("pc"));
  const cloud = await schedulers.for("cloud").acquire("turn", signal);
  const queued = schedulers.for("cloud").acquire("other", signal);
  // The cloud slot is busy, yet the local provider grants immediately.
  const local = await schedulers.for("pc").acquire("turn", signal);
  expect([schedulers.activeCount, schedulers.queuedCount, schedulers.queuePosition("other")]).toEqual([2, 1, 1]);
  local.release(); cloud.release();
  (await queued).release();
  await schedulers.close();
});

test("provider-specific slots allow three Qwen requests while preserving single-slot peers", async () => {
  const schedulers = new InferenceSchedulers(new InferenceScheduler(3), "qwen", { qwen: 3 }, 1);
  const signal = new AbortController().signal;
  const leases = await Promise.all([1, 2, 3].map(i => schedulers.for("qwen").acquire(`q${i}`, signal)));
  const fourth = schedulers.for("qwen").acquire("q4", signal);
  expect(schedulers.for("qwen").activeCount).toBe(3);
  expect(schedulers.for("qwen").queuedCount).toBe(1);
  const cloud = await schedulers.for("cloud").acquire("cloud", signal);
  expect(schedulers.for("cloud").capacity).toBe(1);
  expect(schedulers.capacities).toEqual({ qwen: 3, cloud: 1 });
  leases[0]!.release();
  (await fourth).release();
  for (const lease of leases.slice(1)) lease.release();
  cloud.release();
  await schedulers.close();
  expect(() => new InferenceSchedulers(new InferenceScheduler(1), "cloud", { qwen: 0 })).toThrow("between 1 and 1024");
  expect(() => new InferenceSchedulers(new InferenceScheduler(1), "qwen", { qwen: 3 })).toThrow("Primary scheduler");
});
