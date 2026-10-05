import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope, SubmitTurnResponse } from "@demesne/protocol";
import { CodexProvider, type CodexConnection } from "../../../packages/providers/src/codex.ts";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { createDaemonApp } from "../src/app.ts";
import { ProviderTurnProcessor } from "../src/provider-processor.ts";

type Notification = { method: string; params?: unknown };
type ServerRequest = Notification & { id: string | number };

/** Only the process transport is fake: provider, engine, tools and policy are real. */
class CodexTransport implements CodexConnection {
  readonly requests: { method: string; params: unknown }[] = [];
  readonly responses: { id: string | number; result: unknown }[] = [];
  readonly notifications = new Set<(message: Notification) => void>();
  readonly toolRequests = new Set<(message: ServerRequest) => boolean>();
  closed = false;
  private finishClose!: () => void;
  readonly closedPromise = new Promise<void>(resolve => { this.finishClose = resolve; });
  onTurn: (transport: CodexTransport) => void = () => {};
  onResult: (transport: CodexTransport) => void = transport => transport.finish("Done.");

  async start() {}
  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "account/read") return { account: { type: "chatgpt" } } as T;
    if (method === "model/list") return { data: [{ model: "gpt-6.1-sol", defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high"].map(reasoningEffort => ({ reasoningEffort })) }] } as T;
    if (method === "thread/start") return { thread: { id: "codex-thread" } } as T;
    if (method === "turn/start") {
      this.emit("turn/started", { turn: { id: "codex-turn" } });
      queueMicrotask(() => this.onTurn(this));
      return { turn: { id: "codex-turn" } } as T;
    }
    if (method === "thread/inject_items") return {} as T;
    throw new Error(`Unexpected Codex RPC: ${method}`);
  }
  onNotification(callback: (message: Notification) => void) {
    this.notifications.add(callback); return () => { this.notifications.delete(callback); };
  }
  onServerRequest(callback: (message: ServerRequest) => boolean) {
    this.toolRequests.add(callback); return () => { this.toolRequests.delete(callback); };
  }
  onClose(_callback: (error?: Error) => void) { return () => {}; }
  respond(id: string | number, result: unknown) {
    this.responses.push({ id, result }); queueMicrotask(() => this.onResult(this));
  }
  reject(_id: string | number, _code: number, message: string) { throw new Error(`Unexpected rejected RPC: ${message}`); }
  async close() { this.closed = true; this.finishClose(); }
  emit(method: string, params: Record<string, unknown>) {
    for (const callback of this.notifications) callback({ method, params: { threadId: "codex-thread", turnId: "codex-turn", ...params } });
  }
  tool(name: string, args: Record<string, unknown>) {
    const request: ServerRequest = { id: 77, method: "item/tool/call", params: {
      threadId: "codex-thread", turnId: "codex-turn", callId: "tool-call", namespace: null, tool: `demesne_${name}`, arguments: args,
    } };
    expect([...this.toolRequests].some(callback => callback(request))).toBe(true);
  }
  finish(text: string) {
    this.emit("item/agentMessage/delta", { delta: text });
    this.emit("turn/completed", { turn: { id: "codex-turn", status: "completed" } });
  }
}

async function fixture(run: (context: {
  client: DemesneClient; transport: CodexTransport; workspace: string; sessionId: string;
  consume: (turn: SubmitTurnResponse, onEvent?: (event: EventEnvelope) => Promise<void>) => Promise<EventEnvelope[]>;
  connectionCount: () => number;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "demesne-codex-engine-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "notes.txt"), "The migration uses a shared lexer.\n");
  const transport = new CodexTransport();
  let connections = 0;
  const provider = new CodexProvider({ dataDir: join(root, "data"), createClient: () => { connections++; return transport; } });
  const processor = new ProviderTurnProcessor(provider, "codex/gpt-6.1-sol", { maxOutputTokens: 2048 }, undefined, 32768);
  const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), processor });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  try {
    const { session } = await client.createSession({ title: "Codex tools", workspacePath: workspace, trustWorkspace: true });
    const consume = async (turn: SubmitTurnResponse, onEvent?: (event: EventEnvelope) => Promise<void>) => {
      const events: EventEnvelope[] = [];
      for await (const event of client.streamEvents(session.id, turn.eventId, AbortSignal.timeout(5000))) {
        if (event.turnId !== turn.turn.id) continue;
        events.push(event);
        await onEvent?.(event);
        if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) break;
      }
      return events;
    };
    await run({ client, transport, workspace, sessionId: session.id, consume, connectionCount: () => connections });
  } finally {
    await app.close();
    await provider.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

test("Codex dynamic read_file executes in Demesne and continues the same Codex turn", async () => {
  await fixture(async ({ client, transport, sessionId, consume, connectionCount }) => {
    transport.onTurn = transport => transport.tool("read_file", { path: "notes.txt" });
    transport.onResult = transport => transport.finish("The migration uses a shared lexer.");
    const events = await consume(await client.submitTurn(sessionId, { content: "Read notes.txt and summarize the migration", permissionMode: "deny" }));
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(events.some(event => event.type === "tool.call_completed" && event.payload.name === "read_file")).toBe(true);
    expect(events.some(event => event.type === "permission.requested")).toBe(false);
    expect(transport.responses).toHaveLength(1);
    expect(transport.responses[0]).toMatchObject({ id: 77, result: { success: true, contentItems: [{ type: "inputText", text: expect.stringContaining("The migration uses a shared lexer.") }] } });
    expect(connectionCount()).toBe(1);
    expect(transport.requests.filter(request => request.method === "thread/start")).toHaveLength(1);
    expect(transport.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    expect(JSON.stringify(events)).toContain("The migration uses a shared lexer.");
    expect(transport.closed).toBe(true);
  });
});

test("Codex dynamic write_file observes Demesne's deny policy and receives the denial", async () => {
  await fixture(async ({ client, transport, workspace, sessionId, consume }) => {
    transport.onTurn = transport => transport.tool("write_file", { path: "notes.txt", content: "Overwritten" });
    transport.onResult = transport => transport.finish("The session denied the edit.");
    const events = await consume(await client.submitTurn(sessionId, { content: "Overwrite notes.txt", permissionMode: "deny" }));
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(events.some(event => event.type === "tool.call_denied")).toBe(true);
    expect(transport.responses[0]).toMatchObject({ id: 77, result: { success: true, contentItems: [{ type: "inputText", text: "Permission denied by session policy" }] } });
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("The migration uses a shared lexer.\n");
    expect(transport.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    expect(transport.closed).toBe(true);
  });
});

test("cancelling a pending Demesne approval releases Codex's paused tool RPC", async () => {
  await fixture(async ({ client, transport, workspace, sessionId, consume }) => {
    transport.onTurn = transport => transport.tool("write_file", { path: "new.txt", content: "Must not be written" });
    const submitted = await client.submitTurn(sessionId, { content: "Create new.txt", permissionMode: "ask" });
    let approvalSeen = false;
    const events = await consume(submitted, async event => {
      if (event.type === "permission.requested") {
        approvalSeen = true;
        expect(transport.closed).toBe(false);
        await client.cancelTurn(submitted.turn.id);
      }
    });
    expect(approvalSeen).toBe(true);
    expect(events.at(-1)?.type).toBe("turn.cancelled");
    await transport.closedPromise;
    expect(transport.closed).toBe(true);
    expect(transport.responses).toHaveLength(0);
    expect(existsSync(join(workspace, "new.txt"))).toBe(false);
    expect(transport.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
  });
});
