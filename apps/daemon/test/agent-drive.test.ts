import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveAction, DriveDecision, DriveRequest } from "@demesne/protocol";
import type { ProviderMessage } from "@demesne/providers";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { createDaemonApp } from "../src/app.ts";
import { planDrive } from "../src/drive-planner.ts";
import { snapshotTurnInference, type TurnProcessor } from "../src/processor.ts";

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
  const planned = planDrive(request(), (thinking) => snapshotTurnInference(processor, thinking), new AbortController().signal);
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
  const planned = await planDrive(request(), (thinking) => snapshotTurnInference(processor, thinking), new AbortController().signal, {}, { id: "artifact", url: "data:image/png;base64,cGl4ZWxz" });
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
    // The first attempt uses the client's choice (none here); the correction thinks.
    expect(thinking).toBe(calls === 0 ? undefined : true);
    if (++calls === 2) {
      expect(messages.at(-1)?.content).toContain("verified-work completion requires");
      expect(messages.at(-1)?.content).toContain("basis: answer");
    }
    yield { type: "tool_call_delta", index: 0, idDelta: "call", nameDelta: "drive_ui", argumentsDelta: JSON.stringify(choose(calls === 1 ? { kind: "complete" } : { kind: "complete", basis: "answer" }, {
      note: "The prior audit recommends consolidating menu paths.", remaining: [], evidence: [{ observationId: body.observation.id, quote: "consolidate menu paths" }],
    })) };
    yield { type: "finish", reason: "tool_calls" };
  } };
  const planned = await planDrive(body, (thinking) => snapshotTurnInference(processor, thinking), new AbortController().signal, {}, undefined, (event) => { if (event.type === "correction") corrections.push(event.message); });
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
    await expect(planDrive(body, (thinking) => snapshotTurnInference(processor, thinking), new AbortController().signal)).rejects.toThrow("invalid after one correction");
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
  expect((await planDrive(request(), () => inference, new AbortController().signal)).decision.action).toEqual({ kind: "key", key: "ctrl+b" });
  expect(calls).toBe(2);
});

test("invalid corrections stop with the exact field; a decision that thinks past its cap is retried once without thinking", async () => {
  for (const truncated of [false, true]) {
    let calls = 0;
    const thinkingByCall: (boolean | undefined)[] = [];
    const processor: TurnProcessor = { providerId: "test", modelId: "test", async listModels() { return []; }, async *stream(_messages, _tools, _signal, thinking) {
      calls++; thinkingByCall.push(thinking);
      yield { type: "tool_call_delta", index: 0, idDelta: "bad", nameDelta: "drive_ui", argumentsDelta: JSON.stringify(choose({ kind: "scroll", row: 0, column: 0, amount: 0 })) };
      yield { type: "finish", reason: truncated ? "length" : "tool_calls" };
    } };
    const pending = planDrive(request(), (thinking) => snapshotTurnInference(processor, thinking), new AbortController().signal);
    if (truncated) await expect(pending).rejects.toThrow("output token limit");
    else await expect(pending).rejects.toThrow("Drive decision invalid after one correction: Agent Drive action.amount");
    // Two calls either way: a correction that thinks, or one quick retry after
    // the cap — never a third, so a decision cannot loop.
    expect(calls).toBe(2);
    expect(thinkingByCall).toEqual(truncated ? [undefined, false] : [undefined, true]);
  }
});

test("a correction remains cancellable and cannot yield a late action", async () => {
  const controller = new AbortController(); let calls = 0;
  const processor: TurnProcessor = { providerId: "test", modelId: "test", async listModels() { return []; }, async *stream(_messages, _tools, signal) {
    if (++calls === 2) { controller.abort(new Error("Operator paused")); signal.throwIfAborted(); }
    yield { type: "tool_call_delta", index: 0, idDelta: "bad", nameDelta: "drive_ui", argumentsDelta: '{"action":' };
    yield { type: "finish", reason: "tool_calls" };
  } };
  await expect(planDrive(request(), (thinking) => snapshotTurnInference(processor, thinking), controller.signal)).rejects.toThrow("Operator paused");
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
  const result = await planDrive(body, (thinking) => snapshotTurnInference(processor, thinking), new AbortController().signal);
  expect(calls).toBe(2); expect(result.decision.evidence[0]?.quote).toBe("Recorded output: 999 pass");
});

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
    const session = (await client.createSession({ title: "Mission", workspacePath: join(root, "project"), trustWorkspace: true })).session;
    const body = request(); body.homeSessionId = session.id; body.observation.sessionId = session.id; body.observation.workspace = session.workspace!.root;
    const pending = client.decideDrive(body).catch((error) => error);
    await entered.promise; await app.close(); await pending; expect(aborted).toBe(true);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Drive caps each decision's output: quick steps lower than thinking ones, never above the configured limit", async () => {
  const seen: (number | undefined)[] = [];
  const processor = { providerId: "test", modelId: "test", maxOutputTokens: 131072, async listModels() { return []; },
    createTurnInference(thinking: boolean | undefined, overrides?: { maxOutputTokens?: number }) {
      seen.push(overrides?.maxOutputTokens);
      return snapshotTurnInference({ providerId: "test", modelId: "test", maxOutputTokens: Math.min(131072, overrides?.maxOutputTokens ?? 131072), async listModels() { return []; },
        async *stream() { yield { type: "tool_call_delta" as const, index: 0, idDelta: "ok", nameDelta: "drive_ui", argumentsDelta: JSON.stringify(choose({ kind: "key", key: "ctrl+b" })) }; yield { type: "finish" as const, reason: "tool_calls" }; } } as TurnProcessor, thinking);
    } } as unknown as TurnProcessor;
  const { DRIVE_QUICK_TOKENS, DRIVE_THOUGHT_TOKENS } = await import("../src/drive-planner.ts");
  const inferenceFor = (thinking: boolean | undefined) => snapshotTurnInference(processor, thinking, { maxOutputTokens: thinking === false ? DRIVE_QUICK_TOKENS : DRIVE_THOUGHT_TOKENS });
  await planDrive({ ...request(), thinking: false }, inferenceFor, new AbortController().signal);
  await planDrive({ ...request(), thinking: true }, inferenceFor, new AbortController().signal);
  expect(seen).toEqual([8_000, 16_000]);
});
