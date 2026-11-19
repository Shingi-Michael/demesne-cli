/// The cache line: one chat's prompt cache in numbers, from what each of its
/// requests already recorded (docs/caching.md, "The number on screen").
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrefixReport } from "@demesne/protocol";
import type { ProviderStreamEvent } from "@demesne/providers";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { createDaemonApp } from "../src/app.ts";
import { chatCache, type CacheCall } from "../src/cache-line.ts";
import type { TurnProcessor } from "../src/processor.ts";

const START = Date.parse("2026-11-19T09:00:00Z"), MINUTE = 60_000;
const prefix = (over: Partial<PrefixReport> = {}): PrefixReport => ({ sentChars: 4000, previousChars: 3900, keptChars: 3900, brokeAt: null, idleMs: 30_000, ...over });
/// A request `minute` minutes in, that read `cached` of its `input` tokens.
const call = (minute: number, input: number, cached: number | null, over: Partial<CacheCall> = {}): CacheCall => ({ provider: "Codex", model: "gpt-6",
  startedAt: new Date(START + minute * MINUTE).toISOString(), completedAt: new Date(START + minute * MINUTE + 5000).toISOString(), inputTokens: input, cachedTokens: cached, prefix: prefix(), ...over });
const GPT = { keepsMs: 30 * MINUTE, ownMachine: false };

test("the share is what the provider read from cache over everything the chat sent", () => {
  const cache = chatCache([call(0, 10_000, 0), call(1, 11_000, 10_000), call(2, 12_000, 11_000)], GPT);
  expect(cache).toMatchObject({ requests: 3, inputTokens: 33_000, cachedTokens: 21_000, ticks: ["first", "hit", "hit"], lastMiss: null, keepsMs: 30 * MINUTE, ownMachine: false });
  expect(cache.lastRequestAt).toBe(new Date(START + 2 * MINUTE + 5000).toISOString());
});

test("a request that read under half of what it could have is a miss, with its reason", () => {
  const miss = (over: Partial<CacheCall>, life = GPT) => chatCache([call(0, 10_000, 0), call(1, 11_000, 10_000), call(50, 12_000, 0, over)], life).lastMiss;
  // Away past the cache's lifetime; the old reads cut then cost nothing more.
  expect(miss({ prefix: prefix({ idleMs: 45 * MINUTE }) })).toEqual({ at: new Date(START + 50 * MINUTE).toISOString(), idleMs: 45 * MINUTE, why: "away" });
  expect(miss({ prefix: prefix({ idleMs: 45 * MINUTE, brokeAt: "history", keptChars: 900 }) })).toMatchObject({ why: "away", shortened: true });
  // The start of the request changed while the cache was warm.
  expect(miss({ prefix: prefix({ idleMs: 2 * MINUTE, brokeAt: "history", keptChars: 900 }) })).toMatchObject({ why: "history" });
  expect(miss({ prefix: prefix({ brokeAt: "tools", keptChars: 100 }) })).toMatchObject({ why: "tools" });
  expect(miss({ prefix: prefix({ brokeAt: "instructions", keptChars: 0 }) })).toMatchObject({ why: "instructions" });
  expect(miss({ model: "gpt-6-mini" })).toMatchObject({ why: "model" });
  // Nothing changed and it was not away: the provider let it go, or on your machine another chat took the slot.
  expect(miss({ prefix: prefix({ idleMs: 2 * MINUTE }) })).toMatchObject({ why: "dropped", idleMs: 2 * MINUTE });
  expect(miss({ prefix: prefix({ idleMs: 45 * MINUTE }) }, { keepsMs: 24 * 60 * MINUTE, ownMachine: true })).toMatchObject({ why: "taken" });
  // No meter record (from before it existed): the wait is read off the clock.
  expect(miss({ prefix: null })).toMatchObject({ why: "away", idleMs: 49 * MINUTE - 5000 });
});

test("requests without a cache count are left out, and only the newest ticks are kept", () => {
  expect(chatCache([call(0, 10_000, null), call(1, 11_000, null)], GPT)).toMatchObject({ requests: 0, inputTokens: 0, ticks: [], lastMiss: null });
  const long = chatCache(Array.from({ length: 100 }, (_, at) => call(at, 10_000 + at, at ? 10_000 : 0)), GPT);
  expect(long.requests).toBe(100);
  expect(long.ticks).toHaveLength(60);
  expect(long.ticks.every((tick) => tick === "hit")).toBe(true);
  // A chat that grows smaller (after compaction) is measured against what it could have read.
  expect(chatCache([call(0, 90_000, 0), call(1, 20_000, 15_000)], GPT).ticks).toEqual(["first", "hit"]);
});

test("the daemon answers with a chat's own requests and its model's cache lifetime", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-cache-line-"));
  mkdirSync(join(root, "workspace")); mkdirSync(join(root, "data"));
  writeFileSync(join(root, "workspace/input.txt"), "hello");
  let asked = 0;
  const processor: TurnProcessor = { providerId: "stand-in", modelId: "scripted", contextCapacity: 262144, maxOutputTokens: 1024, cacheLifeMs: 30 * MINUTE,
    async listModels() { return []; }, async *stream(): AsyncGenerator<ProviderStreamEvent> {
      asked++;
      yield { type: "text_delta", delta: "Done." };
      yield { type: "usage", usage: { inputTokens: 1000 * asked, outputTokens: 5, totalTokens: 1000 * asked + 5, cachedInputTokens: asked === 1 ? 0 : 1000 * (asked - 1) } };
    } };
  const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), processor, nameChats: false });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  try {
    const { session } = await client.createSession({ title: "Cache", workspacePath: join(root, "workspace"), trustWorkspace: true });
    expect((await client.sessionCache(session.id)).cache).toMatchObject({ requests: 0, ticks: [], lastRequestAt: null, keepsMs: null });
    for (const ask of ["One", "Two", "Three"]) {
      const submitted = await client.submitTurn(session.id, { content: ask });
      for await (const event of client.streamEvents(session.id, submitted.eventId, AbortSignal.timeout(5000))) if (event.turnId === submitted.turn.id && event.type === "turn.completed") break;
    }
    const { cache } = await client.sessionCache(session.id);
    expect(cache).toMatchObject({ requests: 3, inputTokens: 6000, cachedTokens: 3000, ticks: ["first", "hit", "hit"], keepsMs: 30 * MINUTE, ownMachine: false, lastMiss: null });
    expect(cache.lastRequestAt).not.toBeNull();
    await expect(client.sessionCache("no-such-chat")).rejects.toThrow();
    const db = new Database(join(root, "data/state.sqlite"), { readonly: true });
    expect(db.query("SELECT count(*) AS n FROM provider_calls").get()).toEqual({ n: 3 });
    db.close();
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
