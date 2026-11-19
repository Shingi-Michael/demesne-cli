import { expect, test } from "bun:test";
import type { ChatCache } from "@demesne/protocol";
import { cacheHalfHTML, waitWords } from "../cache-line.ts";

const NOW = Date.parse("2026-11-19T10:00:00Z"), ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const chat = (over: Partial<ChatCache> = {}): ChatCache => ({ requests: 41, inputTokens: 2_000_000, cachedTokens: 1_920_000,
  ticks: ["first", ...Array(28).fill("hit"), "miss", ...Array(11).fill("hit")], keepsMs: 30 * 60_000, ownMachine: false, lastRequestAt: ago(6),
  lastMiss: { at: ago(50), why: "away", idleMs: 45 * 60_000, shortened: true }, ...over });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("a warm chat says its share, how long it stays warm, and the last miss", () => {
  const html = cacheHalfHTML(chat(), NOW, "GPT-6");
  expect(text(html)).toContain("Cache 96% read from cache");
  expect(text(html)).toContain("96% of this chat was read from the provider’s cache. Warm for about 24 more minutes .");
  expect(text(html)).toContain("41 requests · 1.9M of 2M tokens cached");
  expect(text(html)).toContain("Last miss: you were away 45 minutes, past the 30 GPT-6 keeps it. Old file reads were shortened then, at no extra cost.");
  // A tick per request; the first and the miss are the faint ones.
  expect(html.match(/<i/g)).toHaveLength(41);
  expect(html.match(/class="again"/g)).toHaveLength(2);
});

test("a chat left past the cache's lifetime says it has gone cold, and what happens next", () => {
  const html = text(cacheHalfHTML(chat({ lastRequestAt: ago(42) }), NOW, "GPT-6"));
  expect(html).toContain("The cache has gone cold: this chat sat 42 minutes , past the 30 GPT-6 keeps it. The next message reads it once again.");
  expect(html).toContain("Demesne shortens old file reads before that message");
  expect(html).not.toContain("Last miss");
  // While a turn works the cache is in use, however long ago the last request ended.
  expect(text(cacheHalfHTML(chat({ lastRequestAt: ago(42) }), NOW, "GPT-6", true))).not.toContain("gone cold");
});

test("a model on your own machine never goes cold by time", () => {
  const html = text(cacheHalfHTML(chat({ ownMachine: true, keepsMs: 24 * 3_600_000, lastRequestAt: ago(600), cachedTokens: 1_980_000,
    lastMiss: { at: ago(700), why: "taken", idleMs: 180_000 } }), NOW, "gemma-4-31b"));
  expect(html).toContain("99% of this chat was kept by the model on your machine. It stays until another chat takes its place.");
  expect(html).toContain("tokens kept");
  expect(html).toContain("Last miss: another chat used the model in between, so this one was read again.");
});

test("each reason for a miss is said in its own words, and a long cache in hours", () => {
  const why = (miss: NonNullable<ChatCache["lastMiss"]>["why"], idleMs = 120_000) => text(cacheHalfHTML(chat({ lastMiss: { at: ago(9), why: miss, idleMs } }), NOW, "GPT-6"));
  expect(why("model")).toContain("Last miss: the model changed");
  expect(why("tools")).toContain("Last miss: the tool list changed.");
  expect(why("instructions")).toContain("Last miss: the instructions changed.");
  expect(why("history")).toContain("Last miss: an earlier part of the chat was rewritten");
  expect(why("dropped")).toContain("Last miss: the provider let its cache go early, after 2 minutes idle.");
  expect(why("dropped", 4000)).toContain("after less than a minute idle.");
  expect(text(cacheHalfHTML(chat({ keepsMs: 12 * 3_600_000, lastMiss: null }), NOW, "GPT-6"))).toContain("Warm for about 12 more hours .");
  expect(text(cacheHalfHTML(chat({ keepsMs: 12 * 3_600_000, lastRequestAt: ago(13 * 60), lastMiss: null }), NOW, "GPT-6"))).toContain("this chat sat 13 hours , past the 12 hours GPT-6 keeps it");
  expect([waitWords(20_000), waitWords(60 * 60_000), waitWords(89 * 60_000)]).toEqual(["1 minute", "1 hour", "1 hour"]);
});

test("nothing is shown before there is something to say, and a lifetime that is not known is left out", () => {
  expect(cacheHalfHTML(null, NOW, "GPT-6")).toBe("");
  expect(cacheHalfHTML(chat({ requests: 0, inputTokens: 0, cachedTokens: 0, ticks: [] }), NOW, "GPT-6")).toBe("");
  const unknown = text(cacheHalfHTML(chat({ keepsMs: null, lastMiss: { at: ago(9), why: "away", idleMs: 45 * 60_000 } }), NOW, "<b>x"));
  expect(unknown).not.toContain("Warm for");
  expect(unknown).toContain("Last miss: you were away 45 minutes.");
  // One request has no line of ticks, and a model's name is never markup.
  expect(cacheHalfHTML(chat({ requests: 1, ticks: ["first"] }), NOW, "GPT-6")).not.toContain("cache-ticks");
  expect(cacheHalfHTML(chat({ lastRequestAt: ago(42) }), NOW, "<b>x")).toContain("&lt;b&gt;x");
});
