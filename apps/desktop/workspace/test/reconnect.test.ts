import { describe, expect, test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import type { DemesneClient } from "@demesne/client";
import { loadCliSettings } from "@demesne/setup/cli-config.ts";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

    // An empty home: a real config with auto_start = "always" (as on a Mac
    // running Demesne) would swap in a client for the live daemon.
    // auto_start = "never" keeps the app from starting a real daemon here.
    const home = mkdtempSync(join(tmpdir(), "demesne-reconnect-"));
    mkdirSync(join(home, ".demesne"));
    writeFileSync(join(home, ".demesne", "config.toml"), '[daemon]\nauto_start = "never"\n');
    const host = new WorkspaceHost({
      client: fakeClient,
      settings: loadCliSettings({ home, env: {}, workspaceRoot: home, includeProject: false }),
      workspace: home,
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

  test("waits for a daemon a scheduled task owns instead of starting one, whatever auto_start says", async () => {
    const fakeClient = {
      server: "http://127.0.0.1:7337",
      health: async () => { throw new Error("Connection refused"); },
    } as unknown as DemesneClient;
    const home = mkdtempSync(join(tmpdir(), "demesne-managed-"));
    mkdirSync(join(home, ".demesne"));
    writeFileSync(join(home, ".demesne", "config.toml"), '[daemon]\nauto_start = "always"\n');
    writeFileSync(join(home, ".demesne", "daemon.managed"), "the scheduled task \\Demesne\\demesned\n");
    const settings = loadCliSettings({ home, env: {}, workspaceRoot: home, includeProject: false });
    const host = new WorkspaceHost({ client: fakeClient, settings, workspace: home, home: "plain", headless: true, changed: () => {} });
    await host.connect();
    expect(host.connection).toBe("offline");
    expect(host.error).toContain("the scheduled task \\Demesne\\demesned runs the daemon");
    // Nothing was spawned: no pid file, no daemon log.
    expect(existsSync(join(settings.dataDirectory, "daemon.pid"))).toBe(false);
    expect(existsSync(join(settings.dataDirectory, "daemon.log"))).toBe(false);
    host.dispose();
  });

  test("Restart the daemon waits for the task's daemon to come back instead of starting its own", async () => {
    // No pid file and no lock: stopping finds nothing to stop, and the
    // daemon answers again on the third health check, as the task brings it back.
    let healthCalls = 0;
    const fakeClient = {
      server: "http://127.0.0.1:7337",
      health: async () => {
        healthCalls++;
        if (healthCalls >= 2 && healthCalls <= 3) throw new Error("Connection refused");
        return { model: "qwen3-4b", provider: "local", contextCapacity: 65536, reasoning: undefined };
      },
      themes: async () => ({ version: 1, selected: { name: "demesne-dark", roles: {} }, custom: [], installed: [], system: { enabled: false, path: "" } }),
      listSessions: async () => [],
      createSession: async () => ({ session: { id: "s1" } }),
      getSessionState: async () => ({ session: { id: "s1", workspace: null, turns: [] }, events: [], pendingPermissions: [], userQuestions: [], checkpoints: [] }),
      events: async function* () {},
      streamEvents: async function* () {},
      // What Settings shows after the restart.
      trusted: async () => ({ trusted: [] }),
      subagentModel: async () => ({ model: null }),
    } as unknown as DemesneClient;
    const home = mkdtempSync(join(tmpdir(), "demesne-managed-restart-"));
    mkdirSync(join(home, ".demesne"));
    writeFileSync(join(home, ".demesne", "config.toml"), 'server = "http://127.0.0.1:9"\n[daemon]\nauto_start = "always"\n');
    writeFileSync(join(home, ".demesne", "daemon.managed"), "the scheduled task \\Demesne\\demesned\n");
    // A closed port: stopping must never find a real daemon on this machine (7337 on a Mac running Demesne).
    const settings = loadCliSettings({ home, env: {}, workspaceRoot: home, includeProject: false });
    const host = new WorkspaceHost({ client: fakeClient, settings, workspace: home, home: "plain", headless: true, changed: () => {} });
    await host.connect();
    expect(host.connection).toBe("online");
    await host.handle("restart-daemon", { sessionId: "s1" });
    expect(host.connection).toBe("online");
    expect(healthCalls).toBeGreaterThanOrEqual(4);
    expect(existsSync(join(settings.dataDirectory, "daemon.pid"))).toBe(false);
    expect(existsSync(join(settings.dataDirectory, "daemon.log"))).toBe(false);
    host.dispose();
  });
});
