import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { DemesneStore } from "@demesne/storage";
import type { EventEnvelope, SubmitTurnResponse } from "@demesne/protocol";
import type { ProviderMessage, ProviderToolDefinition } from "@demesne/providers";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";

test("sources are kept with the chat, told to the model, and read on need", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-sources-app-"));
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, "project", "db"), { recursive: true });
  writeFileSync(join(root, "project", "db", "schema.sql"), "create table orders(user_id int);");
  const databasePath = join(root, "data/state.sqlite");
  const store = new DemesneStore(databasePath);
  const { session } = store.createSession("Sources", join(root, "project"));
  store.close();
  const requests: { messages: ProviderMessage[]; tools: ProviderToolDefinition[] }[] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "test-model", contextCapacity: 32768, maxOutputTokens: 1024,
    async listModels() { return []; },
    async *stream(messages, tools) {
      requests.push({ messages: structuredClone(messages), tools });
      const id = /- ([a-z0-9-]+): file schema\.sql/.exec(messages[0]?.content ?? "")?.[1];
      if (id && !messages.some((message) => message.role === "tool")) {
        yield { type: "tool_call_delta", index: 0, idDelta: "src", nameDelta: "read_source", argumentsDelta: JSON.stringify({ id }) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "No index on user_id." };
        yield { type: "finish", reason: "stop" };
      }
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
    } };
  const app = createDaemonApp({ databasePath, processor, web: false });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  const consume = async (submitted: SubmitTurnResponse) => {
    for await (const event of client.streamEvents(session.id, submitted.eventId, AbortSignal.timeout(3000)) as AsyncIterable<EventEnvelope>) {
      if (event.turnId === submitted.turn.id && /^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) return event.type;
    }
  };
  try {
    // With none, the model isn't told and read_source isn't offered.
    expect(await consume(await client.submitTurn(session.id, { content: "Hello" }))).toBe("turn.completed");
    expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain("read_source");
    expect(requests[0]!.messages[0]!.content).not.toContain("Sources the person keeps");

    const { source } = await client.addSource(session.id, { path: join(root, "project", "db", "schema.sql") });
    expect(source).toMatchObject({ name: "schema.sql", detail: "in this project · db/", inProject: "db/schema.sql" });
    await expect(client.addSource(session.id, { url: "checkout is slow" })).rejects.toThrow("isn't a link");
    expect((await client.getSessionState(session.id)).sources?.map((one) => one.id)).toEqual([source.id]);

    requests.length = 0;
    expect(await consume(await client.submitTurn(session.id, { content: "Why is checkout slow?" }))).toBe("turn.completed");
    expect(requests[0]!.tools.map((tool) => tool.name)).toContain("read_source");
    expect(requests[0]!.messages[0]!.content).toContain(`- ${source.id}: file schema.sql (in the project at db/schema.sql)`);
    const read = requests[1]!.messages.find((message) => message.role === "tool");
    expect(JSON.parse(read!.content!).content).toBe("create table orders(user_id int);");

    expect((await client.removeSource(session.id, source.id)).sources).toEqual([]);
  } finally {
    await app.close?.();
  }
});
