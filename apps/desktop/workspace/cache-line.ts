/// The Cache half of the context card (pass 243 A): how much of this chat
/// the provider read from its cache, how long it stays warm, a tick per
/// request, and the last miss in one sentence. Greys only: a faint tick is
/// a request that was read again.
///
/// The numbers come from the daemon (apps/daemon/src/cache-line.ts); this
/// file only says them. Read more: docs/caching.md ("The number on screen").
import type { ChatCache, ChatCacheMiss } from "@demesne/protocol";

const escape = (text: string) => text.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
const tokens = (value: number) => value >= 1e6 ? `${+(value / 1e6).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
/// "24 minutes", "1 hour", "11 hours": a wait the way people say it.
export function waitWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
/// "30", "30 minutes" said short when the unit was just said: "45 minutes, past the 30".
const shortWait = (ms: number, like: number) => (ms < 3_600_000) === (like < 3_600_000) && ms < 3_600_000 ? String(Math.round(ms / 60_000)) : waitWords(ms);

function missWords(miss: ChatCacheMiss, cache: ChatCache, model: string): string {
  if (miss.why === "away") return `you were away ${waitWords(miss.idleMs)}${cache.keepsMs ? `, past the ${shortWait(cache.keepsMs, miss.idleMs)} ${model} keeps it` : ""}.${miss.shortened ? " Old file reads were shortened then, at no extra cost." : ""}`;
  if (miss.why === "model") return "the model changed, and each model has a cache of its own.";
  if (miss.why === "tools") return "the tool list changed.";
  if (miss.why === "instructions") return "the instructions changed.";
  if (miss.why === "history") return "an earlier part of the chat was rewritten, by compacting it or cutting a very large read.";
  if (miss.why === "taken") return "another chat used the model in between, so this one was read again.";
  return `the provider let its cache go early, after ${miss.idleMs < 60_000 ? "less than a minute" : waitWords(miss.idleMs)} idle.`;
}

/// The half as HTML. `working`: a turn is running, so the cache is in use.
export function cacheHalfHTML(cache: ChatCache | null, now: number, model: string, working = false): string {
  if (!cache || !cache.requests || !cache.inputTokens) return "";
  const name = escape(model || "this model");
  const share = Math.round(cache.cachedTokens / cache.inputTokens * 100);
  const idle = cache.lastRequestAt ? Math.max(0, now - Date.parse(cache.lastRequestAt)) : 0;
  const cold = !working && !cache.ownMachine && cache.keepsMs !== null && idle >= cache.keepsMs;
  const read = `<b>${share}% of this chat</b> was ${cache.ownMachine ? "kept by the model on your machine" : "read from the provider’s cache"}.`;
  const say = cold
    ? `The cache has gone cold: <b>this chat sat ${waitWords(idle)}</b>, past the ${shortWait(cache.keepsMs!, idle)} ${name} keeps it. The next message reads it once again.`
    : cache.ownMachine ? `${read} It stays until another chat takes its place.`
    : cache.keepsMs !== null && !working ? `${read} Warm for about <b>${waitWords(cache.keepsMs - idle).replace(" ", " more ")}</b>.`
    : read;
  const why = cold ? "Demesne shortens old file reads before that message, since the whole chat is read anyway."
    : cache.lastMiss ? `Last miss: ${missWords(cache.lastMiss, cache, name)}` : "";
  const ticks = cache.ticks.length > 1
    ? `<div class="cache-ticks" aria-hidden="true">${cache.ticks.map((tick) => `<i${tick === "hit" ? "" : ' class="again"'}></i>`).join("")}</div>` : "";
  return `<div class="context-head"><span>Cache</span><span>${share}% ${cache.ownMachine ? "kept" : "read from cache"}</span></div>`
    + `<p class="context-say">${say}</p>${ticks}`
    + `<div class="cache-foot">${cache.requests} request${cache.requests === 1 ? "" : "s"} · ${tokens(cache.cachedTokens)} of ${tokens(cache.inputTokens)} tokens ${cache.ownMachine ? "kept" : "cached"}</div>`
    + (why ? `<p class="cache-why">${why}</p>` : "");
}
