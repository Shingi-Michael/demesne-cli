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
    options: { env: Record<string, string | undefined>; stdout: number; stderr: number; stdin: "ignore" },
  ) => SpawnedDaemon;
  sleep: (ms: number) => Promise<void>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isProcessAlive: (pid: number) => boolean;
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
  const [health, pid] = [await daemonHealth(deps), readPid(deps)];
  return { running: health !== null, health, pid };
}

export async function startDaemon(
  deps: DaemonControlDependencies,
  options: { timeoutMs?: number } = {},
): Promise<{ started: boolean; pid: number | null; health: DaemonHealth | null; message: string }> {
  const existing = await daemonHealth(deps);
  if (existing) return { started: false, pid: readPid(deps), health: existing, message: "Daemon is already running." };

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
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  writePid(deps, child.pid);

  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await deps.sleep(250);
    const health = await daemonHealth(deps);
    if (health) return { started: true, pid: child.pid, health, message: `Daemon started (pid ${child.pid}).` };
    if (!deps.isProcessAlive(child.pid)) {
      removePid(deps);
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
  const pid = readPid(deps);
  const health = await daemonHealth(deps);
  if (!pid && !health) return { stopped: false, message: "Daemon is not running." };

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

function removePid(deps: DaemonControlDependencies): void {
  const path = pidPath(deps);
  if (existsSync(path)) unlinkSync(path);
}
