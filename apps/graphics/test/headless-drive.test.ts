import { expect, test } from "bun:test";
import { fixture } from "./fixture.ts";
import { runHeadlessDrive } from "../headless-drive.ts";

test("a headless mission settles, is committed for review and returns its receipt", async () => {
  const f = await fixture({ providerId: "test", modelId: "test", contextCapacity: 262144, async listModels() { return []; },
    async *stream() { yield { type: "text_delta", delta: "Thinking it over." }; yield { type: "finish", reason: "stop" }; } });
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=a@b", "commit", "-qm", "init"]])
    Bun.spawnSync(["git", ...args], { cwd: f.workspace });
  try {
    const { session } = await f.client.createSession({ title: "Drive", workspacePath: f.workspace, trustWorkspace: true });
    let worktreeSession: string | undefined;
    const result = await runHeadlessDrive({ workspace: f.workspace, sessionId: session.id, mission: "--bounded Make the README friendlier", settings: f.settings }, {
      client: f.client, pollMs: 20,
      // The mission works in its own worktree session; stop it once it's running.
      started: (host) => { worktreeSession = host.current?.session.id; expect(host.driveState?.status).toBe("running"); host.drive!.agent.control("stop"); },
    });
    expect(worktreeSession).not.toBe(session.id);
    expect(result).toMatchObject({ status: "stopped", verified: false, branch: null });
    expect(result.receipt.markdown).toContain("### Drive mission receipt");
    expect(result.receipt.markdown).toContain("Make the README friendlier");
    expect(result.receipt.markdown).toContain("**Branch:** `drive/mission-");
    // Committed for review exactly as the window would (nothing changed here).
    const fix = (await f.client.driveFixes(f.workspace)).fixes.find((item) => item.sessionId === worktreeSession)!;
    expect(fix).toMatchObject({ status: "failed", unchanged: true });
  } finally { await f.close(); }
});
