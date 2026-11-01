import { expect, test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import { fixture, eventually } from "./fixture.ts";

async function setup() {
  let model = "a";
  const calls: string[] = [];
  let hold: Promise<void> | undefined;
  const f = await fixture({
    providerId: "test", get modelId() { return model; }, contextCapacity: 8000,
    async listModels() { return ["a", "b", "c"].map(id => ({ id, provider: "test", contextWindow: 8000, reasoningLevels: ["low", "high"] })); },
    async setModel(id) { calls.push(id); await hold; model = id; },
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
    await f.host.select(f.b.id);
    await f.host.handle("model", { id: "c", sessionId: f.host.current!.session.id });
    await f.host.select(f.a.id);
    expect(f.host.model.id).toBe("b");
    expect((await f.client.health()).model).toBe("b");
    await f.host.select(f.b.id);
    expect(f.host.model.id).toBe("c");
    const reopened = new WorkspaceHost({ client: f.client, settings: f.settings, workspace: f.workspace, sessionId: f.a.id, headless: true, changed() {} });
    try { await reopened.connect(); expect(reopened.model.id).toBe("b"); }
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
