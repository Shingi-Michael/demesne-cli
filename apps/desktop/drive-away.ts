import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCliSettings } from "../cli/src/cli-config.ts";
import { GraphicsHost, type GraphicsHostOptions } from "../graphics/host.ts";

/// Drive keeps working when you close the window. The window's host owns
/// Drive's planning loop, so closing it used to pause a running mission. Now
/// the closing host hands the mission to a small background process with no
/// window (the same host binary, run with --drive-away). It resumes the
/// mission on the same session, keeps going until the mission settles, commits
/// a worktree mission for review as the window would, and exits. Opening the
/// project again takes the mission back: the window stops the background
/// process and resumes the mission itself.
///
/// The hand-off is recorded next to the mission journal so the window can find
/// the process again: `<journal>.away.json`.

export interface AwayMarker { pid: number; sessionId: string; startedAt: string }
export const awayMarkerPath = (journal: string) => `${journal}.away.json`;

export function readAwayMarker(journal: string): AwayMarker | null {
  try {
    const value = JSON.parse(readFileSync(awayMarkerPath(journal), "utf8"));
    if (!Number.isSafeInteger(value?.pid) || value.pid <= 0 || typeof value.sessionId !== "string" || typeof value.startedAt !== "string") return null;
    return value as AwayMarker;
  } catch { return null; }
}
function removeAwayMarker(journal: string, pid?: number) {
  try {
    if (pid !== undefined && readAwayMarker(journal)?.pid !== pid) return;
    unlinkSync(awayMarkerPath(journal));
  } catch {}
}

/// What to hand off when this host closes: a running mission under direct
/// control, on the session it works in. Null when there is nothing to carry on
/// (no mission, paused, finished, or the screen-driven UI route).
export function awayPlan(host: GraphicsHost): { workspace: string; server: string; sessionId: string; journal: string } | null {
  const drive = host.drive, state = host.driveState;
  if (!drive?.direct || !drive.agent.active || !state?.homeSessionId) return null;
  if (host.current?.session.id !== state.homeSessionId) return null;
  return { workspace: host.workspace, server: host.api.server, sessionId: state.homeSessionId, journal: drive.journalPath };
}

export interface AwaySpawn { (argv: string[], log: string): number }
const spawnDetached: AwaySpawn = (argv, log) => {
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  const fd = openSync(log, "a", 0o600);
  try {
    // Its own session: the window and its process group can go away.
    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    child.unref();
    if (!child.pid) throw new Error("The background Drive process did not start");
    return child.pid;
  } finally { closeSync(fd); }
};

/// Starts the background process for a plan made before the host was
/// disposed (disposing pauses the mission; the process resumes it).
/// `self` is how to run this host again: the compiled binary, or bun and the
/// script. Returns the process id, or null when it could not start.
export function handOffDrive(plan: NonNullable<ReturnType<typeof awayPlan>>, self: string[], run: AwaySpawn = spawnDetached): number | null {
  try {
    const pid = run([...self, "--drive-away", "--workspace", plan.workspace, "--server", plan.server, "--session", plan.sessionId],
      join(dirname(plan.journal), "away.log"));
    const marker: AwayMarker = { pid, sessionId: plan.sessionId, startedAt: new Date().toISOString() };
    writeFileSync(awayMarkerPath(plan.journal), JSON.stringify(marker), { mode: 0o600 });
    return pid;
  } catch { return null; }
}

export interface ProcessControl {
  alive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}
const processes: ProcessControl = {
  alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  },
  kill(pid, signal) { try { process.kill(pid, signal); } catch {} },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/// Takes a handed-off mission back before the window loads the journal.
/// Returns the hand-off when a background process was still working on it
/// (the window should resume it), or null.
export async function reclaimDrive(journal: string, control: ProcessControl = processes, timeoutMs = 10_000): Promise<AwayMarker | null> {
  const marker = readAwayMarker(journal);
  if (!marker) return null;
  removeAwayMarker(journal);
  if (!control.alive(marker.pid)) return null;
  // Only signal the process that holds this journal (or one that was only
  // just started and has not taken it yet), never a recycled pid.
  let holder: number | null = null;
  try { holder = Number(readFileSync(`${journal}.lock`, "utf8")); } catch {}
  if (holder !== marker.pid && Date.now() - Date.parse(marker.startedAt) > 60_000) return null;
  control.kill(marker.pid, "SIGTERM");
  for (const deadline = Date.now() + timeoutMs; control.alive(marker.pid) && Date.now() < deadline;) await control.sleep(100);
  if (control.alive(marker.pid)) control.kill(marker.pid, "SIGKILL");
  return marker;
}

/// The background process: `demesne-desktop-host --drive-away`.
export async function runDriveAway(options: { workspace: string; server?: string; sessionId: string },
  test: { settings?: GraphicsHostOptions["settings"]; client?: GraphicsHostOptions["client"]; resumed?: (host: GraphicsHost) => void; pollMs?: number } = {}): Promise<number> {
  const settings = test.settings ?? loadCliSettings({ workspaceRoot: options.workspace, serverOverride: options.server });
  const host = new GraphicsHost({
    workspace: options.workspace, server: options.server, sessionId: options.sessionId, settings, headless: true,
    ...(test.client ? { client: test.client } : {}),
    changed: () => {},
    // Direct control never sends screen commands.
    command: () => {},
  });
  const drive = host.drive!;
  const log = (text: string) => process.stderr.write(`${new Date().toISOString()} ${text}\n`);
  let stopping = false;
  const terminate = () => { stop("The window took the mission back."); process.exit(0); };
  const interrupt = () => { stop("Interrupted."); process.exit(0); };
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    process.off("SIGTERM", terminate); process.off("SIGINT", interrupt);
    log(reason);
    // Pauses a running mission and saves it; the window resumes it.
    host.dispose();
    removeAwayMarker(drive.journalPath, process.pid);
  };
  process.on("SIGTERM", terminate);
  process.on("SIGINT", interrupt);
  await host.connect();
  if (host.connection !== "online" || host.current?.session.id !== options.sessionId || !host.driveState) {
    stop(`Could not reopen the mission session: ${host.error ?? "the session or mission is gone"}.`);
    return 1;
  }
  // The mission's worktree must be known before it can settle and be committed.
  await host.breakageStarted;
  try { drive.agent.control("resume"); }
  catch (error) {
    stop(`Could not resume the mission: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  log(`Carrying on Drive mission ${host.driveState.id} in session ${options.sessionId}.`);
  test.resumed?.(host);
  while (!stopping && drive.agent.active) await new Promise((resolve) => setTimeout(resolve, test.pollMs ?? 1000));
  if (stopping) return 0;
  // A worktree mission that settled is committed for review before exiting.
  await host.missionFinish;
  stop(`Mission ${host.driveState?.status ?? "ended"}: ${host.driveState?.activity ?? ""}`);
  return 0;
}
