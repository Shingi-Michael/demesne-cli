import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDriveRequest, validateDriveDecisionContext, type DriveAction, type DriveFacts, type DriveObservation, type DriveRequest } from "@demesne/protocol";
import { AgentDrive, type DriveServices } from "../src/agent-drive.ts";
import { currentDriveTask } from "../src/drive-tasks.ts";
import { missionReceipt } from "../src/drive-receipt.ts";
import { driveTaskList } from "../src/workbench/drive-timeline.ts";
import { checkSatisfied, loadWorkflows, parseWorkflow, runWorkflowCheck, workflowCommand, workflowMission, workflowRun } from "../src/workflows.ts";

const BUGFIX = `---
description: Reproduce a bug with a test, fix it, prove it
---
Anything before the first step is ignored.

## Reproduce
Write a test that fails because of: $ARGUMENTS
check: bun test   expect: fail

## Fix
Make the smallest change that makes the new test pass.
check: \`bun test\`

## Review
Read your own diff as a reviewer.
`;

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-workflows-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workflow files", () => {
  test("headings are steps and check lines are Drive's checks", () => {
    const workflow = parseWorkflow(BUGFIX, "bugfix")!;
    expect(workflow.description).toBe("Reproduce a bug with a test, fix it, prove it");
    expect(workflow.steps.map((step) => step.title)).toEqual(["Reproduce", "Fix", "Review"]);
    expect(workflow.steps[0]).toEqual({ title: "Reproduce", prompt: "Write a test that fails because of: $ARGUMENTS", check: { command: "bun test", expect: "fail" } });
    expect(workflow.steps[1]!.check).toEqual({ command: "bun test", expect: "pass" });
    expect(workflow.steps[2]!.check).toBeUndefined();
    expect(parseWorkflow("No steps here.", "empty")).toBeNull();
  });

  test("project workflows win over yours, and become slash commands with a tag", () => {
    const home = temporaryDirectory(), workspace = temporaryDirectory();
    mkdirSync(join(home, ".demesne", "workflows"), { recursive: true });
    mkdirSync(join(workspace, ".demesne", "workflows"), { recursive: true });
    writeFileSync(join(home, ".demesne", "workflows", "bugfix.md"), "## Only\nDo it.\n");
    writeFileSync(join(home, ".demesne", "workflows", "notes.md"), "## Draft\nDraft release notes.\n## Polish\nTighten them.\n");
    writeFileSync(join(workspace, ".demesne", "workflows", "bugfix.md"), BUGFIX);
    const loaded = loadWorkflows(workspace, home);
    expect(loaded.map((item) => item.name)).toEqual(["bugfix", "notes"]);
    expect(loaded[0]!.steps).toHaveLength(3);
    const command = workflowCommand(loaded[0]!);
    expect(command).toMatchObject({ id: "workflow:bugfix", name: "/bugfix", argument: "required", detail: "workflow · 3 steps" });
    expect(command.preview).toStartWith("Reproduce › Fix › Review");
    expect(workflowCommand(loaded[1]!).argument).toBe("optional");
  });

  test("the mission names the workflow and every step's check", () => {
    const workflow = parseWorkflow(BUGFIX, "bugfix")!;
    const run = workflowRun(workflow, "greeting ignores GREETING");
    expect(run.steps[0]!.prompt).toBe("Write a test that fails because of: greeting ignores GREETING");
    const mission = workflowMission(workflow, run, "greeting ignores GREETING");
    expect(mission.split("\n")[0]).toBe("bugfix · greeting ignores GREETING");
    expect(mission).toContain("1. Reproduce: Write a test that fails because of: greeting ignores GREETING (Drive checks: `bun test` must fail)");
    expect(mission).toContain("3. Review: Read your own diff as a reviewer.");
  });

  test("an expected failure has to be the command failing, not a missing command", () => {
    const fail = { command: "bun test", expect: "fail" as const }, pass = { command: "bun test", expect: "pass" as const };
    expect(checkSatisfied(fail, 1)).toBe(true);
    expect(checkSatisfied(fail, 127)).toBe(false);
    expect(checkSatisfied(fail, null)).toBe(false);
    expect(checkSatisfied(fail, 0)).toBe(false);
    expect(checkSatisfied(pass, 0)).toBe(true);
    expect(checkSatisfied(pass, 1)).toBe(false);
  });

  test("checks run through the shell in the workspace", async () => {
    const workspace = temporaryDirectory();
    writeFileSync(join(workspace, "marker.txt"), "here");
    const ok = await runWorkflowCheck("cat marker.txt", workspace, new AbortController().signal);
    expect(ok).toEqual({ exitCode: 0, output: "here" });
    const failed = await runWorkflowCheck("echo broken >&2; exit 3", workspace, new AbortController().signal);
    expect(failed.exitCode).toBe(3);
    expect(failed.output).toContain("broken");
    const slow = await runWorkflowCheck("sleep 5", workspace, new AbortController().signal, 50);
    expect(slow.exitCode).toBeNull();
  });
});

describe("workflow missions", () => {
  function harness(exitCodes: number[]) {
    const facts: DriveFacts = {
      sessionId: "home", workspace: "/worktree", capturedAt: "now", latestTurn: { id: "turn", status: "completed" }, selectedTurn: { id: "turn", status: "completed" },
      workspaceRevision: "rev", files: [], changedFiles: [], checks: [], progress: "p0",
    };
    const screen: DriveObservation = { id: "screen", sessionId: "home", workspace: "/worktree", title: "Test", mode: "input", ready: true, draft: "", surface: "log",
      width: 120, height: 30, rows: ["Check passed"], evidenceRows: ["Check passed"], answerRows: ["Check passed"], latestAnswerRows: ["Check passed"], controls: [] };
    let action: DriveAction = { kind: "wait" }, count = 0;
    const ran: { command: string; cwd: string }[] = [];
    let drive: AgentDrive;
    const services: DriveServices = {
      delayMs: 60000, retryDelaysMs: [0, 0], changed() {},
      observe: () => ({ ...screen, id: `screen-${++count}` }),
      facts: async () => structuredClone(facts),
      perform: async (sent) => {
        if (sent.kind !== "compose") return "Opened view";
        const id = `worker-${++count}`;
        drive.workerStarted("home", sent.text, id);
        facts.latestTurn = facts.selectedTurn = { id, status: "completed" };
        facts.progress = id;
        return `Sent to the coder: ${sent.text}`;
      },
      runCheck: async (command, cwd) => {
        ran.push({ command, cwd });
        return { exitCode: exitCodes.shift() ?? 0, output: "1 failing test" };
      },
      decide: async (request) => ({ provider: "test", model: "test", imageInspected: false,
        decision: { action, note: "Step reviewed", notes: "", completed: [], remaining: [], evidence: [{ observationId: request.observation.id, quote: "Check passed" }] } }),
    };
    drive = new AgentDrive(services);
    return { drive, ran, set action(value: DriveAction) { action = value; } };
  }

  test("each step's check gates the next, and a failed check sends Drive back", async () => {
    const workflow = parseWorkflow(BUGFIX, "bugfix")!;
    const run = workflowRun(workflow, "empty GREETING");
    // Reproduce fails as it should; Fix fails once, then passes.
    const h = harness([1, 1, 0]);
    try {
      h.drive.start(workflowMission(workflow, run, "empty GREETING"), run);
      const state = () => h.drive.state!;
      expect(state().mode).toBe("bounded");
      expect(currentDriveTask(state())!.title).toStartWith("Step 1 of 3 · Reproduce");

      h.action = { kind: "complete", basis: "verified-work" };
      await h.drive.step();
      expect(h.ran).toEqual([{ command: "bun test", cwd: "/worktree" }]);
      expect(state().workflow!.current).toBe(1);
      expect(state().status).toBe("running");
      expect(currentDriveTask(state())!.title).toStartWith("Step 2 of 3 · Fix");
      expect(state().steps.at(-1)!.result).toContain("Reproduce passed (bun test failed as expected)");

      await h.drive.step();
      expect(state().workflow!.current).toBe(1);
      expect(state().feedback).toContain('Step "Fix" isn\'t done: Drive ran `bun test` and it failed (exit 1)');
      expect(driveTaskList(state()).map((row) => `${row.mark} ${row.text}`)).toEqual([
        "✓ Reproduce · bun test failed as expected", "× Fix · bun test failed", "· Review · no check",
      ]);

      // The coder fixes it, then the step completes for real.
      h.action = { kind: "compose", text: "Make the failing test pass" };
      await h.drive.step();
      h.action = { kind: "complete", basis: "verified-work" };
      await h.drive.step();
      expect(state().workflow!.current).toBe(2);
      // Review has no check: completing it ends the mission.
      await h.drive.step();
      expect(h.ran).toHaveLength(3);
      expect(state().status).toBe("completed");
      expect(driveTaskList(state()).every((row) => row.mark === "✓")).toBe(true);

      const receipt = missionReceipt(state());
      expect(receipt.headline).toBe("bugfix · 3 of 3 steps passed · 2 checks");
      expect(receipt.verified).toBe(3);
      expect(receipt.markdown).toContain("**Workflow:** `bugfix`, 3 steps");
      expect(receipt.markdown).toContain("Workflow check: ✓ `bun test` exited 1 (this step needs it to fail)");
    } finally {
      h.drive.dispose();
    }
  });
});

test("a workflow step can complete over the coder's own failing run, since Drive checks it itself", () => {
  const observation: DriveObservation = { id: "o1", sessionId: "home", workspace: "/w", title: "T", mode: "input", ready: true, draft: "", surface: "log", width: 80, height: 10, rows: ["1 failing test"], controls: [] };
  const facts: DriveFacts = { sessionId: "home", workspace: "/w", capturedAt: "now", latestTurn: { id: "t1", status: "completed" }, selectedTurn: { id: "t1", status: "completed" },
    workspaceRevision: "r", files: [], changedFiles: [], progress: "p", checks: [{ id: "c", key: "k", turnId: "t1", command: "bun test", status: "failed", freshness: "current", revision: "r" }] };
  const request: DriveRequest = { mode: "bounded", facts, mission: "bugfix · x", homeSessionId: "home", observation, memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] } };
  const decision = { action: { kind: "complete" as const, basis: "verified-work" as const }, note: "Reproduced", notes: "", completed: [], remaining: [], evidence: [{ observationId: "o1", quote: "1 failing test" }] };
  expect(() => validateDriveDecisionContext(decision, request)).toThrow("failed, running or outdated checks");
  const step = parseDriveRequest({ ...request, workflowStep: { title: "Reproduce", check: { command: "bun test", expect: "fail" } } });
  expect(step.workflowStep).toEqual({ title: "Reproduce", check: { command: "bun test", expect: "fail" } });
  expect(() => validateDriveDecisionContext(decision, step)).not.toThrow();
});
