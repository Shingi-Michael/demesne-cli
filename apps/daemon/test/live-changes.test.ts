import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@demesne/protocol";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";
import { restoreSessionEntries, replaySession } from "../../cli/src/workbench/history.ts";
import type { WorkbenchEntry, ToolEntry } from "../../cli/src/workbench/entries.ts";

// The turn's tool entries, in order (one turn per session here).
const toolsOf = (entries: WorkbenchEntry[]) => entries.filter((entry): entry is ToolEntry => entry.type === "tool");

test.each(["applied", "denied", "truncated", "cancelled"] as const)("streamed edits remain display-only until validated and approved: %s", async (outcome) => {
  const root = mkdtempSync(join(tmpdir(), "demesne-live-changes-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace); mkdirSync(join(root, "data"));
  const gate = Promise.withResolvers<void>();
  let round = 0;
  const requests: unknown[] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "test", async listModels() { return []; },
    async *stream(messages, _tools, signal) {
      requests.push(structuredClone(messages));
      if (++round === 1) {
        yield { type: "tool_call_delta", index: 0, idDelta: "create", nameDelta: "write_file", argumentsDelta: '{"path":"a.ts","content":"const a = ' };
        await gate.promise; signal.throwIfAborted();
        yield { type: "tool_call_delta", index: 0, idDelta: "", nameDelta: "", argumentsDelta: '1;\\n"}' };
        yield { type: "finish", reason: outcome === "truncated" ? "length" : "tool_calls" };
      } else if (outcome === "applied" && round < 5) {
        const operation = round === 2 ? { name: "edit_file", input: { path: "a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] } }
          : round === 3 ? { name: "move_path", input: { from: "a.ts", to: "renamed.ts" } }
          : { name: "delete_path", input: { path: "renamed.ts" } };
        yield { type: "tool_call_delta", index: 0, idDelta: `operation-${round}`, nameDelta: operation.name, argumentsDelta: JSON.stringify(operation.input) };
        yield { type: "finish", reason: "tool_calls" };
      } else { yield { type: "text_delta", delta: "Finished." }; yield { type: "finish", reason: "stop" }; }
    } };
  const options = { databasePath: join(root, "data/state.sqlite"), processor };
  let app = createDaemonApp(options);
  const client = new DemesneClient({ server: "http://localhost", fetch: ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url, init)))) as typeof fetch });
  try {
    const { session } = await client.createSession({ title: "Live diff", workspacePath: workspace });
    const submitted = await client.submitTurn(session.id, { content: "Create a.ts, edit it, rename it, then delete it", permissionMode: "ask" });
    const events: EventEnvelope[] = [];
    let observedDraft = false;
    for await (const event of client.streamEvents(session.id, submitted.eventId, AbortSignal.timeout(5000))) {
      events.push(event);
      if (event.type === "tool.call_draft" && !observedDraft) {
        observedDraft = true;
        expect(existsSync(join(workspace, "a.ts"))).toBe(false);
        expect(event.payload.delta).toContain("const a = ");
        const pending = await client.getSessionState(session.id);
        const packed = await replaySession(pending, (id, after, signal) => client.streamEvents(id, after, signal), (id, after, through, signal) => client.replayPage(id, after, through, signal));
        expect(toolsOf(restoreSessionEntries(pending, packed))[0]).toMatchObject({ drafting: true, state: "running", diff: { newText: "const a = " } });
        if (outcome === "cancelled") await client.cancelTurn(submitted.turn.id);
        gate.resolve();
      }
      if (event.type === "permission.requested") {
        if (round === 1) expect(existsSync(join(workspace, "a.ts"))).toBe(false);
        await client.resolvePermission(String(event.payload.permissionId), outcome === "denied" ? "deny" : "allow_once");
      }
      if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) break;
    }
    expect(observedDraft).toBe(true);
    const snapshot = await client.getSessionState(session.id);
    const entries = restoreSessionEntries(snapshot, events);
    const tools = toolsOf(entries);
    expect(tools).toHaveLength(outcome === "applied" ? 4 : 1);
    if (outcome === "applied") {
      expect(events.filter((event) => event.type === "tool.call_completed")).toHaveLength(4);
      expect(tools[0]?.changes?.[0]).toMatchObject({ before: null, after: "const a = 1;\n", beforeExists: false, afterExists: true });
      expect(tools[1]?.changes?.[0]).toMatchObject({ before: "const a = 1;\n", after: "const a = 2;\n" });
      expect(tools[2]?.changes).toEqual([
        { path: "a.ts", before: "const a = 2;\n", after: null, beforeExists: true, afterExists: false },
        { path: "renamed.ts", before: null, after: "const a = 2;\n", beforeExists: false, afterExists: true },
      ]);
      expect(tools[3]?.changes?.[0]).toMatchObject({ before: "const a = 2;\n", after: null, afterExists: false });
      expect(existsSync(join(workspace, "a.ts"))).toBe(false);
      expect(existsSync(join(workspace, "renamed.ts"))).toBe(false);
      expect(JSON.stringify(requests)).not.toContain("draftSent");
      expect(JSON.stringify(requests)).not.toContain("draftId");
      // Replay is immutable even after unrelated changes on disk and restart.
      writeFileSync(join(workspace, "a.ts"), "Later unrelated content");
    } else {
      expect(tools[0]?.state).toBe(outcome === "truncated" ? "failed" : outcome === "cancelled" ? "stopped" : "denied");
      expect(tools[0]?.changes).toBeUndefined();
      expect(existsSync(join(workspace, "a.ts"))).toBe(false);
      expect(events.some((event) => event.type === "tool.call_completed")).toBe(false);
    }
    await app.close(); app = createDaemonApp(options);
    const packed = await replaySession(snapshot, (id, after, signal) => client.streamEvents(id, after, signal), (id, after, through, signal) => client.replayPage(id, after, through, signal));
    expect(restoreSessionEntries(snapshot, packed)).toEqual(entries);
  } finally { gate.resolve(); await app.close(); rmSync(root, { recursive: true, force: true }); }
});
