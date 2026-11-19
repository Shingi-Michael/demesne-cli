import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@demesne/config";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { EventEnvelope, SubmitTurnResponse } from "@demesne/protocol";
import type { ProviderMessage, ProviderStreamEvent, ProviderToolDefinition } from "@demesne/providers";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";

async function fixture(stream: TurnProcessor["stream"], run: (value: {
  client: DemesneClient; id: string; db: Database;
  requests: { messages: ProviderMessage[]; tools: ProviderToolDefinition[] }[];
  consume: (submitted: SubmitTurnResponse) => Promise<EventEnvelope[]>;
  restart: () => Promise<void>;
}) => Promise<void>, agent?: AgentConfig) {
  const root = mkdtempSync(join(tmpdir(), "demesne-turn-budget-"));
  mkdirSync(join(root, "workspace"));
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "workspace/input.txt"), "Saved finding: parser uses a shared lexer.");
  const requests: { messages: ProviderMessage[]; tools: ProviderToolDefinition[] }[] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "test", contextCapacity: 262144, maxOutputTokens: 1024,
    async listModels() { return []; }, async *stream(...args) {
      requests.push(structuredClone({ messages: args[0], tools: args[1] }));
      yield* stream(...args);
    } };
  const options = { databasePath: join(root, "data/state.sqlite"), processor, agent };
  let app = createDaemonApp(options);
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  const db = new Database(options.databasePath, { readonly: true });
  const { session } = await client.createSession({ title: "Turn budgets", workspacePath: join(root, "workspace"), trustWorkspace: true });
  const consume = async (submitted: SubmitTurnResponse) => {
    const events: EventEnvelope[] = [];
    for await (const event of client.streamEvents(session.id, submitted.eventId, AbortSignal.timeout(5000))) {
      if (event.turnId !== submitted.turn.id) continue;
      events.push(event);
      if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) break;
    }
    return events;
  };
  try {
    await run({ client, id: session.id, db, requests, consume,
      restart: async () => { await app.close(); app = createDaemonApp(options); } });
  } finally { db.close(); await app.close(); rmSync(root, { recursive: true, force: true }); }
}

/// The last request of a turn that ran out of its allowance: the same
/// instructions and tools as before, and a note at the end that says so.
const isLast = (messages: ProviderMessage[]) => { const last = messages.at(-1); return last?.role === "user" && String(last.content).includes("last request of this turn"); };

function readCall(round: number, index = 0): ProviderStreamEvent {
  return { type: "tool_call_delta", index, idDelta: `read-${round}-${index}`, nameDelta: "read_file", argumentsDelta: '{"path":"input.txt"}' };
}

test("a single request can finish beyond both the old 8-round and 24-tool limits", async () => {
  let round = 0;
  await fixture(async function* () {
    if (++round <= 10) {
      for (let index = 0; index < 3; index++) yield readCall(round, index);
      yield { type: "finish", reason: "tool_calls" };
    } else {
      yield { type: "text_delta", delta: "Inspection and verification finished." };
      yield { type: "finish", reason: "stop" };
    }
  }, async ({ client, id, requests, consume }) => {
    const events = await consume(await client.submitTurn(id, { content: "Inspect and verify the parser" }));
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(requests).toHaveLength(11);
    expect(events.filter((event) => event.type === "tool.call_completed")).toHaveLength(30);
    expect(requests.at(-1)?.messages.filter((message) => message.role === "tool")).toHaveLength(30);
  });
});

test.each(["rounds", "tools", "batch"] as const)("%s allowance requests a status report and preserves progress for a fresh follow-up after restart", async (limit) => {
  let round = 0;
  await fixture(async function* (messages) {
    round++;
    if (round > 3) { yield { type: "text_delta", delta: "Continued from saved findings." }; return; }
    if (isLast(messages)) { yield { type: "text_delta", delta: "Found the lexer; parser implementation is still pending." }; return; }
    yield readCall(round);
    if (limit === "batch" && round === 2) yield readCall(round, 1);
  }, async ({ client, id, requests, consume, restart, db }) => {
    const submitted = await client.submitTurn(id, { content: "Inspect and implement parser improvements" });
    const events = await consume(submitted);
    expect(events.at(-1)?.type).toBe("turn.interrupted");
    expect(events.at(-1)?.payload.reason).toBe("turn_budget");
    expect(events.at(-1)?.payload.message).toContain(limit === "rounds" ? "2 model-round" : "2 tool-call");
    expect(events.some((event) => event.type === "turn.completed" || event.type === "turn.failed")).toBe(false);
    expect(requests).toHaveLength(3);
    // The last request starts exactly like the one before it, tools and
    // all, so it reads the whole turn from cache; what is new is at the end.
    expect(requests[2]?.tools).toEqual(requests[1]!.tools);
    expect(requests[2]?.tools.length).toBeGreaterThan(0);
    expect(requests[2]?.messages.slice(0, requests[1]!.messages.length)).toEqual(requests[1]!.messages);
    expect(String(requests[2]?.messages.at(-1)?.content)).toStartWith("<system-note>");
    expect(String(requests[2]?.messages.at(-1)?.content)).toContain("specific next steps");
    expect(events.filter((event) => event.type === "tool.call_completed")).toHaveLength(limit === "batch" ? 1 : 2);
    expect(events.filter((event) => event.type === "tool.call_denied")).toHaveLength(limit === "batch" ? 2 : 0);
    expect(db.query("SELECT count(*) AS n FROM tool_calls WHERE status IN ('pending', 'running')").get()).toEqual({ n: 0 });
    await restart();
    expect(await consume(submitted)).toEqual(events);
    const followUp = await consume(await client.submitTurn(id, { content: "Continue the implementation" }));
    expect(followUp.at(-1)?.type).toBe("turn.completed");
    expect(requests[3]?.tools.length).toBeGreaterThan(0);
    const restored = JSON.stringify(requests[3]?.messages);
    expect(restored).toContain("Saved finding: parser uses a shared lexer");
    expect(restored).toContain("Historical turn ended interrupted");
    expect(restored).toContain("parser implementation is still pending");
    if (limit === "batch") expect(restored).toContain("This tool call was not executed");
  }, limit === "rounds" ? { maxModelRounds: 2 } : { maxModelRounds: 10, maxToolCalls: 2 });
});

test("a model that asks for a tool on the last request cannot execute it or claim success", async () => {
  let round = 0;
  await fixture(async function* () {
    if (++round > 2) { yield { type: "text_delta", delta: "Carrying on." }; return; }
    if (round === 2) yield { type: "text_delta", delta: "One more look." };
    yield readCall(round);
  }, async ({ client, id, requests, consume, db }) => {
    const events = await consume(await client.submitTurn(id, { content: "Inspect the parser" }));
    // The turn ends as out of allowance, with what the model wrote, and the tool is not run.
    expect(events.at(-1)?.type).toBe("turn.interrupted");
    expect(events.at(-1)?.payload.reason).toBe("turn_budget");
    expect(events.filter((event) => event.type === "tool.call_requested")).toHaveLength(1);
    expect(db.query("SELECT status FROM provider_calls ORDER BY rowid").all()).toEqual([{ status: "completed" }, { status: "completed" }]);
    // The next turn finds no call without a result.
    expect((await consume(await client.submitTurn(id, { content: "Continue" }))).at(-1)?.type).toBe("turn.completed");
    const next = requests[2]!.messages;
    expect(JSON.stringify(next)).toContain("One more look.");
    expect(next.filter((message) => message.role === "assistant").flatMap((message) => message.toolCalls ?? [])).toHaveLength(1);
    expect(next.filter((message) => message.role === "tool")).toHaveLength(1);
  }, { maxModelRounds: 1 });
});

test("a last request that is only a tool call leaves an answer the next turn can follow", async () => {
  let round = 0;
  await fixture(async function* () {
    if (++round > 2) { yield { type: "text_delta", delta: "Carrying on." }; return; }
    yield readCall(round);
  }, async ({ client, id, requests, consume }) => {
    expect((await consume(await client.submitTurn(id, { content: "Inspect the parser" }))).at(-1)?.type).toBe("turn.interrupted");
    expect((await consume(await client.submitTurn(id, { content: "Continue" }))).at(-1)?.type).toBe("turn.completed");
    const assistants = requests[2]!.messages.filter((message) => message.role === "assistant");
    // The call that was run, an answer in place of the one that was not, then how the turn ended.
    expect(assistants.map((message) => message.content)).toContain("(Out of allowance before a report was written.)");
    expect(assistants.flatMap((message) => message.toolCalls ?? [])).toHaveLength(1);
    expect(requests[2]!.messages.filter((message) => message.role === "tool")).toHaveLength(1);
  }, { maxModelRounds: 1 });
});

test("the final status request remains cancellable and releases the session and inference slot", async () => {
  let started!: () => void;
  const finalizing = new Promise<void>((resolve) => { started = resolve; });
  let round = 0;
  await fixture(async function* (messages, _tools, signal) {
    if (++round > 2) { yield { type: "text_delta", delta: "Resumed." }; return; }
    if (!isLast(messages)) { yield readCall(round); return; }
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, async ({ client, id, requests, consume }) => {
    const submitted = await client.submitTurn(id, { content: "Inspect the parser" });
    await finalizing;
    await client.cancelTurn(submitted.turn.id);
    expect((await consume(submitted)).at(-1)?.type).toBe("turn.cancelled");
    expect((await consume(await client.submitTurn(id, { content: "Continue" }))).at(-1)?.type).toBe("turn.completed");
    expect(JSON.stringify(requests[2]?.messages)).toContain("Saved finding: parser uses a shared lexer");
    expect(JSON.stringify(requests[2]?.messages)).toContain("Historical turn ended cancelled");
  }, { maxModelRounds: 1 });
});

test("a failed provider response retains earlier tool findings in the next request", async () => {
  let round = 0;
  await fixture(async function* () {
    if (++round === 1) yield readCall(round);
    else if (round === 2) throw new Error("Connection lost");
    else yield { type: "text_delta", delta: "Continuing." };
  }, async ({ client, id, requests, consume, restart }) => {
    expect((await consume(await client.submitTurn(id, { content: "Inspect the parser" }))).at(-1)?.type).toBe("turn.failed");
    await restart();
    expect((await consume(await client.submitTurn(id, { content: "Continue" }))).at(-1)?.type).toBe("turn.completed");
    const messages = JSON.stringify(requests[2]?.messages);
    expect(messages).toContain("Saved finding: parser uses a shared lexer");
    expect(messages).toContain("Historical turn ended failed: Connection lost");
  });
});
