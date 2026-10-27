import { describe, expect, test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import type { DemesneClient } from "@demesne/client";

describe("WorkspaceHost reconnect", () => {
  test("automatically schedules reconnect when daemon is offline and recovers", async () => {
    let connectCalls = 0;
    const fakeClient = {
      server: "http://127.0.0.1:7337",
      health: async () => {
        connectCalls++;
        if (connectCalls === 1) {
          throw new Error("Connection refused");
        }
        return {
          model: "fake-model",
          provider: "fake-provider",
          contextCapacity: 8000,
          reasoning: undefined,
        };
      },
      themes: async () => ({
        version: 1,
        selected: { name: "demesne-dark", roles: {} },
        custom: [],
        installed: [],
        system: { enabled: false, path: "" },
      }),
      listSessions: async () => [],
      createSession: async () => ({ session: { id: "s1" } }),
      getSessionState: async () => ({
        session: { id: "s1", workspace: null, turns: [] },
        events: [],
        pendingPermissions: [],
        userQuestions: [],
        checkpoints: [],
      }),
      events: async function* () {},
    } as unknown as DemesneClient;

    const host = new WorkspaceHost({
      client: fakeClient,
      workspace: process.cwd(),
      home: "plain",
      headless: true,
      changed: () => {},
    });

    // Initial connect fails
    await host.connect();
    expect(host.connection).toBe("offline");

    // Wait for the reconnect timer (1500ms + margin)
    await new Promise((r) => setTimeout(r, 1700));

    expect(connectCalls).toBeGreaterThanOrEqual(2);
    expect(host.connection).toBe("online");

    host.dispose();
  });
});
