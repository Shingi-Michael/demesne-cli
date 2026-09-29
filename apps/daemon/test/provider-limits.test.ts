import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { EventEnvelope } from "@demesne/protocol";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";
import type { ProviderStreamLimits } from "../src/provider-limits.ts";

async function run(stream: TurnProcessor["stream"], maxOutputTokens: number, limits: ProviderStreamLimits = {}) {
  const root = mkdtempSync(join(tmpdir(), "demesne-stream-limits-"));
  const app = createDaemonApp({ databasePath: join(root, "state.sqlite"), ...limits,
    processor: { providerId: "test", modelId: "reasoning-model", contextCapacity: 262144, maxOutputTokens,
      async listModels() { return []; }, stream } });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input, init) =>
    Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  try {
    const { session } = await client.createSession({ title: "Large output budget" });
    const { turn, eventId } = await client.submitTurn(session.id, { content: "Think through the problem and answer" });
    const events: EventEnvelope[] = [];
    for await (const event of client.streamEvents(session.id, eventId, AbortSignal.timeout(30000))) {
      if (event.turnId !== turn.id) continue;
      events.push(event);
      if (/^turn\.(completed|failed|cancelled)$/.test(event.type)) break;
    }
    return events;
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}

test("a 131072-token budget survives over 20000 stream events and a million reasoning characters", async () => {
  const chunk = " ".repeat(50) + "x";
  const events = await run(async function* () {
    for (let index = 0; index < 20001; index++) yield { type: "reasoning_delta", delta: chunk };
    yield { type: "text_delta", delta: "Completed the reasoning." };
    yield { type: "finish", reason: "stop" };
  }, 131072);
  expect(events.at(-1)?.type).toBe("turn.completed");
  expect(events.filter((event) => event.type === "reasoning.delta")).toHaveLength(20001);
  expect(events.find((event) => event.type === "model.request_started")?.payload.contextPlan).toMatchObject({
    reserves: { outputTokens: 131072 },
  });
}, 30000);

test.each([
  { output: 131072, timeout: undefined, status: "turn.completed" },
  { output: 131072, timeout: undefined, elapsed: 7300000, status: "turn.completed" },
  { output: 1536, timeout: undefined, status: "turn.failed" },
  { output: 131072, timeout: 900000, status: "turn.failed" },
])("streaming deadlines accommodate slow-model output budgets and explicit timeouts ($output/$timeout/$elapsed)", async ({ output, timeout, elapsed = 900001, status }) => {
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const events = await run(async function* () {
      yield { type: "reasoning_delta", delta: "Still working." };
      now += elapsed;
      yield { type: "reasoning_delta", delta: "Ready to answer." };
      yield { type: "text_delta", delta: "Finished." };
      yield { type: "finish", reason: "stop" };
    }, output, { providerRequestTimeoutMs: timeout });
    expect(events.at(-1)?.type).toBe(status);
    if (status === "turn.failed") expect(events.at(-1)?.payload.message).toContain("total timeout");
  } finally { clock.mockRestore(); }
});

test("an explicit stream-event limit still aborts a large-budget request", async () => {
  let signal: AbortSignal | undefined;
  const events = await run(async function* (_messages, _tools, currentSignal) {
    signal = currentSignal;
    for (let index = 0; index < 4; index++) yield { type: "reasoning_delta", delta: "Working." };
    yield { type: "text_delta", delta: "Must not complete." };
  }, 131072, { providerEventLimit: 3 });
  expect(events.at(-1)?.type).toBe("turn.failed");
  expect(events.at(-1)?.payload.message).toContain("event limit");
  expect(signal?.aborted).toBe(true);
});
