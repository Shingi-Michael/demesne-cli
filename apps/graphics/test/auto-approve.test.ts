import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope, SessionStateResponse } from "@demesne/protocol";
import { GraphicsHost } from "../host.ts";
import { GraphicsSession } from "../session-model.ts";
import { fixture, eventually } from "./fixture.ts";

const hostFor = (f: Awaited<ReturnType<typeof fixture>>) => new GraphicsHost({
  workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {},
});

test("session auto-approve releases the current approval and follows selection, SSE and reconnect", async () => {
  let round = 0;
  const prompt = "Create an approved fixture file";
  const f = await fixture({
    providerId: "test", modelId: "test", async listModels() { return []; },
    async *stream(messages) {
      if (messages.findLast(message => message.role === "user")?.content !== prompt) {
        yield { type: "text_delta", delta: '{"proposals":[]}' };
        yield { type: "finish", reason: "stop" }; return;
      }
      if (++round === 1) {
        yield { type: "tool_call_delta", index: 0, idDelta: "write", nameDelta: "write_file",
          argumentsDelta: JSON.stringify({ path: "approved.txt", content: "Approved in this session.\n" }) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Created the fixture." };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  let host = hostFor(f);
  try {
    await host.connect();
    const first = host.current!.session.id;
    expect(host.snapshot().session?.autoApprove).toBe(false);
    await host.submit(prompt);
    await eventually(() => host.current!.approvals.size === 1);
    expect(existsSync(join(f.workspace, "approved.txt"))).toBe(false);
    await host.handle("auto-approve", { sessionId: first, autoApprove: true });
    await eventually(() => host.current!.runs().at(-1)?.status === "completed" && host.current!.approvals.size === 0);
    expect(readFileSync(join(f.workspace, "approved.txt"), "utf8")).toBe("Approved in this session.\n");
    expect(host.snapshot().session?.autoApprove).toBe(true);

    const second = await host.newSession();
    expect(host.snapshot().session?.autoApprove).toBe(false);
    await expect(host.handle("auto-approve", { sessionId: first, autoApprove: false })).rejects.toThrow("session changed");
    expect((await f.client.getSessionState(first)).session.autoApprove).toBe(true);
    expect((await f.client.getSessionState(second)).session.autoApprove).toBe(false);
    await host.select(first);
    expect(host.snapshot().session?.autoApprove).toBe(true);

    // Another connected client changes the preference: this view follows SSE.
    await f.client.updateSession(first, { autoApprove: false });
    await eventually(() => host.snapshot().session?.autoApprove === false);
    await f.client.updateSession(first, { autoApprove: true });
    await eventually(() => host.snapshot().session?.autoApprove === true);
    host.dispose();
    host = hostFor(f);
    await host.connect(); await host.select(first);
    expect(host.snapshot().session?.autoApprove).toBe(true);
    await host.select(second);
    expect(host.snapshot().session?.autoApprove).toBe(false);
  } finally { host.dispose(); await f.close(); }
});

test("Drive cannot change approvals, malformed toggles fail, and an in-flight toggle cannot alter another selected session", async () => {
  const f = await fixture(), host = hostFor(f);
  try {
    await host.connect();
    const first = host.current!.session.id;
    await expect(host.handle("auto-approve", { sessionId: first, autoApprove: true, driveCommand: "fake" })).rejects.toThrow("Only you");
    await expect(host.handle("auto-approve", { sessionId: first, autoApprove: "true" })).rejects.toThrow("Invalid");
    expect((await f.client.getSessionState(first)).session.autoApprove).toBe(false);
    const currentUpdate = f.client.updateSession.bind(f.client);
    f.client.updateSession = async () => {
      const state = await f.client.getSessionState(first);
      delete state.session.autoApprove;
      return { session: state.session, eventId: null };
    };
    await expect(host.handle("auto-approve", { sessionId: first, autoApprove: true })).rejects.toThrow("Restart Demesne");
    expect(host.snapshot().session?.autoApprove).toBe(false);
    f.client.updateSession = currentUpdate;
    const second = await host.newSession();
    await host.select(first);
    const gate = Promise.withResolvers<void>(), patched = Promise.withResolvers<void>();
    const update = f.client.updateSession.bind(f.client);
    f.client.updateSession = async (id, request) => {
      const result = await update(id, request);
      patched.resolve(); await gate.promise; return result;
    };
    const changing = host.handle("auto-approve", { sessionId: first, autoApprove: true });
    await patched.promise;
    await host.select(second);
    gate.resolve(); await changing;
    expect(host.snapshot().session).toMatchObject({ id: second, autoApprove: false });
    expect((await f.client.getSessionState(first)).session.autoApprove).toBe(true);
  } finally { host.dispose(); await f.close(); }
});

test("the session projection accepts only current permission changes in event order", () => {
  const at = "2026-10-05T12:00:00Z";
  const state: SessionStateResponse = {
    session: { id: "selected", title: "Selected", createdAt: at, updatedAt: at, workspace: null, turns: [] },
    lastEventId: 0, pendingPermissions: [], latestProviderCall: null,
  };
  const session = new GraphicsSession(state);
  const event = (eventId: number, sessionId: string, autoApprove: unknown): EventEnvelope => ({
    schemaVersion: 1, eventId, type: "session.permissions_changed", payload: { autoApprove }, sessionId,
    turnId: null, workspaceId: null, agentRunId: null, occurredAt: at,
  });
  expect(session.apply(event(1, "other", true))).toBe(false);
  expect(session.session.autoApprove).toBeUndefined();
  session.apply(event(2, "selected", true));
  expect(session.session.autoApprove).toBe(true);
  expect(session.apply(event(1, "selected", false))).toBe(false);
  session.apply(event(3, "selected", "false"));
  expect(session.session.autoApprove).toBe(true);
  session.apply(event(4, "selected", false));
  expect(session.session.autoApprove).toBe(false);
});
