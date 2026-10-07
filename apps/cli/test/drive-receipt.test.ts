import { expect, test } from "bun:test";
import type { DriveCompletion, DriveState, DriveTask } from "@demesne/protocol";
import { missionReceipt, taskVerified } from "../src/drive-receipt.ts";

const check = (command: string, status: string, freshness = "current") => ({ id: command, key: command, turnId: "t1", command, status, freshness, revision: "r1" });
const completion = (overrides: Partial<DriveCompletion> = {}): DriveCompletion => ({
  at: "2026-10-06T00:00:00Z", basis: "verified-work", summary: "Parser accepts Unicode identifiers.", criteria: ["Unicode identifiers parse", "Existing tests pass"],
  evidence: [], turnId: "t1", workspaceRevision: "w1", files: [{ path: "src/parser.ts", revision: "r1" }], checks: [check("bun test", "completed")], ...overrides,
});
const task = (title: string, overrides: Partial<DriveTask> = {}): DriveTask => ({ id: title, title, criteria: ["It works"], status: "completed", createdAt: "", workerTurns: ["t1"], completions: [completion()], ...overrides });
const state = (tasks: DriveTask[]): DriveState => ({
  id: "m1", mission: "Make the parser accept Unicode", homeSessionId: "s1", workspace: "/w", status: "completed", mode: "bounded", activity: "", step: 3, model: null, updatedAt: "",
  notes: "", completed: [], remaining: [], evidence: [], steps: [], ledger: { version: 1, currentTaskId: tasks[0]?.id ?? "", tasks },
});

test("a task is verified only by current, passing recorded checks", () => {
  expect(taskVerified(task("ok"))).toBe(true);
  expect(taskVerified(task("red", { completions: [completion({ checks: [check("bun test", "failed")] })] }))).toBe(false);
  expect(taskVerified(task("stale", { completions: [completion({ checks: [check("bun test", "completed", "outdated")] })] }))).toBe(false);
  expect(taskVerified(task("no checks", { completions: [completion({ checks: [] })] }))).toBe(false);
  expect(taskVerified(task("open", { status: "active", completions: [] }))).toBe(false);
});

test("the receipt separates verified work from claims and leads with a headline", () => {
  const receipt = missionReceipt(state([
    task("Accept Unicode identifiers"),
    task("Update the docs", { completions: [completion({ checks: [], summary: "Docs updated.", files: [{ path: "docs/parser.md", revision: null }] })] }),
    task("Benchmark", { status: "active", completions: [] }),
  ]), { branch: "drive/mission-unicode-ab12", base: "0123456789abcdef" });
  expect(receipt).toMatchObject({ tasks: 3, verified: 1, passing: 1, failing: 0, headline: "1 of 3 tasks verified · 1 check passing" });
  expect(receipt.markdown).toContain("> Make the parser accept Unicode");
  expect(receipt.markdown).toContain("**Branch:** `drive/mission-unicode-ab12` from `0123456789`");
  expect(receipt.markdown).toContain("#### ✓ Accept Unicode identifiers\n\n_verified by recorded checks_");
  expect(receipt.markdown).toContain("- [x] Unicode identifiers parse");
  expect(receipt.markdown).toContain("  - ✓ `bun test`");
  expect(receipt.markdown).toContain("#### △ Update the docs\n\n_claimed, not verified_");
  expect(receipt.markdown).toContain("Checks: none recorded.");
  expect(receipt.markdown).toContain("#### ○ Benchmark\n\n_not finished_");
});

test("failing and stale checks are named in the receipt", () => {
  const receipt = missionReceipt(state([task("Fix lint", { completions: [completion({ checks: [check("bun run lint", "failed"), check("bun test", "completed", "outdated")] })] })]));
  expect(receipt.headline).toBe("0 of 1 task verified · 1 check passing, 1 failing");
  expect(receipt.markdown).toContain("  - ✕ `bun run lint` (failed)");
  expect(receipt.markdown).toContain("  - ✓ `bun test` (outdated for the final files)");
});
