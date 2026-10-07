import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awayMarkerPath, awayPlan, handOffDrive, readAwayMarker, reclaimDrive, type ProcessControl } from "../drive-away.ts";
import type { GraphicsHost } from "../../graphics/host.ts";

const journal = () => join(mkdtempSync(join(tmpdir(), "demesne-away-")), "drive.json");
function processes(running: Set<number>) {
  const signals: [number, string][] = [];
  const control: ProcessControl = {
    alive: (pid) => running.has(pid),
    kill: (pid, signal) => { signals.push([pid, signal]); running.delete(pid); },
    sleep: async () => {},
  };
  return { control, signals };
}

test("a hand-off starts the host again with the mission's session and records it", () => {
  const path = journal();
  const runs: { argv: string[]; log: string }[] = [];
  const pid = handOffDrive({ workspace: "/work", server: "http://127.0.0.1:4111/", sessionId: "s1", journal: path }, ["/app/host"],
    (argv, log) => { runs.push({ argv, log }); return 4242; });
  expect(pid).toBe(4242);
  expect(runs[0]!.argv).toEqual(["/app/host", "--drive-away", "--workspace", "/work", "--server", "http://127.0.0.1:4111/", "--session", "s1"]);
  expect(runs[0]!.log).toBe(join(path, "..", "away.log"));
  expect(readAwayMarker(path)).toMatchObject({ pid: 4242, sessionId: "s1" });
  // A failed start leaves nothing behind.
  const failed = journal();
  expect(handOffDrive({ workspace: "/work", server: "s", sessionId: "s1", journal: failed }, ["/app/host"], () => { throw new Error("no"); })).toBeNull();
  expect(existsSync(awayMarkerPath(failed))).toBe(false);
});

test("only a running, directly controlled mission on its own session is handed off", () => {
  const host = (drive: Record<string, unknown> | undefined, status = "running", current = "s1") => ({
    drive: drive && { journalPath: "/j", agent: { active: ["running", "waiting"].includes(status) }, ...drive },
    driveState: { status, homeSessionId: "s1" }, current: { session: { id: current } }, workspace: "/work", api: { server: "http://x/" },
  }) as unknown as GraphicsHost;
  expect(awayPlan(host({ direct: true }))).toEqual({ workspace: "/work", server: "http://x/", sessionId: "s1", journal: "/j" });
  expect(awayPlan(host({ direct: true }, "waiting"))).not.toBeNull();
  expect(awayPlan(host({ direct: true }, "paused"))).toBeNull();
  expect(awayPlan(host({ direct: true }, "completed"))).toBeNull();
  expect(awayPlan(host({ direct: false }))).toBeNull();
  expect(awayPlan(host({ direct: true }, "running", "s2"))).toBeNull();
  expect(awayPlan(host(undefined))).toBeNull();
});

test("reopening stops the background process that holds the journal and returns the hand-off", async () => {
  const path = journal();
  writeFileSync(awayMarkerPath(path), JSON.stringify({ pid: 7, sessionId: "s1", startedAt: new Date(0).toISOString() }));
  writeFileSync(`${path}.lock`, "7");
  const { control, signals } = processes(new Set([7]));
  expect(await reclaimDrive(path, control)).toMatchObject({ pid: 7, sessionId: "s1" });
  expect(signals).toEqual([[7, "SIGTERM"]]);
  expect(existsSync(awayMarkerPath(path))).toBe(false);
});

test("a finished, vanished or unrelated process is never signalled", async () => {
  const path = journal();
  expect(await reclaimDrive(path, processes(new Set()).control)).toBeNull();
  // It already exited: the marker is cleared and there's nothing to resume.
  writeFileSync(awayMarkerPath(path), JSON.stringify({ pid: 7, sessionId: "s1", startedAt: new Date().toISOString() }));
  expect(await reclaimDrive(path, processes(new Set()).control)).toBeNull();
  expect(existsSync(awayMarkerPath(path))).toBe(false);
  // An old marker whose pid no longer holds the journal is a recycled pid.
  writeFileSync(awayMarkerPath(path), JSON.stringify({ pid: 7, sessionId: "s1", startedAt: new Date(0).toISOString() }));
  writeFileSync(`${path}.lock`, "8");
  const { control, signals } = processes(new Set([7]));
  expect(await reclaimDrive(path, control)).toBeNull();
  expect(signals).toEqual([]);
  // A process that ignores SIGTERM is killed.
  writeFileSync(awayMarkerPath(path), JSON.stringify({ pid: 9, sessionId: "s1", startedAt: new Date().toISOString() }));
  const stubborn: [number, string][] = [];
  let alive = true;
  expect(await reclaimDrive(path, { alive: () => alive, kill: (pid, signal) => { stubborn.push([pid, signal]); if (signal === "SIGKILL") alive = false; }, sleep: async () => {} }, 0)).not.toBeNull();
  expect(stubborn).toEqual([[9, "SIGTERM"], [9, "SIGKILL"]]);
  expect(readFileSync(`${path}.lock`, "utf8")).toBe("8");
});

test("the background process carries a worktree mission to the end and commits it for review", async () => {
  const { fixture, eventually } = await import("../../graphics/test/fixture.ts");
  const { GraphicsHost } = await import("../../graphics/host.ts");
  const { runDriveAway } = await import("../drive-away.ts");
  const f = await fixture({ providerId: "test", modelId: "test", contextCapacity: 262144, async listModels() { return []; },
    async *stream() { yield { type: "text_delta", delta: "Thinking it over." }; yield { type: "finish", reason: "stop" }; } });
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=a@b", "commit", "-qm", "init"]])
    Bun.spawnSync(["git", ...args], { cwd: f.workspace });
  const window = new GraphicsHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {}, command: () => {} });
  try {
    await window.connect();
    await eventually(() => Boolean(window.current), 5000);
    await window.drive!.handle("drive", { text: "--bounded Make the README friendlier" });
    const fix = window.breakage.state.fix!, plan = awayPlan(window)!;
    expect(plan.sessionId).toBe(fix.sessionId!);
    window.dispose();
    let away: GraphicsHost | undefined;
    const code = await runDriveAway({ workspace: plan.workspace, server: plan.server, sessionId: plan.sessionId }, {
      settings: f.settings, client: f.client, pollMs: 20,
      resumed: (host) => { away = host; expect(host.driveState?.status).toBe("running"); host.drive!.agent.control("stop"); },
    });
    expect(code).toBe(0);
    expect(away?.driveState?.status).toBe("stopped");
    // Committed for review exactly as the window would (nothing changed here).
    const saved = (await f.client.driveFixes(f.workspace)).fixes.find((item) => item.id === fix.id)!;
    expect(saved).toMatchObject({ status: "failed", unchanged: true, headline: "0 of 1 task verified · no checks recorded" });
  } finally { window.dispose(); await f.close(); }
});
