import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServerSentEvents } from "@demesne/protocol";
import { ChatGPTProvider } from "@demesne/providers";
import { createDaemonApp } from "../src/app.ts";
import { ProviderTurnProcessor } from "../src/provider-processor.ts";
import { responseStream, reasoning } from "../../../packages/providers/test/chatgpt-fixture.ts";

for (const terminalOutput of ["full", "empty"] as const) for (const interrupted of [false, true]) test(`ChatGPT engine (${terminalOutput} terminal output) ${interrupted ? "rejects interrupted tools without executing them" : "executes a tool then persists reasoning across daemon restarts"}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-chatgpt-engine-")), workspace = join(root, "workspace"), databasePath = join(root, "data/state.sqlite");
  mkdirSync(join(root, "data")); mkdirSync(workspace); writeFileSync(join(workspace, "input.txt"), "Tool result");
  const bodies: any[] = [];
  const provider = new ChatGPTProvider({ accountId: "a", accessToken: async () => "mock-access", fetch: (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return responseStream({ tool: bodies.length === 1, complete: !interrupted, terminalOutput });
  }) as typeof fetch });
  const options = { databasePath, processor: new ProviderTurnProcessor(provider, "model-fixture", { maxOutputTokens: 1536 }, undefined, 32768) };
  let app = createDaemonApp(options);
  const post = async (path: string, body: unknown) => { const r = await app.fetch(new Request("http://localhost" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); if (!r.ok) throw new Error(await r.text()); return r.json(); };
  const finish = async (id: string, after: number) => {
    const events = await app.fetch(new Request(`http://localhost/v1/events?session_id=${id}&after=${after}`, { signal: AbortSignal.timeout(5000) }));
    const seen = [];
    for await (const event of readServerSentEvents(events)) { seen.push(event); if (["turn.completed", "turn.failed"].includes(event.type)) break; }
    return seen;
  };
  try {
    const { session } = await post("/v1/sessions", { title: "ChatGPT", workspacePath: workspace, trustWorkspace: true });
    const { eventId } = await post(`/v1/sessions/${session.id}/turns`, { content: "Read input.txt" });
    const events = await finish(session.id, eventId);
    expect(events.at(-1)?.type).toBe(interrupted ? "turn.failed" : "turn.completed");
    if (interrupted) { expect(events.some(e => e.type === "tool.call_completed")).toBe(false); expect(bodies).toHaveLength(1); }
    else {
      expect(bodies).toHaveLength(2); expect(bodies[1].input).toContainEqual(reasoning); expect(bodies[1].input.some((i: any) => i.type === "function_call_output" && String(i.output).includes("Tool result"))).toBe(true);
      await app.close(); app = createDaemonApp(options);
      const { eventId: after } = await post(`/v1/sessions/${session.id}/turns`, { content: "What did you inspect?" });
      expect((await finish(session.id, after)).at(-1)?.type).toBe("turn.completed");
      expect(bodies[2].input).toContainEqual(reasoning);
      expect(JSON.stringify(events)).not.toContain("opaque-reasoning"); expect(JSON.stringify(events)).not.toContain("mock-access");
    }
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
