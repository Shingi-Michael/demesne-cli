import { expect, test } from "bun:test";
import type { EventEnvelope, SessionStateResponse } from "@demesne/protocol";
import { WorkspaceSession } from "../session-model.ts";

const at = "2026-10-01T12:00:00Z";
const state: SessionStateResponse = {
  session: { id: "s", title: "Sub-agents", createdAt: at, updatedAt: at, workspace: null,
    turns: [{ id: "t", sessionId: "s", content: "Where is restore?", responseText: "", status: "running", createdAt: at, completedAt: null, permissionMode: "ask", thinkingEnabled: true }] },
  lastEventId: 0, pendingPermissions: [], latestProviderCall: null,
};
let id = 0;
const event = (type: EventEnvelope["type"], payload: Record<string, unknown>): EventEnvelope =>
  ({ schemaVersion: 1, eventId: ++id, type, payload, sessionId: "s", turnId: "t", workspaceId: null, agentRunId: null, occurredAt: at });

test("the workspace session keeps a sub-agent's steps and report from progress events, never its thinking", () => {
  const session = new WorkspaceSession(state);
  session.apply(event("tool.call_requested", { toolCallId: "a", name: "subagent", arguments: JSON.stringify({ description: "Find restore", prompt: "Where?" }) }));
  session.apply(event("tool.call_progress", { toolCallId: "a", text: "qwen3.8-27b · starting" }));
  // An event recorded before thinking was turned off for sub-agents.
  session.apply(event("tool.call_progress", { toolCallId: "a", thinking: "Read the history module." }));
  session.apply(event("tool.call_progress", { toolCallId: "a", text: "qwen3.8-27b · read history.ts" }));
  session.apply(event("tool.call_progress", { toolCallId: "a", text: "qwen3.8-27b · writing report" }));
  session.apply(event("tool.call_progress", { toolCallId: "a", report: "Restore runs through history.ts." }));
  const tool = session.runs()[0]!.entries.find((entry) => entry.type === "tool");
  expect(tool?.type === "tool" ? [tool.trace, tool.report, tool.subagentModel] : undefined).toEqual([
    [{ kind: "step", text: "qwen3.8-27b · read history.ts" }],
    "Restore runs through history.ts.",
    "qwen3.8-27b",
  ]);
});
