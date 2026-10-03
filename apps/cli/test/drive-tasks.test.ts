import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDrive, type DriveServices } from "../src/agent-drive.ts";
import { currentDriveTask } from "../src/drive-tasks.ts";
import { ProjectMemory } from "../src/drive-memory.ts";
import {
  driveReopenReason,
  parseDriveRequest,
  parseDriveLedger,
  validateDriveDecisionContext,
  type DriveAction,
  type DriveDecision,
  type DriveFacts,
  type DriveObservation,
  type DriveResponse,
} from "@demesne/protocol";

const initialFacts = (): DriveFacts => ({
  sessionId: "home",
  workspace: "/repo",
  capturedAt: "now",
  latestTurn: { id: "turn", status: "completed" },
  selectedTurn: { id: "turn", status: "completed" },
  workspaceRevision: "rev1",
  files: [
    { path: "parser.ts", revision: "a" },
    { path: "other.ts", revision: "b" },
  ],
  changedFiles: ["parser.ts"],
  checks: [],
  progress: "same",
});
function harness(extra: Partial<DriveServices> = {}) {
  let facts = initialFacts(),
    action: DriveAction = { kind: "wait" },
    count = 0;
  let screen: DriveObservation = {
    id: "screen",
    sessionId: "home",
    workspace: "/repo",
    title: "Test",
    mode: "input",
    ready: true,
    draft: "",
    surface: "log",
    width: 120,
    height: 30,
    rows: ["Check passed"],
    evidenceRows: ["Check passed"],
    answerRows: ["Check passed"],
    latestAnswerRows: ["Check passed"],
    controls: [],
  };
  const performed: string[] = [];
  let drive: AgentDrive;
  const services: DriveServices = {
    delayMs: 60000,
    retryDelaysMs: [0, 0],
    changed() {},
    observe: () => ({ ...screen, id: `screen-${++count}` }),
    facts: async () => structuredClone(facts),
    perform: async (action) => {
      if (action.kind === "compose") {
        performed.push(action.text);
        const id = `worker-${performed.length}`;
        drive.workerStarted("home", action.text.replace(/^\/plan\s+/, ""), id);
        facts.latestTurn = facts.selectedTurn = { id, status: "completed" };
        return `Sent through the visible composer: ${action.text}`;
      }
      return "Opened view";
    },
    decide: async (request) => ({
      provider: "test",
      model: "test",
      imageInspected: false,
      decision: {
        action,
        note: "Reviewed criteria",
        notes: "",
        completed: [],
        remaining: [],
        evidence: [
          { observationId: request.observation.id, quote: "Check passed" },
        ],
      },
    }),
    ...extra,
  };
  drive = new AgentDrive(services);
  return {
    drive,
    services,
    performed,
    get facts() {
      return facts;
    },
    set facts(value: DriveFacts) {
      facts = value;
    },
    set action(value: DriveAction) {
      action = value;
    },
    set screen(value: DriveObservation) {
      screen = value;
    },
  };
}

test("bounded missions record completion once, preserve it after restart and cannot resume automatically", async () => {
  const root = mkdtempSync(join(tmpdir(), "drive-tasks-")),
    path = join(root, "mission.json");
  const h = harness({ path });
  let restored: AgentDrive | undefined;
  try {
    h.drive.start("--bounded Fix parser.ts empty input");
    h.action = {
      kind: "set_criteria",
      criteria: [
        "Empty input returns a clear error",
        "Regression check passes",
      ],
    };
    await h.drive.step();
    h.action = { kind: "complete" };
    await h.drive.step();
    const task = currentDriveTask(h.drive.state!)!;
    expect(h.drive.state?.status).toBe("completed");
    expect(h.drive.active).toBe(false);
    expect(task.completions).toHaveLength(1);
    expect(task.completions[0]?.criteria).toHaveLength(2);
    expect(task.completions[0]?.files).toEqual([
      { path: "parser.ts", revision: "a" },
    ]);
    expect(task.completions[0]?.turnId).toBe("turn");
    expect(task.completions[0]?.evidence).toHaveLength(1);
    expect(() => h.drive.control("resume")).toThrow("complete");
    h.drive.dispose();
    restored = new AgentDrive(h.services);
    expect(restored.state?.ledger).toEqual(h.drive.state?.ledger);
    expect(() => restored!.control("resume")).toThrow("complete");
    expect(parseDriveLedger(restored.state!.ledger).tasks[0]?.status).toBe(
      "completed",
    );
  } finally {
    restored?.dispose();
    h.drive.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("continuous mode is explicit and cannot erase or relabel completed work", async () => {
  const h = harness();
  try {
    h.drive.start("--continuous Fix parser.ts empty input");
    h.action = { kind: "complete" };
    await h.drive.step();
    expect(h.drive.state?.autonomy?.phase).toBe("discovering");
    expect(currentDriveTask(h.drive.state!)?.status).toBe("completed");
    h.action = {
      kind: "compose",
      text: "Assess the next useful change, read only",
    };
    await h.drive.step();
    expect(h.performed[0]).toStartWith("/plan ");
    h.action = { kind: "next_task", task: "Verify parser.ts blank input" };
    await h.drive.step();
    expect(h.drive.state?.feedback).toContain("already complete");
    expect(h.drive.state?.ledger?.tasks).toHaveLength(1);
    expect(h.drive.state?.completed).toEqual(["Fix parser.ts empty input"]);
    h.action = { kind: "idle" };
    await h.drive.step();
    expect(h.drive.state?.status).toBe("idle");
  } finally {
    h.drive.dispose();
  }
});

test("reworded requests and fresh prose cannot reset unchanged-outcome attempts", async () => {
  const h = harness();
  try {
    h.drive.start("--bounded Implement parser error handling");
    for (const text of [
      "Make empty input safe",
      "Return a descriptive validation error",
      "Improve how missing tokens are handled",
    ]) {
      h.action = { kind: "compose", text };
      await h.drive.step();
    }
    expect(h.performed).toHaveLength(2);
    expect(h.drive.state?.feedback).toContain("outcomes unchanged");
    h.action = { kind: "complete" };
    await h.drive.step();
    expect(h.drive.state?.status).toBe("completed");
    expect(h.performed).toHaveLength(2);
  } finally {
    h.drive.dispose();
  }
});

test("repeated summaries do not reset the no-progress counter", async () => {
  let n = 0;
  const h = harness({ limits: { maxStalledCycles: 3 } });
  try {
    h.drive.start("Review parser");
    for (let i = 0; i < 7; i++) {
      h.action = { kind: "scroll", row: i, column: 1, amount: 1 };
      h.screen = {
        id: "x",
        sessionId: "home",
        workspace: "/repo",
        title: "Test",
        mode: "input",
        ready: true,
        draft: "",
        surface: "response",
        rows: [`Another newly worded progress report ${++n}`],
        evidenceRows: ["Check passed"],
        width: 120,
        height: 30,
        controls: [],
      };
      await h.drive.step();
    }
    expect(h.drive.state?.protection?.trip?.kind).toBe("loop");
    expect(h.drive.state?.activity).toContain("No new result evidence");
  } finally {
    h.drive.dispose();
  }
});

test("reopening requires relevant changed evidence; a human can explicitly reopen and retains the earlier completion", async () => {
  const h = harness();
  try {
    h.drive.start("Fix parser.ts empty input");
    h.action = { kind: "complete" };
    await h.drive.step();
    const task = currentDriveTask(h.drive.state!)!;
    expect(driveReopenReason(task, h.facts)).toBeUndefined();
    h.facts.files[1]!.revision = "unrelated-edit";
    expect(driveReopenReason(task, h.facts)).toBeUndefined();
    h.facts.files[0]!.revision = "changed";
    expect(driveReopenReason(task, h.facts)).toContain("parser.ts");
    h.drive.reopen(
      task.id.slice(0, 8),
      "I want the empty-input behavior revised",
    );
    expect(task.status).toBe("active");
    expect(task.completions).toHaveLength(1);
    expect(task.reopened?.source).toBe("user");
    h.action = { kind: "complete" };
    await h.drive.step();
    expect(task.completions).toHaveLength(2);
    expect(task.completions[0]?.files[0]?.revision).toBe("a");
  } finally {
    h.drive.dispose();
  }
});

test("automatic reopen rejects suspicion and accepts a new current failure of the recorded check", async () => {
  const h = harness();
  try {
    h.facts.checks = [
      {
        id: "pass",
        key: "test-parser",
        turnId: "turn",
        command: "bun test parser",
        status: "completed",
        freshness: "current",
        revision: "rev1",
      },
    ];
    h.drive.start("--continuous Fix parser.ts empty input");
    h.action = { kind: "complete" };
    await h.drive.step();
    const task = currentDriveTask(h.drive.state!)!;
    h.action = {
      kind: "reopen_task",
      taskId: task.id,
      reason: "It might still be broken",
    };
    await h.drive.step();
    expect(task.status).toBe("completed");
    h.facts.checks[0] = { ...h.facts.checks[0]!, id: "fail", status: "failed" };
    h.facts.progress = "new-failure";
    h.action = {
      kind: "reopen_task",
      taskId: task.id,
      reason: "The parser regression check now fails",
    };
    await h.drive.step();
    expect(task.status).toBe("active");
    expect(task.reopened?.source).toBe("changed-evidence");
    expect(task.completions).toHaveLength(1);
  } finally {
    h.drive.dispose();
  }
});

test("a consultation is tied to its exact worker turn and cannot be replaced by an unrelated latest answer", async () => {
  const h = harness();
  try {
    h.drive.start("--continuous Improve parser reliability");
    h.action = { kind: "complete" };
    await h.drive.step();
    h.action = { kind: "compose", text: "Assess remaining useful changes" };
    await h.drive.step();
    expect(h.drive.state?.autonomy?.consultationTurnId).toBe("worker-1");
    h.facts.latestTurn = { id: "unrelated", status: "completed" };
    h.action = { kind: "next_task", task: "Improve image cache performance" };
    await h.drive.step();
    expect(h.drive.state?.feedback).toContain(
      "specific completed consultation",
    );
    expect(h.drive.state?.ledger?.tasks).toHaveLength(1);
  } finally {
    h.drive.dispose();
  }
});

test("cancelled and outdated checks cannot support completion; criteria cannot change after work starts", async () => {
  const h = harness();
  try {
    h.drive.start("Fix parser");
    h.action = { kind: "compose", text: "Implement missing-input handling" };
    await h.drive.step();
    h.action = { kind: "set_criteria", criteria: ["Just say it is done"] };
    await h.drive.step();
    expect(h.drive.state?.feedback).toContain("before the task");
    h.facts.selectedTurn!.status = "cancelled";
    h.action = { kind: "complete" };
    await h.drive.step();
    expect(h.drive.state?.status).not.toBe("completed");
  } finally {
    h.drive.dispose();
  }
});

test("malformed task records block resume rather than forgetting completed work", async () => {
  const root = mkdtempSync(join(tmpdir(), "drive-tasks-invalid-")),
    path = join(root, "mission.json"),
    h = harness({ path });
  let restored: AgentDrive | undefined;
  try {
    h.drive.start("Fix parser");
    h.drive.control("pause");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.ledger.tasks[0].status = "completed";
    writeFileSync(path, JSON.stringify(saved));
    restored = new AgentDrive(h.services);
    expect(restored.state?.status).toBe("blocked");
    expect(restored.state?.protection?.trip?.kind).toBe("journal");
    expect(() => restored!.control("resume")).toThrow();
    expect(JSON.parse(readFileSync(path, "utf8")).ledger).toEqual(saved.ledger);
  } finally {
    restored?.dispose();
    h.drive.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit reopen grants fresh attempts without resetting mission budgets", async () => {
  const h = harness();
  try {
    h.drive.start("Fix parser");
    h.action = { kind: "compose", text: "Fix parser empty input" };
    await h.drive.step();
    await h.drive.step();
    h.action = { kind: "complete" };
    await h.drive.step();
    const task = currentDriveTask(h.drive.state!)!;
    h.drive.reopen(
      task.id,
      "The requirements changed; revise the same behavior",
    );
    h.action = { kind: "compose", text: "Fix parser empty input" };
    await h.drive.step();
    expect(h.performed).toHaveLength(3);
    expect(h.drive.state?.protection?.used.workerRequests).toBe(3);
    expect(task.completions).toHaveLength(1);
  } finally {
    h.drive.dispose();
  }
});

test("worker binding uses the actual normalized submission, including file mentions", async () => {
  const h = harness({
    normalizeWorker: (text) => text.replace("@parser.ts", "@src/parser.ts"),
  });
  try {
    h.drive.start("Inspect the parser");
    h.action = { kind: "compose", text: "Inspect @parser.ts" };
    await h.drive.step();
    h.drive.workerStarted("home", "Inspect @src/parser.ts", "normalized-turn");
    expect(currentDriveTask(h.drive.state!)?.workerTurns).toContain(
      "normalized-turn",
    );
  } finally {
    h.drive.dispose();
  }
});

test("project memory: Drive plans with it, records verified outcomes, and keeps it across missions", async () => {
  const root = mkdtempSync(join(tmpdir(), "drive-memory-"));
  const memory = new ProjectMemory(join(root, "memory.jsonl"));
  memory.add({ kind: "preference", text: "Merge solid fixes after CI passes", source: "you" });
  const requests: unknown[] = [];
  const h = harness({ memory });
  const decide = h.services.decide;
  h.services.decide = async (request, signal, progress) => { requests.push(request.projectMemory); return decide(request, signal, progress); };
  try {
    h.drive.start("--bounded Fix parser.ts empty input");
    h.action = { kind: "complete" };
    await h.drive.step();
    expect(h.drive.state?.status).toBe("completed");
    // The planner saw the standing preference…
    expect(requests[0]).toEqual([expect.objectContaining({ kind: "preference", text: "Merge solid fixes after CI passes", source: "you" })]);
    // …and the verified task was recorded as an outcome for later missions.
    const outcome = memory.list().find((item) => item.kind === "outcome");
    expect(outcome).toMatchObject({ source: "drive", text: "Fix parser.ts empty input: Reviewed criteria" });
    // A new mission plans with both.
    const next = harness({ memory });
    const seen: unknown[] = [];
    next.services.decide = async (request, signal, progress) => { seen.push(request.projectMemory); return decide(request, signal, progress); };
    next.drive.start("--bounded Add a lexer test");
    next.action = { kind: "wait" };
    await next.drive.step();
    expect((seen[0] as { kind: string }[]).map((item) => item.kind)).toEqual(["preference", "outcome"]);
    next.drive.dispose();
  } finally {
    h.drive.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
