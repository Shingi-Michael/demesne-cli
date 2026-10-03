import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveResponse, DriveState } from "@demesne/protocol";
import { AgentDrive, DriveJournal } from "../src/agent-drive.ts";
import { beginDriveTrace, updateDriveTrace } from "../src/drive-trace.ts";

const state = (): DriveState => ({ id: "mission", mission: "Inspect the saved result", homeSessionId: "home", workspace: "/project", status: "running", activity: "Planning", step: 0,
  model: "test / model", updatedAt: new Date().toISOString(), notes: "", completed: [], remaining: ["Review"], evidence: [], steps: [] });
const response = (): DriveResponse => ({ provider: "test", model: "model", imageInspected: false,
  decision: { action: { kind: "key", key: "ctrl+b" }, note: "Inspect saved checks", notes: "Reviewing", completed: [], remaining: ["Review"], evidence: [] } });

test("pause freezes the partial trace, ignores late deltas, and restores it as stopped", async () => {
  const root = mkdtempSync(join(tmpdir(), "drive-trace-")), path = join(root, "mission.json");
  const gate = Promise.withResolvers<DriveResponse>(); let emit: Parameters<ConstructorParameters<typeof AgentDrive>[0]["decide"]>[2] | undefined;
  const drive = new AgentDrive({ path, observe: () => ({ id: "screen", sessionId: "home", workspace: "/project", title: "Review", mode: "input", ready: true, draft: "", surface: "response", width: 100, height: 30, rows: [], controls: [] }),
    changed() {}, perform: async () => { throw new Error("No action after pause"); }, decide: async (_request, _signal, progress) => { emit = progress; progress({ type: "reasoning.delta", delta: "Partial thinking" }); return gate.promise; }, delayMs: 60_000 });
  try {
    drive.start("Review"); const pending = drive.step(); drive.control("pause"); emit!({ type: "reasoning.delta", delta: "LATE" }); gate.resolve(response()); await pending;
    const saved = new DriveJournal(path).load()!;
    expect(saved.traces?.[0]?.reasoning).toBe("Partial thinking"); expect(saved.traces?.[0]?.status).toBe("stopped");
    expect(saved.steps).toHaveLength(0);
  } finally { drive.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("a correction retains each attempt separately and saved traces remain bounded", () => {
  const s = state(); beginDriveTrace(s);
  updateDriveTrace(s, { type: "reasoning.delta", delta: "First attempt" });
  updateDriveTrace(s, { type: "correction", message: "action.key is missing" });
  updateDriveTrace(s, { type: "attempt", attempt: 2, provider: "test", model: "model" });
  updateDriveTrace(s, { type: "reasoning.delta", delta: "Second attempt" });
  expect(s.traces?.map((trace) => trace.status)).toEqual(["corrected", "thinking"]);
  expect(s.traces?.[0]?.result).toContain("action.key"); expect(s.traces?.[1]?.attempt).toBe(2);
  updateDriveTrace(s, { type: "reasoning.delta", delta: "x".repeat(2_100_001) });
  expect(s.traces?.[1]?.truncated).toBe(true); expect(s.traces?.[1]?.reasoning.length).toBeLessThanOrEqual(2_100_000);
});
