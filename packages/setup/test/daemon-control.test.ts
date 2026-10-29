import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonHealth,
  resolveDaemonCommand,
  startDaemon,
  stopDaemon,
  type DaemonControlDependencies,
  type DaemonHealth} from "../src/daemon-control.ts";

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
  spawnOptions: Parameters<DaemonControlDependencies["spawn"]>[1][];
  killed: number[];
  health: DaemonHealth | null;
  pendingHealth: DaemonHealth | null;
  alive: boolean;
  /// Processes alive independently of the spawned child, with their command lines.
  others: Map<number, string>;
  command: string[] | null;
}

function writeLockOwner(dataDirectory: string, pid: number): void {
  mkdirSync(join(dataDirectory, "daemon.lock"), { recursive: true });
  writeFileSync(
    join(dataDirectory, "daemon.lock", "owner.json"),
    JSON.stringify({ pid, nonce: "test", acquiredAt: new Date().toISOString() }),
  );
}

function createFakeDependencies(dataDirectory: string): FakeState {
  const state: FakeState = {
    spawned: [],
    spawnOptions: [],
    killed: [],
    health: null,
    pendingHealth: null,
    alive: false,
    others: new Map(),
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
    spawn: (command, options) => {
      state.spawned.push(command);
      state.spawnOptions.push(options);
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
      state.others.delete(pid);
    },
    isProcessAlive: (pid) => state.others.has(pid) || state.alive,
    processCommand: (pid) => state.others.get(pid) ?? null,
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
    // Its own session, so closing the terminal that started it can't stop it.
    expect(state.spawnOptions[0]?.detached).toBe(true);
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

  test("a start that loses the lock leaves the running daemon's pid file intact", async () => {
    const directory = temporaryDirectory();
    const state = createFakeDependencies(directory);
    // The running daemon is not answering health checks, and its lock owner
    // file is unreadable, so the start goes ahead and the child exits.
    state.others.set(10492, "/usr/local/bin/demesned");
    writeFileSync(join(directory, "daemon.pid"), "10492\n");
    state.deps.spawn = (command) => {
      state.spawned.push(command);
      return { pid: 4242, unref: () => {} };
    };
    const result = await startDaemon(state.deps);
    expect(result.started).toBe(false);
    expect(result.message).toContain("exited during startup");
    expect(readFileSync(join(directory, "daemon.pid"), "utf8").trim()).toBe("10492");
  });

  test("does not spawn while a scheduled task owns the daemon, and says who does", async () => {
    const directory = temporaryDirectory();
    const state = createFakeDependencies(directory);
    writeFileSync(join(directory, "daemon.managed"), "the scheduled task \\Demesne\\demesned\n");
    const result = await startDaemon(state.deps);
    expect(result.started).toBe(false);
    expect(result.health).toBeNull();
    expect(result.message).toContain("the scheduled task \\Demesne\\demesned runs the daemon");
    expect(result.message).toContain(join(directory, "daemon.managed"));
    expect(state.spawned).toEqual([]);
    // A daemon that is up is still reported as such.
    state.health = { status: "ok", provider: "local", model: "qwen3-4b" };
    expect((await startDaemon(state.deps)).message).toContain("already running");
  });

  test("does not spawn while a live daemon holds the data directory lock", async () => {
    const directory = temporaryDirectory();
    const state = createFakeDependencies(directory);
    state.others.set(10492, "/usr/local/bin/demesned");
    writeLockOwner(directory, 10492);
    writeFileSync(join(directory, "daemon.pid"), "10492\n");
    const result = await startDaemon(state.deps);
    expect(result.started).toBe(false);
    expect(result.pid).toBe(10492);
    expect(result.message).toContain("pid 10492");
    expect(state.spawned).toEqual([]);
    expect(readFileSync(join(directory, "daemon.pid"), "utf8").trim()).toBe("10492");
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

describe("stopDaemon", () => {
  test("falls back to the lock owner when the pid file is missing", async () => {
    const directory = temporaryDirectory();
    const state = createFakeDependencies(directory);
    state.health = { status: "ok", provider: "p", model: "m" };
    state.others.set(10492, "bun /src/demesne-cli/apps/daemon/src/main.ts");
    writeLockOwner(directory, 10492);
    const result = await stopDaemon(state.deps);
    expect(result.stopped).toBe(true);
    expect(state.killed).toEqual([10492]);
    expect(result.message).toContain("10492");
  });

  test("falls back to the lock owner when the pid file is stale", async () => {
    const directory = temporaryDirectory();
    const state = createFakeDependencies(directory);
    state.health = { status: "ok", provider: "p", model: "m" };
    state.others.set(10492, "/usr/local/bin/demesned");
    writeLockOwner(directory, 10492);
    writeFileSync(join(directory, "daemon.pid"), "4242\n");
    const result = await stopDaemon(state.deps);
    expect(result.stopped).toBe(true);
    expect(state.killed).toEqual([10492]);
    expect(existsSync(join(directory, "daemon.pid"))).toBe(false);
  });

  test("does not signal a lock owner pid that is not a demesne daemon", async () => {
    const directory = temporaryDirectory();
    const state = createFakeDependencies(directory);
    state.health = { status: "ok", provider: "p", model: "m" };
    state.others.set(10492, "/Applications/Safari.app/Contents/MacOS/Safari");
    writeLockOwner(directory, 10492);
    const result = await stopDaemon(state.deps, { timeoutMs: 20 });
    expect(result.stopped).toBe(false);
    expect(state.killed).toEqual([]);
  });

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
