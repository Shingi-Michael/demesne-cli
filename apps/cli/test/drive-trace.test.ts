import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPainter, SLASH_COMMANDS, visibleLength } from "@demesne/brand";
import type { DriveResponse, DriveState } from "@demesne/protocol";
import { AgentDrive, DriveJournal } from "../src/agent-drive.ts";
import { beginDriveTrace, updateDriveTrace } from "../src/drive-trace.ts";
import { Workbench } from "../src/workbench/controller.ts";
import { CliContextRail } from "../src/context-rail.ts";
import { renderDrivePanel } from "../src/workbench/drive-panel.ts";
import { SessionView } from "../src/workbench/session.ts";

const state = (): DriveState => ({ id: "mission", mission: "Inspect the saved result", homeSessionId: "home", workspace: "/project", status: "running", activity: "Planning", step: 0,
  model: "test / model", updatedAt: new Date().toISOString(), notes: "", completed: [], remaining: ["Review"], evidence: [], steps: [] });
const response = (): DriveResponse => ({ provider: "test", model: "model", imageInspected: false,
  decision: { action: { kind: "key", key: "ctrl+b" }, note: "Inspect saved checks", notes: "Reviewing", completed: [], remaining: ["Review"], evidence: [] } });

test("thinking streams into the operator UI before action and is excluded from planner observations", async () => {
  const received = Promise.withResolvers<void>(), gate = Promise.withResolvers<DriveResponse>(); let actions = 0;
  let drive: AgentDrive;
  const ui = new Workbench({ paint: createPainter(false), contextRail: new CliContextRail({ id: "model", provider: "test" }, "/project"), sessionTitle: "Review", version: "test",
    onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} }, drive: { control: (control) => drive.control(control), intervene: () => drive.intervene(), waitForFrame: async () => {} } });
  (ui as unknown as { sessionId: string }).sessionId = "home";
  ui.beginTurn({ userText: "Review", at: "now" }); ui.assistantDelta("Saved result"); ui.finishTurn("completed", "Done");
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.frame(140, 36); ui.showDrive();
  drive = new AgentDrive({ observe: () => ui.observeDrive(), changed: (state) => { ui.setDrive(state); if (state?.traces?.at(-1)?.reasoning) received.resolve(); },
    perform: async (action, screen, signal) => { actions++; return ui.performDrive(action, screen, signal); },
    decide: async (request, _signal, progress) => {
      expect(JSON.stringify(request)).not.toContain("PRIVATE PLANNING TEXT");
      progress({ type: "attempt", attempt: 1, provider: "test", model: "model" });
      progress({ type: "reasoning.delta", delta: "PRIVATE PLANNING TEXT: inspect the log first." });
      progress({ type: "action.delta", delta: '{"action":{"kind":"key","key":"ctrl+b"},"note":"Inspect saved checks"' });
      return gate.promise;
    }, delayMs: 60_000 });
  try {
    drive.start("Review"); const pending = drive.step(); await received.promise;
    expect(actions).toBe(0);
    // Drive's thinking stays out of the panel until Details is opened.
    expect(ui.frame(140, 36).rows.join("\n")).not.toContain("PRIVATE PLANNING TEXT");
    (ui as unknown as { sessionView: SessionView }).sessionView.act({ kind: "drive-section-toggle", section: "details" });
    expect(ui.frame(140, 36).rows.join("\n")).toContain("PRIVATE PLANNING TEXT");
    expect(JSON.stringify(ui.observeDrive())).not.toContain("PRIVATE PLANNING TEXT");
    // Close only Drive's panel while inference is pending: the compact card
    // remains visible next to the surface the agent is actually inspecting.
    const input = ui as unknown as { onKeypress(text: string, key: { name: string }): void };
    input.onKeypress("", { name: "escape" });
    expect(drive.state?.status).toBe("running");
    const card = ui.frame(140, 36).rows.join("\n"); expect(card).toContain("DRIVE · CHOOSING ACTION"); expect(card).toContain("Inspect saved checks");
    expect(JSON.stringify(ui.observeDrive())).not.toContain("PRIVATE PLANNING TEXT");
    gate.resolve(response()); await pending;
    expect(drive.state?.traces?.at(-1)?.status).toBe("completed");
    expect(drive.state?.traces?.at(-1)?.reasoning).toContain("PRIVATE PLANNING TEXT");
  } finally { gate.resolve(response()); drive.dispose(); }
});

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

test("trace panel follows streaming output, holds a reading offset, and exposes clickable thinking", () => {
  const s = state(); beginDriveTrace(s);
  updateDriveTrace(s, { type: "attempt", attempt: 1, provider: "test", model: "model" });
  updateDriveTrace(s, { type: "reasoning.delta", delta: Array.from({ length: 60 }, (_, i) => `Thinking line ${i}`).join("\n") });
  const paint = createPainter(false);
  const details = new Set(["details"] as const);
  const live = renderDrivePanel(44, 24, paint, s, 0, { follow: true, sections: details });
  expect(live.rows.join("\n")).toContain("Thinking line 59"); expect(live.rows.at(-1)).toContain("P pause"); expect(live.rows.join("\n")).toContain("THINKING");
  const held = renderDrivePanel(44, 24, paint, s, 12, { sections: details });
  updateDriveTrace(s, { type: "reasoning.delta", delta: "\nLatest thinking line" });
  expect(renderDrivePanel(44, 24, paint, s, 12, { sections: details }).rows).toEqual(held.rows);
  for (const width of [20, 40, 80]) {
    const panel = renderDrivePanel(width, 24, paint, s, 0, { collapsed: new Set([s.traces![0]!.id]), follow: true, sections: details });
    expect(panel.rows.every((row) => visibleLength(row) <= width)).toBe(true);
    expect(panel.zones.some((zone) => zone.action.kind === "drive-trace-toggle")).toBe(true);
    expect(panel.rows.join("\n")).not.toContain("Thinking line 59");
  }
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

test("Drive reading snapshots survive new steps; Live catches up and streamed rows advance gradually", () => {
  const s = state(); beginDriveTrace(s);
  updateDriveTrace(s, { type: "reasoning.delta", delta: Array.from({ length: 40 }, (_, i) => `Read line ${i}`).join("\n") });
  const view = new SessionView(), paint = createPainter(false);
  view.act({ kind: "drive-open" });
  const render = (now: number) => view.render({ width: 44, height: 24, paint, title: "Review", path: "/project", panel: true, drive: s, now, animateScroll: true, markdown: () => [] }).rows;
  render(900);
  // The live reasoning stream lives under Details; opening it, then Live, follows it.
  view.act({ kind: "drive-section-toggle", section: "details" });
  view.act({ kind: "drive-follow" });
  render(1000);
  view.key({ name: "pageup" });
  const held = render(1100).slice(4);
  s.notes = "Changed mission notes\n".repeat(10);
  beginDriveTrace(s); updateDriveTrace(s, { type: "reasoning.delta", delta: "Next decision" });
  expect(render(1200).slice(4)).toEqual(held);
  view.key({ name: "g", ctrl: true });
  expect(render(1300).join("\n")).toContain("Next decision");
  updateDriveTrace(s, { type: "reasoning.delta", delta: Array.from({ length: 20 }, (_, i) => `\nNew line ${i}`).join("") });
  expect(render(1301).join("\n")).not.toContain("New line 19");
  expect(view.animating(1301)).toBe(true);
  for (let now = 1320; now <= 2000; now += 20) render(now);
  expect(render(2020).join("\n")).toContain("New line 19");
  expect(view.animating(2020)).toBe(false);
});

test("the Drive panel shows a status line per state, buttons where Drive holds, and keycap controls", () => {
  const paint = createPainter(false), now = Date.parse("2026-09-29T12:00:00Z");
  const panel = (over: Partial<DriveState>) => renderDrivePanel(44, 24, paint, { ...state(), step: 57, updatedAt: new Date(now - 30_000).toISOString(), ...over }, 0, { now });
  const text = (over: Partial<DriveState>) => panel(over).rows.join("\n");
  const step = (action: object, note = "Reason for it.") => ({ steps: [{ step: 57, action: JSON.stringify(action), note, result: "", at: "" }] });
  expect(text(step({ kind: "keep_working" }, "On task."))).toMatch(/✓ Keep working[\s\S]*On task\./);
  expect(text(step({ kind: "redirect", text: "Stay test-only." }, "It drifted."))).toMatch(/↻ Redirected the coder[\s\S]*Sent: “Stay test-only\.”/);
  expect(text(step({ kind: "next_task", task: "Add the regression test" }))).toMatch(/→ Next task[\s\S]*Add the regression test/);
  expect(text({ status: "waiting", activity: "Coder is drafting." })).toContain("◌ Coder is working");
  expect(text({ status: "completed", activity: "All checks pass." })).toMatch(/✓ Mission complete[\s\S]*step 57/);
  expect(text({ recovery: { kind: "transient", attempt: 2, limit: 5, retryAt: now + 12_000, message: "Connection reset." } })).toMatch(/↻ Retrying in 12s[\s\S]*attempt 2 of 5/);
  // Paused and blocked hold for you: Resume and Stop buttons, and P resumes.
  const paused = panel({ status: "paused" });
  expect(paused.rows.join("\n")).toMatch(/‖ Paused[\s\S]*p {2}Resume {4}s {2}Stop/);
  expect(paused.zones.filter((zone) => zone.action.kind === "drive-control").map((zone) => zone.action.kind === "drive-control" && zone.action.control)).toEqual(["resume", "stop", "resume", "stop"]);
  expect(paused.rows.at(-1)).toContain("P resume  S stop  Alt+J hide");
  // A running mission pauses from the footer; details stay folded until opened.
  const running = panel(step({ kind: "keep_working" }));
  expect(running.rows.at(-1)).toContain("P pause  S stop  Alt+J hide");
  expect(running.rows.join("\n")).toContain("▸ Details");
  expect(running.rows.join("\n")).not.toContain("MISSION");
  const open = renderDrivePanel(44, 40, paint, { ...state(), ...step({ kind: "keep_working" }) }, 0, { now, sections: new Set(["details"]) });
  expect(open.rows.join("\n")).toMatch(/▾ Details[\s\S]*MISSION[\s\S]*Inspect the saved result/);
});

test("P and S control Drive only while its panel has focus and the draft is empty", () => {
  const controls: string[] = [];
  const ui = new Workbench({ paint: createPainter(false), contextRail: new CliContextRail({ id: "model", provider: "test" }, "/project"), sessionTitle: "Review", version: "test",
    drive: { control: (control) => controls.push(control), intervene() {} }, onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} } });
  const internals = ui as unknown as { onKeypress(text: string, key: object): void; editor: { value: string } };
  void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] });
  ui.setDrive(state()); ui.showDrive(); ui.frame(120, 30);
  internals.onKeypress("p", { name: "p" });
  expect(controls).toEqual(["pause"]);
  ui.setDrive({ ...state(), status: "paused" }); ui.frame(120, 30);
  internals.onKeypress("p", { name: "p" }); internals.onKeypress("s", { name: "s" });
  expect(controls).toEqual(["pause", "resume", "stop"]);
  // With a draft, letters type as usual.
  internals.onKeypress("x", { name: "x" }); ui.showDrive(); ui.frame(120, 30);
  internals.onKeypress("p", { name: "p" });
  expect(controls).toHaveLength(3);
  ui.stop();
});

test("the Drive panel is status + timeline: a two-line summary, steps in a few words, plain tasks, the rest under Details", () => {
  const paint = createPainter(false), now = Date.parse("2026-09-29T12:00:00Z");
  const long = "Yes, the retry did not supersede the earlier audit. The follow-up reports two priorities that were omitted, not disproved, and no edits or commits were made.";
  const steps = [
    { step: 1, action: JSON.stringify({ kind: "compose", text: "Inspect the UI with an Astra sub-agent and report findings." }), note: "Asked the coder.", result: "Sent through the visible composer: …", at: new Date(now - 120_000).toISOString() },
    { step: 2, action: JSON.stringify({ kind: "inspect", target: "answer" }), note: "Collecting.", result: "Controller inspected 1 visible answer views", at: new Date(now - 60_000).toISOString() },
    { step: 3, action: JSON.stringify({ kind: "key", key: "alt+d" }), note: "Open diff.", result: "UI changed since observation; inspect again before acting.", at: new Date(now - 30_000).toISOString() },
    { step: 4, action: JSON.stringify({ kind: "complete", basis: "answer" }), note: long, result: long, at: new Date(now - 1_000).toISOString() },
  ];
  const mission = { ...state(), status: "completed" as const, activity: long, step: 4, steps, answer: "The full answer for the person.",
    remaining: ["anything else?"], completed: [], ledger: { version: 1 as const, currentTaskId: "39a8a3b0aaaa", tasks: [{ id: "39a8a3b0aaaa", title: "anything else?", status: "completed" as const,
      criteria: ["Something"], completions: [], workerTurns: [], createdAt: "", updatedAt: "" }] } } as unknown as DriveState;
  const text = renderDrivePanel(48, 40, paint, mission, 0, { now }).rows.join("\n");
  expect(text).toContain("✓ Mission complete");
  // The long note is two lines at most, ending in an ellipsis.
  expect(text).toContain("…");
  expect(text).not.toContain("no edits or commits were made");
  expect(text).toMatch(/TIMELINE[\s\S]*→ Sent: Inspect the UI with an Astra[\s\S]*2m[\s\S]*◇ Read the coder's answer[\s\S]*Pressed alt\+d \(screen[\s\S]*✓ Answered/);
  // Tasks once, without the record ID or criteria.
  expect(text.match(/anything else\?/g)).toHaveLength(1);
  expect(text).not.toContain("39a8a3b0"); expect(text).not.toContain("Something");
  expect(text).not.toContain("The full answer");
  const open = renderDrivePanel(72, 80, paint, mission, 0, { now, sections: new Set(["details"]) }).rows.join("\n");
  expect(open).toMatch(/ANSWER[\s\S]*The full answer for the person\.[\s\S]*MISSION/);
  expect(open).toContain("/drive reopen <task-id> <reason>"); expect(open).toContain("39a8a3b0 · anything else?");
});
