import { expect, test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import { fixture, eventually } from "./fixture.ts";

async function setup() {
  let model = "a", reasoning: string | undefined;
  const calls: string[] = [];
  let hold: Promise<void> | undefined;
  const f = await fixture({
    providerId: "test", get modelId() { return model; }, get reasoning() { return reasoning; }, contextCapacity: 8000,
    async listModels() { return ["a", "b", "c"].map(id => ({ id, provider: "test", contextWindow: 8000, reasoningLevels: ["low", "medium", "high"] })); },
    async setModel(id, effort) { calls.push(id); await hold; model = id; reasoning = effort; },
    async *stream() { yield { type: "finish", reason: "stop" }; },
  });
  const a = (await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true })).session;
  const b = (await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true })).session;
  const host = new WorkspaceHost({ client: f.client, settings: f.settings, workspace: f.workspace, sessionId: a.id, headless: true, changed() {} });
  await host.connect();
  return { ...f, host, a, b, calls, hold: (promise?: Promise<void>) => { hold = promise; }, close: async () => { host.dispose(); await f.close(); } };
}

test("each chat restores its persisted model, including a new host opening it", async () => {
  const f = await setup();
  try {
    await f.host.handle("model", { id: "b", reasoning: "high", sessionId: f.a.id });
    expect(f.host.current?.session.preferredModel).toBe("b");
    expect(f.host.current?.session.preferredReasoning).toBe("high");
    await f.host.select(f.b.id);
    await f.host.handle("model", { id: "c", sessionId: f.host.current!.session.id });
    await f.host.select(f.a.id);
    expect(f.host.model.id).toBe("b");
    expect(f.host.reasoning).toBe("high");
    expect((await f.client.health()).model).toBe("b");
    await f.host.select(f.b.id);
    expect(f.host.model.id).toBe("c");
    const reopened = new WorkspaceHost({ client: f.client, settings: f.settings, workspace: f.workspace, sessionId: f.a.id, headless: true, changed() {} });
    try { await reopened.connect(); expect(reopened.model.id).toBe("b"); expect(reopened.reasoning).toBe("high"); }
    finally { reopened.dispose(); }
  } finally { await f.close(); }
});

test("overlapping choices finish in order and stay attached to the original chat", async () => {
  const f = await setup();
  try {
    await f.client.updateSession(f.b.id, { preferredModel: "a" });
    const gate = Promise.withResolvers<void>(); f.hold(gate.promise);
    const first = f.host.handle("model", { id: "b", sessionId: f.a.id });
    await eventually(() => f.calls.includes("b"));
    const second = f.host.handle("model", { id: "c", sessionId: f.host.current!.session.id });
    const switching = f.host.select(f.b.id);
    gate.resolve(); f.hold();
    await Promise.all([first, second, switching]);
    expect(f.calls.slice(-3)).toEqual(["b", "c", "a"]);
    expect((await f.client.getSessionState(f.a.id)).session.preferredModel).toBe("c");
    expect((await f.client.getSessionState(f.b.id)).session.preferredModel).toBe("a");
    expect(f.host.model.id).toBe("a");
  } finally { await f.close(); }
});

test("same-model chats keep independent efforts; an unset chat starts at medium", async () => {
  const f = await setup();
  try {
    expect(f.host.reasoning).toBe("medium");
    await f.host.handle("model", { id: "a", reasoning: "high", sessionId: f.a.id });
    await f.host.select(f.b.id);
    expect(f.host.model.id).toBe("a");
    expect(f.host.reasoning).toBe("medium");
    await f.host.handle("model", { id: "a", reasoning: "low", sessionId: f.b.id });
    await f.host.select(f.a.id);
    expect(f.host.reasoning).toBe("high");
    expect((await f.client.health()).reasoning).toBe("high");
    await f.host.select(f.b.id);
    expect(f.host.reasoning).toBe("low");
    expect((await f.client.getSessionState(f.b.id)).session.preferredReasoning).toBe("low");
    await f.client.updateSession(f.b.id, { preferredReasoning: null });
    await f.host.select(f.b.id);
    expect(f.host.reasoning).toBe("medium");
  } finally { await f.close(); }
});
