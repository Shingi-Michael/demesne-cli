/// The cache line: one chat's prompt cache in a few numbers, for the context
/// card. How much of what the chat sent the provider read from its cache, a
/// tick per request (read from cache, or read again), how long the cache
/// lasts on this model, and why the newest miss happened.
///
/// It reads what is already recorded for every request: the provider's own
/// cache count, and the cache meter's finding (cache-prefix.ts). Nothing is
/// measured again here, and nothing is guessed: a provider that reports no
/// cache count gets no share.
///
/// Read more: docs/caching.md ("The number on screen") and
/// https://code.claude.com/docs/en/prompt-caching#check-cache-performance
import type { ChatCache, ChatCacheMiss, PrefixReport } from "@demesne/protocol";

export interface CacheCall { provider: string; model: string; startedAt: string; completedAt: string | null; inputTokens: number; cachedTokens: number | null; prefix: PrefixReport | null }

/// A request that read less than this share of what it could have was read again.
const MISS_BELOW = 0.5;
/// The ticks the card has room for.
const TICKS = 60;

export function chatCache(calls: readonly CacheCall[], life: { keepsMs: number | null; ownMachine: boolean }): ChatCache {
  const measured = calls.filter((call) => call.cachedTokens !== null);
  const ticks: ChatCache["ticks"] = [];
  let lastMiss: ChatCacheMiss | null = null, previous: CacheCall | undefined;
  for (const call of measured) {
    const before = previous;
    previous = call;
    if (!before) { ticks.push("first"); continue; }
    // The request before is the most this one could have read from cache.
    const reusable = Math.min(before.inputTokens, call.inputTokens);
    if (call.cachedTokens! >= reusable * MISS_BELOW) { ticks.push("hit"); continue; }
    ticks.push("miss");
    const idleMs = call.prefix?.idleMs ?? Math.max(0, Date.parse(call.startedAt) - Date.parse(before.completedAt ?? before.startedAt));
    lastMiss = { at: call.startedAt, idleMs, ...why(call, before, idleMs, life) };
  }
  return {
    requests: measured.length,
    inputTokens: measured.reduce((total, call) => total + call.inputTokens, 0),
    cachedTokens: measured.reduce((total, call) => total + call.cachedTokens!, 0),
    ticks: ticks.slice(-TICKS),
    keepsMs: life.keepsMs, ownMachine: life.ownMachine,
    lastRequestAt: calls.at(-1)?.completedAt ?? calls.at(-1)?.startedAt ?? null,
    lastMiss,
  };
}

/// Why a request was read again, in the order the answer is known best.
function why(call: CacheCall, before: CacheCall, idleMs: number, life: { keepsMs: number | null; ownMachine: boolean }): Pick<ChatCacheMiss, "why" | "shortened"> {
  if (before.provider !== call.provider || before.model !== call.model) return { why: "model" };
  if (call.prefix?.brokeAt === "tools") return { why: "tools" };
  if (call.prefix?.brokeAt === "instructions") return { why: "instructions" };
  const away = !life.ownMachine && life.keepsMs !== null && idleMs >= life.keepsMs;
  // Old turns are shortened only once the cache is gone: the wait lost it, not the cut.
  if (call.prefix?.brokeAt === "history") return away ? { why: "away", shortened: true } : { why: "history" };
  if (away) return { why: "away" };
  return { why: life.ownMachine ? "taken" : "dropped" };
}
