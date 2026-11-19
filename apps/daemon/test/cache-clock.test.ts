import { expect, test } from "bun:test";
import type { PrefixReport } from "@demesne/protocol";
import { DemesneStore } from "@demesne/storage";
import { CACHE_LIFE_MS } from "@demesne/providers";
import { CacheClock, coldAfterMs, DEFAULT_CACHE_LIFE_MS, measureLife, type CacheSample } from "../src/cache-clock.ts";
import { CACHE_COLD_MS, COLD_CUT_CHARS, nextForgetThrough } from "../src/forget-reads.ts";
import type { ModelMessage } from "@demesne/protocol";

const MIN = 60_000;
/// A request that repeated the one before it after `idleMinutes`, and read
/// its cache (hit) or did not.
const sample = (idleMinutes: number, hit: boolean, over: Partial<PrefixReport> = {}): CacheSample => ({
  inputTokens: 40_000, cachedTokens: hit ? 38_000 : 0,
  prefix: { sentChars: 160_000, previousChars: 158_000, keptChars: 158_000, brokeAt: null, idleMs: idleMinutes * MIN, ...over },
});
const times = (count: number, make: () => CacheSample) => Array.from({ length: count }, make);

test("the clock reads how long a cache lived from requests that repeated the one before", () => {
  // Alive through 30 minutes, gone after: cold from 30.
  const lived = measureLife([...times(5, () => sample(0.5, true)), ...times(4, () => sample(3, true)), ...times(3, () => sample(20, true)), ...times(4, () => sample(45, false))]);
  expect(lived).toEqual({ aliveMs: 30 * MIN, goneMs: 30 * MIN, samples: 16 });
  expect(coldAfterMs(CACHE_LIFE_MS.short, lived)).toBe(30 * MIN);
  // Shorter than published: a provider said to keep 30 minutes that is mostly gone after 5.
  const short = measureLife([...times(6, () => sample(0.5, true)), ...times(3, () => sample(2, true)), sample(7, true), ...times(3, () => sample(7, false))]);
  expect(short.goneMs).toBe(5 * MIN);
  expect(coldAfterMs(CACHE_LIFE_MS.gpt, short)).toBe(5 * MIN);
  // Never seen gone: at least the published figure, more when it was seen alive for longer.
  const long = measureLife([...times(3, () => sample(0.5, true)), ...times(3, () => sample(100, true))]);
  expect(long).toMatchObject({ aliveMs: 180 * MIN, goneMs: null });
  expect(coldAfterMs(CACHE_LIFE_MS.gpt, long)).toBe(180 * MIN);
  expect(coldAfterMs(CACHE_LIFE_MS.long, long)).toBe(CACHE_LIFE_MS.long);
});

test("the clock concludes nothing from what it can't trust", () => {
  // Too few requests in a wait to say anything about it.
  expect(measureLife([sample(0.5, true), sample(45, false), sample(45, false)])).toMatchObject({ aliveMs: null, goneMs: null });
  // A request Demesne itself changed says nothing about the provider, nor does a first or a tiny one.
  const ours = [sample(3, false, { brokeAt: "history" }), sample(3, false, { previousChars: null, keptChars: null, idleMs: null }), { ...sample(3, false), inputTokens: 500 }, sample(3, false, { keptChars: 40_000 })];
  expect(measureLife([...ours, ...ours, ...ours]).samples).toBe(0);
  // A provider that never reports a cache read can't be told from one that never caches.
  const silent = measureLife([...times(5, () => sample(0.5, false)), ...times(5, () => sample(3, false))]);
  expect(silent).toEqual({ aliveMs: null, goneMs: null, samples: 10 });
  expect(coldAfterMs(CACHE_LIFE_MS.ownMachine, silent)).toBe(CACHE_LIFE_MS.ownMachine);
  // Nothing published, nothing measured.
  expect(coldAfterMs(undefined, null)).toBe(DEFAULT_CACHE_LIFE_MS);
  expect(DEFAULT_CACHE_LIFE_MS).toBe(CACHE_COLD_MS);
});

test("the clock reads this machine's own history, per provider and model, and reuses its answer", () => {
  const store = new DemesneStore(":memory:");
  try {
    const { session } = store.createSession("Clock");
    const call = (model: string, idleMinutes: number, hit: boolean) => {
      const { turn } = store.createTurn(session.id, "ask");
      store.startTurn(turn.id);
      const { providerCallId } = store.startProviderCall(turn.id, "Codex", model);
      const one = sample(idleMinutes, hit);
      store.recordProviderPrefix(providerCallId, one.prefix);
      store.recordProviderUsage(providerCallId, { inputTokens: one.inputTokens, outputTokens: 10, totalTokens: one.inputTokens + 10, cachedInputTokens: one.cachedTokens });
      store.settleProviderCall(providerCallId, "completed");
      store.completeTurn(turn.id);
    };
    for (let i = 0; i < 3; i++) { call("gpt-6-astra", 0.5, true); call("gpt-6-astra", 20, true); call("gpt-6-astra", 45, false); call("other", 0.5, true); }
    let now = Date.now(), reads = 0;
    const counting = { cacheSamples: (...args: Parameters<DemesneStore["cacheSamples"]>) => { reads++; return store.cacheSamples(...args); } };
    const clock = new CacheClock(counting, () => now);
    const astra = { providerId: "Codex", modelId: "gpt-6-astra", cacheLifeMs: CACHE_LIFE_MS.long };
    expect(clock.measured("Codex", "gpt-6-astra")).toEqual({ aliveMs: 30 * MIN, goneMs: 30 * MIN, samples: 9 });
    // Said to live 12 hours, seen gone after 30 minutes: 30 minutes it is.
    expect(clock.coldAfterMs(astra)).toBe(30 * MIN);
    expect(clock.coldAfterMs({ providerId: "Codex", modelId: "other", cacheLifeMs: CACHE_LIFE_MS.gpt })).toBe(CACHE_LIFE_MS.gpt);
    expect(reads).toBe(2);
    now += 11 * MIN;
    clock.coldAfterMs(astra);
    expect(reads).toBe(3);
  } finally { store.close(); }
});

test("old turns are cut when this provider's cache is gone, not after a fixed wait", () => {
  const read = "x".repeat(COLD_CUT_CHARS * 2);
  const readTurn: ModelMessage[] = [{ role: "user", content: "read" }, { role: "assistant", content: null, toolCalls: [{ id: "c", name: "read_file", arguments: "{}" }] }, { role: "tool", toolCallId: "c", content: read }, { role: "assistant", content: "ok" }];
  const chat: ModelMessage[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
  const turns = [readTurn, chat, chat].map((messages, index) => ({ firstMessageId: (index + 1) * 10, messages }));
  // 20 minutes away: gone on a five-minute cache, alive on a GPT-6 one, and never gone by time on your own machine.
  expect(nextForgetThrough(turns, 0, 20 * MIN, null, CACHE_LIFE_MS.short)).toBe(10);
  expect(nextForgetThrough(turns, 0, 20 * MIN, null, CACHE_LIFE_MS.gpt)).toBe(0);
  expect(nextForgetThrough(turns, 0, 40 * MIN, null, CACHE_LIFE_MS.gpt)).toBe(10);
  expect(nextForgetThrough(turns, 0, 6 * 60 * MIN, null, CACHE_LIFE_MS.ownMachine)).toBe(0);
});
