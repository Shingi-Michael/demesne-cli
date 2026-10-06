import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { EventEnvelope } from "@demesne/protocol";
import { ChatGPTProvider } from "@demesne/providers";
import { DemesneStore } from "@demesne/storage";
import { createDaemonApp, type DaemonApp } from "../src/app.ts";
import { MultiProviderProcessor } from "../src/multi-provider-processor.ts";
import { ProviderTurnProcessor } from "../src/provider-processor.ts";

const SOL = "gpt-6.1-sol";
const reasoning = { id: "rs_direct", type: "reasoning", summary: [], encrypted_content: "direct-opaque-reasoning" };
const write = { id: "fc_direct", type: "function_call", call_id: "call_direct", namespace: "demesne", name: "write_file",
  arguments: JSON.stringify({ path: "proof.txt", content: "Written through the direct provider.\n" }), status: "completed" };
type RequestBody = { model: string; input: Record<string, unknown>[]; prompt_cache_key?: string; reasoning?: { effort?: string; summary?: string } };

function responseStream(tool: boolean): Response {
  const message = { id: "msg_direct", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Wrote proof.txt.", annotations: [] }] };
  const events = tool ? [
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: null } },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...write, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: write.arguments },
    { type: "response.output_item.done", output_index: 1, item: write },
  ] : [
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", delta: "Wrote proof.txt." },
    { type: "response.output_item.done", output_index: 0, item: message },
  ];
  // The live plan route can send its terminal output only through item events.
  const completed = { type: "response.completed", response: { model: SOL, status: "completed", output: [],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40 } } } };
  return new Response([...events, completed].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } });
}

test("unlisted configured direct Sol preserves Codex history and waits for Demesne approval before writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-direct-sol-"));
  let app: DaemonApp | undefined;
  try {
    const databasePath = join(root, "data/state.sqlite");
    const workspace = join(root, "workspace");
    mkdirSync(join(root, "data"));
    mkdirSync(workspace);
    const store = new DemesneStore(databasePath);
    let sessionId: string;
    try {
      const { session } = store.createSession("Existing Codex session", realpathSync(workspace));
      sessionId = session.id;
      const { turn } = store.createTurn(sessionId, "Read legacy.txt", "deny");
      store.startTurn(turn.id);
      store.appendModelMessage(turn.id, { role: "user", content: "Read legacy.txt" });
      store.appendModelMessage(turn.id, { role: "assistant", content: null,
        toolCalls: [{ id: "call_codex_legacy", name: "read_file", arguments: '{"path":"legacy.txt"}' }] });
      store.appendModelMessage(turn.id, { role: "tool", toolCallId: "call_codex_legacy", content: "Legacy Codex tool result" });
      store.appendModelMessage(turn.id, { role: "assistant", content: "I inspected the legacy file." });
      store.appendMessageDelta(turn.id, "I inspected the legacy file.");
      store.completeTurn(turn.id);
    } finally { store.close(); }

    const bodies: RequestBody[] = [];
    const direct = new ChatGPTProvider({ accountId: "direct-account", accessToken: async () => "fake-own-token", configuredModel: SOL,
      contextWindow: 262_144, fetch: (async (url, init) => {
        if (String(url) === "https://api.openai.com/v1/models") {
          // Lagging discovery is exactly the real account's missing-Sol case.
          return Response.json({ models: [{ slug: "gpt-6-astra", visibility: "list" }] });
        }
        expect(String(url)).toBe("https://api.openai.com/v1/responses");
        expect(init?.redirect).toBe("manual");
        const body = JSON.parse(String(init?.body)) as RequestBody;
        expect(body.model).toBe(SOL);
        bodies.push(body);
        return responseStream(bodies.length === 1);
      }) as typeof fetch });
    const router = new MultiProviderProcessor([
      new ProviderTurnProcessor(direct, SOL, { maxOutputTokens: 1536 }, undefined, 262_144, undefined, true),
    ], []);
    const running = app = createDaemonApp({ databasePath, processor: router, agent: { maxModelRounds: 3, maxToolCalls: 6 } });
    const client = new DemesneClient({ server: "http://localhost", fetch: ((input, init) =>
      Promise.resolve(running.fetch(new Request(input, init)))) as typeof fetch });
    const models = await client.listModels();
    expect(models.find(model => model.id === SOL)).toMatchObject({ provider: "ChatGPT", displayName: "GPT-6.1 Sol" });
    expect(models.every(model => model.provider === "ChatGPT")).toBe(true);
    expect(bodies).toHaveLength(0); // Discovery does not spend inference or prove access.
    await client.setModel(SOL, "high");
    expect(await client.health()).toMatchObject({ provider: "ChatGPT", model: SOL, reasoning: "high", contextCapacity: 262_144 });
    expect(router.createTurnInference(false).preservesPromptCache).toBe(true);

    const submitted = await client.submitTurn(sessionId, { content: "Create proof.txt", permissionMode: "ask", thinkingEnabled: false });
    const events: EventEnvelope[] = [];
    let approvals = 0;
    for await (const event of client.streamEvents(sessionId, submitted.eventId, AbortSignal.timeout(5000))) {
      if (event.turnId !== submitted.turn.id) continue;
      events.push(event);
      if (event.type === "permission.requested") {
        approvals++;
        expect(event.payload.name).toBe("write_file");
        expect(JSON.parse(String(event.payload.arguments))).toEqual(JSON.parse(write.arguments));
        expect(existsSync(join(workspace, "proof.txt"))).toBe(false);
        expect(bodies).toHaveLength(1);
        expect(events.some(item => item.type === "tool.call_completed")).toBe(false);
        await client.resolvePermission(String(event.payload.permissionId), "allow_once");
      }
      if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) break;
    }
    expect(approvals).toBe(1);
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(events.some(event => event.type === "tool.call_completed" && event.payload.name === "write_file")).toBe(true);
    expect(readFileSync(join(workspace, "proof.txt"), "utf8")).toBe("Written through the direct provider.\n");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.input).toContainEqual({ role: "user", content: "Read legacy.txt" });
    expect(bodies[0]!.input).toContainEqual({ type: "function_call", call_id: "call_codex_legacy", name: "read_file", namespace: "demesne", arguments: '{"path":"legacy.txt"}' });
    expect(bodies[0]!.input).toContainEqual({ type: "function_call_output", call_id: "call_codex_legacy", output: "Legacy Codex tool result" });
    expect(bodies[0]!.input).toContainEqual({ role: "assistant", content: "I inspected the legacy file." });
    expect(bodies[1]!.input).toContainEqual(reasoning);
    expect(bodies[1]!.input).toContainEqual(write);
    expect(bodies[1]!.input.some((item: Record<string, unknown>) => item.type === "function_call_output" && item.call_id === write.call_id)).toBe(true);
    expect(bodies.map(body => body.prompt_cache_key)).toEqual([sessionId, sessionId]);
    expect(bodies.map(body => body.reasoning)).toEqual([{ effort: "high" }, { effort: "high" }]);
    expect(JSON.stringify(events)).not.toContain("direct-opaque-reasoning");
    expect(JSON.stringify(events)).not.toContain("fake-own-token");
  } finally {
    try { await app?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});
