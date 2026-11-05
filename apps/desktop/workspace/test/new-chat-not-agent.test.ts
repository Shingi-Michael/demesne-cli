import { expect, test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import { fixture } from "./fixture.ts";

// An agent's chat (agent-cli.ts) sits empty in the project until it's used.
// New chat must make a real chat, never open that agent's chat.
test("New chat in a project never reuses an empty agent chat", async () => {
  const f = await fixture({ providerId: "test", modelId: "m", async listModels() { return [{ id: "m", provider: "test", contextWindow: 131072 }]; },
    async *stream() { yield { type: "text_delta", delta: "ok" }; yield { type: "finish", reason: "stop" }; } });
  const used = (await f.client.createSession({ workspacePath: f.workspace })).session.id;
  await f.client.submitTurn(used, { content: "hello", permissionMode: "ask" });
  for (let i = 0; i < 100 && (await f.client.listSessions()).find((session) => session.id === used)?.turns.length !== 1; i++) await Bun.sleep(20);
  const agent = (await f.client.createSession({ workspacePath: f.workspace, title: "Claude Code" })).session.id;
  await f.client.updateSession(agent, { preferredModel: "agent:claude" });
  const host = new WorkspaceHost({ client: f.client, settings: f.settings, workspace: f.workspace, sessionId: used, headless: true, changed() {} });
  try {
    await host.connect(false);
    const id = await host.handle("new-session", { reuse: true }) as string;
    expect(id).not.toBe(agent);
    expect(id).not.toBe(used);
    expect((await f.client.getSessionState(id)).session.preferredModel ?? "").not.toStartWith("agent:");
  } finally { host.dispose(); await f.close(); }
});
