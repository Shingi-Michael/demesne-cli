import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPainter, SLASH_COMMANDS } from "../../../packages/brand/src/index.ts";
import type { DriveAction, DriveDecision, DriveRequest, EventEnvelope } from "@demesne/protocol";
import type { ProviderMessage } from "@demesne/providers";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { createDaemonApp } from "../src/app.ts";
import { planDrive } from "../src/drive-planner.ts";
import { snapshotTurnInference, type TurnProcessor } from "../src/processor.ts";
import { Workbench } from "../../cli/src/workbench/controller.ts";
import { CliContextRail } from "../../cli/src/context-rail.ts";
import { AgentDrive } from "../../cli/src/agent-drive.ts";
import { inspectDrive } from "../../cli/src/drive-inspection.ts";
import { replaySession } from "../../cli/src/workbench/history.ts";

const choose = (action: DriveAction, extra: Partial<DriveDecision> = {}): DriveDecision => ({ action, note: "Inspect and advance the mission", notes: "Recover the requested greeting from history and verify the saved file.", completed: [], remaining: ["Review file"], evidence: [], ...extra });
const request = (): DriveRequest => ({ mission: "Finish the greeting", homeSessionId: "home", memory: { notes: "", completed: [], remaining: [], evidence: [], steps: [] },
  observation: { id: "screen", sessionId: "home", workspace: "/project", title: "Greeting", mode: "input", ready: true, draft: "", surface: "response", width: 80, height: 24, rows: ["Finish the previous request"], controls: [] } });

test.each(["length", "missing", "multiple", "invalid", "valid"])("planner rejects unusable decisions without applying actions: %s", async (kind) => {
  const processor: TurnProcessor = { providerId: "test", modelId: "test", maxOutputTokens: 131072, async listModels() { return []; },
    async *stream(messages, tools, _signal, thinking) {
      expect(thinking).toBeUndefined(); expect(tools.map((tool) => tool.name)).toEqual(["drive_ui"]);
      expect(messages.slice(0, 2).map((message) => message.role)).toEqual(["system", "user"]);
      yield { type: "reasoning_delta", delta: "Inspect visible evidence." };
      if (kind !== "missing") yield { type: "tool_call_delta", index: kind === "multiple" ? 1 : 0, idDelta: "ui", nameDelta: "drive_ui",
        argumentsDelta: kind === "invalid" ? '{"action":' : JSON.stringify(choose({ kind: "key", key: "alt+h" })) };
      yield { type: "finish", reason: kind === "length" ? "length" : "tool_calls" };
    } };
  const planned = planDrive(request(), snapshotTurnInference(processor, undefined), new AbortController().signal);
  if (kind === "valid") expect((await planned).decision.action).toEqual({ kind: "key", key: "alt+h" });
  else await expect(planned).rejects.toThrow();
});

test("planner supplies only the visible artifact's pixels in its separate context", async () => {
  let received: ProviderMessage[] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "vision", async listModels() { return []; }, async *stream(messages) {
    received = messages;
    yield { type: "tool_call_delta", index: 0, idDelta: "ui", nameDelta: "drive_ui", argumentsDelta: JSON.stringify(choose({ kind: "wait" })) };
    yield { type: "finish", reason: "tool_calls" };
  } };
  const planned = await planDrive(request(), snapshotTurnInference(processor, undefined), new AbortController().signal, {}, { id: "artifact", url: "data:image/png;base64,cGl4ZWxz" });
  expect(planned.imageInspected).toBe(true);
  expect(received[1]?.imageInputs).toEqual([{ artifactId: "artifact", url: "data:image/png;base64,cGl4ZWxz" }]);
});

test("completion validation is corrected in the planner before the CLI can reject it", async () => {
  let calls = 0;
  const body = request(); body.mission = "Tell me what we can improve?";
  body.observation.surface = "drive";
  body.observation.rows = ["Prior audit: consolidate menu paths. | Drive notes"];
  body.observation.evidenceRows = ["Prior audit: consolidate menu paths."];
  body.observation.answerRows = ["Prior audit: consolidate menu paths."];
  const corrections: string[] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "test", maxOutputTokens: 131072, async listModels() { return []; }, async *stream(messages, _tools, _signal, thinking) {
    expect(thinking).toBeUndefined();
    if (++calls === 2) {
      expect(messages.at(-1)?.content).toContain("verified-work completion requires");
      expect(messages.at(-1)?.content).toContain("basis: answer");
    }
    yield { type: "tool_call_delta", index: 0, idDelta: "call", nameDelta: "drive_ui", argumentsDelta: JSON.stringify(choose(calls === 1 ? { kind: "complete" } : { kind: "complete", basis: "answer" }, {
      note: "The prior audit recommends consolidating menu paths.", remaining: [], evidence: [{ observationId: body.observation.id, quote: "consolidate menu paths" }],
    })) };
    yield { type: "finish", reason: "tool_calls" };
  } };
  const planned = await planDrive(body, snapshotTurnInference(processor, undefined), new AbortController().signal, {}, undefined, (event) => { if (event.type === "correction") corrections.push(event.message); });
  expect(calls).toBe(2); expect(corrections).toHaveLength(1);
  expect(planned.decision.action).toEqual({ kind: "complete", basis: "answer" });
});

test("implementation completion and advisory completion both require fresh eligible evidence", async () => {
  for (const kind of ["implementation-summary", "own-note", "remaining", "stale"]) {
    let calls = 0;
    const body = request(); body.observation.rows = ["Done"]; body.observation.answerRows = kind === "own-note" ? [] : ["Done"];
    body.memory.evidence = [{ observationId: "earlier", quote: "Done" }];
    const processor: TurnProcessor = { providerId: "test", modelId: "test", async listModels() { return []; }, async *stream() {
      calls++;
      yield { type: "tool_call_delta", index: 0, idDelta: "call", nameDelta: "drive_ui", argumentsDelta: JSON.stringify(choose({ kind: "complete", basis: kind === "implementation-summary" ? "verified-work" : "answer" }, {
        remaining: kind === "remaining" ? ["Unfinished"] : [], evidence: [{ observationId: kind === "stale" ? "earlier" : body.observation.id, quote: "Done" }],
      })) };
      yield { type: "finish", reason: "tool_calls" };
    } };
    await expect(planDrive(body, snapshotTurnInference(processor, undefined), new AbortController().signal)).rejects.toThrow("invalid after one correction");
    expect(calls).toBe(2);
  }
});

test.each(["missing-field", "bad-json", "unknown-target"])("planner corrects a malformed decision once without executing it: %s", async (kind) => {
  let calls = 0;
  const processor: TurnProcessor = { providerId: "test", modelId: "test", maxOutputTokens: 131072, async listModels() { return []; }, async *stream(messages, _tools, signal, thinking) {
    expect(thinking).toBeUndefined(); expect(signal.aborted).toBe(false);
    if (++calls === 2) {
      expect(messages.at(-1)?.role).toBe("tool");
      expect(messages.at(-1)?.content).toContain("No UI action was performed");
      expect(messages.at(-1)?.content).toContain(kind === "missing-field" ? "action.key" : kind === "bad-json" ? "valid JSON" : "action.target");
      const prior = messages.at(-2);
      expect(prior?.role === "assistant" ? prior.toolCalls?.[0]?.id : undefined).toBe("invalid-decision");
    }
    const invalid = kind === "bad-json" ? '{"action":' : JSON.stringify(choose(kind === "unknown-target" ? { kind: "click", target: "absent" } : { kind: "key" } as DriveAction));
    yield { type: "tool_call_delta", index: 0, idDelta: calls === 1 ? "invalid-decision" : "corrected", nameDelta: "drive_ui",
      argumentsDelta: calls === 1 ? invalid : JSON.stringify(choose({ kind: "key", key: "ctrl+b" })) };
    yield { type: "finish", reason: "tool_calls" };
  } };
  const inference = snapshotTurnInference(processor, undefined);
  expect(inference.maxOutputTokens).toBe(131072);
  expect((await planDrive(request(), inference, new AbortController().signal)).decision.action).toEqual({ kind: "key", key: "ctrl+b" });
  expect(calls).toBe(2);
});

test("invalid corrections stop with the exact field, while truncated decisions are never retried", async () => {
  for (const truncated of [false, true]) {
    let calls = 0;
    const processor: TurnProcessor = { providerId: "test", modelId: "test", async listModels() { return []; }, async *stream() {
      calls++;
      yield { type: "tool_call_delta", index: 0, idDelta: "bad", nameDelta: "drive_ui", argumentsDelta: JSON.stringify(choose({ kind: "scroll", row: 0, column: 0, amount: 0 })) };
      yield { type: "finish", reason: truncated ? "length" : "tool_calls" };
    } };
    const pending = planDrive(request(), snapshotTurnInference(processor, undefined), new AbortController().signal);
    if (truncated) await expect(pending).rejects.toThrow();
    else await expect(pending).rejects.toThrow("Drive decision invalid after one correction: Agent Drive action.amount");
    expect(calls).toBe(truncated ? 1 : 2);
  }
});

test("a correction remains cancellable and cannot yield a late action", async () => {
  const controller = new AbortController(); let calls = 0;
  const processor: TurnProcessor = { providerId: "test", modelId: "test", async listModels() { return []; }, async *stream(_messages, _tools, signal) {
    if (++calls === 2) { controller.abort(new Error("Operator paused")); signal.throwIfAborted(); }
    yield { type: "tool_call_delta", index: 0, idDelta: "bad", nameDelta: "drive_ui", argumentsDelta: '{"action":' };
    yield { type: "finish", reason: "tool_calls" };
  } };
  await expect(planDrive(request(), snapshotTurnInference(processor, undefined), controller.signal)).rejects.toThrow("Operator paused");
  expect(calls).toBe(2);
});

test("planner corrects self-cited evidence before navigation without weakening the evidence gate", async () => {
  let calls = 0;
  const body = request();
  body.observation.surface = "drive";
  body.observation.rows = ["Recorded output: 999 pass | Drive: Resuming from the current UI"];
  body.observation.evidenceRows = ["Recorded output: 999 pass"];
  const processor: TurnProcessor = { providerId: "test", modelId: "test", async listModels() { return []; }, async *stream(messages) {
    if (++calls === 2) expect(messages.at(-1)?.content).toContain("evidence[0]");
    yield { type: "tool_call_delta", index: 0, idDelta: "evidence", nameDelta: "drive_ui", argumentsDelta: JSON.stringify(choose({ kind: "key", key: "ctrl+b" }, {
      evidence: [{ observationId: body.observation.id, quote: calls === 1 ? "Resuming from the current UI" : "Recorded output: 999 pass" }],
    })) };
    yield { type: "finish", reason: "tool_calls" };
  } };
  const result = await planDrive(body, snapshotTurnInference(processor, undefined), new AbortController().signal);
  expect(calls).toBe(2); expect(result.decision.evidence[0]?.quote).toBe("Recorded output: 999 pass");
});

test.each([{ continuous: false, hybrid: false }, { continuous: true, hybrid: false }, { continuous: true, hybrid: true }])("end-to-end Drive recovers history, submits work, verifies Diff, and consults for follow-on tasks (%j)", async ({ continuous, hybrid }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "demesne-drive-e2e-")));
  const workspace = join(root, "project"); mkdirSync(workspace); mkdirSync(join(root, "data"));
  let planningStep = 0, homeId = "", workSubmitted = "";
  const observed: DriveRequest[] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "test", async listModels() { return []; }, async *stream(messages, tools) {
    if (tools.length === 1 && tools[0]?.name === "drive_ui") {
      const input = JSON.parse(messages[1]!.content!) as DriveRequest; observed.push(input);
      let action: DriveAction;
      switch (++planningStep) {
        case 1: expect(input.observation.surface).toBe("drive"); action = { kind: "key", key: "escape" }; break;
        case 2: action = { kind: "compose", text: "/sessions greeting" }; break;
        case 3: expect(input.observation.surface).toBe("sessions"); expect(input.observation.rows.join("\n")).toContain("Original greeting"); action = { kind: "key", key: "return" }; break;
        case 4: expect(input.observation.rows.join("\n")).toContain("HELLO DEMESNE"); action = { kind: "compose", text: `/resume ${homeId}` }; break;
        case 5: expect(input.observation.sessionId).toBe(homeId); action = { kind: "compose", text: "Create greeting.ts exporting greeting = 'HELLO DEMESNE', as requested in the original greeting conversation." }; break;
        case 6: action = hybrid ? { kind: "inspect", target: "diff", item: "greeting.ts" } : { kind: "key", key: "alt+d" }; break;
        case 8: expect(input.autonomy?.phase).toBe("discovering"); action = { kind: "compose", text: "Suggest the next useful improvement to the greeting library based on our goals. Assess only; no edits yet." }; break;
        case 9: expect(input.autonomy?.consulted).toBe(true); action = { kind: "next_task", task: "Add a typed usage example" }; break;
        case 10: expect(input.autonomy?.task).toBe("Add a typed usage example"); action = { kind: "compose", text: "Add a typed usage example in usage.ts importing greeting.ts. No commits." }; break;
        case 11: action = hybrid ? { kind: "inspect", target: "diff", item: "usage.ts" } : { kind: "key", key: "alt+d" }; break;
        case 13: expect(input.autonomy?.history).toHaveLength(2); action = { kind: "compose", text: "Assess whether any worthwhile work remains in the greeting library. No edits." }; break;
        case 14: action = { kind: "idle" }; break;
        default: action = { kind: "complete" }; break;
      }
      const complete = action.kind === "complete";
      const quote = planningStep === 9 ? "Add a typed usage example" : planningStep === 14 ? "No worthwhile work remains" : planningStep === 12 ? "greeting.ts" : "HELLO DEMESNE";
      const inspected = hybrid ? input.inspection?.pages.find((page) => page.rows.some((row) => row.includes(quote))) : undefined;
      if (complete) { expect(input.observation.surface).toBe("diff"); expect((inspected?.rows ?? input.observation.rows).join("\n")).toContain(quote); }
      if (action.kind === "next_task" || action.kind === "idle") {
        const indexes = (input.observation as typeof input.observation & { latestAnswerRowIndexes?: number[] }).latestAnswerRowIndexes;
        expect((inspected?.rows ?? input.observation.latestAnswerRows ?? indexes?.map((index) => input.observation.rows[index]!))?.join("\n")).toContain(quote);
        if (hybrid) expect(inspected?.latest).toBe(true);
      }
      yield { type: "tool_call_delta", index: 0, idDelta: `step-${planningStep}`, nameDelta: "drive_ui", argumentsDelta: JSON.stringify(choose(action,
        complete || action.kind === "next_task" || action.kind === "idle" ? { remaining: [], completed: ["Work reviewed"], evidence: [{ observationId: inspected?.observationId ?? input.observation.id, quote }] } : {})) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    const prompt = messages.findLast((message) => message.role === "user")?.content ?? "";
    if (prompt.startsWith("Remember")) { yield { type: "text_delta", delta: "The greeting must say HELLO DEMESNE. Implementation is still pending." }; }
    else if (prompt.startsWith("Suggest")) { yield { type: "text_delta", delta: "Add a typed usage example to show consumers how to import the greeting." }; }
    else if (prompt.startsWith("Assess")) { yield { type: "text_delta", delta: "No worthwhile work remains in this greeting-library scope." }; }
    else if (!messages.slice(messages.findLastIndex((message) => message.role === "user")).some((message) => message.role === "tool")) {
      workSubmitted = prompt;
      yield { type: "tool_call_delta", index: 0, idDelta: "write", nameDelta: "write_file", argumentsDelta: JSON.stringify(prompt.startsWith("Add a typed")
        ? { path: "usage.ts", content: 'import { greeting } from "./greeting.ts";\nexport const message: string = greeting;\n' }
        : { path: "greeting.ts", content: "export const greeting = 'HELLO DEMESNE';\n" }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    } else yield { type: "text_delta", delta: "Created greeting.ts. Please review the applied Diff." };
    yield { type: "finish", reason: "stop" };
  } };
  const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), processor });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url, init)))) as typeof fetch });
  const rail = new CliContextRail({ id: "test", provider: "test" }, workspace);
  const ui = new Workbench({ paint: createPainter(false), contextRail: rail, sessionTitle: "Greeting", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} },
    drive: { control() {}, intervene() {}, waitForFrame: async () => {} } });
  let outgoing: string | undefined;
  const prompt = () => { outgoing = undefined; void ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }).then((value) => { outgoing = value; }); };
  const restore = async (id: string) => {
    const state = await client.getSessionState(id);
    const events = await replaySession(state, (id, after, signal) => client.streamEvents(id, after, signal), (id, after, through, signal) => client.replayPage(id, after, through, signal));
    ui.restoreSession(state, events); ui.frame(140, 40); prompt();
  };
  const driveUI = { observe: () => ui.observeDrive(), perform: (action: DriveAction, screen: DriveRequest["observation"], signal: AbortSignal) => ui.performDrive(action, screen, signal) };
  const drive = new AgentDrive({ continuous, path: join(root, "drive.json"), ...driveUI,
    ...(hybrid ? { inspect: (action, screen, signal, activity) => inspectDrive(driveUI, action, screen, signal, activity) } : {}),
    decide: (body, signal, progress) => client.decideDrive(body, signal, progress), changed: (state) => ui.setDrive(state), delayMs: 60_000 });
  const review = async () => {
    if (hybrid) await drive.step(); // Settled answer collected locally.
    await drive.step(); // Planner selects result inspection.
    if (hybrid) await drive.step(); // Diff collected locally.
    await drive.step(); // Planner judges the result.
  };
  try {
    const old = (await client.createSession({ title: "Original greeting", workspacePath: workspace })).session;
    const prior = await client.submitTurn(old.id, { content: "Remember: greeting must say HELLO DEMESNE.", permissionMode: "deny" });
    for await (const event of client.streamEvents(old.id, prior.eventId, AbortSignal.timeout(5000))) if (event.type === "turn.completed") break;
    const home = (await client.createSession({ title: "Finish greeting", workspacePath: workspace })).session; homeId = home.id;
    await restore(homeId); drive.start("Finish the greeting from the previous conversation"); ui.showDrive();
    await drive.step(); await drive.step(); expect(drive.state?.activity).toBe("Inspect and advance the mission"); expect(outgoing).toBe("/sessions greeting");
    let selected: number | null | undefined;
    const picker = ui.choose('Sessions matching "greeting"', ["Original greeting", "Finish greeting"]).then((index) => { selected = index; });
    await drive.step(); await picker; expect(selected).toBe(0);
    await restore(old.id); await drive.step(); expect(outgoing).toBe(`/resume ${homeId}`);
    await restore(homeId); await drive.step(); expect(outgoing).toContain("HELLO DEMESNE");
    ui.beginTurn({ userText: outgoing!, at: "now" });
    const submitted = await client.submitTurn(homeId, { content: outgoing!, permissionMode: "ask" });
    const events: EventEnvelope[] = [];
    for await (const event of client.streamEvents(homeId, submitted.eventId, AbortSignal.timeout(5000))) {
      events.push(event);
      if (event.type === "permission.requested") {
        void ui.askApproval({ summary: "Create greeting.ts", allowPersist: false });
        await drive.step(); expect(planningStep).toBe(5); expect(drive.state?.status).toBe("waiting");
        expect(existsSync(join(workspace, "greeting.ts"))).toBe(false);
        await client.resolvePermission(String(event.payload.permissionId), "allow_once");
      }
      if (/^turn\.(completed|failed|interrupted)$/.test(event.type)) break;
    }
    expect(workSubmitted).toContain("as requested in the original greeting conversation");
    await restore(homeId); await review();
    expect(drive.state?.status).toBe(continuous ? "running" : "completed"); expect(drive.state?.evidence[0]?.quote).toBe("HELLO DEMESNE");
    expect(readFileSync(join(workspace, "greeting.ts"), "utf8")).toContain("HELLO DEMESNE");
    expect((await client.getSessionState(homeId)).session.turns).toHaveLength(1);
    expect(observed).toHaveLength(7); expect(observed[4]?.memory.notes).toContain("history");
    if (continuous) {
      const send = async () => {
        const content = outgoing!; expect(content).toBeTruthy();
        ui.beginTurn({ userText: content, at: "now" });
        const submitted = await client.submitTurn(homeId, { content, permissionMode: "ask" });
        for await (const event of client.streamEvents(homeId, submitted.eventId, AbortSignal.timeout(5000))) {
          if (event.type === "permission.requested") await client.resolvePermission(String(event.payload.permissionId), "allow_once");
          if (/^turn\.(completed|failed|interrupted)$/.test(event.type)) { expect(event.type).toBe("turn.completed"); break; }
        }
        await restore(homeId);
      };
      await drive.step(); expect(outgoing).toContain("Assess only"); await send();
      if (hybrid) await drive.step();
      await drive.step(); expect(drive.state?.autonomy).toMatchObject({ cycle: 2, phase: "working", task: "Add a typed usage example" });
      await drive.step(); expect(outgoing).toContain("usage.ts"); await send();
      await review(); expect(drive.state?.autonomy?.history).toHaveLength(2);
      expect(readFileSync(join(workspace, "usage.ts"), "utf8")).toContain('import { greeting }');
      await drive.step(); expect(outgoing).toContain("Assess whether"); await send();
      if (hybrid) await drive.step();
      await drive.step(); expect(drive.state?.status).toBe("idle");
      expect((await client.getSessionState(homeId)).session.turns).toHaveLength(4);
      expect(observed).toHaveLength(14);
    }
    expect(new AgentDrive({ observe: () => ui.observeDrive(), perform: async () => "", decide: async () => { throw new Error("must not run"); }, changed() {}, path: join(root, "drive.json") }).state?.status).toBe(continuous ? "idle" : "completed");
  } finally { drive.dispose(); await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test.each(["keep_working", "redirect"] as const)("live %s check-in shares one slot at a coder round boundary and uses real cancellation/composer routes", async verdict => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "drive-check-in-"))), workspace = join(root, "project"); mkdirSync(workspace); mkdirSync(join(root, "data"));
  const releaseRound = Promise.withResolvers<void>(), reviewEntered = Promise.withResolvers<void>(), finishReview = Promise.withResolvers<void>();
  const workerVisible = Promise.withResolvers<void>(), reviewQueued = Promise.withResolvers<void>(), finishWorker = Promise.withResolvers<void>();
  let workerRounds = 0, planning = 0, now = 0, roundReleased = false;
  const wait = (promise: Promise<void>, signal: AbortSignal) => Promise.race([promise, new Promise<void>((_, reject) => {
    if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })]);
  const processor: TurnProcessor = { providerId: "test", modelId: "test", maxOutputTokens: 131072, async listModels() { return []; }, async *stream(messages, tools, signal) {
    if (tools[0]?.name === "drive_ui") {
      planning++;
      const input = JSON.parse(messages[1]!.content!) as DriveRequest;
      let decision = choose({ kind: "compose", text: "Inspect parser behavior read-only. No edits or commits." });
      if (input.checkIn) {
        expect(roundReleased).toBe(true);
        expect(messages[0]?.content).toContain("periodic CHECK-IN");
        expect(input.observation.mode).toBe("streaming"); expect(workerRounds).toBe(1);
        reviewEntered.resolve(); await wait(finishReview.promise, signal);
        decision = choose(verdict === "keep_working" ? { kind: "keep_working" } : { kind: "redirect", text: "Inspect parser behavior only; abandon the rewrite. No edits or commits." }, {
          evidence: verdict === "redirect" ? [{ observationId: input.observation.id, quote: "Rewrite all parser files" }] : [],
        });
      }
      yield { type: "tool_call_delta", index: 0, idDelta: "plan", nameDelta: "drive_ui", argumentsDelta: JSON.stringify(decision) };
      yield { type: "usage", usage: { inputTokens: 300, outputTokens: 100, totalTokens: 400 } };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (++workerRounds === 1) {
      yield { type: "reasoning_delta", delta: "Rewrite all parser files to replace the whole implementation." };
      await wait(releaseRound.promise, signal);
      roundReleased = true;
      yield { type: "tool_call_delta", index: 0, idDelta: "read", nameDelta: "list_files", argumentsDelta: '{"path":"."}' };
      yield { type: "finish", reason: "tool_calls" };
    } else {
      await wait(finishWorker.promise, signal);
      yield { type: "text_delta", delta: "Read-only parser assessment finished." }; yield { type: "finish", reason: "stop" };
    }
  } };
  const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), processor, inferenceSlots: 1 });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url, init)))) as typeof fetch });
  const ui = new Workbench({ paint: createPainter(false), contextRail: new CliContextRail({ id: "test", provider: "test" }, workspace), sessionTitle: "Check-in", version: "test",
    onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} }, drive: { control() {}, intervene() {}, waitForFrame: async () => {} } });
  let outgoing: Promise<string | undefined>, drive: AgentDrive | undefined, eventsTask: Promise<void> | undefined;
  const prompt = () => { outgoing = ui.readPrompt({ history: [], commands: SLASH_COMMANDS, mentions: [] }); ui.frame(140, 40); };
  try {
    const session = (await client.createSession({ title: "Read-only parser review", workspacePath: workspace })).session;
    ui.restoreSession(await client.getSessionState(session.id)); prompt();
    drive = new AgentDrive({ observe: () => ui.observeDrive(), perform: (action, screen, signal) => ui.performDrive(action, screen, signal), changed: state => ui.setDrive(state),
      now: () => now, limits: { checkInIntervalSeconds: 1 }, delayMs: 60_000,
      decide: (body, signal, progress) => client.decideDrive(body, signal, event => { if (body.checkIn && event.type === "queued") reviewQueued.resolve(); progress(event); }),
      cancelWorker: async turnId => (await client.cancelTurn(turnId)).turn.status === "cancelled" });
    drive.start("Inspect parser behavior read-only. No edits or commits."); await drive.step();
    const text = (await outgoing!)!; ui.beginTurn({ userText: text, at: "now" });
    const submitted = await client.submitTurn(session.id, { content: text, permissionMode: "deny" }); drive.workerStarted(session.id, text, submitted.turn.id);
    eventsTask = (async () => {
      for await (const event of client.streamEvents(session.id, submitted.eventId, AbortSignal.timeout(8000))) {
        if (event.turnId !== submitted.turn.id) continue;
        drive!.workerEvent(event);
        if (event.type === "reasoning.delta") { ui.reasoningDelta(String(event.payload.delta)); ui.frame(140, 40); workerVisible.resolve(); }
        if (event.type === "message.delta") ui.assistantDelta(String(event.payload.delta));
        if (/^turn\.(completed|cancelled|failed|interrupted)$/.test(event.type)) {
          ui.finishTurn(event.type === "turn.completed" ? "completed" : "stopped", "Settled"); prompt(); return;
        }
      }
    })();
    await workerVisible.promise; now = 1001;
    const checking = drive.step(); await reviewQueued.promise;
    expect((await client.status()).activeInferences).toBe(1);
    releaseRound.resolve(); await reviewEntered.promise;
    expect(workerRounds).toBe(1); finishReview.resolve(); await checking;
    if (verdict === "keep_working") { expect(drive.state?.protection?.used.redirects).toBe(0); finishWorker.resolve(); }
    await eventsTask;
    const saved = await client.getSessionState(session.id);
    expect(saved.session.turns[0]?.status).toBe(verdict === "redirect" ? "cancelled" : "completed");
    if (verdict === "redirect") { await drive.step(); expect(await outgoing!).toContain("abandon the rewrite"); expect(drive.state?.protection?.used.redirects).toBe(1); }
    expect(planning).toBe(2); expect(drive.state?.protection?.used.checkIns).toBe(1);
  } finally {
    releaseRound.resolve(); finishReview.resolve(); finishWorker.resolve(); drive?.dispose(); await eventsTask?.catch(() => {}); await app.close(); rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test("daemon authenticates Drive and aborts pending planning before shutting down", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-drive-close-")); const entered = Promise.withResolvers<void>(); let aborted = false;
  mkdirSync(join(root, "project")); mkdirSync(join(root, "data"));
  const processor: TurnProcessor = { providerId: "test", modelId: "test", async listModels() { return []; }, async *stream(_messages, _tools, signal) {
    entered.resolve(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true })); signal.throwIfAborted();
  } };
  const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), processor, authToken: "test-token" });
  const client = new DemesneClient({ server: "http://localhost", token: "test-token", fetch: ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url, init)))) as typeof fetch });
  try {
    expect((await app.fetch(new Request("http://localhost/v1/drive/decide", { method: "POST" }))).status).toBe(401);
    const session = (await client.createSession({ title: "Mission", workspacePath: join(root, "project") })).session;
    const body = request(); body.homeSessionId = session.id; body.observation.sessionId = session.id; body.observation.workspace = session.workspace!.root;
    const pending = client.decideDrive(body).catch((error) => error);
    await entered.promise; await app.close(); await pending; expect(aborted).toBe(true);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
