import type { DriveFix } from "@demesne/protocol";
import { missionReceipt, type DriveReceipt } from "../cli/src/drive-receipt.ts";
import type { CliSettings } from "../cli/src/cli-config.ts";
import { GraphicsHost, type GraphicsHostOptions } from "./host.ts";

/// `demesne drive "<mission>"`: a Drive mission with no window, for CI and
/// scripts. It runs the same planner the window does (in its own worktree
/// unless the mission says `--here`), waits for the mission to settle,
/// commits a worktree mission for review, and returns the mission receipt.

export interface HeadlessDriveResult {
  /// "completed", "paused", "stopped", "idle" or "failed".
  status: string;
  receipt: DriveReceipt;
  /// The worktree mission's branch, when it made a commit.
  branch: string | null;
  /// True when the mission completed and every task is backed by recorded checks.
  verified: boolean;
}

export async function runHeadlessDrive(options: { workspace: string; sessionId: string; mission: string; workflow?: string; server?: string; settings: CliSettings; log?: (line: string) => void },
  test: { client?: GraphicsHostOptions["client"]; pollMs?: number; started?: (host: GraphicsHost) => void } = {}): Promise<HeadlessDriveResult> {
  const log = options.log ?? (() => {});
  const host = new GraphicsHost({
    workspace: options.workspace, server: options.server, sessionId: options.sessionId, settings: options.settings, headless: true,
    ...(test.client ? { client: test.client } : {}),
    changed: () => {},
    // Direct control never sends screen commands.
    command: () => {},
  });
  // A cancelled CI job pauses the mission and saves it, as closing the window would.
  const interrupt = () => { host.dispose(); process.exit(130); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await host.connect();
    if (host.connection !== "online" || host.current?.session.id !== options.sessionId)
      throw new Error(`Couldn't open the Drive session: ${host.error ?? "the daemon didn't answer"}.`);
    // The mission's worktree must be known before it can settle and be committed.
    await host.breakageStarted;
    const drive = host.drive;
    if (!drive) throw new Error("Drive is unavailable here.");
    await drive.handle("drive", { text: options.mission, ...(options.workflow ? { workflow: options.workflow } : {}) });
    test.started?.(host);
    let activity = "";
    const denied = new Set<string>();
    while (drive.agent.active) {
      const now = host.driveState?.activity ?? "";
      if (now && now !== activity) log((activity = now));
      // Nobody is here to approve publishing, so it's denied rather than
      // left waiting, as with `demesne prompt`.
      for (const [id, approval] of host.current?.approvals ?? []) {
        if (denied.has(id) || !host.current!.isActive(approval.turnId)) continue;
        denied.add(id);
        log(`Denied ${approval.name}: approvals aren't answered in a headless run.`);
        try { await host.handle("permission", { id, decision: "deny" }); } catch { /* it was resolved meanwhile */ }
      }
      await new Promise((resolve) => setTimeout(resolve, test.pollMs ?? 1000));
    }
    await host.missionFinish;
    const state = host.driveState;
    if (!state) throw new Error("Drive didn't record a mission.");
    // The committed fix carries the branch and diff for the receipt.
    let fix: DriveFix | null = null;
    try { fix = (await host.api.driveFixes(options.workspace)).fixes.findLast((item) => item.mission && item.sessionId === state.homeSessionId) ?? null; }
    catch { /* an older daemon: the receipt goes without the branch */ }
    const receipt = missionReceipt(state, fix);
    return {
      status: state.status, receipt,
      branch: fix?.status === "ready" ? fix.branch : null,
      verified: state.status === "completed" && receipt.tasks > 0 && receipt.verified === receipt.tasks,
    };
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    host.dispose();
  }
}

