import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@demesne/config";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { EventEnvelope, SubmitTurnResponse } from "@demesne/protocol";
import type { ProviderMessage, ProviderStreamEvent, ProviderToolDefinition } from "@demesne/providers";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";
import { describeCall, SUBAGENT_TOOLS } from "../src/subagent.ts";

type ModelRequest = { messages: ProviderMessage[]; tools: ProviderToolDefinition[] };
const isSubagent = (messages: ProviderMessage[]) => typeof messages[0]?.content === "string" && messages[0].content.startsWith("You are a Demesne sub-agent");
const lastUser = (messages: ProviderMessage[]) => messages.findLast((message) => message.role === "user")?.content;
const toolResults = (messages: ProviderMessage[]) => messages.filter((message) => message.role === "tool").map((message) => String(message.content));
const call = (id: string, name: string, args: unknown): ProviderStreamEvent => ({ type: "tool_call_delta", index: 0, idDelta: id, nameDelta: name, argumentsDelta: JSON.stringify(args) });

async function fixture(stream: (request: ModelRequest) => AsyncGenerator<ProviderStreamEvent>, run: (value: {
  client: DemesneClient; id: string; workspace: string; requests: ModelRequest[];
  consume: (submitted: SubmitTurnResponse) => Promise<EventEnvelope[]>;
}) => Promise<void>, agent?: AgentConfig) {
  const root = mkdtempSync(join(tmpdir(), "demesne-subagent-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace); mkdirSync(join(root, "data"));
  writeFileSync(join(workspace, "notes.txt"), "The session restore lives in history.ts.\n");
  const requests: ModelRequest[] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "test", contextCapacity: 262144, maxOutputTokens: 1024,
    async listModels() { return []; }, async *stream(messages, tools) {
      const request = structuredClone({ messages, tools });
      requests.push(request);
      yield* stream(request);
    } };
  const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), processor, agent });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  const { session } = await client.createSession({ title: "Sub-agents", workspacePath: workspace });
  const consume = async (submitted: SubmitTurnResponse) => {
    const events: EventEnvelope[] = [];
    for await (const event of client.streamEvents(session.id, submitted.eventId, AbortSignal.timeout(5000))) {
      if (event.turnId !== submitted.turn.id) continue;
      events.push(event);
      if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) break;
    }
    return events;
  };
  try { await run({ client, id: session.id, workspace, requests, consume }); }
  finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}

test("the agent delegates an investigation; only the sub-agent's report returns to it", async () => {
  await fixture(async function* ({ messages }) {
    if (isSubagent(messages)) {
      if (!toolResults(messages).length) { yield call("sub-read", "read_file", { path: "notes.txt" }); yield { type: "finish", reason: "tool_calls" }; return; }
      yield { type: "text_delta", delta: "Session restore is in history.ts (notes.txt line 1)." }; yield { type: "finish", reason: "stop" }; return;
    }
    if (!toolResults(messages).length) {
      yield call("delegate", "subagent", { description: "Find session restore", prompt: "Where is session restore implemented? Report the file." });
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "It is in history.ts." }; yield { type: "finish", reason: "stop" };
  }, async ({ client, id, requests, consume }) => {
    const events = await consume(await client.submitTurn(id, { content: "Where is session restore?" }));
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(requests[0]!.tools.map((tool) => tool.name)).toContain("subagent");

    const sub = requests.filter((request) => isSubagent(request.messages));
    expect(sub).toHaveLength(2);
    expect(lastUser(sub[0]!.messages)).toBe("Where is session restore implemented? Report the file.");
    // Read-only tools only: no edits, commands, questions, or nested sub-agents.
    expect(sub[0]!.tools.map((tool) => tool.name).sort()).toEqual([...SUBAGENT_TOOLS].sort());

    const parent = requests.filter((request) => !isSubagent(request.messages));
    const report = toolResults(parent[1]!.messages)[0]!;
    expect(report).toStartWith("Session restore is in history.ts (notes.txt line 1).");
    expect(report).toContain("(Sub-agent on test used 1 tool call: read_file ×1.)");
    // The sub-agent's own reads never enter the main conversation.
    expect(JSON.stringify(parent[1]!.messages)).not.toContain("The session restore lives in history.ts.");

    expect(events.filter((event) => event.type === "tool.call_progress").map((event) => event.payload.text)).toContain("read notes.txt");
    expect(events.find((event) => event.type === "tool.call_completed")?.payload.name).toBe("subagent");
    expect(events.some((event) => event.type === "permission.requested")).toBe(false);
  });
});

test("a sub-agent cannot write, even if its model asks to", async () => {
  await fixture(async function* ({ messages }) {
    if (isSubagent(messages)) {
      if (!toolResults(messages).length) { yield call("sub-write", "write_file", { path: "pwned.txt", content: "x" }); yield { type: "finish", reason: "tool_calls" }; return; }
      yield { type: "text_delta", delta: `Could not write: ${toolResults(messages)[0]}` }; yield { type: "finish", reason: "stop" }; return;
    }
    if (!toolResults(messages).length) { yield call("delegate", "subagent", { description: "Try to write", prompt: "Create pwned.txt" }); yield { type: "finish", reason: "tool_calls" }; return; }
    yield { type: "text_delta", delta: toolResults(messages)[0]! }; yield { type: "finish", reason: "stop" };
  }, async ({ client, id, workspace, requests, consume }) => {
    const events = await consume(await client.submitTurn(id, { content: "Delegate a write" }));
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(existsSync(join(workspace, "pwned.txt"))).toBe(false);
    const refused = toolResults(requests.findLast((request) => isSubagent(request.messages))!.messages)[0];
    expect(refused).toContain("write_file is not available to a sub-agent");
    expect(events.some((event) => event.type === "permission.requested")).toBe(false);
  });
});

test("several sub-agents from one round run side by side and each report returns", async () => {
  const started: string[] = [];
  let bothRunning!: () => void;
  const overlap = new Promise<void>((resolve) => { bothRunning = resolve; });
  await fixture(async function* ({ messages }) {
    if (isSubagent(messages)) {
      const task = String(lastUser(messages));
      if (!toolResults(messages).length) {
        started.push(task);
        if (started.length === 2) bothRunning();
        yield call(`read-${task}`, "read_file", { path: "notes.txt" }); yield { type: "finish", reason: "tool_calls" }; return;
      }
      // Neither finishes until both have started: they run concurrently.
      await overlap;
      yield { type: "text_delta", delta: `Report for ${task}` }; yield { type: "finish", reason: "stop" }; return;
    }
    if (!toolResults(messages).length) {
      yield { type: "tool_call_delta", index: 0, idDelta: "a", nameDelta: "subagent", argumentsDelta: JSON.stringify({ description: "First", prompt: "task A" }) };
      yield { type: "tool_call_delta", index: 1, idDelta: "b", nameDelta: "subagent", argumentsDelta: JSON.stringify({ description: "Second", prompt: "task B" }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "Both done." }; yield { type: "finish", reason: "stop" };
  }, async ({ client, id, requests, consume }) => {
    const events = await consume(await client.submitTurn(id, { content: "Investigate two things" }));
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(started.sort()).toEqual(["task A", "task B"]);
    const final = requests.findLast((request) => !isSubagent(request.messages))!;
    expect(toolResults(final.messages).map((result) => result.split("\n")[0])).toEqual(["Report for task A", "Report for task B"]);
  });
});

test("plan mode offers sub-agents, and their live steps read as verb and target", async () => {
  await fixture(async function* () { yield { type: "text_delta", delta: "Plan." }; yield { type: "finish", reason: "stop" }; },
    async ({ client, id, requests, consume }) => {
      await consume(await client.submitTurn(id, { content: "Plan the change", planOnly: true }));
      expect(requests[0]!.tools.map((tool) => tool.name)).toContain("subagent");
    });
  expect(describeCall("search_files", { query: "restoreSession" })).toBe('search "restoreSession"');
  expect(describeCall("read_files", { files: [{ path: "a" }, { path: "b" }] })).toBe("read 2 files");
  expect(describeCall("git_status", {})).toBe("git status");
});

test("with subagent_model set, sub-agents run on that model while the turn stays on its own", async () => {
  const { MultiProviderProcessor } = await import("../src/multi-provider-processor.ts");
  const { ProviderTurnProcessor } = await import("../src/provider-processor.ts");
  const calls: { provider: string; model: string; subagent: boolean }[] = [];
  const provider = (id: string, model: string, reply: (messages: ProviderMessage[]) => ProviderStreamEvent[]) => new ProviderTurnProcessor({
    id,
    async listModels() { return [{ id: model, provider: id, contextWindow: 262144 }]; },
    async *stream(request) { calls.push({ provider: id, model: request.model, subagent: isSubagent(request.messages) }); yield* reply(request.messages); },
  }, model, { maxOutputTokens: 1024 }, undefined, 262144, [model]);
  const cloud = provider("ChatGPT", "astra", (messages) => toolResults(messages).length
    ? [{ type: "text_delta", delta: "Done." }, { type: "finish", reason: "stop" }]
    : [call("delegate", "subagent", { description: "Find notes", prompt: "Read notes.txt" }), { type: "finish", reason: "tool_calls" }]);
  const local = provider("Qwen on PC", "qwen3.8-27b", (messages) => toolResults(messages).length
    ? [{ type: "text_delta", delta: "Notes say: restore lives in history.ts." }, { type: "finish", reason: "stop" }]
    : [call("read", "read_file", { path: "notes.txt" }), { type: "finish", reason: "tool_calls" }]);

  const root = mkdtempSync(join(tmpdir(), "demesne-subagent-model-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace); mkdirSync(join(root, "data"));
  writeFileSync(join(workspace, "notes.txt"), "restore lives in history.ts\n");
  const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), processor: new MultiProviderProcessor([cloud, local], []),
    agent: { subagentModel: "qwen3.8-27b" } });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  try {
    const { session } = await client.createSession({ title: "Sub-agent model", workspacePath: workspace });
    const submitted = await client.submitTurn(session.id, { content: "What do the notes say?" });
    const events: EventEnvelope[] = [];
    for await (const event of client.streamEvents(session.id, submitted.eventId, AbortSignal.timeout(5000))) {
      if (event.turnId !== submitted.turn.id) continue;
      events.push(event);
      if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) break;
    }
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(calls).toEqual([
      { provider: "ChatGPT", model: "astra", subagent: false },
      { provider: "Qwen on PC", model: "qwen3.8-27b", subagent: true },
      { provider: "Qwen on PC", model: "qwen3.8-27b", subagent: true },
      { provider: "ChatGPT", model: "astra", subagent: false },
    ]);
    expect(events.filter((event) => event.type === "tool.call_progress").map((event) => event.payload.text)).toContain("qwen3.8-27b · read notes.txt");
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an unknown subagent_model fails the delegation clearly instead of falling back", async () => {
  await fixture(async function* ({ messages }) {
    if (!toolResults(messages).length) { yield call("delegate", "subagent", { description: "Find", prompt: "Find it" }); yield { type: "finish", reason: "tool_calls" }; return; }
    yield { type: "text_delta", delta: toolResults(messages)[0]! }; yield { type: "finish", reason: "stop" };
  }, async ({ client, id, requests, consume }) => {
    const events = await consume(await client.submitTurn(id, { content: "Delegate" }));
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(requests.some((request) => isSubagent(request.messages))).toBe(false);
    expect(toolResults(requests.at(-1)!.messages)[0]).toContain("sub-agent model no-such-model is unavailable");
  }, { subagentModel: "no-such-model" });
});
