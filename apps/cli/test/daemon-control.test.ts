import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonHealth,
  daemonStatus,
  ensureDaemon,
  readDaemonLog,
  resolveDaemonCommand,
  startDaemon,
  stopDaemon,
  type DaemonControlDependencies,
  type DaemonHealth,
} from "../src/daemon-control.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-daemon-control-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface FakeState {
  deps: DaemonControlDependencies;
  spawned: string[][];
  killed: number[];
  health: DaemonHealth | null;
  pendingHealth: DaemonHealth | null;
  alive: boolean;
  command: string[] | null;
}

function createFakeDependencies(dataDirectory: string): FakeState {
  const state: FakeState = {
    spawned: [],
    killed: [],
    health: null,
    pendingHealth: null,
    alive: false,
    command: ["demesned"],
    deps: undefined as unknown as DaemonControlDependencies,
  };
  state.deps = {
    server: "http://127.0.0.1:7337",
    dataDirectory,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/healthz" && state.health) {
        return new Response(JSON.stringify(state.health), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
    spawn: (command) => {
      state.spawned.push(command);
      state.alive = true;
      return { pid: 4242, unref: () => {} };
    },
    sleep: async () => {
      if (state.pendingHealth) {
        state.health = state.pendingHealth;
        state.pendingHealth = null;
      }
    },
    kill: (pid) => {
      state.killed.push(pid);
      state.health = null;
      state.alive = false;
    },
    isProcessAlive: () => state.alive,
    resolveCommand: () => state.command,
  };
  return state;
}

describe("daemonHealth", () => {
  test("returns null when the daemon is unreachable", async () => {
    const state = createFakeDependencies(temporaryDirectory());
    expect(await daemonHealth(state.deps)).toBeNull();
  });

  test("parses a healthy response including the version", async () => {
    const state = createFakeDependencies(temporaryDirectory());
    state.health = { status: "ok", provider: "llama.cpp", model: "local", version: "0.1.0" };
    expect(await daemonHealth(state.deps)).toEqual({
      status: "ok",
      provider: "llama.cpp",
      model: "local",
      version: "0.1.0",
    });
  });
});

describe("daemonStatus", () => {
  test("reports the pid file alongside health", async () => {
    const directory = temporaryDirectory();
    const state = createFakeDependencies(directory);
    writeFileSync(join(directory, "daemon.pid"), "1234\n");
    const status = await daemonStatus(state.deps);
    expect(status.running).toBe(false);
    expect(status.pid).toBe(1234);
  });
});

describe("startDaemon", () => {
  test("returns immediately when the daemon is already running", async () => {
    const state = createFakeDependencies(temporaryDirectory());
    state.health = { status: "ok", provider: "p", model: "m" };
    const result = await startDaemon(state.deps);
    expect(result.started).toBe(false);
    expect(result.message).toContain("already running");
    expect(state.spawned).toEqual([]);
  });

  test("fails with guidance when no binary can be found", async () => {
    const state = createFakeDependencies(temporaryDirectory());
    state.command = null;
    const result = await startDaemon(state.deps);
    expect(result.started).toBe(false);
    expect(result.message).toContain("DEMESNE_DAEMON_BIN");
  });

  test("spawns, waits for health, and writes the pid file", async () => {
    const directory = temporaryDirectory();
    const dataDirectory = join(directory, "missing", "data");
    const state = createFakeDependencies(dataDirectory);
    state.pendingHealth = { status: "ok", provider: "llama.cpp", model: "local" };
    const result = await startDaemon(state.deps);
    expect(result.started).toBe(true);
    expect(result.pid).toBe(4242);
    expect(state.spawned).toEqual([["demesned"]]);
    expect(readFileSync(join(dataDirectory, "daemon.pid"), "utf8").trim()).toBe("4242");
    expect(existsSync(join(dataDirectory, "daemon.log"))).toBe(true);
  });

  test("reports a daemon that exits during startup", async () => {
    const directory = temporaryDirectory();
    const state = createFakeDependencies(directory);
    state.deps.spawn = (command) => {
      state.spawned.push(command);
      state.alive = false;
      return { pid: 4242, unref: () => {} };
    };
    const result = await startDaemon(state.deps);
    expect(result.started).toBe(false);
    expect(result.message).toContain("exited during startup");
    expect(existsSync(join(directory, "daemon.pid"))).toBe(false);
  });
});

describe("stopDaemon", () => {
  test("signals the recorded pid and clears the pid file", async () => {
    const directory = temporaryDirectory();
    const state = createFakeDependencies(directory);
    state.alive = true;
    state.health = { status: "ok", provider: "p", model: "m" };
    writeFileSync(join(directory, "daemon.pid"), "777\n");
    const result = await stopDaemon(state.deps);
    expect(result.stopped).toBe(true);
    expect(state.killed).toEqual([777]);
    expect(existsSync(join(directory, "daemon.pid"))).toBe(false);
  });

  test("reports a daemon that is not running", async () => {
    const state = createFakeDependencies(temporaryDirectory());
    const result = await stopDaemon(state.deps);
    expect(result.stopped).toBe(false);
    expect(result.message).toContain("not running");
  });
});

describe("ensureDaemon", () => {
  test("does nothing when the daemon is healthy", async () => {
    const state = createFakeDependencies(temporaryDirectory());
    state.health = { status: "ok", provider: "p", model: "m" };
    const result = await ensureDaemon(state.deps, "prompt", async () => false);
    expect(result).toEqual({ started: false, remember: false });
  });

  test("never policy explains how to start the daemon", async () => {
    const state = createFakeDependencies(temporaryDirectory());
    await expect(ensureDaemon(state.deps, "never", async () => true))
      .rejects.toThrow(/daemon start/);
  });

  test("prompt policy starts only after acceptance and asks to remember", async () => {
    const state = createFakeDependencies(temporaryDirectory());
    state.pendingHealth = { status: "ok", provider: "p", model: "m" };
    const declined = ensureDaemon(state.deps, "prompt", async () => false);
    await expect(declined).rejects.toThrow(/not running/);
    expect(state.spawned).toEqual([]);

    const result = await ensureDaemon(state.deps, "prompt", async () => true);
    expect(result).toEqual({ started: true, remember: true });
    expect(state.spawned).toHaveLength(1);
  });

  test("always policy starts without prompting", async () => {
    const state = createFakeDependencies(temporaryDirectory());
    state.pendingHealth = { status: "ok", provider: "p", model: "m" };
    const result = await ensureDaemon(state.deps, "always", async () => {
      throw new Error("should not prompt");
    });
    expect(result).toEqual({ started: true, remember: false });
  });
});

describe("readDaemonLog", () => {
  test("returns the tail of the log and tolerates a missing file", () => {
    const directory = temporaryDirectory();
    const state = createFakeDependencies(directory);
    expect(readDaemonLog(state.deps)).toBe("");
    writeFileSync(join(directory, "daemon.log"), Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n"));
    const tail = readDaemonLog(state.deps, 3);
    expect(tail.split("\n")).toEqual(["line 47", "line 48", "line 49"]);
  });
});

describe("resolveDaemonCommand", () => {
  test("a compiled CLI finds demesned beside its own executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "demesne-bin-"));
    try {
      const daemon = join(dir, "demesned");
      writeFileSync(daemon, "");
      // Compiled binaries report Bun's virtual filesystem as their module dir.
      const command = resolveDaemonCommand({}, { moduleDir: "/$bunfs/root", execPath: join(dir, "demesne") });
      expect(command).toEqual([daemon]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit DEMESNE_DAEMON_BIN still wins", () => {
    const command = resolveDaemonCommand(
      { DEMESNE_DAEMON_BIN: "/opt/demesned" },
      { moduleDir: "/$bunfs/root", execPath: "/nowhere/demesne" },
    );
    expect(command).toEqual(["/opt/demesned"]);
  });
});
