/// The cache clock: how long after a chat's last request its provider still
/// holds the prompt cache. Two things wait for the cache to be gone before
/// they rewrite a conversation, because rewriting what a cache still holds
/// throws it away: cutting old turns to notes (forget-reads.ts) and
/// compacting while you are away (app.ts). They used to wait a fixed 15 and
/// 10 minutes for every provider, which gave up a GPT-6 cache that lives 30
/// minutes or 12 hours, and a local model's cache that never goes by time.
///
/// The clock starts from what the provider publishes (cacheLifeMs on its
/// adapter) and is corrected by what Demesne has measured: the cache meter
/// (cache-prefix.ts) records, for every request, how long the chat sat idle
/// and whether the request repeated the one before it. A request that
/// repeated everything and still read nothing from cache shows the cache
/// was gone by then; one that read it shows it was alive.
///
/// Read more: docs/caching.md ("The cache clock"),
/// https://developers.openai.com/api/docs/guides/prompt-caching (lifetimes)
/// and https://platform.claude.com/docs/en/build-with-claude/prompt-caching
/// (what a lifetime costs).
import type { PrefixReport } from "@demesne/protocol";

/// When nothing is published and nothing is measured.
export const DEFAULT_CACHE_LIFE_MS = 15 * 60_000;
/// Idle time before a request, in minutes: up to each bound.
const BOUNDS = [1, 5, 10, 15, 30, 60, 180, 720, 1440];
/// A bucket says something once it holds this many requests.
const ENOUGH = 3;
/// How much history the clock reads, and how long an answer is reused.
const DAYS = 14, REFRESH_MS = 10 * 60_000;

/// One past request, as the clock needs it.
export interface CacheSample { inputTokens: number; cachedTokens: number; prefix: PrefixReport }

/// What the measurements say about one provider and model: how long its
/// cache was seen alive, and from when it was seen gone. Either can be
/// unknown.
export interface MeasuredLife { aliveMs: number | null; goneMs: number | null; samples: number }

/// Requests that tested the provider's cache and nothing else: they repeated
/// the request before them, so a miss is the provider's, not Demesne's.
export function measureLife(samples: readonly CacheSample[]): MeasuredLife {
  const buckets = BOUNDS.map(() => ({ hits: 0, total: 0 }));
  let counted = 0;
  for (const { inputTokens, cachedTokens, prefix } of samples) {
    if (prefix.brokeAt || prefix.previousChars === null || prefix.keptChars === null || prefix.idleMs === null || !prefix.sentChars || inputTokens < 1024) continue;
    const expected = prefix.keptChars / prefix.sentChars;
    if (expected < 0.5) continue;
    const bucket = BOUNDS.findIndex((bound) => prefix.idleMs! < bound * 60_000);
    if (bucket < 0) continue;
    buckets[bucket]!.total++; counted++;
    if (cachedTokens / inputTokens >= expected / 2) buckets[bucket]!.hits++;
  }
  // A provider that never reports a cache read can't be told from one that
  // never caches: nothing is concluded, and the published figure stands.
  if (!buckets.some((bucket) => bucket.hits > 0)) return { aliveMs: null, goneMs: null, samples: counted };
  let aliveMs: number | null = null, goneMs: number | null = null;
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.total < ENOUGH) continue;
    if (bucket.hits * 2 >= bucket.total) aliveMs = BOUNDS[index]! * 60_000;
    // Gone from the start of the first wait after which most requests missed.
    else { goneMs = (BOUNDS[index - 1] ?? 0) * 60_000; break; }
  }
  return { aliveMs, goneMs, samples: counted };
}

/// The idle time after which the cache is taken to be gone. Measured where
/// there is enough to go on; the published figure otherwise.
export function coldAfterMs(published: number | undefined, measured: MeasuredLife | null): number {
  const base = published ?? DEFAULT_CACHE_LIFE_MS;
  if (!measured) return base;
  // Seen gone: from then on, but never earlier than it was seen alive, and
  // never under a minute.
  if (measured.goneMs !== null) return Math.max(60_000, measured.goneMs, measured.aliveMs ?? 0);
  // Never seen gone: at least as long as it was seen alive.
  return Math.max(base, measured.aliveMs ?? 0);
}

interface ClockStore { cacheSamples(provider: string, model: string, sinceIso: string): CacheSample[] }

/// One clock for the daemon: an answer per provider and model, read from
/// history at most every ten minutes.
export class CacheClock {
  private readonly known = new Map<string, { at: number; measured: MeasuredLife }>();
  constructor(private readonly store: ClockStore, private readonly now: () => number = Date.now) {}

  measured(provider: string, model: string): MeasuredLife {
    const key = `${provider}\n${model}`, at = this.now(), known = this.known.get(key);
    if (known && at - known.at < REFRESH_MS) return known.measured;
    const measured = measureLife(this.store.cacheSamples(provider, model, new Date(at - DAYS * 86_400_000).toISOString()));
    this.known.set(key, { at, measured });
    return measured;
  }

  /// How long this model's cache is taken to live after a request.
  coldAfterMs(inference: { providerId: string; modelId: string; cacheLifeMs?: number }): number {
    return coldAfterMs(inference.cacheLifeMs, this.measured(inference.providerId, inference.modelId));
  }
}
