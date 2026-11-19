import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cacheReport, readCalls, type CallRow } from "../../../scripts/cache-report.ts";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 19, 8, 0) + minutes * 60_000).toISOString();
let serial = 0;
const call = (turnId: string, minute: number, input: number, cached: number, more: Partial<CallRow> = {}): CallRow => ({ id: `c${serial++}`, turnId, sessionId: "s1", provider: "Codex", model: "codex/gpt-6.1-sol",
  startedAt: at(minute), completedAt: at(minute + 0.5), input, cached, written: null, prefix: null, ...more });

test("the report counts what was read from cache and names why a request missed", () => {
  const report = cacheReport([
    call("t1", 0, 10_000, 0),
    call("t1", 1, 12_000, 10_000),
    // A new ask two minutes later, read from cache.
    call("t2", 3, 13_000, 12_000),
    // Plan mode changed the instructions: the meter says so.
    call("t3", 5, 14_000, 500, { prefix: { sentChars: 50_000, previousChars: 48_000, keptChars: 2_000, brokeAt: "instructions", cause: 'The instructions changed, now reading "Plan mode"', idleMs: 90_000 } }),
    // Back after two hours: nobody's fault.
    call("t4", 126, 15_000, 0),
    // A model switch.
    call("t5", 128, 15_500, 0, { model: "codex/gpt-6.2-astra" }),
  ]);
  expect(report.calls).toBe(6);
  expect(report.inputTokens).toBe(79_500);
  expect(report.cachedTokens).toBe(22_500);
  expect(report.models.map((row) => row.model)).toEqual(["codex/gpt-6.1-sol", "codex/gpt-6.2-astra"]);
  expect(report.missed).toEqual([
    { why: "The model was switched", requests: 1, lostTokens: 15_000 },
    { why: "The chat sat idle over an hour", requests: 1, lostTokens: 14_000 },
    { why: "The instructions changed", requests: 1, lostTokens: 12_500 },
  ]);
  expect(report.biggest[0]).toMatchObject({ why: "The model was switched", detail: "codex/gpt-6.1-sol to codex/gpt-6.2-astra", lostTokens: 15_000 });
  // How long the cache lasts: only a turn's first request on the same model counts.
  expect(report.idle).toEqual([
    { provider: "Codex", bucket: "1 to 5 min", asks: 2, medianCachedShare: 500 / 13_000 },
    { provider: "Codex", bucket: "1 to 3 hours", asks: 1, medianCachedShare: 0 },
  ]);
  // Misses inside the hour (the instructions, the model switch) are the ones to win back.
  expect(report.possibleShare).toBeCloseTo((22_500 + 12_500 + 15_000) / 79_500);
});

test("history from before the meter still reads", () => {
  const database = new Database(":memory:");
  database.run("CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT)");
  database.run("CREATE TABLE provider_calls (id TEXT PRIMARY KEY, turn_id TEXT, provider TEXT, model TEXT, status TEXT, started_at TEXT, completed_at TEXT, input_tokens INTEGER, cached_input_tokens INTEGER)");
  database.run("INSERT INTO turns VALUES ('t1', 's1')");
  database.run("INSERT INTO provider_calls VALUES ('c1', 't1', 'Codex', 'gpt', 'completed', ?, ?, 1000, 900)", [at(0), at(1)]);
  database.run("INSERT INTO provider_calls VALUES ('c2', 't1', 'Codex', 'gpt', 'failed', ?, ?, 1000, 0)", [at(2), at(3)]);
  const calls = readCalls(database, at(-60));
  expect(calls).toEqual([{ id: "c1", turnId: "t1", sessionId: "s1", provider: "Codex", model: "gpt", startedAt: at(0), completedAt: at(1), input: 1000, cached: 900, written: null, prefix: null }]);
  expect(cacheReport(calls).cachedTokens).toBe(900);
});
