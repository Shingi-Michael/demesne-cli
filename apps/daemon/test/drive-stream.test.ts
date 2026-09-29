import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DrivePlanningError, type DriveProgress, type DriveRequest } from "@demesne/protocol";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { createDaemonApp } from "../src/app.ts";
import { serveDaemon } from "../src/http-server.ts";
import type { TurnProcessor } from "../src/processor.ts";

async function fixture(processor: TurnProcessor) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "drive-stream-")));
  mkdirSync(join(root, "project")); mkdirSync(join(root, "data"));
  const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), processor, authToken: "test-token" });
  const client = new DemesneClient({ server: "http://localhost", token: "test-token", fetch: ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url, init)))) as typeof fetch });
  const session = (await client.createSession({ title: "Review", workspacePath: join(root, "project") })).session;
  const request: DriveRequest = { mission: "Review", homeSessionId: session.id, memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] },
    observation: { id: "screen", sessionId: session.id, workspace: session.workspace!.root, title: "Review", mode: "input", ready: true, draft: "", surface: "response", width: 100, height: 30, rows: ["Saved result"], controls: [] } };
  return { app, client, request, async close() { await app.close(); rmSync(root, { recursive: true, force: true }); } };
}
const action = JSON.stringify({ action: { kind: "key", key: "ctrl+b" }, note: "Read the execution log", notes: "Inspect recorded checks", completed: [], remaining: ["Review"], evidence: [] });

test("production HTTP survives cold prefill, queued JSON planning, and idle events beyond Bun's default timeout", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let calls = 0;
  const processor: TurnProcessor = { providerId: "test", modelId: "slow-local", async listModels() { return []; }, async *stream(_messages, _tools, signal) {
    calls++; entered.resolve(); await release.promise; signal.throwIfAborted();
    yield { type: "tool_call_delta", index: 0, idDelta: "call", nameDelta: "drive_ui", argumentsDelta: action };
    yield { type: "finish", reason: "tool_calls" };
  } };
  const f = await fixture(processor), server = serveDaemon(f.app, { hostname: "127.0.0.1", port: 0 });
  const client = new DemesneClient({ server: server.url.href, token: "test-token" });
  const controller = new AbortController();
  const eventsResponse = await fetch(new URL(`/v1/events?session_id=${f.request.homeSessionId}&after=0`, server.url), {
    headers: { authorization: "Bearer test-token" }, signal: controller.signal,
  });
  const eventReader = eventsResponse.body!.getReader();
  const events = (async () => { let text = ""; while (!text.includes(": heartbeat")) { const { value, done } = await eventReader.read(); if (done) throw new Error("Idle event stream closed"); text += new TextDecoder().decode(value); } return text; })();
  const progress: DriveProgress[] = [];
  const streamed = client.decideDrive(f.request, controller.signal, (event) => progress.push(event));
  // Attach rejection handlers immediately so a regression's early disconnect
  // is reported by the assertions rather than as an unhandled rejection.
  const streamResult = streamed.then((value) => ({ value }), (error: unknown) => ({ error }));
  const eventResult = events.then((value) => ({ value }), (error: unknown) => ({ error }));
  await entered.promise;
  const jsonResult = client.decideDrive(f.request, controller.signal).then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await Bun.sleep(16_000);
    expect(progress.map((event) => event.type)).toEqual(["queued", "attempt"]);
    expect(await client.status()).toMatchObject({ activeInferences: 1, queuedInferences: 1 });
    release.resolve();
    const streamed = await streamResult, json = await jsonResult, idle = await eventResult;
    expect("error" in streamed ? String(streamed.error) : null).toBeNull();
    expect("error" in json ? String(json.error) : null).toBeNull();
    expect("value" in streamed && streamed.value.decision.action.kind).toBe("key");
    expect("value" in json && json.value.decision.action.kind).toBe("key");
    expect("value" in idle && idle.value.includes(": heartbeat")).toBe(true);
    expect(calls).toBe(2); expect((await client.status()).activeInferences).toBe(0);
  } finally {
    release.resolve(); controller.abort(); await eventReader.cancel().catch(() => {});
    await Promise.all([streamResult, jsonResult, eventResult]); await server.stop(true); await f.close();
  }
}, 25_000);

test("production HTTP disconnect during silent prefill cancels planning and releases the slot", async () => {
  const entered = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
  const processor: TurnProcessor = { providerId: "test", modelId: "slow-local", async listModels() { return []; }, async *stream(_messages, _tools, signal) {
    entered.resolve();
    await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    stopped.resolve(); signal.throwIfAborted();
  } };
  const f = await fixture(processor), server = serveDaemon(f.app, { hostname: "127.0.0.1", port: 0 });
  const client = new DemesneClient({ server: server.url.href, token: "test-token" }), controller = new AbortController();
  const pending = client.decideDrive(f.request, controller.signal, () => {}).then(() => null, (error: unknown) => error);
  try {
    await entered.promise; controller.abort(); expect(await pending).toBeInstanceOf(Error); await stopped.promise;
    expect((await client.status()).activeInferences).toBe(0);
  } finally { controller.abort(); await pending; await server.stop(true); await f.close(); }
});

test("real Drive HTTP/client stream exposes thinking and drafts before a validated decision", async () => {
  const gate = Promise.withResolvers<void>(), thinking = Promise.withResolvers<void>();
  const processor: TurnProcessor = { providerId: "test", modelId: "model", maxOutputTokens: 131072, async listModels() { return []; }, async *stream(_messages, _tools, _signal, enabled) {
    expect(enabled).toBeUndefined();
    yield { type: "reasoning_delta", delta: "Inspect the recorded check first." };
    await gate.promise;
    yield { type: "text_delta", delta: "Opening the log." };
    yield { type: "tool_call_delta", index: 0, idDelta: "call", nameDelta: "drive_ui", argumentsDelta: action.slice(0, 30) };
    yield { type: "tool_call_delta", index: 0, idDelta: "", nameDelta: "", argumentsDelta: action.slice(30) };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
    yield { type: "finish", reason: "tool_calls" };
  } };
  const f = await fixture(processor), progress: DriveProgress[] = []; let settled = false;
  try {
    const pending = f.client.decideDrive(f.request, undefined, (event) => { progress.push(event); if (event.type === "reasoning.delta") thinking.resolve(); }).then((value) => { settled = true; return value; });
    await thinking.promise;
    expect(progress.map((event) => event.type)).toEqual(["queued", "attempt", "reasoning.delta"]);
    expect(settled).toBe(false); expect((await f.client.status()).activeInferences).toBe(1);
    gate.resolve(); const result = await pending;
    expect(result.decision.action).toEqual({ kind: "key", key: "ctrl+b" });
    expect(progress.flatMap((event) => event.type === "action.delta" ? [event.delta] : []).join("")).toBe(action);
    expect(progress.some((event) => event.type === "usage" && event.usage.outputTokens === 50)).toBe(true);
    expect((await f.client.status()).activeInferences).toBe(0);
  } finally { gate.resolve(); await f.close(); }
});

test("cancelling a Drive stream aborts inference and releases its scheduler slot", async () => {
  const started = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>();
  const processor: TurnProcessor = { providerId: "test", modelId: "model", async listModels() { return []; }, async *stream(_messages, _tools, signal) {
    yield { type: "reasoning_delta", delta: "Reading…" };
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    aborted.resolve(); signal.throwIfAborted();
  } };
  const f = await fixture(processor), controller = new AbortController();
  try {
    const pending = f.client.decideDrive(f.request, controller.signal, (event) => { if (event.type === "reasoning.delta") started.resolve(); });
    await started.promise; controller.abort();
    await expect(pending).rejects.toThrow(); await aborted.promise;
    expect((await f.client.status()).activeInferences).toBe(0);
  } finally { controller.abort(); await f.close(); }
});

test("streamed corrections expose both attempts and never return an invalid draft", async () => {
  let calls = 0;
  const processor: TurnProcessor = { providerId: "test", modelId: "model", async listModels() { return []; }, async *stream() {
    calls++;
    yield { type: "reasoning_delta", delta: calls === 1 ? "First attempt" : "Correcting the field" };
    yield { type: "tool_call_delta", index: 0, idDelta: "call", nameDelta: "drive_ui", argumentsDelta: calls === 1 ? '{"action":' : action };
    yield { type: "finish", reason: "tool_calls" };
  } };
  const f = await fixture(processor), progress: DriveProgress[] = [];
  try {
    expect((await f.client.decideDrive(f.request, undefined, (event) => progress.push(event))).decision.action.kind).toBe("key");
    expect(progress.filter((event) => event.type === "attempt").map((event) => event.attempt)).toEqual([1, 2]);
    expect(progress.find((event) => event.type === "correction")?.message).toContain("valid JSON");
  } finally { await f.close(); }
});

test("a disconnected planning stream is not silently retried as another decision", async () => {
  let calls = 0;
  const client = new DemesneClient({ server: "http://localhost", fetch: (async () => { calls++; return new Response('data: {"type":"reasoning.delta","delta":"Partial thought"}\n\n', { headers: { "Content-Type": "text/event-stream" } }); }) as unknown as typeof fetch });
  const events: DriveProgress[] = [];
  await expect(client.decideDrive({} as DriveRequest, undefined, (event) => events.push(event))).rejects.toThrow("before a validated decision");
  expect(calls).toBe(1); expect(events).toEqual([{ type: "reasoning.delta", delta: "Partial thought" }]);
});

test.each(["socket", "validation", "auth"])("Drive streams a classified %s failure to the controller without replaying inference", async (kind) => {
  let calls = 0;
  const processor: TurnProcessor = { providerId: "test", modelId: "model", async listModels() { return []; }, async *stream() {
    calls++;
    if (kind === "socket") throw new Error("The socket connection was closed unexpectedly.");
    if (kind === "auth") throw new Error("HTTP 401 Unauthorized");
    yield { type: "tool_call_delta", index: 0, idDelta: "bad", nameDelta: "drive_ui", argumentsDelta: '{"action":' };
    yield { type: "finish", reason: "tool_calls" };
  } };
  const f = await fixture(processor);
  try {
    const error = await f.client.decideDrive(f.request, undefined, () => {}).then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(DrivePlanningError);
    expect((error as DrivePlanningError).recovery).toBe(kind === "socket" ? "transient" : kind === "validation" ? "decision" : undefined);
    expect(calls).toBe(kind === "validation" ? 2 : 1);
    expect((await f.client.status()).activeInferences).toBe(0);
  } finally { await f.close(); }
});

test("cancelling the response body cancels inference even without a request abort", async () => {
  const aborted = Promise.withResolvers<void>();
  const processor: TurnProcessor = { providerId: "test", modelId: "model", async listModels() { return []; }, async *stream(_messages, _tools, signal) {
    yield { type: "reasoning_delta", delta: "Reading" };
    await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    aborted.resolve(); signal.throwIfAborted();
  } };
  const f = await fixture(processor);
  try {
    const response = await f.app.fetch(new Request("http://localhost/v1/drive/decide", { method: "POST", body: JSON.stringify(f.request),
      headers: { authorization: "Bearer test-token", accept: "text/event-stream", "content-type": "application/json" } }));
    const reader = response.body!.getReader();
    while (true) { const event = await reader.read(); if (event.done) throw new Error("Missing thinking"); if (new TextDecoder().decode(event.value).includes("reasoning.delta")) break; }
    await reader.cancel(); await aborted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await f.client.status()).activeInferences).toBe(0);
  } finally { await f.close(); }
});

test("daemon shutdown cancels streamed planning before closing its resources", async () => {
  const started = Promise.withResolvers<void>(); let aborted = false;
  const processor: TurnProcessor = { providerId: "test", modelId: "model", async listModels() { return []; }, async *stream(_messages, _tools, signal) {
    yield { type: "reasoning_delta", delta: "Inspecting" };
    await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    aborted = signal.aborted; signal.throwIfAborted();
  } };
  const f = await fixture(processor);
  try {
    const pending = f.client.decideDrive(f.request, undefined, (event) => { if (event.type === "reasoning.delta") started.resolve(); });
    const stopped = pending.then(() => null, (error: unknown) => error);
    await started.promise; await f.app.close();
    expect(await stopped).toBeInstanceOf(Error);
    expect(aborted).toBe(true);
  } finally { await f.close(); }
});
