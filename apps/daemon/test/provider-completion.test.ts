import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServerSentEvents, type EventEnvelope } from "@demesne/protocol";
import { OpenAICompatibleProvider } from "@demesne/providers";
import { createDaemonApp } from "../src/app.ts";
import { ProviderTurnProcessor } from "../src/provider-processor.ts";

interface Round {
  reasoning?: string;
  text?: string;
  toolArguments?: string;
  reason?: string;
  tokens?: number;
}

function stream(round: Round): Response {
  const events: unknown[] = [];
  if (round.reasoning) events.push({ choices: [{ delta: { reasoning_content: round.reasoning } }] });
  if (round.text) events.push({ choices: [{ delta: { content: round.text } }] });
  if (round.toolArguments !== undefined) events.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read-1",
    function: { name: "read_file", arguments: round.toolArguments } }] } }] });
  if (round.reason) events.push({ choices: [{ delta: {}, finish_reason: round.reason }] });
  if (round.tokens !== undefined) events.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: round.tokens, total_tokens: 100 + round.tokens } });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
}

async function fixture(rounds: Round[], verify: (result: {
  events: EventEnvelope[]; db: Database; turnId: string; requests: Array<Record<string, unknown>>;
  replay: () => Promise<EventEnvelope[]>;
}) => void | Promise<void>, maxOutputTokens = 1536) {
  const root = mkdtempSync(join(tmpdir(), "demesne-completion-"));
  mkdirSync(join(root, "data"));
  const databasePath = join(root, "data/state.sqlite");
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, "input.txt"), "Tool result");
  const requests: Array<Record<string, unknown>> = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: "http://localhost:1234/v1", providerId: "test-qwen",
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const round = rounds[requests.length - 1];
      if (!round) throw new Error("Unexpected extra model request");
      return stream(round);
    }) as typeof fetch,
  });
  const options = { databasePath, processor: new ProviderTurnProcessor(provider, "qwen", { maxOutputTokens }, undefined, 262144) };
  let app = createDaemonApp(options);
  let db: Database | undefined;
  try {
    const post = async (path: string, body: unknown) => {
      const response = await app.fetch(new Request(`http://localhost${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    };
    const { session } = await post("/v1/sessions", { title: "Completion regression", workspacePath });
    const { turn, eventId } = await post(`/v1/sessions/${session.id}/turns`, { content: "Inspect input.txt and answer" });
    const collect = async () => {
      const response = await app.fetch(new Request(`http://localhost/v1/events?session_id=${session.id}&after=${eventId}`, { signal: AbortSignal.timeout(5000) }));
      const events: EventEnvelope[] = [];
      for await (const event of readServerSentEvents(response)) {
        events.push(event);
        if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type)) break;
      }
      return events;
    };
    const events = await collect();
    db = new Database(databasePath, { readonly: true });
    await verify({ events, db, turnId: turn.id, requests, replay: async () => {
      await app.close(); app = createDaemonApp(options);
      return collect();
    } });
  } finally {
    db?.close(); await app.close(); rmSync(root, { recursive: true, force: true });
  }
}

test.each([
  { name: "reasoning exhausts the budget", round: { reasoning: "Still thinking", reason: "length", tokens: 1536 }, error: "output token limit" },
  { name: "partial visible answer", round: { text: "An unfinished answer", reason: "length", tokens: 1536 }, error: "output token limit" },
  { name: "truncated tool arguments", round: { toolArguments: '{"path":', reason: "length", tokens: 1536 }, error: "output token limit" },
  { name: "apparently valid tool call in a truncated round", round: { toolArguments: '{"path":"input.txt"}', reason: "length", tokens: 1536 }, error: "output token limit" },
  { name: "usage-only exhaustion on a legacy server", round: { reasoning: "Still thinking", tokens: 1536 }, error: "output token limit" },
  { name: "reasoning-only normal stop", round: { reasoning: "Only thinking", reason: "stop", tokens: 20 }, error: "stopped after thinking" },
  { name: "empty normal stop", round: { reason: "stop", tokens: 0 }, error: "empty response" },
  { name: "whitespace-only legacy reply", round: { text: " \n\t" }, error: "empty response" },
  { name: "filtered partial answer", round: { text: "Partial", reason: "content_filter", tokens: 10 }, error: 'finish reason "content_filter"' },
  { name: "missing tool call", round: { text: "I will inspect it", reason: "tool_calls" }, error: "returned no tool call" },
])("fails clearly for $name, preserving usage, partial output and the stop reason", async ({ round, error }) => {
  await fixture([round], async ({ events, db, turnId, requests, replay }) => {
    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.at(-1)?.payload.message).toContain(error);
    expect(events.some((event) => ["turn.completed", "message.completed", "model.request_completed", "tool.call_requested"].includes(event.type))).toBe(false);
    const call = db.query("SELECT status, finish_reason, output_tokens, error_message, duration_ms FROM provider_calls WHERE turn_id = ?").get(turnId) as {
      status: string; finish_reason: string | null; output_tokens: number | null; error_message: string; duration_ms: number;
    };
    expect(call.status).toBe("failed");
    expect(call.finish_reason).toBe(round.reason ?? null);
    expect(call.output_tokens).toBe(round.tokens ?? null);
    expect(call.error_message).toContain(error);
    expect(call.duration_ms).toBeGreaterThanOrEqual(0);
    expect(events.find((event) => event.type === "model.request_failed")?.payload.finishReason).toBe(round.reason);
    expect(db.query("SELECT status, response_text FROM turns WHERE id = ?").get(turnId)).toEqual({ status: "failed", response_text: round.text ?? "" });
    expect(db.query("SELECT count(*) AS count FROM model_messages WHERE turn_id = ? AND role = 'assistant'").get(turnId)).toEqual({ count: 0 });
    expect(requests).toHaveLength(1);
    if (round.reason === "length") {
      expect(call.error_message).toContain("1536");
      expect(call.error_message).toContain("max_output_tokens");
      expect(call.error_message).toContain("test-qwen");
      expect(await replay()).toEqual(events);
    }
  });
});

test("an earlier narration and successful tool do not turn a later reasoning-only stop into success", async () => {
  await fixture([
    { text: "Inspecting the file", toolArguments: '{"path":"input.txt"}', reason: "tool_calls", tokens: 30 },
    { reasoning: "Still considering the result", reason: "stop", tokens: 20 },
  ], ({ events, db, turnId, requests }) => {
    expect(requests).toHaveLength(2);
    expect(events.some((event) => event.type === "tool.call_completed")).toBe(true);
    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.at(-1)?.payload.message).toContain("stopped after thinking");
    expect(db.query("SELECT count(*) AS count FROM model_messages WHERE turn_id = ? AND role = 'assistant' AND content = ''").get(turnId)).toEqual({ count: 0 });
  });
});

test("normal tool and answer stops retain their reasons, and the configured budget reaches the provider and planner", async () => {
  await fixture([
    { reasoning: "Inspect first", toolArguments: '{"path":"input.txt"}', reason: "tool_calls", tokens: 100 },
    { text: "The file contains Tool result.", reason: "stop", tokens: 8192 },
  ], async ({ events, db, turnId, requests, replay }) => {
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.max_tokens === 8192)).toBe(true);
    expect(events.filter((event) => event.type === "model.request_completed").map((event) => event.payload.finishReason)).toEqual(["tool_calls", "stop"]);
    for (const call of db.query("SELECT status, finish_reason, context_plan_json FROM provider_calls WHERE turn_id = ? ORDER BY rowid").all(turnId) as { status: string; context_plan_json: string }[]) {
      expect(call.status).toBe("completed");
      expect(JSON.parse(call.context_plan_json).reserves.outputTokens).toBe(8192);
    }
    expect(await replay()).toEqual(events);
  }, 8192);
});
