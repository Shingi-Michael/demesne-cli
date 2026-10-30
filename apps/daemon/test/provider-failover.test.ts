import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@demesne/protocol";
import { ProviderError } from "@demesne/providers";
import { DemesneStore } from "@demesne/storage";
import { AgentEngine, isProviderDropped } from "../src/engine.ts";
import { InferenceScheduler, InferenceSchedulers } from "../src/inference-scheduler.ts";
import { MultiProviderProcessor } from "../src/multi-provider-processor.ts";
import { PermissionBroker } from "../src/permissions.ts";
import { QuestionBroker } from "../src/questions.ts";
import type { TurnInference } from "../src/processor.ts";
import { ProviderTurnProcessor } from "../src/provider-processor.ts";
import { ToolRegistry } from "../src/tools.ts";

const inference = (providerId: string, stream: TurnInference["stream"], released: string[] = []): TurnInference =>
  ({ providerId, modelId: `${providerId}-model`, profile: null, thinkingEnabled: undefined, preservesPromptCache: false, stream,
    release: async () => { released.push(providerId); } });

function fixture(fallback: (tried: string[]) => TurnInference | null, questions?: QuestionBroker, assistant = false) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "demesne-failover-")));
  const store = new DemesneStore(":memory:");
  const { session } = store.createSession("Failover", workspace);
  const events: EventEnvelope[] = [];
  store.setEventSink((event) => events.push(event));
  const schedulers = new InferenceSchedulers(new InferenceScheduler(1), "test");
  const engine = new AgentEngine(store, new ToolRegistry([]), new PermissionBroker(), schedulers, undefined, undefined,
    { fallbackInference: (_current, tried) => fallback(tried), ...(questions ? { questions } : {}), ...(assistant ? { assistantChat: () => true } : {}) });
  return { store, session, events, engine, close: async () => { await schedulers.close(); store.close(); rmSync(workspace, { recursive: true, force: true }); } };
}

test("a turn whose provider drops carries on with the next one, and says so once", async () => {
  const released: string[] = [];
  const asked: string[] = [];
  const pc = inference("Qwen on PC", async function* () { throw new Error("The socket connection was closed unexpectedly"); }, released);
  const chatgpt = inference("ChatGPT", async function* (messages) { asked.push(messages.at(-1)!.content as string); yield { type: "text_delta", delta: "Drive is diagnosing CI." }; }, released);
  const { store, session, events, engine, close } = fixture((tried) => (tried.includes("ChatGPT") ? null : chatgpt));
  try {
    // An Auto turn (Drive, mail) has nobody to ask: it carries on.
    const { turn } = store.createTurn(session.id, "what is drive working on?", "allow");
    await engine.run(turn.id, pc, new AbortController().signal);
    expect(store.getTurn(turn.id)?.status).toBe("completed");
    expect(store.getTurn(turn.id)?.responseText).toBe("Drive is diagnosing CI.");
    expect(asked).toEqual(["what is drive working on?"]);
    const switched = events.filter((event) => event.type === "model.provider_switched");
    expect(switched).toHaveLength(1);
    expect(switched[0]!.payload).toMatchObject({ from: { provider: "Qwen on PC" }, to: { provider: "ChatGPT", model: "ChatGPT-model" } });
    expect(events.map((event) => event.type).filter((type) => type.startsWith("model.request_"))).toEqual(["model.request_started", "model.request_failed", "model.request_started", "model.request_completed"]);
    expect(released.sort()).toEqual(["ChatGPT", "Qwen on PC"]);
  } finally { await close(); }
});

test("the assistant's chat never carries on with another provider: its turn fails instead", async () => {
  const asked: string[] = [];
  const pc = inference("Qwen on PC", async function* () { throw new Error("The socket connection was closed unexpectedly"); });
  const codex = inference("Codex", async function* (messages) { asked.push(messages.at(-1)!.content as string); yield { type: "text_delta", delta: "Here is your file." }; });
  const { store, session, events, engine, close } = fixture(() => codex, undefined, true);
  try {
    const { turn } = store.createTurn(session.id, "Summarize my immigration letter", "allow");
    await expect(engine.run(turn.id, pc, new AbortController().signal)).rejects.toThrow("closed unexpectedly");
    expect(asked).toEqual([]);
    expect(events.filter((event) => event.type === "model.provider_switched")).toHaveLength(0);
  } finally { await close(); }
});

test("with no provider left, or a request the model got wrong, the turn fails as before", async () => {
  const { store, session, events, engine, close } = fixture(() => null);
  try {
    const { turn } = store.createTurn(session.id, "hi", "ask");
    await expect(engine.run(turn.id, inference("only", async function* () { throw new Error("fetch failed"); }), new AbortController().signal)).rejects.toThrow("fetch failed");
    expect(events.some((event) => event.type === "model.provider_switched")).toBe(false);
  } finally { await close(); }
  expect(isProviderDropped(new Error("The socket connection was closed unexpectedly"))).toBe(true);
  expect(isProviderDropped(new Error("Provider did not emit an event before the timeout"))).toBe(true);
  expect(isProviderDropped(new ProviderError("upstream", 502))).toBe(true);
  expect(isProviderDropped(new ProviderError("rate limited", 429))).toBe(true);
  expect(isProviderDropped(new ProviderError("bad request", 400))).toBe(false);
  expect(isProviderDropped(new ProviderError("limit", undefined, "output_token_limit"))).toBe(false);
  expect(isProviderDropped(new Error("Model returned an incomplete tool call"))).toBe(false);
});

test("the router offers the selected provider first, then the rest, never one already tried", () => {
  const make = (id: string, model: string) => new ProviderTurnProcessor({ id, async listModels() { return [{ id: model, provider: id }]; },
    async *stream() { yield { type: "text_delta" as const, delta: id }; } }, model, { maxOutputTokens: 512 }, undefined, 100_000, [model]);
  const router = new MultiProviderProcessor([make("ChatGPT", "gpt-6.1-sol"), make("llama", "local-qwen"), make("Qwen on PC", "qwen3.8-27b")], []);
  router.setModel("qwen3.8-27b");
  expect(router.createFallbackInference(false, ["Qwen on PC"])?.providerId).toBe("ChatGPT");
  expect(router.createFallbackInference(false, ["Qwen on PC", "ChatGPT"])?.providerId).toBe("llama");
  expect(router.createFallbackInference(false, ["Qwen on PC", "ChatGPT", "llama"])).toBeNull();
});

async function answer(events: EventEnvelope[], broker: QuestionBroker, text: string) {
  for (let i = 0; i < 200; i++) {
    const asked = events.find((event) => event.type === "question.requested");
    if (asked && broker.resolve(String(asked.payload.questionId), [{ answer: text, source: "suggestion" }])) return asked;
    await Bun.sleep(5);
  }
  throw new Error("never asked");
}

test("a chat you're in asks first: Continue carries on, Stop ends the turn", async () => {
  const broker = new QuestionBroker();
  const pc = inference("Qwen on PC", async function* () { throw new Error("The socket connection was closed unexpectedly"); });
  const chatgpt = inference("ChatGPT", async function* () { yield { type: "text_delta", delta: "Carried on." }; });
  const { store, session, events, engine, close } = fixture((tried) => (tried.includes("ChatGPT") ? null : chatgpt), broker);
  try {
    const { turn } = store.createTurn(session.id, "hello", "ask");
    const [, asked] = await Promise.all([engine.run(turn.id, pc, new AbortController().signal), answer(events, broker, "Continue")]);
    expect((asked.payload.questions as { question: string; suggestions: string[] }[])[0]).toEqual({ question: "Qwen on PC dropped the connection. Continue on ChatGPT ChatGPT-model?", suggestions: ["Continue", "Stop"] });
    expect(store.getTurn(turn.id)?.status).toBe("completed");
    expect(store.getTurn(turn.id)?.responseText).toBe("Carried on.");
    expect(events.filter((event) => event.type === "model.provider_switched")).toHaveLength(1);

    events.length = 0;
    const { turn: second } = store.createTurn(session.id, "again", "ask");
    await Promise.all([engine.run(second.id, pc, new AbortController().signal), answer(events, broker, "Stop")]);
    expect(store.getTurn(second.id)?.status).toBe("interrupted");
    expect(events.some((event) => event.type === "model.provider_switched")).toBe(false);
  } finally { await close(); }
});
