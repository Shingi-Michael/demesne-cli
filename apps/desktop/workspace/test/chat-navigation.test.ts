import { expect, test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import { ProviderTurnProcessor } from "../../../daemon/src/provider-processor.ts";
import { fixture, eventually } from "./fixture.ts";

const within = <T>(promise: Promise<T>) => Promise.race([promise, Bun.sleep(1000).then((): never => { throw new Error("Navigation waited for model discovery"); })]);

test("cold catalog cannot block navigation; send waits and only the latest chat activates", async () => {
  let requests = 0;
  const activations: string[] = [];
  const processor = new ProviderTurnProcessor({ id: "test",
    async listModels() { return ["a", "b", "c"].map(id => ({ id, provider: "test", contextWindow: 262144, reasoningLevels: ["low", "medium", "high"] })); },
    async *stream(request) { expect(request.model).toBe("c"); expect(request.reasoningLevel).toBe("low"); requests++; yield { type: "text_delta", delta: "Ready" }; yield { type: "finish", reason: "stop" }; },
  }, "a", {}, undefined, 262144);
  const activate = processor.setModel.bind(processor);
  processor.setModel = (id, level) => { activations.push(id); activate(id, level); };
  const f = await fixture(processor);
  const gate = Promise.withResolvers<void>();
  const list = f.client.listModels.bind(f.client);
  f.client.listModels = async () => { await gate.promise; return list(); };
  const a = (await f.client.createSession({ workspacePath: f.workspace })).session.id;
  const b = (await f.client.createSession({ workspacePath: f.workspace })).session.id;
  const c = (await f.client.createSession({ workspacePath: f.workspace })).session.id;
  await f.client.updateSession(b, { preferredModel: "b", preferredReasoning: "high" });
  await f.client.updateSession(c, { preferredModel: "c", preferredReasoning: "low" });
  const host = new WorkspaceHost({ client: f.client, settings: f.settings, workspace: f.workspace, sessionId: a, headless: true, changed() {} });
  try {
    await within(host.connect(false));
    expect(host.current?.session.id).toBe(a);
    await within(host.handle("select-session", { id: b }));
    expect(host.snapshot()).toMatchObject({ session: { id: b }, model: { id: "b" }, reasoning: "high", busy: false });
    await within(host.handle("select-session", { id: c }));
    expect(host.snapshot()).toMatchObject({ session: { id: c }, model: { id: "c" }, reasoning: "low", busy: false });
    const sending = host.submit("Check the selected model");
    await Bun.sleep(30); expect(requests).toBe(0);
    gate.resolve(); await sending;
    await eventually(() => requests === 1);
    expect(activations).toEqual(["c"]);
    expect(host.model.id).toBe("c"); expect(host.reasoning).toBe("low");
    expect((await f.client.getSessionState(b)).session.preferredReasoning).toBe("high");
  } finally { gate.resolve(); host.dispose(); await f.close(); }
});

test("a chat whose model can't be restored opens on the running model and says so in the picker", async () => {
  const f = await fixture();
  const running = (await f.client.health()).model;
  const id = (await f.client.createSession({ workspacePath: f.workspace })).session.id;
  await f.client.updateSession(id, { preferredModel: "missing-model", preferredReasoning: "high" });
  const host = new WorkspaceHost({ client: f.client, settings: f.settings, workspace: f.workspace, sessionId: id, headless: true, changed() {} });
  try {
    await host.connect(false);
    await eventually(() => host.model.id === running);
    expect(host.snapshot()).toMatchObject({ connection: "online", error: null, model: { id: running } });
  } finally { host.dispose(); await f.close(); }
});

for (const pending of ["picker", "restoration"] as const) test(`new chat inherits a pending ${pending} model, not the old daemon model`, async () => {
  const seen: Array<{ model: string; effort?: string }> = [];
  const processor = new ProviderTurnProcessor({ id: "test",
    async listModels() { return ["a", "b"].map(id => ({ id, provider: "test", contextWindow: 262144, reasoningLevels: ["low", "medium", "high"] })); },
    async *stream(request) { seen.push({ model: request.model, effort: request.reasoningLevel }); yield { type: "text_delta", delta: "Ready" }; yield { type: "finish", reason: "stop" }; },
  }, "a", {}, undefined, 262144);
  const f = await fixture(processor), gate = Promise.withResolvers<void>();
  const a = (await f.client.createSession({ workspacePath: f.workspace })).session.id;
  const saved = (await f.client.createSession({ workspacePath: f.workspace })).session.id;
  await f.client.updateSession(saved, { preferredModel: "b", preferredReasoning: "high" });
  const host = new WorkspaceHost({ client: f.client, settings: f.settings, workspace: f.workspace, sessionId: a, headless: true, changed() {} });
  let entered = false, choice: Promise<unknown> | undefined;
  try {
    await host.connect();
    const activate = f.client.setModel.bind(f.client);
    f.client.setModel = async (...args) => { entered = true; await gate.promise; return activate(...args); };
    if (pending === "picker") choice = host.handle("model", { sessionId: a, id: "b", reasoning: "high" });
    else await within(host.select(saved, false));
    await eventually(() => entered);
    await within(host.handle("new-session", {}));
    const fresh = host.current!.session.id;
    expect([a, saved]).not.toContain(fresh);
    const sending = host.submit("Use the inherited model");
    await Bun.sleep(20); expect(seen).toHaveLength(0);
    gate.resolve(); await choice; await sending;
    await eventually(() => seen.length === 1);
    expect(seen).toEqual([{ model: "b", effort: "medium" }]);
    expect(host.model.id).toBe("b"); expect(host.reasoning).toBe("medium");
    if (pending === "picker") expect((await f.client.getSessionState(a)).session).toMatchObject({ preferredModel: "b", preferredReasoning: "high" });
    expect((await f.client.getSessionState(saved)).session.preferredReasoning).toBe("high");
  } finally { gate.resolve(); await choice?.catch(() => {}); host.dispose(); await f.close(); }
});
