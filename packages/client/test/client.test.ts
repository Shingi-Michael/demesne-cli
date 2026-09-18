import { describe, expect, test } from "bun:test";
import { encodeServerSentEvent, PROTOCOL_VERSION, type EventEnvelope } from "@demesne/protocol";
import { ApiRequestError, DemesneClient } from "../src/index.ts";

interface RecordedCall {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(handler: (call: RecordedCall) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const call: RecordedCall = {
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function envelope(eventId: number, type: EventEnvelope["type"] = "model.request_started"): EventEnvelope {
  return {
    schemaVersion: PROTOCOL_VERSION,
    eventId,
    type,
    occurredAt: "2026-01-01T00:00:00.000Z",
    workspaceId: null,
    sessionId: "session-1",
    turnId: "turn-1",
    agentRunId: null,
    payload: {},
  };
}

describe("DemesneClient typed methods", () => {
  test("maps methods to routes with auth and JSON bodies", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.path === "/healthz") return json({ status: "ok", provider: "llama.cpp", model: "local", version: "0.1.0" });
      if (call.path === "/v1/models") return json({ models: [{ id: "local", provider: "llama.cpp" }] });
      if (call.path === "/v1/model") return json({ status: "ok", model: "local" });
      if (call.path === "/v1/runtime") return json({ profile: null, state: "unconfigured", expected: null, observed: null, mismatches: [], observedAt: null });
      if (call.path === "/v1/sessions?query=fix") return json({ sessions: [{ id: "s1" }] });
      if (call.path === "/v1/sessions") return json({ sessions: [] });
      if (call.path === "/v1/sessions/s1") return json({ session: { id: "s1" }, eventId: 1 });
      if (call.path === "/v1/sessions/s1/turns") return json({ turn: { id: "t1" }, eventId: 2 });
      if (call.path === "/v1/turns/t1/cancel") return json({ turn: { id: "t1" }, eventId: 3 });
      if (call.path === "/v1/permissions/p1") return json({ permissionId: "p1", decision: "deny" });
      if (call.path === "/v1/sessions/s1/undo") return json({ turnId: "t1", files: [], complete: true });
      if (call.path === "/v1/sessions/s1/changes") return json({ turnId: "t1", changes: [] });
      if (call.path === "/v1/sessions/s1/files") return json({ files: ["src/a.ts"] });
      return json({ error: { code: "not_found", message: `no route for ${call.path}` } }, 404);
    });
    const client = new DemesneClient({ server: "http://127.0.0.1:7337", token: "secret", fetch });

    expect(await client.health()).toMatchObject({ status: "ok", version: "0.1.0" });
    expect(await client.listModels()).toEqual([{ id: "local", provider: "llama.cpp" }]);
    await client.setModel("local");
    expect((await client.listSessions("fix")).map((session) => session.id)).toEqual(["s1"]);
    await client.updateSession("s1", { title: "Renamed" });
    expect(await client.listWorkspaceFiles("s1")).toEqual(["src/a.ts"]);
    await client.submitTurn("s1", { content: "hello", permissionMode: "deny", planOnly: true });
    await client.cancelTurn("t1");
    await client.resolvePermission("p1", "allow_once");
    await client.undo("s1", { paths: ["a.ts"] });
    await client.changes("s1");

    expect(calls.find((call) => call.path === "/v1/model")).toMatchObject({
      method: "POST",
      body: { model: "local" },
    });
    expect(calls.find((call) => call.path === "/v1/sessions/s1/turns")).toMatchObject({
      method: "POST",
      body: { content: "hello", permissionMode: "deny", planOnly: true },
    });
    expect(calls.find((call) => call.path === "/v1/sessions/s1/undo")).toMatchObject({
      body: { paths: ["a.ts"] },
    });
    expect(calls.every((call) => call.headers.authorization === "Bearer secret")).toBe(true);
  });

  test("returns raw export text and maps errors", async () => {
    const { fetch } = mockFetch((call) => {
      if (call.path.startsWith("/v1/sessions/s1/export")) return new Response("# Title\n", { status: 200 });
      return json({ error: { code: "invalid_state", message: "not now" } }, 409);
    });
    const client = new DemesneClient({ server: "http://127.0.0.1:7337", fetch });
    expect(await client.exportSession("s1", "md")).toBe("# Title\n");

    try {
      await client.getSessionState("s1");
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError);
      expect(error).toMatchObject({ status: 409, code: "invalid_state", message: "not now" });
    }
  });
});

describe("DemesneClient event stream", () => {
  test("yields events and stops when aborted", async () => {
    const controller = new AbortController();
    let eventRequests = 0;
    const { fetch, calls } = mockFetch((call) => {
      if (!call.path.startsWith("/v1/events")) return json({}, 404);
      eventRequests += 1;
      if (eventRequests === 1) {
        return new Response(encodeServerSentEvent(envelope(4)), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(": connected\n\n", { headers: { "Content-Type": "text/event-stream" } });
    });
    const client = new DemesneClient({
      server: "http://127.0.0.1:7337",
      fetch,
      sleep: async () => {},
    });

    const received: EventEnvelope[] = [];
    for await (const event of client.streamEvents("session-1", 3, controller.signal)) {
      received.push(event);
      controller.abort();
    }

    expect(received.map((event) => event.eventId)).toEqual([4]);
    const first = calls.find((call) => call.path.startsWith("/v1/events"))!;
    expect(first.path).toBe("/v1/events?session_id=session-1&after=3");
    expect(first.headers["last-event-id"]).toBe("3");
  });

  test("retries transient failures with backoff and resumes from the cursor", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const { fetch, calls } = mockFetch(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection reset");
      if (attempts === 2) {
        return new Response(encodeServerSentEvent(envelope(9)), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(": connected\n\n", { headers: { "Content-Type": "text/event-stream" } });
    });
    const client = new DemesneClient({
      server: "http://127.0.0.1:7337",
      fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
      retry: { initialDelayMs: 25, maxDelayMs: 50 },
    });

    const received: EventEnvelope[] = [];
    for await (const event of client.streamEvents("session-1", 0)) {
      received.push(event);
      break;
    }

    expect(received.map((event) => event.eventId)).toEqual([9]);
    expect(delays[0]).toBe(25);
    expect(calls[1]!.path).toBe("/v1/events?session_id=session-1&after=0");
  });

  test("treats 4xx responses as terminal", async () => {
    const { fetch } = mockFetch(() => json({ error: { code: "not_found", message: "nope" } }, 404));
    const client = new DemesneClient({ server: "http://127.0.0.1:7337", fetch, sleep: async () => {} });
    const consume = async () => {
      for await (const _event of client.streamEvents("missing")) {
        // No events are expected.
      }
    };
    await expect(consume()).rejects.toThrow("404");
  });
});
