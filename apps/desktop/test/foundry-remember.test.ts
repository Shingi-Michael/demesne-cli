import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const RUNTIME = readFileSync(join(import.meta.dir, "../foundry-kit/remember.js"), "utf8");

/// The runtime in a bare page: a fake fetch stands in for the foundry: handler.
function page(options: { inside?: boolean; storage?: boolean } = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [], kept: Record<string, unknown> = {}, local = new Map<string, string>();
  const fetch = async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    if (body.page !== "key") return { ok: false, status: 403, json: async () => ({ error: "This page can't reach Demesne" }) };
    if (url.startsWith("foundry://ask/")) return { ok: true, status: 200, json: async () => ({ answer: `You asked: ${body.question}` }) };
    if (typeof body.name === "string") { if (body.value === null) delete kept[body.name]; else kept[body.name] = body.value; }
    return { ok: true, status: 200, json: async () => ({ data: { ...kept } }) };
  };
  const localStorage = { get length() { return local.size; }, key: (i: number) => [...local.keys()][i] ?? null, getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) };
  const window: Record<string, unknown> = { __demesnePage: options.inside === false ? undefined : { id: "a1", key: "key" } };
  if (options.storage) Object.defineProperty(window, "localStorage", { get: () => localStorage });
  else Object.defineProperty(window, "localStorage", { get: () => { throw new Error("SecurityError"); } });
  runInNewContext(RUNTIME, { window, fetch, location: { pathname: "/a1" }, Promise, JSON, Object, String, Error, TypeError });
  return { demesne: window.demesne as { save(k: string, v: unknown): Promise<unknown>; load(k: string, f?: unknown): Promise<unknown>; ask(q: string): Promise<string> }, calls, kept, local, window };
}

test("inside Demesne, saves go to the page's own address with its key, in order", async () => {
  const { demesne, calls, kept, window } = page();
  expect(window.__demesnePage).toBeUndefined();
  expect(await demesne.load("items", [])).toEqual([]);
  await Promise.all([demesne.save("items", ["a"]), demesne.save("items", ["a", "b"])]);
  expect(kept.items).toEqual(["a", "b"]);
  expect(await demesne.load("items")).toEqual(["a", "b"]);
  expect(calls.every((call) => call.url === "foundry://data/a1" && call.body.page === "key")).toBe(true);
  // Loaded once, then answered from what the page already has.
  expect(calls.filter((call) => call.body.name === undefined).length).toBe(1);
  await demesne.save("items", undefined);
  expect("items" in kept).toBe(false);
  expect(await demesne.ask("What did I forget?")).toBe("You asked: What did I forget?");
  await expect(demesne.ask("  ")).rejects.toThrow(/needs a question/);
  expect(() => demesne.save("", 1)).toThrow(/name/);
});

test("outside Demesne a page keeps its saves in localStorage, or in memory where there is none", async () => {
  const exported = page({ inside: false, storage: true });
  await exported.demesne.save("n", 3);
  expect(exported.local.get("demesne:/a1:n")).toBe("3");
  expect(await exported.demesne.load("n")).toBe(3);
  expect(exported.calls).toEqual([]);
  expect(await exported.demesne.ask("hi")).toContain("open in Demesne");
  const look = page({ inside: false });
  await look.demesne.save("n", { a: 1 });
  expect(await look.demesne.load("n")).toEqual({ a: 1 });
  expect(await look.demesne.load("missing", "fallback")).toBe("fallback");
});
