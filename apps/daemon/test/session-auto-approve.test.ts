import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { EventEnvelope } from "@demesne/protocol";
import { DemesneStore } from "@demesne/storage";
import { createDaemonApp, type DaemonApp } from "../src/app.ts";
import { AgentEngine } from "../src/engine.ts";
import { InferenceScheduler, InferenceSchedulers } from "../src/inference-scheduler.ts";
import { PermissionBroker } from "../src/permissions.ts";
import type { TurnInference, TurnProcessor } from "../src/processor.ts";
import { ToolRegistry, type AgentTool } from "../src/tools.ts";

const roots: string[] = [];
const apps: DaemonApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "demesne-auto-approve-")));
  roots.push(path);
  return path;
}

async function poll<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (ready(value)) return value;
    await Bun.sleep(5);
  }
  throw new Error("Fixture did not reach expected state");
}

test("PATCH releases pending approvals only for the selected session and rejects invalid values", async () => {
  const directory = root();
  const workspace = join(directory, "workspace");
  const data = join(directory, "data");
  mkdirSync(workspace);
  mkdirSync(data);
  const processor: TurnProcessor = {
    providerId: "test", modelId: "test", async listModels() { return []; },
    async *stream(messages) {
      if (messages.some(message => message.role === "tool")) {
        yield { type: "text_delta", delta: "Done." }; return;
      }
      const title = messages.findLast(message => message.role === "user")?.content;
      yield { type: "tool_call_delta", index: 0, idDelta: "write", nameDelta: "write_file",
        argumentsDelta: JSON.stringify({ path: `${title}.txt`, content: "written" }) };
    },
  };
  const app = createDaemonApp({ databasePath: join(data, "state.sqlite"), processor, inferenceSlots: 2,
    allowlistPath: join(data, "config.toml") });
  apps.push(app);
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  const { session: first } = await client.createSession({ title: "First", workspacePath: workspace, trustWorkspace: true });
  const { session: second } = await client.createSession({ title: "Second", workspacePath: workspace, trustWorkspace: true });
  expect(first.autoApprove).toBe(false);
  const bad = await app.fetch(new Request(`http://localhost/v1/sessions/${first.id}`, {
    method: "PATCH", body: JSON.stringify({ autoApprove: "yes" }), headers: { "Content-Type": "application/json" },
  }));
  expect(bad.status).toBe(400);
  await client.submitTurn(first.id, { content: "first", permissionMode: "ask" });
  const { turn: otherTurn } = await client.submitTurn(second.id, { content: "second", permissionMode: "ask" });
  await poll(() => client.getSessionState(first.id), state => state.pendingPermissions.length === 1);
  await poll(() => client.getSessionState(second.id), state => state.pendingPermissions.length === 1);
  const updated = await client.updateSession(first.id, { autoApprove: true });
  expect(updated.session.autoApprove).toBe(true);
  expect(updated.eventId).toBeNumber();
  const completed = await poll(() => client.getSessionState(first.id), state => state.session.turns[0]?.status === "completed");
  expect(completed.pendingPermissions).toEqual([]);
  expect(completed.sessionGrants).toEqual([]);
  expect(existsSync(join(workspace, "first.txt"))).toBe(true);
  const pending = await client.getSessionState(second.id);
  expect(pending.session.autoApprove).toBe(false);
  expect(pending.pendingPermissions).toHaveLength(1);
  await client.cancelTurn(otherTurn.id);
  await client.updateSession(second.id, { autoApprove: true });
  const cancelled = await poll(() => client.getSessionState(second.id), state => state.session.turns[0]?.status === "cancelled");
  expect(cancelled.pendingPermissions).toEqual([]);
  expect(existsSync(join(workspace, "second.txt"))).toBe(false);
});

function engineFixture(toolNames: string[], execute?: (name: string) => void) {
  const workspace = root();
  const store = new DemesneStore(":memory:");
  const { session } = store.createSession("Policy", workspace);
  const broker = new PermissionBroker(undefined, id => store.isSessionAutoApprove(id));
  const events: EventEnvelope[] = [];
  store.setEventSink(event => events.push(event));
  const executed: string[] = [];
  const tools = new ToolRegistry(toolNames.map(name => ({
    definition: { name, description: name, inputSchema: { type: "object" } },
    permission: () => ({ kind: "execute", summary: name }),
    async execute() { executed.push(name); execute?.(name); return "done"; },
  } satisfies AgentTool)));
  const schedulers = new InferenceSchedulers(new InferenceScheduler(1), "test");
  const engine = new AgentEngine(store, tools, broker, schedulers);
  return { store, session, broker, events, executed, engine, schedulers };
}

function inference(stream: TurnInference["stream"]): TurnInference {
  return { providerId: "test", modelId: "test", profile: null, thinkingEnabled: undefined, preservesPromptCache: false, stream };
}

test("auto-approve authorizes publishing even in deny turns, without changing Drive allow policy", async () => {
  const fixture = engineFixture(["run_command"]);
  const { store, session, engine, events, executed } = fixture;
  store.setSessionAutoApprove(session.id, true);
  const { turn } = store.createTurn(session.id, "Publish", "deny");
  let round = 0;
  try {
    await engine.run(turn.id, inference(async function* () {
      if (round++ === 0) {
        yield { type: "tool_call_delta", index: 0, idDelta: "publish", nameDelta: "run_command",
          argumentsDelta: JSON.stringify({ argv: ["git", "push", "origin", "main"] }) };
      } else yield { type: "text_delta", delta: "Done." };
    }), new AbortController().signal);
    expect(executed).toEqual(["run_command"]);
    expect(events.filter(event => event.type === "permission.requested")).toEqual([]);
  } finally { await fixture.schedulers.close(); store.close(); }
});

test("enabling from a permission event before waiter registration resolves the recorded permission once", async () => {
  const fixture = engineFixture(["run_command"]);
  const { store, session, broker, engine, events, executed } = fixture;
  store.setEventSink(event => {
    events.push(event);
    if (event.type === "permission.requested") {
      store.setSessionAutoApprove(session.id, true);
      expect(broker.approvePendingSession(session.id)).toBe(0);
    }
  });
  const { turn } = store.createTurn(session.id, "Run a command", "ask");
  let round = 0;
  try {
    await engine.run(turn.id, inference(async function* () {
      if (round++ === 0) yield { type: "tool_call_delta", index: 0, idDelta: "command", nameDelta: "run_command",
        argumentsDelta: JSON.stringify({ argv: ["fixture-command"] }) };
      else yield { type: "text_delta", delta: "Done." };
    }), new AbortController().signal);
    expect(executed).toEqual(["run_command"]);
    expect(store.getSessionState(session.id)?.pendingPermissions).toEqual([]);
    expect(events.find(event => event.type === "permission.resolved")?.payload.decision).toBe("allow_once");
    expect(broker.listGrants(session.id)).toEqual([]);
  } finally { await fixture.schedulers.close(); store.close(); }
});

test("disabling auto-approve applies to the next action in the same model round and refreshes prompt guidance", async () => {
  let fixture: ReturnType<typeof engineFixture>;
  fixture = engineFixture(["run_command"], () => fixture.store.setSessionAutoApprove(fixture.session.id, false));
  const { store, session, broker, engine, executed, events } = fixture;
  store.setSessionAutoApprove(session.id, true);
  store.setEventSink(event => {
    events.push(event);
    if (event.type === "permission.requested") queueMicrotask(() => broker.resolve(String(event.payload.permissionId), "deny"));
  });
  const { turn } = store.createTurn(session.id, "Run two commands", "ask");
  const prompts: string[] = [];
  let round = 0;
  try {
    await engine.run(turn.id, inference(async function* (messages) {
      prompts.push(messages[0]?.content ?? "");
      if (round++ === 0) {
        for (const index of [0, 1]) yield { type: "tool_call_delta", index, idDelta: `command-${index}`, nameDelta: "run_command",
          argumentsDelta: JSON.stringify({ argv: ["fixture-command", String(index)] }) };
      } else yield { type: "text_delta", delta: "Done." };
    }), new AbortController().signal);
    expect(executed).toEqual(["run_command"]);
    expect(events.filter(event => event.type === "permission.requested")).toHaveLength(1);
    expect(prompts[0]).toContain("Session auto-approve is enabled");
    expect(prompts[1]).not.toContain("Session auto-approve is enabled");
    expect(prompts[1]).toContain("edits and commands need approval");
    expect(broker.listGrants(session.id)).toEqual([]);
  } finally { await fixture.schedulers.close(); store.close(); }
});

test("Plan mode still filters and rejects writes with auto-approve enabled", async () => {
  const fixture = engineFixture(["write_file", "run_command", "read_file"]);
  const { store, session, engine, executed, events } = fixture;
  store.setSessionAutoApprove(session.id, true);
  const { turn } = store.createTurn(session.id, "Plan a change", "ask", undefined, true);
  let round = 0;
  let offered: string[] = [], prompt = "";
  try {
    await engine.run(turn.id, inference(async function* (messages, tools) {
      if (round++ === 0) {
        offered = tools.map(tool => tool.name);
        prompt = messages[0]?.content ?? "";
        yield { type: "tool_call_delta", index: 0, idDelta: "write", nameDelta: "write_file",
          argumentsDelta: JSON.stringify({ path: "plan.txt", content: "bad" }) };
      } else yield { type: "text_delta", delta: "Plan ready." };
    }), new AbortController().signal);
    expect(offered).toContain("read_file");
    expect(offered).not.toContain("write_file");
    expect(offered).not.toContain("run_command");
    expect(prompt).toContain("Plan mode: this turn is read-only");
    expect(prompt).not.toContain("Session auto-approve is enabled");
    expect(executed).toEqual([]);
    expect(events.filter(event => event.type === "permission.requested")).toEqual([]);
    expect(events.some(event => event.type === "tool.call_denied")).toBe(true);
  } finally { await fixture.schedulers.close(); store.close(); }
});
