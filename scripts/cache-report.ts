/** The cache report: how well the prompt cache worked in your real chats.
 *
 * Reads Demesne's own history (read-only, nothing leaves the machine) and
 * prints, for the last days:
 *  - the share of input the provider read from its cache, per provider and model;
 *  - how that share falls the longer a chat sat idle before its next ask,
 *    which shows how long each provider really keeps its cache;
 *  - the requests that lost a cache they should have had, grouped by why
 *    (the cache meter's record where there is one, apps/daemon/src/cache-prefix.ts),
 *    and the biggest of them.
 *
 *   bun scripts/cache-report.ts [--db path/state.sqlite] [--days 14] [--json file]
 *
 * Read more: https://code.claude.com/docs/en/prompt-caching#check-cache-performance
 */
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/config/src/index.ts";
import type { PrefixReport } from "../packages/protocol/src/index.ts";

export interface CallRow { id: string; turnId: string; sessionId: string; provider: string; model: string; startedAt: string; completedAt: string | null; input: number; cached: number | null; written: number | null; prefix: PrefixReport | null }
export interface Miss { at: string; provider: string; model: string; lostTokens: number; idleMinutes: number | null; why: string; detail: string }
export interface CacheReport {
  calls: number; inputTokens: number; cachedTokens: number;
  models: { provider: string; model: string; calls: number; inputTokens: number; cachedTokens: number }[];
  idle: { provider: string; bucket: string; asks: number; medianCachedShare: number }[];
  missed: { why: string; requests: number; lostTokens: number }[];
  biggest: Miss[];
  /// The share read from cache had no chat idle under an hour missed.
  possibleShare: number;
}

/// Idle time before a turn's first request, in minutes: up to each bound.
const BUCKETS: [number, string][] = [[1, "under 1 min"], [5, "1 to 5 min"], [10, "5 to 10 min"], [15, "10 to 15 min"], [30, "15 to 30 min"], [60, "30 to 60 min"], [180, "1 to 3 hours"], [Infinity, "over 3 hours"]];
const bucketOf = (minutes: number) => BUCKETS.find(([bound]) => minutes < bound)![1];
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0; };
/// A request that read less than this share of the one before it lost its cache.
const MISS_BELOW = 0.5;
/// Past this the cache is surely gone whoever the provider is: not Demesne's doing.
const SURELY_COLD_MINUTES = 60;

export function readCalls(database: Database, sinceIso: string): CallRow[] {
  const columns = new Set((database.query("PRAGMA table_info(provider_calls)").all() as { name: string }[]).map((column) => column.name));
  const optional = (name: string) => columns.has(name) ? `c.${name}` : "NULL";
  const rows = database.query(`SELECT c.id, c.turn_id, t.session_id, c.provider, c.model, c.started_at, c.completed_at, c.input_tokens, c.cached_input_tokens,
      ${optional("cache_write_tokens")} AS written, ${optional("prefix_json")} AS prefix
    FROM provider_calls c JOIN turns t ON t.id = c.turn_id
    WHERE c.status = 'completed' AND c.input_tokens IS NOT NULL AND c.input_tokens > 0 AND c.started_at >= ?
    ORDER BY t.session_id, c.started_at, c.rowid`).all(sinceIso) as { id: string; turn_id: string; session_id: string; provider: string; model: string; started_at: string; completed_at: string | null; input_tokens: number; cached_input_tokens: number | null; written: number | null; prefix: string | null }[];
  return rows.map((row) => ({ id: row.id, turnId: row.turn_id, sessionId: row.session_id, provider: row.provider, model: row.model, startedAt: row.started_at, completedAt: row.completed_at,
    input: row.input_tokens, cached: row.cached_input_tokens, written: row.written, prefix: row.prefix ? JSON.parse(row.prefix) as PrefixReport : null }));
}

/// Why a request lost its cache, in the order the answer is known best.
function reason(call: CallRow, previous: CallRow, idleMinutes: number): { why: string; detail: string } {
  if (previous.model !== call.model || previous.provider !== call.provider) return { why: "The model was switched", detail: `${previous.model} to ${call.model}` };
  if (call.prefix?.brokeAt === "instructions") return { why: "The instructions changed", detail: call.prefix.cause ?? "" };
  if (call.prefix?.brokeAt === "tools") return { why: "The tool list changed", detail: call.prefix.cause ?? "" };
  if (call.prefix?.brokeAt === "history") return { why: "Earlier history was rewritten", detail: call.prefix.cause ?? "" };
  if (idleMinutes >= SURELY_COLD_MINUTES) return { why: "The chat sat idle over an hour", detail: "" };
  if (call.prefix && call.prefix.previousChars !== null) return { why: `The cache had expired or was dropped (idle ${bucketOf(idleMinutes)})`, detail: "the request repeated the one before it exactly" };
  return { why: `Not known: from before the cache meter (idle ${bucketOf(idleMinutes)})`, detail: "" };
}

export function cacheReport(calls: CallRow[]): CacheReport {
  const measured = calls.filter((call) => call.cached !== null);
  const models = new Map<string, CacheReport["models"][number]>();
  for (const call of measured) {
    const key = `${call.provider}\n${call.model}`;
    const entry = models.get(key) ?? { provider: call.provider, model: call.model, calls: 0, inputTokens: 0, cachedTokens: 0 };
    entry.calls++; entry.inputTokens += call.input; entry.cachedTokens += call.cached!;
    models.set(key, entry);
  }
  const idle = new Map<string, number[]>(), missed = new Map<string, { requests: number; lostTokens: number }>(), biggest: Miss[] = [];
  let avoidable = 0;
  const last = new Map<string, CallRow>();
  for (const call of measured) {
    const previous = last.get(call.sessionId);
    last.set(call.sessionId, call);
    if (!previous) continue;
    const idleMinutes = Math.max(0, Date.parse(call.startedAt) - Date.parse(previous.completedAt ?? previous.startedAt)) / 60_000;
    // The request before is the most this one could have read from cache.
    const reusable = Math.min(previous.input, call.input);
    if (reusable <= 0) continue;
    if (previous.model === call.model && previous.provider === call.provider && previous.turnId !== call.turnId) {
      const key = `${call.provider}\n${bucketOf(idleMinutes)}`;
      idle.set(key, [...(idle.get(key) ?? []), Math.min(1, call.cached! / reusable)]);
    }
    if (call.cached! >= reusable * MISS_BELOW) continue;
    const lostTokens = reusable - call.cached!, { why, detail } = reason(call, previous, idleMinutes);
    const entry = missed.get(why) ?? { requests: 0, lostTokens: 0 };
    entry.requests++; entry.lostTokens += lostTokens;
    missed.set(why, entry);
    if (idleMinutes < SURELY_COLD_MINUTES) avoidable += lostTokens;
    biggest.push({ at: call.startedAt, provider: call.provider, model: call.model, lostTokens, idleMinutes: Math.round(idleMinutes), why, detail });
  }
  const inputTokens = measured.reduce((total, call) => total + call.input, 0), cachedTokens = measured.reduce((total, call) => total + call.cached!, 0);
  return {
    calls: measured.length, inputTokens, cachedTokens,
    models: [...models.values()].sort((a, b) => b.inputTokens - a.inputTokens),
    idle: [...idle.entries()].map(([key, shares]) => { const [provider, bucket] = key.split("\n") as [string, string]; return { provider, bucket, asks: shares.length, medianCachedShare: median(shares) }; })
      .sort((a, b) => a.provider.localeCompare(b.provider) || BUCKETS.findIndex(([, name]) => name === a.bucket) - BUCKETS.findIndex(([, name]) => name === b.bucket)),
    missed: [...missed.entries()].map(([why, entry]) => ({ why, ...entry })).sort((a, b) => b.lostTokens - a.lostTokens),
    biggest: biggest.sort((a, b) => b.lostTokens - a.lostTokens).slice(0, 10),
    possibleShare: inputTokens ? Math.min(1, (cachedTokens + avoidable) / inputTokens) : 0,
  };
}

if (import.meta.main) {
  const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
  const days = Number(flag("days") ?? 14);
  const path = flag("db") ?? join(loadConfig({ includeProject: false }).config.dataDir ?? join(homedir(), ".demesne"), "state.sqlite");
  if (!existsSync(path)) { console.error(`No history at ${path}. Pass --db path/to/state.sqlite.`); process.exit(1); }
  const database = new Database(path, { readonly: true });
  const report = cacheReport(readCalls(database, new Date(Date.now() - days * 86_400_000).toISOString()));
  database.close();
  const k = (tokens: number) => tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
  const share = (part: number, whole: number) => whole ? `${(part / whole * 100).toFixed(1)}%` : "n/a";
  console.log(`Last ${days} days, ${path}\n`);
  if (!report.calls) { console.log("No requests with a cache count in that time."); process.exit(0); }
  console.log(`Read from cache: ${share(report.cachedTokens, report.inputTokens)} of ${k(report.inputTokens)} input tokens over ${report.calls} requests.`);
  console.log(`With no misses in chats idle under an hour it would have been ${(report.possibleShare * 100).toFixed(1)}%.\n`);
  console.log("By model");
  for (const row of report.models) console.log(`  ${`${row.provider} ${row.model}`.padEnd(38)} ${share(row.cachedTokens, row.inputTokens).padStart(6)}  ${k(row.inputTokens).padStart(7)} in  ${String(row.calls).padStart(5)} requests`);
  console.log("\nHow long the cache lasts: a turn's first request, by how long the chat sat idle before it");
  for (const row of report.idle) console.log(`  ${row.provider.padEnd(18)} ${row.bucket.padEnd(14)} ${`${Math.round(row.medianCachedShare * 100)}%`.padStart(5)} read from cache (median of ${row.asks})`);
  console.log(`\nRequests that read under ${MISS_BELOW * 100}% of the request before them from cache`);
  if (!report.missed.length) console.log("  None.");
  for (const row of report.missed) console.log(`  ${k(row.lostTokens).padStart(7)} tokens  ${String(row.requests).padStart(4)} requests  ${row.why}`);
  if (report.biggest.length) console.log("\nThe biggest");
  for (const miss of report.biggest) console.log(`  ${miss.at.slice(0, 16).replace("T", " ")}  ${k(miss.lostTokens).padStart(6)}  ${miss.model}  idle ${miss.idleMinutes} min  ${miss.why}${miss.detail ? `: ${miss.detail}` : ""}`);
  const out = flag("json");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
}
