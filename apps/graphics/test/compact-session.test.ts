import { expect, test } from "bun:test";
import { GraphicsHost } from "../host.ts";
import { fixture, eventually } from "./fixture.ts";

test("desktop compact action preserves a draft and shows the compaction turn", async () => {
  const f = await fixture();
  const host = new GraphicsHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {} });
  try {
    await host.connect();
    host.draft = "Keep my unfinished request";
    await host.handle("compact", { sessionId: host.current!.session.id });
    await eventually(() => host.snapshot().runs.at(-1)?.status === "completed");
    expect(host.snapshot().runs.at(-1)?.kind).toBe("compaction");
    expect(host.draft).toBe("Keep my unfinished request");
  } finally { host.dispose(); await f.close(); }
});

test("desktop refuses compaction while a conversation turn is active", async () => {
  const ready = Promise.withResolvers<void>();
  const f = await fixture({ providerId: "test", modelId: "test", async listModels() { return []; },
    async *stream(_messages, _tools, signal) {
      ready.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  const host = new GraphicsHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {} });
  try {
    await host.connect();
    await host.submit("Work");
    await ready.promise;
    await expect(host.handle("compact", { sessionId: host.current!.session.id })).rejects.toThrow("Wait for the current turn");
    expect(host.snapshot().runs.some(run => run.kind === "compaction")).toBe(false);
  } finally { host.dispose(); await f.close(); }
});
test("completed compaction updates the live context meter to the saved plan without reopening", async () => {
  const summary = JSON.stringify({ schemaVersion: 1, goal: "Keep working", currentState: "Earlier work summarized", constraints: [], decisions: [], files: [], validation: [], unresolved: [] });
  const f = await fixture({ providerId: "test", modelId: "test", contextCapacity: 262144, maxOutputTokens: 1024,
    async listModels() { return []; },
    async *stream(messages) {
      const compacting = messages[0]?.content?.includes("immutable coding-session checkpoints");
      yield { type: "text_delta", delta: compacting ? summary : "Earlier evidence. ".repeat(1200) };
      yield { type: "finish", reason: "stop" };
      yield { type: "usage", usage: { inputTokens: 18000, outputTokens: 100, totalTokens: 18100 } };
    },
  });
  const host = new GraphicsHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {} });
  try {
    await host.connect();
    for (let i = 0; i < 5; i++) {
      await host.submit(`Work ${i}`);
      await eventually(() => host.snapshot().runs.at(-1)?.status === "completed");
    }
    const previousRuns = host.snapshot().runs.map(run => run.id);
    await host.handle("compact", { sessionId: host.current!.session.id });
    await eventually(() => host.snapshot().runs.at(-1)?.status === "completed");
    const live = host.snapshot(), saved = await f.client.getSessionState(host.current!.session.id);
    expect(live.checkpoint).not.toBeNull();
    expect(live.checkpoint!.afterTokens).toBeLessThan(live.checkpoint!.beforeTokens);
    expect(live.provider!.contextPlan).toEqual(saved.latestProviderCall!.contextPlan);
    expect(live.provider!.contextPlan!.estimatedInputTokens).toBe(live.checkpoint!.afterTokens);
    expect(live.provider!.usage!.inputTokens).toBe(18000); // Keep actual request accounting separate.
    expect(live.runs.slice(0, -1).map(run => run.id)).toEqual(previousRuns);
  } finally { host.dispose(); await f.close(); }
});
