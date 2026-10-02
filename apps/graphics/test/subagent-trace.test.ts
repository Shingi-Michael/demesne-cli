import { expect, test } from "bun:test";
import type { EventEnvelope, SessionStateResponse } from "@demesne/protocol";
import { GraphicsSession } from "../session-model.ts";

const at = "2026-10-01T12:00:00Z";
const state: SessionStateResponse = {
  session: { id: "s", title: "Sub-agents", createdAt: at, updatedAt: at, workspace: null,
    turns: [{ id: "t", sessionId: "s", content: "Where is restore?", responseText: "", status: "running", createdAt: at, completedAt: null, permissionMode: "ask", thinkingEnabled: true }] },
  lastEventId: 0, pendingPermissions: [], latestProviderCall: null,
};
let id = 0;
const event = (type: EventEnvelope["type"], payload: Record<string, unknown>): EventEnvelope =>
  ({ schemaVersion: 1, eventId: ++id, type, payload, sessionId: "s", turnId: "t", workspaceId: null, agentRunId: null, occurredAt: at });

test("the graphics session builds a live sub-agent trace from progress events", () => {
  const session = new GraphicsSession(state);
  session.apply(event("tool.call_requested", { toolCallId: "a", name: "subagent", arguments: JSON.stringify({ description: "Find restore", prompt: "Where?" }) }));
  session.apply(event("tool.call_progress", { toolCallId: "a", thinking: "Read the history module." }));
  session.apply(event("tool.call_progress", { toolCallId: "a", text: "read history.ts" }));
  const tool = session.runs()[0]!.entries.find((entry) => entry.type === "tool");
  expect(tool?.type === "tool" ? tool.trace : undefined).toEqual([
    { kind: "thinking", text: "Read the history module." },
    { kind: "step", text: "read history.ts" },
  ]);
});
