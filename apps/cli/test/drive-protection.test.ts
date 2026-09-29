import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPainter } from "@demesne/brand";
import { parseDriveDecision, parseDriveRequest, validateDriveDecisionContext, type DriveAction, type DriveDecision, type DriveLimits, type DriveObservation, type DriveRequest, type DriveResponse, type EventEnvelope } from "@demesne/protocol";
import { AgentDrive, type DriveServices } from "../src/agent-drive.ts";
import { driveIntent, similarIntent } from "../src/drive-protection.ts";
import { renderDrivePanel } from "../src/workbench/drive-panel.ts";

const screen = (): DriveObservation => ({ id: crypto.randomUUID(), sessionId: "home", workspace: "/project", title: "Mission", mode: "input", ready: true,
  draft: "", surface: "response", rows: ["The worker is reviewing the parser behavior."], width: 120, height: 30, controls: [] });
const choice = (action: DriveAction, evidence: DriveDecision["evidence"] = []): DriveResponse => ({ provider: "test", model: "test", imageInspected: false,
  decision: { action, evidence, note: "Review the mission", notes: "Keep constraints", completed: [], remaining: [], } });
const services = (extra: Partial<DriveServices> = {}): DriveServices => ({ observe: screen, changed() {}, delayMs: 60_000, perform: async () => "No UI change",
  decide: async () => choice({ kind: "wait" }), ...extra });
const event = (eventId: number, type: EventEnvelope["type"], payload: Record<string, unknown> = {}): EventEnvelope => ({ schemaVersion: 1, workspaceId: null, agentRunId: null, eventId, type, sessionId: "home", turnId: "worker", payload, occurredAt: new Date().toISOString() });

test("mission cycles survive pause, task boundaries, journal reload and Resume; a protection stop cannot reset them", async () => {
  const root = mkdtempSync(join(tmpdir(), "drive-guard-")), path = join(root, "mission.json"); let calls = 0;
  const options = services({ path, limits: { maxCycles: 2 }, decide: async () => { calls++; return choice({ kind: "key", key: calls % 2 ? "up" : "down" }); } });
  const first = new AgentDrive(options); let restored: AgentDrive | undefined;
  try {
    first.start("Review parser"); await first.step(); first.control("pause");
    restored = new AgentDrive(options); restored.control("resume"); await restored.step(); await restored.step();
    expect(calls).toBe(2); expect(restored.state?.protection?.used.cycles).toBe(2);
    expect(restored.state?.status).toBe("blocked"); expect(restored.state?.activity).toContain("Mission cycle limit");
    expect(() => restored!.control("resume")).toThrow("protection stopped");
    const again = new AgentDrive(options);
    expect(again.state?.protection?.trip?.kind).toBe("budget"); expect(() => again.control("resume")).toThrow("protection stopped"); again.dispose();
    const panel = renderDrivePanel(100, 50, createPainter(false), restored.state, 0);
    expect(panel.rows.join("\n")).toContain("PROTECTION STOP"); expect(panel.zones.some(zone => zone.action.kind === "drive-control" && zone.action.control === "resume")).toBe(false);
    restored.start("Investigate a different parser edge case"); expect(restored.state?.protection?.used.cycles).toBe(0);
  } finally { restored?.dispose(); first.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("three A/B navigation cycles stop despite new observation IDs and changing notes", async () => {
  let calls = 0, actions = 0;
  const drive = new AgentDrive(services({ decide: async () => choice({ kind: "key", key: ++calls % 2 ? "alt+d" : "escape" }), perform: async () => { actions++; return "Opened pane"; } }));
  try { drive.start("Review"); for (let i = 0; i < 10; i++) await drive.step();
    expect(drive.state?.protection?.trip?.kind).toBe("loop"); expect(drive.state?.activity).toContain("Navigation cycle"); expect(actions).toBe(5);
  } finally { drive.dispose(); }
});

test("different unproductive actions still exhaust the no-progress allowance", async () => {
  let calls = 0;
  const drive = new AgentDrive(services({ limits: { maxStalledCycles: 3 }, decide: async () => choice({ kind: "scroll", row: ++calls, column: 1, amount: 1 }) }));
  try { drive.start("Review"); for (let i = 0; i < 5; i++) await drive.step();
    expect(calls).toBe(3); expect(drive.state?.activity).toContain("No new result evidence");
  } finally { drive.dispose(); }
});

test("rephrased completed tasks are blocked across task transitions; distinct targets and work phases remain possible", async () => {
  expect(similarIntent(driveIntent("Repair parser blank input handling"), driveIntent("Fix the parser empty-input handling"))).toBe(true);
  expect(similarIntent(driveIntent("Fix image cancellation in producer.ts"), driveIntent("Test image cancellation in producer.ts"))).toBe(false);
  expect(similarIntent(driveIntent("Fix parser.ts empty input handling"), driveIntent("Fix lexer.ts empty input handling"))).toBe(false);
  const shared = "Keep the existing architecture and preserve compatibility. ".repeat(15);
  expect(similarIntent(driveIntent(`${shared} Fix parser.ts empty input handling`), driveIntent(`${shared} Fix lexer.ts token positions`))).toBe(false);
  let current = { ...screen(), surface: "log", rows: ["Parser handles empty input with a clear validation error"], latestAnswerRows: ["Fix the parser empty-input handling"] };
  let next: DriveAction = { kind: "complete" };
  const drive = new AgentDrive(services({ continuous: true, observe: () => current, decide: async request => choice(next,
    [{ observationId: request.observation.id, quote: next.kind === "next_task" ? "Fix the parser empty-input handling" : "Parser handles empty input" }]) }));
  try {
    drive.start("Repair parser blank input handling"); await drive.step();
    drive.state!.autonomy!.consulted = true;
    current = { ...current, rows: current.latestAnswerRows }; next = { kind: "next_task", task: "Fix the parser empty-input handling" }; await drive.step();
    expect(drive.state?.protection?.trip?.kind).toBe("loop"); expect(drive.state?.activity).toContain("revisits completed work");
    expect(drive.state?.autonomy?.cycle).toBe(1);
  } finally { drive.dispose(); }
});

test("planning token accounting includes corrected attempts, deduplicates cumulative receipts, and stops before an action", async () => {
  let actions = 0;
  const drive = new AgentDrive(services({ limits: { maxTokens: 10_000 }, perform: async () => { actions++; return "Sent"; }, decide: async (_request, _signal, progress) => {
    progress({ type: "attempt", attempt: 1, model: "test", provider: "test" });
    const usage = { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 };
    progress({ type: "usage", usage }); progress({ type: "usage", usage });
    progress({ type: "correction", message: "Invalid first decision" }); progress({ type: "attempt", attempt: 2, model: "test", provider: "test" });
    progress({ type: "usage", usage: { inputTokens: 6000, outputTokens: 2000, totalTokens: 8000 } });
    return choice({ kind: "compose", text: "Must not send after budget exhaustion" });
  } }));
  try { drive.start("Review"); await drive.step(); expect(actions).toBe(0); expect(drive.state?.protection?.used.planningTokens).toBe(11_000); expect(drive.state?.activity).toContain("token limit"); }
  finally { drive.dispose(); }
});

test("a silent in-flight planner is cancelled at the active-time limit; paused time is excluded", async () => {
  let now = 0; let aborted = false;
  const drive = new AgentDrive(services({ now: () => now, limits: { maxActiveMinutes: 1 }, decide: async (_request, signal) => {
    now = 60_001;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return choice({ kind: "compose", text: "Never act after timeout" });
  } }));
  try {
    drive.start("Review"); drive.control("pause"); now = 1_000_000; drive.control("resume");
    expect(drive.state?.protection?.used.activeMs).toBe(0);
    now = 0; drive.control("pause"); drive.control("resume"); await drive.step();
    expect(aborted).toBe(true); expect(drive.state?.activity).toContain("active-time limit");
  } finally { drive.dispose(); }
});

test("tracked worker tokens survive event replay and /plan attribution without charging unrelated turns", async () => {
  const drive = new AgentDrive(services({ decide: async () => choice({ kind: "compose", text: "/plan Assess parser behavior" }) }));
  try {
    drive.start("Review parser"); await drive.step(); drive.workerStarted("home", "Assess parser behavior", "worker");
    const start = event(1, "model.request_started", { contextPlan: { estimatedInputTokens: 1500 } });
    const usage = event(2, "model.usage", { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 });
    drive.workerEvent(start); drive.workerEvent(usage); drive.workerEvent(usage); drive.workerEvent({ ...usage, eventId: 3, turnId: "unrelated" });
    expect(drive.state?.protection?.used.workerTokens).toBe(1050);
    drive.control("pause");
    drive.workerEvent(event(4, "model.request_started", { contextPlan: { estimatedInputTokens: 100 } }));
    drive.workerEvent(event(5, "model.usage", { inputTokens: 100, outputTokens: 20, totalTokens: 120 }));
    drive.workerEvent(start, true); drive.workerEvent(usage, true);
    expect(drive.state?.protection?.used.workerTokens).toBe(1170);
  } finally { drive.dispose(); }
});

test("malformed protection data preserves the mission but fails closed instead of resetting counters", async () => {
  const root = mkdtempSync(join(tmpdir(), "drive-corrupt-")), path = join(root, "mission.json"); const drive = new AgentDrive(services({ path }));
  try {
    drive.start("Preserve this mission"); drive.control("pause");
    const data = JSON.parse(readFileSync(path, "utf8")); data.protection.used.cycles = -5; writeFileSync(path, JSON.stringify(data));
    const restored = new AgentDrive(services({ path }));
    expect(restored.state?.mission).toBe("Preserve this mission"); expect(restored.state?.protection?.trip?.kind).toBe("journal");
    expect(() => restored.control("resume")).toThrow("counters are invalid"); restored.dispose();
  } finally { drive.dispose(); rmSync(root, { recursive: true, force: true }); }
});

function liveFixture(verdict: "keep_working" | "redirect", extra: { limits?: Partial<DriveLimits>; review?: (request: DriveRequest, response: DriveResponse) => Promise<DriveResponse> } = {}) {
  let now = 0, calls = 0, cancellations = 0, sent: string[] = [], current = screen();
  const gate = Promise.withResolvers<DriveResponse>();
  const drive = new AgentDrive(services({ now: () => now, limits: { checkInIntervalSeconds: 1, ...extra.limits }, observe: () => ({ ...current, id: crypto.randomUUID() }),
    perform: async action => { if (action.kind === "compose") sent.push(action.text); return "Sent through the visible composer: instruction"; },
    cancelWorker: async turnId => { expect(turnId).toBe("worker"); cancellations++; return true; },
    decide: async request => {
      if (++calls === 1) return choice({ kind: "compose", text: "Inspect parser only. Do not edit files." });
      expect(parseDriveRequest(request).checkIn?.turnId).toBe("worker");
      const result = choice(verdict === "keep_working" ? { kind: "keep_working" } : { kind: "redirect", text: "Stop the rewrite. Inspect parser behavior read-only and report your findings; no edits or commits." },
        verdict === "redirect" ? [{ observationId: request.observation.id, quote: "Rewrite all parser files" }] : []);
      validateDriveDecisionContext(result.decision, request); gate.resolve(result); return extra.review ? extra.review(request, result) : result;
    } }));
  const start = async () => {
    drive.start("Read-only parser assessment"); await drive.step(); drive.workerStarted("home", sent[0]!, "worker");
    current = { ...screen(), mode: "streaming", ready: false, rows: ["Coder thinking: Rewrite all parser files to replace the whole implementation."] };
    drive.workerEvent(event(1, "model.request_started", { contextPlan: { estimatedInputTokens: 100 } })); now = 1001;
  };
  const settle = () => { drive.workerEvent(event(2, "turn.cancelled")); current = screen(); };
  return { drive, start, settle, sent, gate, counts: () => ({ calls, cancellations }), change: (patch: Partial<DriveObservation>) => { current = { ...current, ...patch }; } };
}

test("an agreeing check-in leaves the worker running and is interval-bounded", async () => {
  const f = liveFixture("keep_working");
  try { await f.start(); await f.drive.step(); await f.drive.step();
    expect(f.counts()).toEqual({ calls: 2, cancellations: 0 }); expect(f.sent).toHaveLength(1); expect(f.drive.state?.steps.at(-1)?.result).toContain("continues without interruption");
  } finally { f.drive.dispose(); }
});

test("a grounded check-in cancels the exact worker, waits for settlement, and submits one targeted correction", async () => {
  const f = liveFixture("redirect");
  try {
    await f.start(); await f.drive.step(); expect(f.counts().cancellations).toBe(1); expect(f.sent).toHaveLength(1);
    await f.drive.step(); expect(f.sent).toHaveLength(1);
    f.settle(); await f.drive.step();
    expect(f.sent).toHaveLength(2); expect(f.sent[1]).toContain("no edits or commits");
    expect(f.drive.state?.protection?.used.redirects).toBe(1); expect(f.drive.state?.protection?.used.checkIns).toBe(1);
  } finally { f.drive.dispose(); }
});

test("human pause after a check-in interruption prevents automatic correction replay", async () => {
  const f = liveFixture("redirect");
  try { await f.start(); await f.drive.step(); f.drive.control("pause"); f.settle(); await f.drive.step(); expect(f.sent).toHaveLength(1);
    expect(f.drive.state?.feedback).toContain("Check-in requested a correction");
  } finally { f.drive.dispose(); }
});

test("check-in protocol forbids completion, slash-command redirection and ungrounded interruption", () => {
  const current = { ...screen(), mode: "streaming" as const, ready: false };
  const request = { mission: "Review", homeSessionId: "home", observation: current, checkIn: { turnId: "worker", cursor: 1 }, memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] } };
  expect(() => validateDriveDecisionContext(choice({ kind: "complete" }).decision, request)).toThrow("keep_working or redirect");
  expect(() => validateDriveDecisionContext(choice({ kind: "redirect", text: "Change direction" }).decision, request)).toThrow("quote concrete visible activity");
  expect(() => validateDriveDecisionContext(choice({ kind: "keep_working" }).decision, { ...request, checkIn: undefined })).toThrow("only available during a live check-in");
  expect(() => parseDriveDecision(choice({ kind: "redirect", text: "/resume another-session" }).decision)).toThrow("not a slash command");
});

test.each(["settled", "stale", "pause"])("a %s check-in cannot interrupt a changed worker or overwrite human control", async change => {
  const deferred = Promise.withResolvers<DriveResponse>(), f = liveFixture("redirect", { review: async () => deferred.promise });
  try {
    await f.start(); const reviewing = f.drive.step(), response = await f.gate.promise;
    if (change === "settled") f.settle();
    else if (change === "stale") f.change({ rows: ["Coder thinking: I will inspect the existing parser without making edits."] });
    else f.drive.control("pause");
    deferred.resolve(response); await reviewing;
    expect(f.counts().cancellations).toBe(0); expect(f.sent).toHaveLength(1);
  } finally { f.drive.dispose(); }
});

test("mission correction allowance blocks repeated interrupt-and-restart cycles", async () => {
  const f = liveFixture("redirect", { limits: { maxRedirects: 1 } });
  try {
    await f.start(); f.drive.state!.protection!.used.redirects = 1;
    await f.drive.step(); expect(f.counts().cancellations).toBe(1); expect(f.drive.state?.protection?.trip?.kind).toBe("loop");
    expect(f.sent).toHaveLength(1); // Protection stops the worker instead of restarting it again.
    expect(f.drive.state?.activity).toContain("correction limit");
  } finally { f.drive.dispose(); }
});

test("a tracked worker exhausting the token budget is cancelled once and cannot trigger another submission", async () => {
  const f = liveFixture("keep_working", { limits: { maxTokens: 5000 } });
  try {
    await f.start(); const usage = event(2, "model.usage", { inputTokens: 6000, outputTokens: 500, totalTokens: 6500 });
    f.drive.workerEvent(usage); f.drive.workerEvent(usage); await f.drive.step();
    expect(f.counts().cancellations).toBe(1); expect(f.counts().calls).toBe(1); expect(f.sent).toHaveLength(1);
    expect(f.drive.state?.activity).toContain("token limit"); expect(f.drive.state?.protection?.trip?.kind).toBe("budget");
    expect(() => f.drive.control("resume")).toThrow("protection stopped"); expect(f.counts().cancellations).toBe(1);
  } finally { f.drive.dispose(); }
});

test("worker request and completed-task budgets remain global across phase changes", async () => {
  const first = new AgentDrive(services({ limits: { maxWorkerRequests: 1 }, decide: async () => choice({ kind: "compose", text: "Review a different file" }) }));
  try { first.start("Review"); await first.step(); first.control("pause"); first.control("resume"); await first.step(); expect(first.state?.activity).toContain("worker-request limit"); }
  finally { first.dispose(); }
  const second = new AgentDrive(services({ continuous: true, limits: { maxTasks: 1 }, observe: () => ({ ...screen(), surface: "log" }), decide: async request => choice({ kind: "complete" }, [{ observationId: request.observation.id, quote: "worker is reviewing" }]) }));
  try { second.start("Review"); await second.step(); await second.step(); expect(second.state?.protection?.used.tasks).toBe(1); expect(second.state?.activity).toContain("task limit"); }
  finally { second.dispose(); }
});

test("old journals migrate conservatively and retained work still prevents repeated tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "drive-migrate-")), path = join(root, "mission.json"), first = new AgentDrive(services({ path, continuous: true }));
  try {
    first.start("Review parser"); first.control("pause");
    const data = JSON.parse(readFileSync(path, "utf8")); delete data.protection; data.step = 40; data.autonomy.cycle = 3;
    data.autonomy.history = [{ task: "Repair parser blank input handling", summary: "Verified", at: "now" }]; writeFileSync(path, JSON.stringify(data));
    const restored = new AgentDrive(services({ path }));
    expect(restored.state?.protection?.used.cycles).toBe(40); expect(restored.state?.protection?.used.tasks).toBe(2);
    expect(restored.state?.protection?.migrated).toBe(true); expect(restored.state?.protection?.tasks).toHaveLength(1); restored.dispose();
  } finally { first.dispose(); rmSync(root, { recursive: true, force: true }); }
});
