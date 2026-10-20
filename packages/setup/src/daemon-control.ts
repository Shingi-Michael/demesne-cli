import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AutoStartPolicy } from "@demesne/config";

/// Daemon lifecycle management for the CLI: health probes, starting a detached
/// daemon, stopping it, tailing its log, and applying the configured
/// auto-start policy. All process and network effects are injectable so the
/// state machine can be tested without spawning anything.

export interface DaemonHealth {
  status: string;
  provider: string;
  model: string;
  version?: string;
}

export interface SpawnedDaemon {
  pid: number;
  unref(): void;
}

export interface DaemonControlDependencies {
  server: string;
  dataDirectory: string;
  fetch: typeof fetch;
  spawn: (
    command: string[],
    options: { env: Record<string, string | undefined>; stdout: number; stderr: number; stdin: "ignore"; detached: true },
  ) => SpawnedDaemon;
  sleep: (ms: number) => Promise<void>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isProcessAlive: (pid: number) => boolean;
  /// The process's command line, or null when it cannot be determined.
  processCommand: (pid: number) => string | null;
  resolveCommand: () => string[] | null;
}

export function createDaemonControlDependencies(
  server: string,
  dataDirectory: string,
  env: Record<string, string | undefined> = process.env,
): DaemonControlDependencies {
  return {
    server,
    dataDirectory,
    fetch,
    spawn: (command, options) => Bun.spawn(command, options),
    sleep: (ms) => Bun.sleep(ms),
    kill: (pid, signal) => process.kill(pid, signal),
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    processCommand: (pid) => {
      try {
        const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
        if (!result.success) return null;
        const command = result.stdout.toString().trim();
        return command || null;
      } catch {
        return null;
      }
    },
    resolveCommand: () => resolveDaemonCommand(env),
  };
}

export function resolveDaemonCommand(
  env: Record<string, string | undefined>,
  location: { moduleDir: string; execPath: string } = { moduleDir: import.meta.dir, execPath: process.execPath },
): string[] | null {
  const { moduleDir, execPath } = location;
  const configured = env.DEMESNE_DAEMON_BIN?.trim();
  if (configured) return [configured];
  // Searches the given environment's PATH, so callers (and tests) control it.
  const installed = env.PATH ? Bun.which("demesned", { PATH: env.PATH }) : null;
  if (installed) return [installed];
  // In a source checkout the TypeScript source is authoritative: a stale
  // dist/demesned would silently run an older daemon than the CLI.
  const source = join(moduleDir, "../../daemon/src/main.ts");
  if (existsSync(source)) return [execPath, source];
  // A compiled CLI's moduleDir is Bun's virtual /$bunfs/root, so look beside
  // the real executable, where release archives and `bun run build` put it.
  const beside = join(dirname(execPath), "demesned");
  if (existsSync(beside)) return [beside];
  const sibling = join(moduleDir, "demesned");
  if (existsSync(sibling)) return [sibling];
  const compiled = join(moduleDir, "../../../dist/demesned");
  if (existsSync(compiled)) return [compiled];
  return null;
}

export async function daemonHealth(deps: DaemonControlDependencies): Promise<DaemonHealth | null> {
  try {
    const response = await deps.fetch(new URL("/healthz", deps.server), {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    const body = await response.json() as Partial<DaemonHealth>;
    if (body.status !== "ok") return null;
    return {
      status: "ok",
      provider: typeof body.provider === "string" ? body.provider : "unknown",
      model: typeof body.model === "string" ? body.model : "unknown",
      ...(typeof body.version === "string" ? { version: body.version } : {}),
    };
  } catch {
    return null;
  }
}

export async function daemonStatus(deps: DaemonControlDependencies): Promise<{
  running: boolean;
  health: DaemonHealth | null;
  pid: number | null;
}> {
  const health = await daemonHealth(deps);
  const pid = readPid(deps) ?? (health ? lockOwnerDaemonPid(deps) : null);
  return { running: health !== null, health, pid };
}

export async function startDaemon(
  deps: DaemonControlDependencies,
  options: { timeoutMs?: number } = {},
): Promise<{ started: boolean; pid: number | null; health: DaemonHealth | null; message: string }> {
  const existing = await daemonHealth(deps);
  if (existing) return { started: false, pid: readPid(deps), health: existing, message: "Daemon is already running." };

  // A daemon that holds the data directory but is not answering health checks
  // (busy, or listening elsewhere) would make a new one exit on the lock.
  const owner = lockOwnerDaemonPid(deps);
  if (owner) {
    return {
      started: false,
      pid: owner,
      health: null,
      message: `Daemon pid ${owner} holds ${deps.dataDirectory} but is not healthy at ${deps.server}. `
        + "Stop it with `demesne daemon stop` before starting another.",
    };
  }

  const command = deps.resolveCommand();
  if (!command) {
    return {
      started: false,
      pid: null,
      health: null,
      message: "Could not find demesned. Install it, build it with `bun run build`, or set DEMESNE_DAEMON_BIN.",
    };
  }

  const logPath = join(deps.dataDirectory, "daemon.log");
  mkdirSync(deps.dataDirectory, { recursive: true, mode: 0o700 });
  const logFd = openSync(logPath, "a", 0o600);
  let child: SpawnedDaemon;
  try {
    child = deps.spawn(command, {
      env: process.env,
      stdout: logFd,
      stderr: logFd,
      stdin: "ignore",
      // Its own session: closing the terminal that ran `demesne daemon start`
      // (or that auto-started it) must not take the daemon down with it.
      detached: true,
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  const previousPid = readPid(deps);
  writePid(deps, child.pid);

  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await deps.sleep(250);
    const health = await daemonHealth(deps);
    if (health) return { started: true, pid: child.pid, health, message: `Daemon started (pid ${child.pid}).` };
    if (!deps.isProcessAlive(child.pid)) {
      // Never leave the file pointing at a dead child, and never take it away
      // from a daemon that is still running.
      if (previousPid && previousPid !== child.pid && deps.isProcessAlive(previousPid)) writePid(deps, previousPid);
      else removePid(deps, child.pid);
      return {
        started: false,
        pid: null,
        health: null,
        message: `Daemon exited during startup. Check ${logPath}.`,
      };
    }
  }
  return {
    started: false,
    pid: child.pid,
    health: null,
    message: `Daemon did not become healthy within ${Math.round(timeoutMs / 1000)}s. Check ${logPath}.`,
  };
}

export async function stopDaemon(
  deps: DaemonControlDependencies,
  options: { timeoutMs?: number } = {},
): Promise<{ stopped: boolean; message: string }> {
  const recorded = readPid(deps);
  const health = await daemonHealth(deps);
  if (!recorded && !health) return { stopped: false, message: "Daemon is not running." };

  // The pid file can be missing or stale while a daemon still serves; the data
  // directory lock records the process that actually owns it.
  let pid = recorded;
  if (health && (!pid || !deps.isProcessAlive(pid))) pid = lockOwnerDaemonPid(deps) ?? pid;

  if (pid) {
    try {
      deps.kill(pid, "SIGTERM");
    } catch {
      // The process may already be gone; the health check decides the outcome.
    }
  }

  const timeoutMs = options.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await deps.sleep(200);
    const stillHealthy = await daemonHealth(deps);
    if (!stillHealthy && (!pid || !deps.isProcessAlive(pid))) {
      removePid(deps);
      return { stopped: true, message: pid ? `Daemon stopped (pid ${pid}).` : "Daemon stopped." };
    }
  }
  return { stopped: false, message: "Daemon did not stop in time. Check the daemon log." };
}

/// Applies the configured auto-start policy. Returns whether the caller should
/// remember an accepted prompt as `[daemon] auto_start = "always"`.
export async function ensureDaemon(
  deps: DaemonControlDependencies,
  policy: AutoStartPolicy,
  prompt: (question: string) => Promise<boolean>,
): Promise<{ started: boolean; remember: boolean }> {
  if (await daemonHealth(deps)) return { started: false, remember: false };

  if (policy === "never") throw daemonNotRunningError(deps);

  if (policy === "prompt") {
    const accepted = await prompt(`Demesne daemon is not running at ${deps.server}. Start it now? [Y/n] `);
    if (!accepted) throw daemonNotRunningError(deps);
    const result = await startDaemon(deps);
    if (!result.started && !result.health) throw new Error(result.message);
    return { started: true, remember: true };
  }

  const result = await startDaemon(deps);
  if (!result.started && !result.health) throw new Error(result.message);
  return { started: true, remember: false };
}

export function readDaemonLog(deps: DaemonControlDependencies, maxLines = 40): string {
  const path = join(deps.dataDirectory, "daemon.log");
  if (!existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n").trimEnd();
}

function daemonNotRunningError(deps: DaemonControlDependencies): Error {
  return new Error(
    `Demesne daemon is not running at ${deps.server}. `
      + 'Start it with "demesne daemon start" or set [daemon] auto_start = "always".',
  );
}

function pidPath(deps: DaemonControlDependencies): string {
  return join(deps.dataDirectory, "daemon.pid");
}

function readPid(deps: DaemonControlDependencies): number | null {
  const path = pidPath(deps);
  if (!existsSync(path)) return null;
  const parsed = Number(readFileSync(path, "utf8").trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function writePid(deps: DaemonControlDependencies, pid: number): void {
  writeFileSync(pidPath(deps), `${pid}\n`, { encoding: "utf8", mode: 0o600 });
}

/// Removes the pid file, or only when it still records `expected`.
function removePid(deps: DaemonControlDependencies, expected?: number): void {
  const path = pidPath(deps);
  if (!existsSync(path)) return;
  if (expected !== undefined && readPid(deps) !== expected) return;
  unlinkSync(path);
}

/// The live demesned process recorded as owner of the data directory lock
/// (written by the daemon's acquireDataDirectoryLock), or null.
function lockOwnerDaemonPid(deps: DaemonControlDependencies): number | null {
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(join(deps.dataDirectory, "daemon.lock", "owner.json"), "utf8")) as { pid?: unknown })?.pid;
  } catch {
    return null;
  }
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return null;
  if (!deps.isProcessAlive(pid)) return null;
  // Guards against a stale lock whose pid now belongs to an unrelated process.
  // When the command line cannot be read, the live lock owner is trusted.
  const command = deps.processCommand(pid);
  if (command !== null && !looksLikeDaemon(command, deps.resolveCommand())) return null;
  return pid;
}

function looksLikeDaemon(command: string, resolved: string[] | null): boolean {
  if (/demesned|daemon\/src\/main\.ts/.test(command)) return true;
  const configured = resolved?.at(-1);
  return Boolean(configured && command.includes(configured));
}
