import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider, type CodexConnection } from "../src/codex.ts";
import type { ProviderMessage, ProviderRequest, ProviderStreamEvent } from "../src/index.ts";

class FakeCodex implements CodexConnection {
  readonly requests: { method: string; params: any }[] = [];
  readonly responses: { id: string | number; result: any }[] = [];
  readonly rejected: (string | number)[] = [];
  readonly listeners = new Set<(message: { method: string; params?: unknown }) => void>();
  readonly calls = new Set<(message: { id: string | number; method: string; params?: unknown }) => boolean>();
  readonly closers = new Set<(error?: Error) => void>();
  closed = false;
  onStart: (client: FakeCodex) => void = client => client.complete();
  onResult: (client: FakeCodex) => void = client => client.complete();
  async start() {}
  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "account/read") return { account: { type: "chatgpt" } } as T;
    if (method === "model/list") return { data: [{ model: "gpt-6.1-sol", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: "medium" }] } as T;
    if (method === "thread/start") return { thread: { id: "thread" } } as T;
    if (method === "turn/start") {
      this.emit("turn/started", { turn: { id: "turn" } });
      queueMicrotask(() => this.onStart(this));
      return { turn: { id: "turn" } } as T;
    }
    return {} as T;
  }
  onNotification(cb: (message: { method: string; params?: unknown }) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  onServerRequest(cb: (message: { id: string | number; method: string; params?: unknown }) => boolean) { this.calls.add(cb); return () => { this.calls.delete(cb); }; }
  onClose(cb: (error?: Error) => void) { this.closers.add(cb); return () => { this.closers.delete(cb); }; }
  respond(id: string | number, result: unknown) { this.responses.push({ id, result }); queueMicrotask(() => this.onResult(this)); }
  reject(id: string | number) { this.rejected.push(id); }
  async close() { this.closed = true; }
  emit(method: string, params: Record<string, unknown>) { for (const cb of this.listeners) cb({ method, params: { threadId: "thread", turnId: "turn", ...params } }); }
  tool(id = "call", rpcId = 50, name = "demesne_read_file", args: unknown = { path: "README.md" }) {
    for (const cb of this.calls) cb({ id: rpcId, method: "item/tool/call", params: { threadId: "thread", turnId: "turn", callId: id, namespace: null, tool: name, arguments: args } });
  }
  complete(status = "completed") { this.emit("turn/completed", { turn: { id: "turn", status } }); }
  usage(input: number, output: number) { this.emit("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: input, outputTokens: output, totalTokens: input + output, cachedInputTokens: 5 } } }); }
}
const tools = [{ name: "read_file", description: "Read a workspace file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
const messages: ProviderMessage[] = [{ role: "system", content: "Use Demesne tools." }, { role: "user", content: "Read the README." }];
const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({ model: "codex/gpt-6.1-sol", messages, tools, cacheKey: "session", ...overrides });
const collect = async (provider: CodexProvider, input = request(), signal = new AbortController().signal) => {
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.stream(input, signal)) events.push(event);
  return events;
};
function fixture(client = new FakeCodex()) {
  const root = mkdtempSync(join(tmpdir(), "demesne-codex-adapter-"));
  const provider = new CodexProvider({ dataDir: root, createClient: () => client });
  return { provider, client, cleanup: async () => { await provider.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test("Codex pauses a complete tool call and resumes the same turn with Demesne's result", async () => {
  const f = fixture();
  f.client.onStart = client => { client.usage(100, 10); client.tool(); };
  f.client.onResult = client => { client.emit("item/agentMessage/delta", { delta: "The README explains setup." }); client.usage(230, 25); client.complete(); };
  try {
    const first = await collect(f.provider);
    expect(first).toContainEqual({ type: "tool_call_delta", index: 0, idDelta: "call", nameDelta: "read_file", argumentsDelta: '{"path":"README.md"}' });
    expect(first.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
    expect(f.client.responses).toHaveLength(0);
    expect(f.client.closed).toBe(false);
    const second = await collect(f.provider, request({ messages: [...messages,
      { role: "assistant", content: null, toolCalls: [{ id: "call", name: "read_file", arguments: '{"path":"README.md"}' }] },
      { role: "tool", toolCallId: "call", content: "Install Bun, then run setup." }] }));
    expect(f.client.responses).toEqual([{ id: 50, result: { success: true, contentItems: [{ type: "inputText", text: "Install Bun, then run setup." }] } }]);
    expect(second).toContainEqual({ type: "usage", usage: { inputTokens: 130, outputTokens: 15, totalTokens: 145, cachedInputTokens: 0 } });
    expect(second.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(f.client.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
    expect(f.client.closed).toBe(true);
  } finally { await f.cleanup(); }
});

test("Codex replays conversation history and runs in an isolated read-only thread", async () => {
  const f = fixture();
  try {
    await collect(f.provider, request({ messages: [...messages, { role: "assistant", content: "Previous answer." }, { role: "user", content: "Continue." }] }));
    const start = f.client.requests.find(r => r.method === "thread/start")!.params;
    expect(start).toMatchObject({ model: "gpt-6.1-sol", ephemeral: true, approvalPolicy: "never", sandbox: "read-only", environments: [], runtimeWorkspaceRoots: [], allowProviderModelFallback: false });
    expect(start.config["features.stable_environment_tools"]).toBe(false);
    expect(start.config["include_permissions_instructions"]).toBe(false);
    expect(start.dynamicTools[0].name).toBe("demesne_read_file");
    expect(f.client.requests.find(r => r.method === "thread/inject_items")!.params.items).toContainEqual({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Previous answer." }] });
    expect(f.client.requests.find(r => r.method === "turn/start")!.params.input[0].text).toBe("Continue.");
  } finally { await f.cleanup(); }
});

test.each(["failed", "interrupted"])("Codex %s turn cannot emit a successful finish", async status => {
  const f = fixture(); f.client.onStart = client => { client.emit("item/agentMessage/delta", { delta: "Partial" }); client.complete(status); };
  try { await expect(collect(f.provider)).rejects.toThrow(status === "failed" ? "failed" : "interrupted"); expect(f.client.closed).toBe(true); }
  finally { await f.cleanup(); }
});

test.each(["unknown", "invalid", "native"])("Codex rejects %s tool capability before exposing a call", async kind => {
  const f = fixture();
  f.client.onStart = client => {
    if (kind === "native") for (const cb of client.calls) cb({ id: 51, method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn" } });
    else client.tool("call", 50, kind === "unknown" ? "delete_everything" : "demesne_read_file", kind === "invalid" ? null : {});
  };
  try { await expect(collect(f.provider)).rejects.toThrow(); expect(f.client.rejected).toHaveLength(1); expect(f.client.closed).toBe(true); }
  finally { await f.cleanup(); }
});

test("Codex cancellation and disconnect close a waiting inference promptly", async () => {
  for (const disconnected of [false, true]) {
    const f = fixture(); const abort = new AbortController();
    f.client.onStart = client => queueMicrotask(() => {
      if (disconnected) for (const cb of client.closers) cb(new Error("connection lost"));
      else abort.abort(new Error("cancelled"));
    });
    try { await expect(collect(f.provider, request(), abort.signal)).rejects.toThrow(disconnected ? "connection lost" : "cancelled"); expect(f.client.closed).toBe(true); }
    finally { await f.cleanup(); }
  }
});

test("Codex one-shot planners close their pending dynamic call after handing off the decision", async () => {
  const f = fixture(); f.client.onStart = client => client.tool();
  try { expect((await collect(f.provider, request({ cacheKey: undefined }))).at(-1)).toEqual({ type: "finish", reason: "tool_calls" }); expect(f.client.closed).toBe(true); }
  finally { await f.cleanup(); }
});

test("Codex refuses a missing tool result and releases pending state", async () => {
  const f = fixture(); f.client.onStart = client => client.tool();
  try { await collect(f.provider); await expect(collect(f.provider)).rejects.toThrow("pending tool result is missing"); expect(f.client.responses).toHaveLength(0); expect(f.client.closed).toBe(true); }
  finally { await f.cleanup(); }
});

test("Codex models retain a distinct route and their advertised reasoning choices", async () => {
  const provider = new CodexProvider({ dataDir: tmpdir(), contextWindow: 100_000, listModels: async () => [{ id: "codex/gpt-6.1-sol", provider: "Codex", contextWindow: 272_000, reasoningLevels: ["low", "medium", "high", "xhigh", "max"] }] });
  expect((await provider.listModels())[0]).toMatchObject({ id: "codex/gpt-6.1-sol", contextWindow: 100_000, reasoningLevels: ["low", "medium", "high", "xhigh", "max"] });
  await expect(collect(provider, request({ model: "gpt-6.1-sol" }))).rejects.toThrow("catalog");
});

test("Codex preserves parallel pending calls without responding before each result is delivered", async () => {
  const f = fixture();
  f.client.onStart = client => { client.tool("first", 50); client.tool("second", 51); };
  f.client.onResult = client => { if (client.responses.length === 2) client.complete(); };
  try {
    const first = await collect(f.provider);
    expect(first.find(e => e.type === "tool_call_delta")).toMatchObject({ idDelta: "first" });
    const nextMessages: ProviderMessage[] = [...messages, { role: "assistant", content: null, toolCalls: [{ id: "first", name: "read_file", arguments: "{}" }] }, { role: "tool", toolCallId: "first", content: "first result" }];
    const second = await collect(f.provider, request({ messages: nextMessages }));
    expect(second.find(e => e.type === "tool_call_delta")).toMatchObject({ idDelta: "second" });
    expect(f.client.responses.map(response => response.id)).toEqual([50]);
    await collect(f.provider, request({ messages: [...nextMessages, { role: "assistant", content: null, toolCalls: [{ id: "second", name: "read_file", arguments: "{}" }] }, { role: "tool", toolCallId: "second", content: "second result" }] }));
    expect(f.client.responses.map(response => response.id)).toEqual([50, 51]);
  } finally { await f.cleanup(); }
});

test("Codex rebuilds its thread after Demesne drops historical context", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-codex-context-"));
  const clients = [new FakeCodex(), new FakeCodex()]; let index = 0;
  clients[0]!.onStart = client => client.tool();
  const provider = new CodexProvider({ dataDir: root, createClient: () => clients[index++]! });
  try {
    await collect(provider, request({ messages: [messages[0]!, { role: "user", content: "Old context." }, { role: "assistant", content: "Old answer." }, messages[1]!] }));
    await collect(provider, request({ messages: [...messages, { role: "assistant", content: null, toolCalls: [{ id: "call", name: "read_file", arguments: "{}" }] }, { role: "tool", toolCallId: "call", content: "fresh result" }] }));
    expect(clients[0]!.closed).toBe(true);
    expect(clients[0]!.responses).toHaveLength(0);
    const replay = clients[1]!.requests.find(r => r.method === "thread/inject_items")!.params.items;
    expect(replay).not.toContainEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "Old context." }] });
    expect(replay).toContainEqual({ type: "function_call_output", call_id: "call", output: "fresh result" });
  } finally { await provider.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("Codex validates effort against the catalog and uses its lowest supported level for quick calls", async () => {
  const f = fixture();
  try {
    await collect(f.provider, request({ thinkingEnabled: false }));
    expect(f.client.requests.find(r => r.method === "turn/start")!.params.effort).toBe("low");
    await expect(collect(f.provider, request({ reasoningLevel: "none" }))).rejects.toThrow("not supported");
  } finally { await f.cleanup(); }
});

test("Releasing a one-shot request does not cancel another paused conversation", async () => {
  const f = fixture(); f.client.onStart = client => client.tool();
  try { await collect(f.provider); await f.provider.release(); expect(f.client.closed).toBe(false); await f.provider.release("session"); expect(f.client.closed).toBe(true); }
  finally { await f.cleanup(); }
});

test("Codex renames reserved MCP tool names and restores the original Demesne call", async () => {
  const f = fixture();
  f.client.onStart = client => client.tool("browser", 50, "demesne_mcp__browser__browser_click", { target: "button" });
  try {
    const events = await collect(f.provider, request({ tools: [{ name: "mcp__browser__browser_click", description: "Click", inputSchema: { type: "object" } }] }));
    expect(f.client.requests.find(r => r.method === "thread/start")!.params.dynamicTools[0].name).toBe("demesne_mcp__browser__browser_click");
    expect(events.find(event => event.type === "tool_call_delta")).toMatchObject({ nameDelta: "mcp__browser__browser_click" });
  } finally { await f.cleanup(); }
});
