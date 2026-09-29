import { expect, test } from "bun:test";
import { createPainter, SLASH_COMMANDS } from "@demesne/brand";
import { parseDriveRequest, validateDriveDecisionContext, type DriveAction, type DriveDecision, type DriveInspection, type DriveRequest, type DriveResponse } from "@demesne/protocol";
import { AgentDrive } from "../src/agent-drive.ts";
import { inspectDrive } from "../src/drive-inspection.ts";
import { Workbench } from "../src/workbench/controller.ts";
import { CliContextRail } from "../src/context-rail.ts";
import { renderDrivePanel } from "../src/workbench/drive-panel.ts";
import { drivePlannerInput } from "../../daemon/src/drive-context.ts";

function fixture(width = 140, wait: () => void = () => {}, intervene: () => void = () => {}) {
  const ui = new Workbench({ paint: createPainter(false), contextRail: new CliContextRail({ id: "test", provider: "test" }, "/project"), sessionTitle: "Review", version: "test",
    onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} }, drive: { control() {}, intervene, waitForFrame: async () => wait() } });
  const internal = ui as unknown as { sessionId: string; onKeypress(text: string, key: { name?: string }): void; onData(data: string): void };
  internal.sessionId = "home";
  const ready = () => { void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.frame(width, 36); };
  const services = { observe: () => ui.observeDrive(), perform: (action: DriveAction, screen: ReturnType<typeof ui.observeDrive>, signal: AbortSignal) => ui.performDrive(action, screen, signal) };
  const collect = (target: "answer" | "diff" | "checks", item?: string, position?: "continue") => inspectDrive(services, { kind: "inspect", target, item, position }, ui.observeDrive(), new AbortController().signal);
  return { ui, internal, ready, services, collect };
}
const choose = (action: DriveAction, evidence: DriveDecision["evidence"] = []): DriveResponse => ({ provider: "test", model: "test", imageInspected: false,
  decision: { action, note: "Evaluated the collected result", notes: "Keep scope", completed: [], remaining: [], evidence } });
function request(ui: Workbench, inspection: DriveInspection): DriveRequest {
  return { mission: "Review", homeSessionId: "home", observation: ui.observeDrive(), inspection, memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] } };
}

test.each([80, 140])("the controller reads a multi-page answer before one model judgment (%s columns)", async (width) => {
  const f = fixture(width); let decisions = 0;
  f.ui.beginTurn({ userText: "Explain the system design", at: "now" });
  f.ui.assistantDelta(Array.from({ length: 35 }, (_, i) => `Architecture section ${String(i).padStart(2, "0")}: the daemon owns execution.\n\n`).join(""));
  f.ui.finishTurn("completed", "Done"); f.ready();
  const drive = new AgentDrive({ ...f.services, delayMs: 60_000, changed: (state) => f.ui.setDrive(state),
    inspect: (action, screen, signal, activity) => inspectDrive(f.services, action, screen, signal, activity),
    decide: async (input) => {
      decisions++;
      const body = parseDriveRequest(input), packet = body.inspection!;
      expect(packet.truncated).toBe(false);
      expect(packet.pages.map((page) => page.rows.join("\n")).join("\n")).toContain("Architecture section 00");
      expect(packet.pages.at(-1)?.rows.join("\n")).toContain("Architecture section 34");
      return choose({ kind: "complete", basis: "answer" }, [{ observationId: packet.pages[0]!.observationId, quote: "Architecture section 00" }]);
    } });
  try {
    drive.start("Explain the system design"); f.ui.showDrive(); await drive.step();
    expect(decisions).toBe(0); expect(drive.state?.traces?.at(-1)?.source).toBe("controller");
    expect(drive.state?.steps.at(-1)?.result).toContain("no model calls");
    const panel = renderDrivePanel(90, 100, createPainter(false), drive.state, 0).rows.join("\n");
    expect(panel).toContain("Local controller"); expect(panel).not.toContain("THINKING");
    await drive.step(); expect(decisions).toBe(1); expect(drive.state?.status).toBe("completed");
  } finally { drive.dispose(); }
});

test("one checks inspection visits failures, reruns, and long test-output tails without model navigation", async () => {
  const f = fixture(); f.ui.beginTurn({ userText: "Review implementation", at: "now" });
  for (let i = 0; i < 5; i++) {
    f.ui.toolRequested({ toolCallId: `check-${i}`, name: "run_command", arguments: { argv: i < 2 ? ["bun", "run", "typecheck"] : ["bun", "test"] } });
    f.ui.toolFinished({ toolCallId: `check-${i}`, name: "run_command", state: i === 0 ? "failed" : "done", exitCode: i === 0 ? 1 : 0,
      message: i === 0 ? "EARLIER TYPE ERROR" : i === 4 ? `${"(pass) intermediate test\n".repeat(500)}1049 pass\n0 fail\n117 files` : `CHECK ${i} PASSED` });
  }
  f.ui.assistantDelta("Work finished; inspect the actual checks."); f.ui.finishTurn("completed", "Done"); f.ready();
  const packet = await f.collect("checks"), rows = packet.pages.flatMap((page) => page.rows).join("\n");
  expect(rows).toContain("EARLIER TYPE ERROR"); expect(rows).toContain("CHECK 1 PASSED"); expect(rows).toContain("1049 pass"); expect(rows).toContain("0 fail");
  expect(new Set(packet.pages.map((page) => page.item)).size).toBe(5);
  expect(packet.truncated).toBe(true); // The middle of the 500-line output was omitted.
  const last = packet.pages.find((page) => page.rows.some((row) => row.includes("1049 pass")))!;
  expect(() => validateDriveDecisionContext(choose({ kind: "complete" }, [{ observationId: last.observationId, quote: "1049 pass" }]).decision, parseDriveRequest(request(f.ui, packet)))).not.toThrow();
});

test.each([80, 140])("Diff inspection selects and expands a file and pages its visible evidence (%s columns)", async (width) => {
  const f = fixture(width); f.ui.beginTurn({ userText: "Implement", at: "now" });
  for (const path of ["first.ts", "second.ts"]) {
    const content = Array.from({ length: 65 }, (_, i) => `export const field${i} = ${i};`).join("\n");
    f.ui.toolRequested({ toolCallId: path, name: "write_file", arguments: { path, content } });
    f.ui.toolFinished({ toolCallId: path, name: "write_file", state: "done", changes: [{ path, before: null, after: content, beforeExists: false, afterExists: true }] });
  }
  f.ui.finishTurn("completed", "Done"); f.ready();
  const packet = await f.collect("diff", "first.ts");
  expect(packet.pages.every((page) => page.item === "first.ts")).toBe(true);
  const rows = packet.pages.flatMap((page) => page.rows).join("\n");
  expect(rows).toContain("field0"); expect(rows).toContain("field64"); expect(packet.truncated).toBe(false);
  expect(f.ui.observeDrive().panes?.find((pane) => pane.surface === "diff")?.column).toBe(0);
});

test("oversized inspections are bounded and can continue from their actual viewport", async () => {
  const f = fixture(80); f.ui.beginTurn({ userText: "Explain", at: "now" });
  f.ui.assistantDelta(Array.from({ length: 1000 }, (_, i) => `Finding ${String(i).padStart(4, "0")}: details.\n\n`).join("")); f.ui.finishTurn("completed", "Done"); f.ready();
  const first = await f.collect("answer");
  expect(first.truncated).toBe(true); expect(first.pages.length).toBeLessThanOrEqual(6); expect(first.actions).toBeLessThanOrEqual(6);
  expect(() => parseDriveRequest(request(f.ui, first))).not.toThrow();
  const second = await f.collect("answer", undefined, "continue");
  expect(second.pages[0]?.rows.join("\n")).not.toContain("Finding 0000:");
  expect(second.pages.at(-1)?.rows).not.toEqual(first.pages.at(-1)?.rows);
});

test.each(["type", "scroll", "abort"])("%s during controller paging cancels or discards evidence and preserves human input", async (takeover) => {
  let actions = 0; const controller = new AbortController();
  const f = fixture(140, () => {
    if (++actions !== 2) return;
    if (takeover === "type") f.internal.onKeypress("keep my draft", {});
    else if (takeover === "scroll") f.internal.onData("\x1b[<64;10;10M");
    else controller.abort(new DOMException("Paused", "AbortError"));
  });
  f.ui.beginTurn({ userText: "Explain", at: "now" }); f.ui.assistantDelta("Long answer content\n\n".repeat(100)); f.ui.finishTurn("completed", "Done"); f.ready();
  const pending = inspectDrive(f.services, { kind: "inspect", target: "answer" }, f.ui.observeDrive(), controller.signal);
  if (takeover === "abort") await expect(pending).rejects.toThrow("Paused");
  else { const packet = await pending; expect(packet.pages).toHaveLength(0); expect(packet.result).toContain("UI changed"); }
  expect(actions).toBe(2);
  if (takeover === "type") expect(f.ui.observeDrive().draft).toBe("keep my draft");
  if (takeover === "scroll") expect(f.ui.observeDrive().navigation?.readingHeld).toBe(true);
});

test("old inspection quotes cannot complete a new turn, even if retained in memory", async () => {
  const f = fixture(); f.ui.beginTurn({ userText: "Old question", at: "now" }); f.ui.assistantDelta("An earlier completed answer"); f.ui.finishTurn("completed", "Done"); f.ready();
  const packet = await f.collect("answer"), evidence = [{ observationId: packet.pages[0]!.observationId, quote: "An earlier completed answer" }];
  expect(() => validateDriveDecisionContext(choose({ kind: "complete", basis: "answer" }, evidence).decision, request(f.ui, packet))).not.toThrow();
  f.ui.beginTurn({ userText: "New question", at: "now" }); f.ui.assistantDelta("Different new answer"); f.ui.finishTurn("completed", "Done"); f.ready();
  const current = request(f.ui, packet); current.memory.evidence = evidence;
  expect(() => validateDriveDecisionContext(choose({ kind: "complete", basis: "answer" }, evidence).decision, current)).toThrow("answer completion requires");
  expect(() => validateDriveDecisionContext(choose({ kind: "complete" }, evidence).decision, current)).toThrow("verified-work completion requires");
});

test("model context deduplicates padded screen/answer copies while preserving exact evidence and scope", async () => {
  const f = fixture(255); f.ui.beginTurn({ userText: "Explain", at: "now" });
  f.ui.assistantDelta("The daemon owns execution and the CLI owns rendering.\n\n".repeat(15)); f.ui.finishTurn("completed", "Done"); f.ready();
  const packet = await f.collect("answer"), full = request(f.ui, packet); full.mission = "Explain only. No edits or commits.";
  const compact = drivePlannerInput(full), rawSize = JSON.stringify(full).length, compactSize = JSON.stringify(compact).length;
  expect(compactSize).toBeLessThan(rawSize * 0.6);
  expect(compact.mission).toBe(full.mission); expect(compact.inspection).toEqual(packet);
  expect(JSON.stringify(compact)).not.toContain('"latestAnswerRows"');
  const quote = { observationId: packet.pages[0]!.observationId, quote: "The daemon owns execution" };
  expect(() => validateDriveDecisionContext(choose({ kind: "complete", basis: "answer" }, [quote]).decision, full)).not.toThrow();
});

test("verification batches continue to remaining checks and a targeted check exposes omitted middle rows", async () => {
  const f = fixture(); f.ui.beginTurn({ userText: "Review all checks", at: "now" });
  for (let i = 0; i < 8; i++) {
    f.ui.toolRequested({ toolCallId: `check-${i}`, name: "run_command", arguments: { argv: ["bun", "test", `suite-${i}`] } });
    f.ui.toolFinished({ toolCallId: `check-${i}`, name: "run_command", state: "done", exitCode: 0,
      message: i === 0 ? Array.from({ length: 500 }, (_, row) => `TEST ROW ${row}`).join("\n") : `SUITE ${i} PASSED` });
  }
  f.ui.finishTurn("completed", "Done"); f.ready();
  const ids = f.ui.observeDrive().navigation!.checks;
  const first = await f.collect("checks");
  expect(new Set(first.pages.map((page) => page.item))).toEqual(new Set(ids.slice(0, 6)));
  expect(first.truncated).toBe(true);
  const next = await f.collect("checks", undefined, "continue");
  expect(new Set(next.pages.map((page) => page.item))).toEqual(new Set(ids.slice(6)));
  expect(next.pages.flatMap((page) => page.rows).join("\n")).toContain("SUITE 7 PASSED");
  const targeted = await f.collect("checks", ids[0]);
  expect(targeted.pages.flatMap((page) => page.rows).join("\n")).toContain("TEST ROW 55");
  expect(targeted.pages.at(-1)!.offset).toBeGreaterThan(targeted.pages[0]!.offset!);
  expect(() => parseDriveRequest(request(f.ui, targeted))).not.toThrow();
});

test("a queued inspection waits through human scrollback without spending model calls, then resumes on Live", async () => {
  let takeovers = 0; const f = fixture(140, () => {}, () => { takeovers++; }); let calls = 0;
  f.ui.beginTurn({ userText: "Explain", at: "now" }); f.ui.assistantDelta("Visible answer paragraph\n\n".repeat(40)); f.ui.finishTurn("completed", "Done"); f.ready();
  const drive = new AgentDrive({ ...f.services, delayMs: 60_000, changed: (state) => f.ui.setDrive(state),
    inspect: (action, screen, signal, activity) => inspectDrive(f.services, action, screen, signal, activity),
    decide: async () => { calls++; return choose({ kind: "inspect", target: "answer" }); } });
  try {
    drive.start("Explain"); await drive.step(); await drive.step();
    expect(calls).toBe(1);
    f.internal.onData("\x1b[<64;10;10M");
    expect(f.ui.observeDrive().navigation?.readingHeld).toBe(true);
    const held = f.ui.observeDrive().scrollRegions;
    await drive.step(); await drive.step();
    expect(drive.state?.status).toBe("waiting"); expect(drive.state?.activity).toContain("your Live view");
    expect(calls).toBe(1); expect(f.ui.observeDrive().scrollRegions).toEqual(held);
    // Ctrl+G on the conversation takes the same route as Live.
    (f.internal as unknown as { onKeypress(text: string, key: { name: string; ctrl: boolean }): void }).onKeypress("", { name: "g", ctrl: true });
    expect(f.ui.observeDrive().navigation?.readingHeld).toBe(false);
    expect(takeovers).toBe(0);
    await drive.step(); expect(calls).toBe(1); expect(drive.state?.traces?.at(-1)?.source).toBe("controller");
  } finally { drive.dispose(); }
});

test("a result that changes during model review is rejected and recollected before any completion", async () => {
  const f = fixture(); f.ui.beginTurn({ userText: "Explain", at: "now" }); f.ui.assistantDelta("Original completed answer"); f.ui.finishTurn("completed", "Done"); f.ready();
  const decision = Promise.withResolvers<DriveResponse>(); let input: DriveRequest | undefined;
  const drive = new AgentDrive({ ...f.services, delayMs: 60_000, retryDelaysMs: [0], changed: (state) => f.ui.setDrive(state),
    inspect: (action, screen, signal, activity) => inspectDrive(f.services, action, screen, signal, activity),
    decide: async (request) => { input = request; return decision.promise; } });
  try {
    drive.start("Explain"); await drive.step(); const reviewing = drive.step();
    const old = input!.inspection!.pages[0]!;
    f.ui.beginTurn({ userText: "New request", at: "later" }); f.ui.assistantDelta("Replacement answer"); f.ui.finishTurn("completed", "Done"); f.ready();
    decision.resolve(choose({ kind: "complete", basis: "answer" }, [{ observationId: old.observationId, quote: "Original completed answer" }]));
    await reviewing;
    expect(drive.state?.status).toBe("waiting"); expect(drive.state?.feedback).toContain("session changed");
    await drive.step(); expect(drive.state?.traces?.at(-1)?.source).toBe("controller");
    expect(drive.state?.status).toBe("running");
  } finally { drive.dispose(); }
});

test("next-work selection can quote a collected latest consultation but cannot reuse it after another turn", async () => {
  const f = fixture(); f.ui.beginTurn({ userText: "Assess useful next work without editing", at: "now" });
  f.ui.assistantDelta("Add cancellation coverage for the image workflow."); f.ui.finishTurn("completed", "Done"); f.ready();
  const packet = await f.collect("answer"), current = request(f.ui, packet);
  current.autonomy = { task: "Review existing work", phase: "discovering", consulted: true, cycle: 1, history: [] };
  const evidence = [{ observationId: packet.pages[0]!.observationId, quote: "Add cancellation coverage" }];
  const decision = choose({ kind: "next_task", task: "Test image cancellation" }, evidence).decision;
  expect(() => validateDriveDecisionContext(decision, parseDriveRequest(current))).not.toThrow();
  current.autonomy.consulted = false;
  expect(() => validateDriveDecisionContext(decision, current)).toThrow("compose a focused question");
  current.autonomy.consulted = true;
  f.ui.beginTurn({ userText: "Follow up", at: "later" }); f.ui.assistantDelta("A different assessment"); f.ui.finishTurn("completed", "Done"); f.ready();
  current.observation = f.ui.observeDrive(); current.memory.evidence = evidence;
  expect(() => validateDriveDecisionContext(decision, current)).toThrow("latest settled answer");
});
