import { describe, expect, test } from "bun:test";
import { encodeServerSentEvent, readServerSentEvents, type EventEnvelope } from "../src/index.ts";

describe("readServerSentEvents", () => {
  test("decodes CRLF framing split at every byte boundary", async () => {
    const event: EventEnvelope = {
      schemaVersion: 1,
      eventId: 42,
      type: "turn.completed",
      occurredAt: "2026-08-23T00:00:00Z",
      workspaceId: null,
      sessionId: "session",
      turnId: "turn",
      agentRunId: null,
      payload: {},
    };
    const bytes = new TextEncoder().encode(encodeServerSentEvent(event).replaceAll("\n", "\r\n"));

    for (let split = 1; split < bytes.length; split += 1) {
      const response = new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split));
          controller.close();
        },
      }));
      const received = [];
      for await (const value of readServerSentEvents(response)) received.push(value);
      expect(received).toEqual([event]);
    }
  });

  test("accepts mixed SSE line endings", async () => {
    const event: EventEnvelope = {
      schemaVersion: 1,
      eventId: 1,
      type: "turn.completed",
      occurredAt: "2026-08-23T00:00:00Z",
      workspaceId: null,
      sessionId: "session",
      turnId: "turn",
      agentRunId: null,
      payload: {},
    };
    const data = `id: 1\r\nevent: turn.completed\ndata: ${JSON.stringify(event)}\n\r`;
    const received = [];
    for await (const value of readServerSentEvents(new Response(data))) received.push(value);
    expect(received).toEqual([event]);
  });

  test("keeps CRLF data lines inside one event", async () => {
    const event: EventEnvelope = {
      schemaVersion: 1,
      eventId: 2,
      type: "turn.completed",
      occurredAt: "2026-08-23T00:00:00Z",
      workspaceId: null,
      sessionId: "session",
      turnId: "turn",
      agentRunId: null,
      payload: { result: "complete" },
    };
    const data = JSON.stringify(event, null, 2)
      .split("\n")
      .map((line) => `data: ${line}`)
      .join("\r\n") + "\r\n\r\n";
    const received = [];
    for await (const value of readServerSentEvents(new Response(data))) received.push(value);
    expect(received).toEqual([event]);
  });
});
