import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { ProviderAdapter, ProviderRequest } from "@demesne/providers";
import { createDaemonApp, type DaemonApp } from "../src/app.ts";
import { ProviderTurnProcessor } from "../src/provider-processor.ts";

test("direct session turns use saved effort, not another chat's global selection, after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-session-effort-"));
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    id: "test",
    async listModels() { return ["one", "two"].map(id => ({ id, provider: "test", reasoningLevels: ["low", "medium", "high"] })); },
    async *stream(request) { requests.push(request); yield { type: "text_delta", delta: "Done" }; yield { type: "finish", reason: "stop" }; },
  };
  let app: DaemonApp | undefined;
  try {
    let processor = new ProviderTurnProcessor(provider, "one");
    app = createDaemonApp({ databasePath: join(root, "state.sqlite"), processor });
    const client = new DemesneClient({ server: "http://localhost", fetch: ((input, init) => Promise.resolve(app!.fetch(new Request(input, init)))) as typeof fetch });
    await client.listModels();
    const a = (await client.createSession({ title: "High" })).session.id;
    const b = (await client.createSession({ title: "Low" })).session.id;
    const c = (await client.createSession({ title: "Default" })).session.id;
    await client.updateSession(a, { preferredModel: "one", preferredReasoning: "high" });
    await client.updateSession(b, { preferredModel: "one", preferredReasoning: "low" });
    await client.updateSession(c, { preferredModel: "one" });
    await app.close();
    processor = new ProviderTurnProcessor(provider, "two");
    app = createDaemonApp({ databasePath: join(root, "state.sqlite"), processor });
    await client.listModels();
    await client.setModel("two", "high");
    for (const session of [a, b, c]) {
      const submitted = await client.submitTurn(session, { content: "Reply" });
      for await (const event of client.streamEvents(session, submitted.eventId, AbortSignal.timeout(5000))) {
        if (event.turnId === submitted.turn.id && /^turn\.(completed|failed)$/.test(event.type)) {
          expect(event.type).toBe("turn.completed"); break;
        }
      }
    }
    expect(requests.map(request => [request.model, request.reasoningLevel])).toEqual([["one", "high"], ["one", "low"], ["one", "medium"]]);
    expect(processor.modelId).toBe("two");
    expect(processor.reasoning).toBe("high");
  } finally { await app?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("immutable inference captures its effort before later global and catalog changes", async () => {
  const seen: Array<string | undefined> = [];
  const provider: ProviderAdapter = {
    id: "test",
    async listModels() { return [{ id: "one", provider: "test", reasoningLevels: ["low", "medium", "high"] }]; },
    async *stream(request) { seen.push(request.reasoningLevel); yield { type: "finish", reason: "stop" }; },
  };
  const processor = new ProviderTurnProcessor(provider, "one");
  await processor.listModels();
  const first = processor.createTurnInference(undefined, { model: "one", reasoning: "low" });
  processor.setModel("one", "high");
  const defaults = processor.createTurnInference(undefined, { model: "one", reasoning: null });
  for (const inference of [first, defaults, processor.createTurnInference(undefined)])
    for await (const _event of inference.stream([], [], new AbortController().signal)) { /* consume */ }
  expect(seen).toEqual(["low", "medium", "high"]);
});
