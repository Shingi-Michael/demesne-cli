import { expect, test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import { eventually, fixture } from "./fixture.ts";

for (const home of ["plain", "project"] as const) {
  test(`Foundry's make box saves an artifact from ${home} Home and can revise it`, async () => {
    const f = await fixture({
      providerId: "test", modelId: "foundry-test",
      async listModels() { return []; },
      async *stream(messages, tools) {
        if (messages.at(-1)?.role === "tool") {
          yield { type: "text_delta", delta: "Your page is in Foundry." };
          yield { type: "finish", reason: "stop" }; return;
        }
        yield { type: "tool_call_delta", index: 0, idDelta: "make-page", nameDelta: "foundry_save",
          argumentsDelta: JSON.stringify({ title: "Tiny Garden", kind: "html", source: "<!doctype html><h1>Your tiny garden</h1>" }) };
        yield { type: "finish", reason: "tool_calls" };
      },
    });
    const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, home, headless: true, changed: () => {} });
    try {
      await host.connect();
      await host.handle("foundry-make", { sessionId: host.current!.session.id, text: "make me a small interactive page" });
      await eventually(() => host.current!.runs().at(-1)?.status === "completed");
      const artifacts = await host.handle("foundry-list", {}) as { id: string; title: string; workspace: string | null; sessionId: string }[];
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ title: "Tiny Garden", workspace: home === "plain" ? null : f.workspace, sessionId: host.current!.session.id });
      expect(host.current!.runs()[0]!.content).toBe("Create in Foundry: make me a small interactive page");
      await host.handle("foundry-revise", { sessionId: host.current!.session.id, id: artifacts[0]!.id, title: artifacts[0]!.title });
      expect(host.snapshot().draft).toContain(artifacts[0]!.id);
    } finally {
      host.dispose();
      await f.close();
    }
  });
  test(`Foundry can be invoked inside an existing ${home} chat without switching sessions`, async () => {
    const f = await fixture({
      providerId: "test", modelId: "foundry-test",
      async listModels() { return []; },
      async *stream(messages) {
        if (messages.at(-1)?.role === "tool") {
          yield { type: "text_delta", delta: "Here is your interactive mockup." };
          yield { type: "finish", reason: "stop" }; return;
        }
        yield { type: "tool_call_delta", index: 0, idDelta: "make-chat-mockup", nameDelta: "foundry_save",
          argumentsDelta: JSON.stringify({ title: "Chat mockup", kind: "html", source: "<button>Try me</button>" }) };
        yield { type: "finish", reason: "tool_calls" };
      },
    });
    const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, home, headless: true, changed: () => {} });
    try {
      await host.connect();
      const id = host.current!.session.id;
      await host.handle("foundry-create", { sessionId: id, text: "a small dashboard mockup" });
      await eventually(() => host.current!.runs().at(-1)?.status === "completed");
      expect(host.current!.session.id).toBe(id);
      expect(host.current!.runs()[0]!.content).toBe("Foundry: a small dashboard mockup");
      expect(host.current!.runs()[0]!.entries.find(entry => entry.type === "tool" && entry.name === "foundry_save" && entry.state === "done")).toBeDefined();
      const { artifacts } = await f.client.foundryList();
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]!.sessionId).toBe(id);
      const saved = host.current!.runs()[0]!.entries.find(entry => entry.type === "tool" && entry.name === "foundry_save");
      expect(JSON.parse(saved?.type === "tool" ? saved.message ?? "{}" : "{}")).toMatchObject({ id: artifacts[0]!.id, title: "Chat mockup", kind: "html", version: 1 });
      await expect(host.handle("foundry-create", { sessionId: id, text: "   " })).rejects.toThrow("Describe what to make");
    } finally { host.dispose(); await f.close(); }
  });
}
