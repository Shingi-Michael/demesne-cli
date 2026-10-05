import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderStreamEvent } from "@demesne/providers";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { createDaemonApp } from "../src/app.ts";
import { InferenceScheduler } from "../src/inference-scheduler.ts";
import { ProviderTurnProcessor } from "../src/provider-processor.ts";
import { runSubagent } from "../src/subagent.ts";
import { ToolRegistry } from "../src/tools.ts";

test.each(["completed", "failed", "cancelled"] as const)("main %s turn releases provider conversation state", async (outcome) => {
  const root = mkdtempSync(join(tmpdir(), "demesne-provider-release-"));
  const released: (string | undefined)[] = [];
  let started!: () => void, closed!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const cleaned = new Promise<void>(resolve => { closed = resolve; });
  const provider: ProviderAdapter = {
    id: "stateful",
    async listModels() { return []; },
    async *stream(_request, signal) {
      if (outcome === "failed") throw new Error("provider disconnected");
      if (outcome === "cancelled") {
        started();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      yield { type: "text_delta", delta: "Finished." };
      yield { type: "finish", reason: "stop" };
    },
    async release(key) { released.push(key); closed(); },
  };
  const processor = new ProviderTurnProcessor(provider, "test");
  const app = createDaemonApp({ databasePath: join(root, "state.sqlite"), processor });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  try {
    const { session } = await client.createSession({ title: "Release" });
    const submitted = await client.submitTurn(session.id, { content: "Answer" });
    if (outcome === "cancelled") {
      await running;
      await client.cancelTurn(submitted.turn.id);
    }
    let terminal: string | undefined;
    for await (const event of client.streamEvents(session.id, submitted.eventId, AbortSignal.timeout(5000))) {
      if (event.turnId === submitted.turn.id && /^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) {
        terminal = event.type;
        break;
      }
    }
    expect(terminal).toBe(`turn.${outcome}`);
    await cleaned;
    expect(released).toEqual([session.id]);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["completed", "failed", "cancelled"] as const)("subagent %s run releases its own provider conversation", async (outcome) => {
  const controller = new AbortController();
  const released: (string | undefined)[] = [];
  let calls = 0;
  const provider: ProviderAdapter = {
    id: "stateful",
    async listModels() { return []; },
    async *stream(): AsyncGenerator<ProviderStreamEvent> {
      if (++calls === 1) {
        yield { type: "tool_call_delta", index: 0, idDelta: "read", nameDelta: "read_file", argumentsDelta: "{}" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (outcome === "failed") throw new Error("continuation disconnected");
      yield { type: "text_delta", delta: "Read complete." };
      yield { type: "finish", reason: "stop" };
    },
    async release(key) { released.push(key); },
  };
  const inference = new ProviderTurnProcessor(provider, "test").createTurnInference(undefined);
  const tools = new ToolRegistry([{
    definition: { name: "read_file", description: "Read", inputSchema: { type: "object" } },
    permission() { return null; },
    async execute() {
      if (outcome === "cancelled") {
        controller.abort(new Error("cancelled during tool execution"));
        controller.signal.throwIfAborted();
      }
      return "content";
    },
  }]);
  const result = runSubagent({ prompt: "Read", workspaceRoot: tmpdir(), sessionId: "main", turnId: "turn", tools,
    inference, scheduler: new InferenceScheduler(1), signal: controller.signal, progress() {}, cacheKey: "main:delegate" });
  if (outcome === "completed") expect(await result).toContain("Read complete.");
  else await expect(result).rejects.toThrow(outcome === "failed" ? "continuation disconnected" : "cancelled during tool execution");
  expect(released).toEqual(["main:delegate"]);
  expect(calls).toBe(outcome === "cancelled" ? 1 : 2);
});
