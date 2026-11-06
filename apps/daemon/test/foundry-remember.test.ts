import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { createDaemonApp, type TurnProcessor } from "../src/app.ts";
import { AskLimits, askOnce, askMessages } from "../src/foundry-ask.ts";

function daemon(answer = "A plug adapter.") {
  const root = mkdtempSync(join(tmpdir(), "demesne-remember-"));
  const asked: string[] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "test", async listModels() { return []; },
    async *stream(messages) { asked.push(String(messages.at(-1)?.content)); yield { type: "text_delta" as const, delta: answer }; } };
  const app = createDaemonApp({ databasePath: join(root, "state.sqlite"), processor, authToken: "t" });
  const client = new DemesneClient({ server: "http://localhost", token: "t", fetch: ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url, init)))) as typeof fetch });
  return { app, client, asked, done: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("a page's saves stay with the artifact across versions and go with it", async () => {
  const { client, done } = daemon();
  try {
    const page = await client.foundrySave({ title: "Trip checklist", kind: "html", source: "<p>v1</p>" });
    expect((await client.foundryData(page.id)).data).toEqual({});
    await client.foundrySetData(page.id, "done", [true, false]);
    await client.foundrySetData(page.id, "note", "pack light");
    await client.foundrySave({ id: page.id, source: "<p>v2</p>" });
    expect((await client.foundryData(page.id)).data).toEqual({ done: [true, false], note: "pack light" });
    // null forgets one name.
    expect((await client.foundrySetData(page.id, "note", null)).data).toEqual({ done: [true, false] });
    await expect(client.foundrySetData(page.id, "big", "x".repeat(300 * 1024))).rejects.toThrow(/256 KB/);
    await client.foundryDelete(page.id);
    await expect(client.foundryData(page.id)).rejects.toThrow(/not found/i);
  } finally { await done(); }
});

test("a page asks the chat's model and gets plain text, a few times a minute at most", async () => {
  const { client, asked, done } = daemon();
  try {
    const page = await client.foundrySave({ title: "Trip checklist", kind: "html", source: "<p>v1</p>" });
    expect((await client.foundryAsk(page.id, "What did I forget?")).answer).toBe("A plug adapter.");
    expect(asked[0]).toContain("The page: Trip checklist");
    expect(asked[0]).toContain("What did I forget?");
    for (let index = 1; index < 6; index++) await client.foundryAsk(page.id, "again");
    await expect(client.foundryAsk(page.id, "one more")).rejects.toThrow(/too often/);
    await expect(client.foundryAsk("missing", "hello")).rejects.toThrow(/not found/i);
  } finally { await done(); }
});

test("ask limits slide per artifact, by minute and by hour", () => {
  let now = 0;
  const limits = new AskLimits(2, 3, () => now);
  expect(limits.take("a")).toBeNull(); expect(limits.take("a")).toBeNull();
  expect(limits.take("a")).toMatch(/too often/);
  expect(limits.take("b")).toBeNull();
  now = 61_000; expect(limits.take("a")).toBeNull();
  now = 122_000; expect(limits.take("a")).toMatch(/this hour/);
  now = 3_600_001 + 61_000; expect(limits.take("a")).toBeNull();
});

test("an answer is trimmed and a silent model is an error", async () => {
  async function* says(text: string) { yield { type: "text_delta", delta: text }; }
  expect(await askOnce(() => says("  Yes.\n"), "Quiz", "Is it?")).toBe("Yes.");
  await expect(askOnce(() => says(""), "Quiz", "Is it?")).rejects.toThrow(/no answer/);
  expect(String(askMessages("Quiz", "x".repeat(9000))[1]!.content).length).toBeLessThan(8100);
});
