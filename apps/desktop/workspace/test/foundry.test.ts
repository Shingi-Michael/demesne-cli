import { expect, test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import { eventually, fixture } from "./fixture.ts";

for (const home of ["plain", "project"] as const) {
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
