import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DriveFix, DriveProposal } from "@demesne/protocol";
import { driveContext, driveRunTool } from "../src/drive-in-chat.ts";
import { listWorkspaceFiles } from "../src/tools.ts";

const idea = { id: "a", kind: "tidy", title: "Tidy the parser", why: "Three copies of one loop." } as DriveProposal;
const fix = (status: DriveFix["status"], extra: Partial<DriveFix> = {}) => ({ id: status, workspace: "/w", title: `Fix ${status}`, branch: `drive/${status}`, status, ...extra }) as DriveFix;

test("a chat is told Drive's ideas, its work and how the person starts it", () => {
  const text = driveContext({
    auto: { workspace: "/w", on: true, quietMinutes: 20, perDay: 3, usedToday: 1 },
    ideas: [idea],
    fixes: [fix("running"), fix("ready", { diff: { files: 2, additions: 10, deletions: 3, paths: [] }, summary: "Merged the loops." }), fix("failed", { error: "provider dropped" }), fix("discarded")],
    away: { workspace: "/w", auto: true, status: "running" } as never,
  });
  expect(text).toContain("after 20 quiet minutes (1 of 3 runs used today)");
  expect(text).toContain("1. Tidy the parser (Three copies of one loop.)");
  expect(text).toContain("Working now: Fix running on branch drive/running (started on its own).");
  expect(text).toContain("Waiting for review: Fix ready (+10 -3 in 2 files): Merged the loops.");
  expect(text).toContain("Recently failed: Fix failed: provider dropped.");
  expect(text).not.toContain("Fix discarded");
  expect(text).toContain("call drive_run with its number");
});

test("with nothing going on it says so, and an off switch is mentioned", () => {
  const text = driveContext({ auto: { workspace: "/w", on: false, quietMinutes: 20, perDay: 3, usedToday: 0 }, ideas: [], fixes: [], away: null });
  expect(text).toContain("turned off in this project");
  expect(text).toContain("no ideas listed");
  expect(text).not.toContain("Working now");
});

test("a discarded worktree lists no files instead of throwing", () => {
  expect(listWorkspaceFiles(join(tmpdir(), `gone-${Date.now()}`))).toEqual([]);
});

test("drive_run starts the idea the chat names, by number or title", async () => {
  const second = { ...idea, id: "b", title: "Speed up the build", evidence: ["s1"] } as DriveProposal;
  const runs: string[] = [];
  const tool = driveRunTool({
    ideas: (root) => (root === "/w" ? { proposals: [{ ...idea, evidence: [] } as DriveProposal, second], signals: [{ id: "s1" } as never, { id: "s2" } as never] } : null),
    run: async (_root, proposal, signals) => { runs.push(`${proposal.id}:${signals.map((signal) => signal.id).join()}`); return fix("running", { title: proposal.title, branch: "drive/b" }); },
  });
  const context = { workspaceRoot: "/w", signal: new AbortController().signal };
  expect(tool.permission({ idea: "2" })).toBeNull();
  expect(await tool.execute({ idea: "2" }, context)).toContain('Drive started "Speed up the build" on branch drive/b');
  await tool.execute({ idea: "tidy the PARSER" }, context);
  expect(runs).toEqual(["b:s1", "a:"]);
  await expect(tool.execute({ idea: "9" }, context)).rejects.toThrow("1. Tidy the parser 2. Speed up the build");
  await expect(tool.execute({ idea: "1" }, { ...context, workspaceRoot: "/elsewhere" })).rejects.toThrow("can't run ideas");
});
