import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readServerSentEvents,
  type ArchiveSessionResponse,
  type ContextPlan,
  type CreateSessionResponse,
  type DaemonStatusResponse,
  type EventEnvelope,
  type Session,
  type SessionStateResponse,
  type SubmitTurnResponse,
  type TurnChangesResponse,
  type UndoTurnResponse,
  type UpdateSessionResponse,
  type WorkspaceFilesResponse,
} from "@demesne/protocol";
import { ProviderError, type ProviderAdapter, type ProviderMessage } from "@demesne/providers";
import { DemesneStore } from "@demesne/storage";
import { createDaemonApp, type DaemonApp, type TurnProcessor } from "../src/app.ts";
import { createInferenceRecycleController } from "../src/inference-recycle-controller.ts";
import type { InferenceBoundaryHook } from "../src/inference-scheduler.ts";
import { ProviderTurnProcessor } from "../src/provider-processor.ts";
import { ANSWER_FORMAT_GUIDANCE } from "../src/engine.ts";
import { isolatedCliEnv } from "../../cli/test/isolated-env.ts";

const temporaryDirectories: string[] = [];
const servers: Bun.Server<unknown>[] = [];
const apps: DaemonApp[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const app of apps.splice(0)) await app.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Demesne daemon", () => {
  test("streams a prompt through the command-line client", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const running = startApp(join(directory, "demesne.sqlite"));
    const cliPath = join(import.meta.dir, "../../cli/src/main.ts");
    const child = Bun.spawn(
      [process.execPath, cliPath, "--server", running.url.href, "prompt", "Exercise the full path"],
      { env: isolatedCliEnv({ HOME: directory }), stdout: "pipe", stderr: "pipe" },
    );

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/^Session [0-9a-f-]+\n$/);
    expect(stdout).toBe("Request accepted: Exercise the full path\n");
  });

  test("cancels a command-line turn on SIGINT", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const processor: TurnProcessor = {
      providerId: "test-provider",
      modelId: "slow-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream(_messages, _tools, signal) {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const cliPath = join(import.meta.dir, "../../cli/src/main.ts");
    const child = Bun.spawn(
      [process.execPath, cliPath, "--server", running.url.href, "prompt", "Wait for interrupt"],
      { env: isolatedCliEnv({ HOME: directory }), stdout: "pipe", stderr: "pipe" },
    );

    await started;
    await Bun.sleep(25);
    child.kill("SIGINT");
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(2_000).then(() => null),
    ]);
    if (exitCode === null) child.kill("SIGKILL");
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);

    expect(exitCode).toBe(130);
    const snapshot = await jsonRequest<{ sessions: Session[] }>(running.url, "/v1/sessions");
    expect(snapshot.sessions[0]?.turns[0]?.status).toBe("cancelled");
  });

  test("passes an explicit thinking selection to the turn processor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    let thinkingEnabled: boolean | undefined;
    const processor: TurnProcessor = {
      providerId: "test-provider",
      modelId: "test-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream(_messages, _tools, _signal, selectedThinking) {
        thinkingEnabled = selectedThinking;
        yield { type: "reasoning_delta" as const, delta: "This should remain hidden" };
        yield { type: "text_delta" as const, delta: "Direct answer" };
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Thinking controls" }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "Be direct", thinkingEnabled: false }) },
    );

    const eventTypes = await collectPersistedEventTypes(running.url, created.session.id, submitted.eventId);

    expect(submitted.turn.thinkingEnabled).toBe(false);
    expect(thinkingEnabled).toBe(false);
    expect(eventTypes).not.toContain("reasoning.delta");
  });

  test("persists one context plan per provider round beside actual usage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    let round = 0;
    const processor: TurnProcessor = {
      providerId: "planned-provider",
      modelId: "planned-model",
      contextCapacity: 8_192,
      maxOutputTokens: 1_536,
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId, contextWindow: this.contextCapacity }];
      },
      async *stream() {
        round += 1;
        if (round === 1) {
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "call-missing",
            nameDelta: "missing_tool",
            argumentsDelta: "{}",
          };
          yield { type: "usage" as const, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
          return;
        }
        yield { type: "usage" as const, usage: { inputTokens: 140, outputTokens: 12, totalTokens: 152 } };
        yield { type: "text_delta" as const, delta: "Finished" };
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Context plans" }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "Use a tool" }) },
    );

    const events = await collectPersistedEvents(running.url, created.session.id, submitted.eventId);
    const starts = events.filter((event) => event.type === "model.request_started");
    const state = await jsonRequest<SessionStateResponse>(running.url, `/v1/sessions/${created.session.id}`);

    expect(starts).toHaveLength(2);
    for (const start of starts) {
      expect(start.payload.contextPlan).toEqual(expect.objectContaining({
        schemaVersion: 3,
        capacityTokens: 8_192,
        budgetStatus: "within_soft_limit",
      }));
    }
    const latestPlan = starts[1]?.payload.contextPlan as ContextPlan | undefined;
    expect(state.latestProviderCall?.contextPlan).toEqual(latestPlan);
    expect(state.latestProviderCall?.usage).toEqual({ inputTokens: 140, outputTokens: 12, totalTokens: 152 });
  });

  test("the file viewer reads workspace text under read_file's rules", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "workspace"), dataPath = join(directory, "data");
    mkdirSync(join(workspacePath, "src"), { recursive: true }); mkdirSync(dataPath);
    writeFileSync(join(workspacePath, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(workspacePath, ".env"), "TOKEN=secret\n");
    writeFileSync(join(workspacePath, "blob.bin"), new Uint8Array([1, 0, 2]));
    const running = startApp(join(dataPath, "demesne.sqlite"));
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", { method: "POST", body: JSON.stringify({ title: "Files", workspacePath }) });
    const read = (path: string) => jsonRequest<{ path: string; content: string | null; reason?: string; byteLength: number | null }>(running.url, `/v1/sessions/${created.session.id}/file?path=${encodeURIComponent(path)}`);
    expect(await read("src/a.ts")).toMatchObject({ path: "src/a.ts", content: "export const a = 1;\n", byteLength: 20 });
    expect((await read(".env")).reason).toContain("protected");
    expect((await read("../outside.txt")).reason).toContain("traversal");
    expect((await read("blob.bin")).reason).toBe("binary file");
    expect((await read("missing.ts")).content).toBeNull();
  });

  test("ask_user pauses the turn until the user answers, then hands the answers to the model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "workspace");
    const dataPath = join(directory, "data");
    mkdirSync(workspacePath);
    mkdirSync(dataPath);
    const offered: string[][] = [];
    let toolResult = "";
    const questions = [{ question: "Which guard should change?", suggestions: ["The lexer guard", "Both"] }, { question: "Allow digits?" }];
    const processor: TurnProcessor = {
      providerId: "asking-provider", modelId: "asking-model", contextCapacity: 8_192, maxOutputTokens: 1_536,
      async listModels() { return [{ id: this.modelId, provider: this.providerId, contextWindow: this.contextCapacity }]; },
      async *stream(messages, tools) {
        offered.push(tools.map((tool) => tool.name));
        const last = messages.at(-1);
        if (last?.role === "tool") {
          toolResult = String(last.content);
          yield { type: "text_delta" as const, delta: "Thanks, changing the lexer guard." };
          return;
        }
        if (messages.some((message) => message.role === "user" && String(message.content).includes("non-interactive"))) {
          yield { type: "text_delta" as const, delta: "Done." };
          return;
        }
        yield { type: "tool_call_delta" as const, index: 0, idDelta: "call-ask", nameDelta: "ask_user", argumentsDelta: JSON.stringify({ questions }) };
      },
    };
    const running = startApp(join(dataPath, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "Questions", workspacePath }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "Accept Unicode identifiers", permissionMode: "ask" }) });
    const asked = await waitForPersistedEvent(running.url, created.session.id, submitted.eventId, "question.requested");
    expect(asked.payload.questions).toEqual([{ question: "Which guard should change?", suggestions: ["The lexer guard", "Both"] }, { question: "Allow digits?", suggestions: [] }]);
    const questionId = String(asked.payload.questionId);
    // Answers must line up one-to-one with the questions.
    const mismatched = await fetch(new URL(`/v1/questions/${questionId}`, running.url), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: [{ source: "suggestion", answer: "The lexer guard" }] }) });
    expect(mismatched.status).toBe(409);
    await jsonRequest(running.url, `/v1/questions/${questionId}`, { method: "POST",
      body: JSON.stringify({ answers: [{ source: "suggestion", answer: "The lexer guard" }, { source: "typed", answer: "yes, after the first letter" }] }) });
    const events = await collectPersistedEvents(running.url, created.session.id, submitted.eventId);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["question.requested", "question.resolved", "tool.call_completed", "turn.completed"]));
    expect(toolResult).toBe("1. Which guard should change?\n   Answer: The lexer guard\n2. Allow digits?\n   Answer: yes, after the first letter (the user's own words)");
    expect(offered[0]).toContain("ask_user");
    // A non-interactive turn is never offered the tool.
    const quiet = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "non-interactive follow-up", permissionMode: "deny" }) });
    await collectPersistedEvents(running.url, created.session.id, quiet.eventId);
    expect(offered.at(-1)).not.toContain("ask_user");
  });

  test("persists a completed turn and replays its events after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "demesne.sqlite");

    const first = startApp(databasePath);
    const created = await jsonRequest<CreateSessionResponse>(first.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Persistent session" }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      first.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "Build the runtime" }) },
    );

    const streamed: EventEnvelope[] = [];
    const eventsUrl = new URL("/v1/events", first.url);
    eventsUrl.searchParams.set("session_id", created.session.id);
    eventsUrl.searchParams.set("after", String(submitted.eventId));
    for await (const event of readServerSentEvents(await fetch(eventsUrl))) {
      streamed.push(event);
      if (event.type === "turn.completed") break;
    }

    expect(streamed.map((event) => event.type)).toEqual([
      "agent.started",
      "model.request_started",
      "message.delta",
      "model.metrics",
      "model.request_completed",
      "message.completed",
      "turn.completed",
    ]);
    expect(streamed[2]?.payload.delta).toBe("Request accepted: Build the runtime");

    await first.server.stop(true);
    servers.splice(servers.indexOf(first.server), 1);
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);

    const second = startApp(databasePath);
    const snapshot = await jsonRequest<{ session: Session }>(
      second.url,
      `/v1/sessions/${created.session.id}`,
    );
    expect(snapshot.session.turns).toHaveLength(1);
    expect(snapshot.session.turns[0]?.status).toBe("completed");
    expect(snapshot.session.turns[0]?.responseText).toBe("Request accepted: Build the runtime");

    const replayUrl = new URL("/v1/events", second.url);
    replayUrl.searchParams.set("session_id", created.session.id);
    replayUrl.searchParams.set("after", String(submitted.eventId));
    const replayed: EventEnvelope[] = [];
    for await (const event of readServerSentEvents(await fetch(replayUrl))) {
      replayed.push(event);
      if (event.type === "turn.completed") break;
    }
    expect(replayed.map((event) => event.eventId)).toEqual(streamed.map((event) => event.eventId));
  });

  test("cancels an active provider call without completing the turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const processor: TurnProcessor = {
      providerId: "test-provider",
      modelId: "slow-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream() {
        await Bun.sleep(20);
        yield { type: "text_delta" as const, delta: "late output" };
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Cancellation" }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "Wait forever" }) },
    );
    const cancelled = await jsonRequest<{ turn: { status: string } }>(
      running.url,
      `/v1/turns/${submitted.turn.id}/cancel`,
      { method: "POST", body: JSON.stringify({}) },
    );

    expect(cancelled.turn.status).toBe("cancelled");
    const types = await collectPersistedEventTypes(running.url, created.session.id, submitted.eventId);
    const snapshot = await jsonRequest<{ session: Session }>(
      running.url,
      `/v1/sessions/${created.session.id}`,
    );
    expect(snapshot.session.turns[0]?.status).toBe("cancelled");
    expect(snapshot.session.turns[0]?.responseText).toBe("");
    expect(types).toContain("model.request_cancelled");
    expect(types).toContain("turn.cancelled");
    expect(types.indexOf("model.request_cancelled")).toBeLessThan(types.indexOf("turn.cancelled"));
    expect(types).not.toContain("turn.completed");
  });

  test("serializes concurrent sessions in FIFO order and records queue time", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    let activeStreams = 0;
    let maximumActiveStreams = 0;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const processor: TurnProcessor = {
      providerId: "scheduled",
      modelId: "one-slot-model",
      async listModels() { return []; },
      async *stream(messages) {
        const content = messages.findLast((message) => message.role === "user")?.content ?? "missing";
        activeStreams += 1;
        maximumActiveStreams = Math.max(maximumActiveStreams, activeStreams);
        order.push(content);
        try {
          if (content === "first") {
            markFirstStarted();
            await firstReleased;
          }
          yield { type: "text_delta" as const, delta: content };
        } finally {
          activeStreams -= 1;
        }
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const firstSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "First" }),
    });
    const secondSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "Second" }),
    });
    const first = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${firstSession.session.id}/turns`, {
      method: "POST", body: JSON.stringify({ content: "first" }),
    });
    await firstStarted;
    const second = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${secondSession.session.id}/turns`, {
      method: "POST", body: JSON.stringify({ content: "second" }),
    });
    await Bun.sleep(20);

    expect(order).toEqual(["first"]);
    releaseFirst();
    await Promise.all([
      collectPersistedEventTypes(running.url, firstSession.session.id, first.eventId),
      collectPersistedEventTypes(running.url, secondSession.session.id, second.eventId),
    ]);
    const secondState = await jsonRequest<{
      latestProviderCall: { metrics: { queueDurationMs: number | null; durationMs: number } | null } | null;
    }>(running.url, `/v1/sessions/${secondSession.session.id}`);

    expect(order).toEqual(["first", "second"]);
    expect(maximumActiveStreams).toBe(1);
    expect(secondState.latestProviderCall?.metrics?.queueDurationMs).toBeGreaterThanOrEqual(20);
  });

  test("runs benchmark maintenance between concurrent provider requests and includes it in queue time", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    let releaseMaintenance!: () => void;
    let markMaintenanceStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const maintenanceStarted = new Promise<void>((resolve) => { markMaintenanceStarted = resolve; });
    const maintenanceReleased = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
    const entered: string[] = [];
    const boundarySnapshots: Array<{
      activeCount: 0;
      queuedCount: number;
      settledLeaseCount: number;
      pendingContinuationTurnCount: number;
      continuationDrainActive: boolean;
    }> = [];
    const processor: TurnProcessor = {
      providerId: "scheduled",
      modelId: "one-slot-model",
      async listModels() { return []; },
      async *stream(messages) {
        const content = messages.findLast((message) => message.role === "user")?.content ?? "missing";
        entered.push(content);
        if (content === "first") {
          markFirstStarted();
          await firstReleased;
        }
        yield { type: "text_delta" as const, delta: content };
      },
    };
    const boundaryHook: InferenceBoundaryHook = async (snapshot) => {
      boundarySnapshots.push(snapshot);
      markMaintenanceStarted();
      await maintenanceReleased;
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor, boundaryHook);
    const firstSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "First" }),
    });
    const secondSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "Second" }),
    });
    const first = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${firstSession.session.id}/turns`, {
      method: "POST", body: JSON.stringify({ content: "first" }),
    });
    await firstStarted;
    const second = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${secondSession.session.id}/turns`, {
      method: "POST", body: JSON.stringify({ content: "second" }),
    });

    releaseFirst();
    await maintenanceStarted;
    expect(entered).toEqual(["first"]);
    await Bun.sleep(20);
    releaseMaintenance();
    await Promise.all([
      collectPersistedEventTypes(running.url, firstSession.session.id, first.eventId),
      collectPersistedEventTypes(running.url, secondSession.session.id, second.eventId),
    ]);
    const secondState = await jsonRequest<{
      session: Session;
      latestProviderCall: { metrics: { queueDurationMs: number | null } | null } | null;
    }>(running.url, `/v1/sessions/${secondSession.session.id}`);

    expect(boundarySnapshots).toEqual([{
      activeCount: 0,
      queuedCount: 1,
      settledLeaseCount: 1,
      pendingContinuationTurnCount: 0,
      continuationDrainActive: false,
    }]);
    expect(entered).toEqual(["first", "second"]);
    expect(secondState.session.turns[0]).toMatchObject({ status: "completed", responseText: "second" });
    expect(secondState.latestProviderCall?.metrics?.queueDurationMs).toBeGreaterThanOrEqual(20);
  });

  test("defers benchmark maintenance until concurrent multi-round turns finish", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "workspace");
    const dataPath = join(directory, "data");
    mkdirSync(workspacePath);
    mkdirSync(dataPath);
    writeFileSync(join(workspacePath, "fact.txt"), "turn-aware\n");
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    let releaseMaintenance!: () => void;
    let markMaintenanceStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const maintenanceStarted = new Promise<void>((resolve) => { markMaintenanceStarted = resolve; });
    const maintenanceReleased = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
    const entered: string[] = [];
    const snapshots: Array<{ settledLeaseCount: number; pendingContinuationTurnCount: number }> = [];
    const processor: TurnProcessor = {
      providerId: "scheduled",
      modelId: "one-slot-model",
      async listModels() { return []; },
      async *stream(messages) {
        const content = messages.findLast((message) => message.role === "user")?.content ?? "missing";
        const hasToolResult = messages.some((message) => message.role === "tool");
        entered.push(`${content}:${hasToolResult ? "final" : "first"}`);
        if (content === "a" && !hasToolResult) {
          markFirstStarted();
          await firstReleased;
        }
        if (content !== "next" && !hasToolResult) {
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: `read-${content}`,
            nameDelta: "read_file",
            argumentsDelta: JSON.stringify({ path: "fact.txt" }),
          };
          return;
        }
        yield { type: "text_delta" as const, delta: `${content} complete` };
      },
    };
    const running = startApp(join(dataPath, "demesne.sqlite"), processor, async (snapshot) => {
      snapshots.push({
        settledLeaseCount: snapshot.settledLeaseCount,
        pendingContinuationTurnCount: snapshot.pendingContinuationTurnCount,
      });
      markMaintenanceStarted();
      await maintenanceReleased;
    });
    const sessions = await Promise.all(["a", "b", "next"].map((title) => jsonRequest<CreateSessionResponse>(
      running.url,
      "/v1/sessions",
      { method: "POST", body: JSON.stringify({ title, workspacePath }) },
    )));
    const firstTurn = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${sessions[0]!.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "a" }) },
    );
    await firstStarted;
    const secondTurn = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${sessions[1]!.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "b" }) },
    );
    releaseFirst();
    const pair = [firstTurn, secondTurn];
    await Promise.all(pair.map((turn, index) => collectPersistedEventTypes(
      running.url,
      sessions[index]!.session.id,
      turn.eventId,
    )));

    expect(snapshots).toEqual([]);
    expect(entered).toEqual(["a:first", "b:first", "a:final", "b:final"]);
    const next = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${sessions[2]!.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "next" }) },
    );
    await maintenanceStarted;
    expect(entered).not.toContain("next:first");
    expect(snapshots).toEqual([{ settledLeaseCount: 4, pendingContinuationTurnCount: 0 }]);

    releaseMaintenance();
    await collectPersistedEventTypes(running.url, sessions[2]!.session.id, next.eventId);
    expect(entered.at(-1)).toBe("next:first");
  });

  test("drains mixed permission, cancellation, and recoverable-failure turns before fresh work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "workspace");
    const dataPath = join(directory, "data");
    mkdirSync(workspacePath);
    mkdirSync(dataPath);
    writeFileSync(join(workspacePath, "approved.txt"), "0\n");
    writeFileSync(join(workspacePath, "cancelled.txt"), "0\n");
    let releaseApprovedFirst!: () => void;
    let markApprovedFirstStarted!: () => void;
    let releaseRecycle!: () => void;
    let markRecycleStarted!: () => void;
    const approvedFirstStarted = new Promise<void>((resolve) => { markApprovedFirstStarted = resolve; });
    const approvedFirstReleased = new Promise<void>((resolve) => { releaseApprovedFirst = resolve; });
    const recycleStarted = new Promise<void>((resolve) => { markRecycleStarted = resolve; });
    const recycleReleased = new Promise<void>((resolve) => { releaseRecycle = resolve; });
    const entries: string[] = [];
    const processor: TurnProcessor = {
      providerId: "mixed",
      modelId: "lifecycle-model",
      async listModels() { return []; },
      async *stream(messages) {
        const content = messages.findLast((message) => message.role === "user")?.content ?? "missing";
        const toolResult = messages.findLast((message) => message.role === "tool")?.content;
        const round = messages.filter((message) => message.role === "assistant").length + 1;
        entries.push(`${content}:${round}`);
        if (content === "approved" && round === 1) {
          markApprovedFirstStarted();
          await approvedFirstReleased;
        }
        if ((content === "approved" || content === "cancel-permission") && !toolResult) {
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: `edit-${content}`,
            nameDelta: "edit_file",
            argumentsDelta: JSON.stringify({
              path: content === "approved" ? "approved.txt" : "cancelled.txt",
              oldText: "0",
              newText: "1",
            }),
          };
          return;
        }
        if (content === "failure" && !toolResult) {
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "missing-tool",
            nameDelta: "missing_tool",
            argumentsDelta: "{}",
          };
          return;
        }
        if (content === "failure") {
          if (!toolResult?.includes("unknown tool missing_tool")) throw new Error("Failure turn did not receive the tool error");
          yield { type: "text_delta" as const, delta: "recovered" };
          return;
        }
        yield { type: "text_delta" as const, delta: `${content} complete` };
      },
    };
    const controller = createInferenceRecycleController({
      workThreshold: 3,
      availablePercentThreshold: 100,
      maximumRecycles: 1,
      maximumContinuationDrainMs: 1_000,
      memorySnapshot: () => ({
        observedAt: "2026-08-29T00:00:00.000Z",
        availablePercent: 50,
        swapUsedBytes: 0,
        pageSizeBytes: 4_096,
        pageOuts: 0,
        swapOuts: 0,
      }),
      recycle: async () => {
        markRecycleStarted();
        await recycleReleased;
      },
    });
    const running = startApp(join(dataPath, "demesne.sqlite"), processor, controller.hook);
    const names = ["approved", "queued-cancel", "cancel-permission", "failure", "fresh"] as const;
    const sessions = new Map<string, CreateSessionResponse>();
    for (const name of names) {
      sessions.set(name, await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ title: name, workspacePath }),
      }));
    }
    const submit = (name: typeof names[number], permissionMode: "ask" | "deny" = "deny") => {
      const session = sessions.get(name)!;
      return jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${session.session.id}/turns`, {
        method: "POST",
        body: JSON.stringify({ content: name, permissionMode }),
      });
    };

    const approved = await submit("approved", "ask");
    await approvedFirstStarted;
    const queuedCancel = await submit("queued-cancel");
    const cancelledPermission = await submit("cancel-permission", "ask");
    const failure = await submit("failure");
    const fresh = await submit("fresh");
    await jsonRequest(running.url, `/v1/turns/${queuedCancel.turn.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    releaseApprovedFirst();

    const approvedPermission = await waitForPersistedEvent(
      running.url,
      sessions.get("approved")!.session.id,
      approved.eventId,
      "permission.requested",
    );
    const cancelledPermissionEvent = await waitForPersistedEvent(
      running.url,
      sessions.get("cancel-permission")!.session.id,
      cancelledPermission.eventId,
      "permission.requested",
    );
    const failureEvents = await collectPersistedEvents(
      running.url,
      sessions.get("failure")!.session.id,
      failure.eventId,
    );

    expect(entries).toEqual(["approved:1", "cancel-permission:1", "failure:1", "failure:2"]);
    expect(failureEvents.map((event) => event.type)).toContain("tool.call_failed");
    await jsonRequest(running.url, `/v1/turns/${cancelledPermission.turn.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const cancelledState = await jsonRequest<SessionStateResponse>(
      running.url,
      `/v1/sessions/${sessions.get("cancel-permission")!.session.id}`,
    );
    expect(cancelledState.pendingPermissions).toEqual([]);
    const lateResolution = await fetch(new URL(
      `/v1/permissions/${String(cancelledPermissionEvent.payload.permissionId)}`,
      running.url,
    ), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "allow_once" }) });
    expect(lateResolution.status).toBe(409);

    await jsonRequest(running.url, `/v1/permissions/${String(approvedPermission.payload.permissionId)}`, {
      method: "POST",
      body: JSON.stringify({ decision: "allow_once" }),
    });
    await recycleStarted;
    expect(entries).toEqual(["approved:1", "cancel-permission:1", "failure:1", "failure:2", "approved:2"]);
    expect(entries).not.toContain("fresh:1");

    releaseRecycle();
    const [approvedEvents, freshEvents, queuedEvents, cancelledEvents] = await Promise.all([
      collectPersistedEvents(running.url, sessions.get("approved")!.session.id, approved.eventId),
      collectPersistedEvents(running.url, sessions.get("fresh")!.session.id, fresh.eventId),
      collectPersistedEvents(running.url, sessions.get("queued-cancel")!.session.id, queuedCancel.eventId),
      collectPersistedEvents(running.url, sessions.get("cancel-permission")!.session.id, cancelledPermission.eventId),
    ]);
    const report = controller.report();
    const drain = report.decisions.find((decision) => decision.reason === "continuation_drain");
    const recycled = report.decisions.find((decision) => decision.recycled);

    expect(entries).toEqual(["approved:1", "cancel-permission:1", "failure:1", "failure:2", "approved:2", "fresh:1"]);
    expect(report).toMatchObject({ recycleCount: 1, drainTimeoutCount: 0 });
    expect(drain).toMatchObject({ drainRequested: true, drainTimedOut: false });
    expect(recycled?.scheduler).toMatchObject({ pendingContinuationTurnCount: 0, continuationDrainActive: true });
    expect(queuedEvents.map((event) => event.type)).not.toContain("model.request_started");
    expect(cancelledEvents.map((event) => event.type)).toEqual(expect.arrayContaining([
      "permission.requested",
      "tool.call_cancelled",
      "turn.cancelled",
    ]));
    expect(approvedEvents.map((event) => event.type)).toEqual(expect.arrayContaining([
      "permission.requested",
      "permission.resolved",
      "tool.call_completed",
      "turn.completed",
    ]));
    expect(freshEvents.at(-1)?.type).toBe("turn.completed");
    expect(readFileSync(join(workspacePath, "approved.txt"), "utf8")).toBe("1\n");
    expect(readFileSync(join(workspacePath, "cancelled.txt"), "utf8")).toBe("0\n");
  });

  test("drain timeout resumes fresh turns and disables further maintenance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "workspace");
    const dataPath = join(directory, "data");
    mkdirSync(workspacePath);
    mkdirSync(dataPath);
    writeFileSync(join(workspacePath, "stalled.txt"), "0\n");
    let releaseStalledFirst!: () => void;
    let markStalledFirstStarted!: () => void;
    const stalledFirstStarted = new Promise<void>((resolve) => { markStalledFirstStarted = resolve; });
    const stalledFirstReleased = new Promise<void>((resolve) => { releaseStalledFirst = resolve; });
    const entries: string[] = [];
    const processor: TurnProcessor = {
      providerId: "mixed",
      modelId: "timeout-model",
      async listModels() { return []; },
      async *stream(messages) {
        const content = messages.findLast((message) => message.role === "user")?.content ?? "missing";
        const hasToolResult = messages.some((message) => message.role === "tool");
        entries.push(content);
        if (content === "stalled" && !hasToolResult) {
          markStalledFirstStarted();
          await stalledFirstReleased;
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "stalled-edit",
            nameDelta: "edit_file",
            argumentsDelta: JSON.stringify({ path: "stalled.txt", oldText: "0", newText: "1" }),
          };
          return;
        }
        yield { type: "text_delta" as const, delta: `${content} complete` };
      },
    };
    const controller = createInferenceRecycleController({
      workThreshold: 1,
      availablePercentThreshold: 100,
      maximumRecycles: 1,
      maximumContinuationDrainMs: 20,
      memorySnapshot: () => ({
        observedAt: "2026-08-29T00:00:00.000Z",
        availablePercent: 50,
        swapUsedBytes: 0,
        pageSizeBytes: 4_096,
        pageOuts: 0,
        swapOuts: 0,
      }),
      recycle: async () => { throw new Error("Timed-out drain must not recycle"); },
    });
    const running = startApp(join(dataPath, "demesne.sqlite"), processor, controller.hook);
    const stalledSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Stalled", workspacePath }),
    });
    const freshSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Fresh", workspacePath }),
    });
    const nextSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Next", workspacePath }),
    });
    const stalled = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${stalledSession.session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ content: "stalled", permissionMode: "ask" }),
    });
    await stalledFirstStarted;
    const fresh = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${freshSession.session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ content: "fresh" }),
    });
    releaseStalledFirst();
    const permission = await waitForPersistedEvent(
      running.url,
      stalledSession.session.id,
      stalled.eventId,
      "permission.requested",
    );
    await collectPersistedEvents(running.url, freshSession.session.id, fresh.eventId);

    const timedOutReport = controller.report();
    expect(entries).toEqual(["stalled", "fresh"]);
    expect(timedOutReport).toMatchObject({ recycleCount: 0, drainTimeoutCount: 1 });
    expect(timedOutReport.decisions).toContainEqual(expect.objectContaining({
      reason: "continuation_drain",
      drainTimedOut: true,
    }));
    const decisionCount = timedOutReport.decisions.length;
    const next = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${nextSession.session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ content: "next" }),
    });
    await collectPersistedEvents(running.url, nextSession.session.id, next.eventId);
    expect(entries).toEqual(["stalled", "fresh", "next"]);
    expect(controller.report().decisions).toHaveLength(decisionCount);

    await jsonRequest(running.url, `/v1/turns/${stalled.turn.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const stalledState = await jsonRequest<SessionStateResponse>(running.url, `/v1/sessions/${stalledSession.session.id}`);
    expect(stalledState.pendingPermissions).toEqual([]);
    const lateResolution = await fetch(new URL(`/v1/permissions/${String(permission.payload.permissionId)}`, running.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow_once" }),
    });
    expect(lateResolution.status).toBe(409);
  });

  test("cancels a queued turn before it enters the provider", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered: string[] = [];
    const processor: TurnProcessor = {
      providerId: "scheduled",
      modelId: "one-slot-model",
      async listModels() { return []; },
      async *stream(messages) {
        const content = messages.findLast((message) => message.role === "user")?.content ?? "missing";
        entered.push(content);
        if (content === "holder") {
          markFirstStarted();
          await firstReleased;
        }
        yield { type: "text_delta" as const, delta: content };
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const holderSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "Holder" }),
    });
    const queuedSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "Queued" }),
    });
    const holder = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${holderSession.session.id}/turns`, {
      method: "POST", body: JSON.stringify({ content: "holder" }),
    });
    await firstStarted;
    const queued = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${queuedSession.session.id}/turns`, {
      method: "POST", body: JSON.stringify({ content: "cancel me" }),
    });
    await Bun.sleep(10);
    await jsonRequest(running.url, `/v1/turns/${queued.turn.id}/cancel`, {
      method: "POST", body: JSON.stringify({}),
    });
    const queuedEvents = await collectPersistedEventTypes(running.url, queuedSession.session.id, queued.eventId);

    expect(entered).toEqual(["holder"]);
    expect(queuedEvents).toContain("turn.cancelled");
    expect(queuedEvents).not.toContain("model.request_started");
    releaseFirst();
    await collectPersistedEventTypes(running.url, holderSession.session.id, holder.eventId);
  });

  test("releases the slot during permission work and keeps turn configuration immutable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "workspace");
    const dataPath = join(directory, "data");
    mkdirSync(workspacePath);
    mkdirSync(dataPath);
    writeFileSync(join(workspacePath, "answer.txt"), "41\n");
    const requests: Array<{ model: string; thinkingEnabled: boolean | undefined; user: string }> = [];
    const provider: ProviderAdapter = {
      id: "scripted",
      async listModels() { return []; },
      async *stream(request) {
        const user = request.messages.findLast((message) => message.role === "user")?.content ?? "missing";
        requests.push({ model: request.model, thinkingEnabled: request.thinkingEnabled, user });
        const hasToolResult = request.messages.some((message) => message.role === "tool");
        if (user === "edit" && !hasToolResult) {
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "call-edit",
            nameDelta: "edit_file",
            argumentsDelta: JSON.stringify({ path: "answer.txt", oldText: "41", newText: "42" }),
          };
          return;
        }
        yield { type: "text_delta" as const, delta: user === "edit" ? "edited" : "second complete" };
      },
    };
    const processor = new ProviderTurnProcessor(provider, "model-one");
    const running = startApp(join(dataPath, "demesne.sqlite"), processor);
    const firstSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "Edit", workspacePath }),
    });
    const secondSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "Second" }),
    });
    const first = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${firstSession.session.id}/turns`, {
      method: "POST", body: JSON.stringify({ content: "edit", permissionMode: "ask", thinkingEnabled: false }),
    });
    const eventsUrl = new URL("/v1/events", running.url);
    eventsUrl.searchParams.set("session_id", firstSession.session.id);
    eventsUrl.searchParams.set("after", String(first.eventId));
    for await (const event of readServerSentEvents(await fetch(eventsUrl))) {
      if (event.type === "permission.requested") {
        const permissionId = event.payload.permissionId;
        if (typeof permissionId !== "string") throw new Error("Permission event is malformed");
        await jsonRequest(running.url, "/v1/model", {
          method: "POST", body: JSON.stringify({ model: "model-two" }),
        });
        const second = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${secondSession.session.id}/turns`, {
          method: "POST", body: JSON.stringify({ content: "second", thinkingEnabled: true }),
        });
        await collectPersistedEventTypes(running.url, secondSession.session.id, second.eventId);
        expect(requests.map((request) => request.user)).toEqual(["edit", "second"]);
        await jsonRequest(running.url, `/v1/permissions/${permissionId}`, {
          method: "POST", body: JSON.stringify({ decision: "allow_once" }),
        });
      }
      if (event.type === "turn.completed") break;
    }

    expect(readFileSync(join(workspacePath, "answer.txt"), "utf8")).toBe("42\n");
    expect(requests).toEqual([
      { model: "model-one", thinkingEnabled: false, user: "edit" },
      { model: "model-two", thinkingEnabled: true, user: "second" },
      { model: "model-one", thinkingEnabled: false, user: "edit" },
    ]);
  });

  test("uses Last-Event-ID when replaying a session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const running = startApp(join(directory, "demesne.sqlite"));
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Resume" }),
    });
    const eventsUrl = new URL("/v1/events", running.url);
    eventsUrl.searchParams.set("session_id", created.session.id);
    eventsUrl.searchParams.set("after", "0");
    const response = await fetch(eventsUrl, {
      headers: { "Last-Event-ID": String(created.eventId) },
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "Continue" }) },
    );
    const received: EventEnvelope[] = [];
    for await (const event of readServerSentEvents(response)) {
      received.push(event);
      if (event.type === "turn.completed") break;
    }

    expect(received.every((event) => event.eventId > created.eventId)).toBe(true);
    expect(received.some((event) => event.eventId === submitted.eventId)).toBe(true);
    expect(received.some((event) => event.type === "session.created")).toBe(false);
  });

  test("closes active event streams during application shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const running = startApp(join(directory, "demesne.sqlite"));
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Shutdown" }),
    });
    const eventsUrl = new URL("/v1/events", running.url);
    eventsUrl.searchParams.set("session_id", created.session.id);
    eventsUrl.searchParams.set("after", String(created.eventId));
    const response = await fetch(eventsUrl);
    const reader = response.body!.getReader();
    await reader.read();
    const pendingRead = reader.read();

    const closePromise = running.app.close();
    const duringShutdown = await running.app.fetch(new Request(new URL("/healthz", running.url)));
    expect(duringShutdown.status).toBe(503);
    await closePromise;
    apps.splice(apps.indexOf(running.app), 1);
    expect((await pendingRead).done).toBe(true);
    await running.server.stop(true);
    servers.splice(servers.indexOf(running.server), 1);
  });

  test("waits for active inference cancellation and removes queued work during shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let observedAbort = false;
    const entered: string[] = [];
    const processor: TurnProcessor = {
      providerId: "shutdown",
      modelId: "one-slot-model",
      async listModels() { return []; },
      async *stream(messages, _tools, signal) {
        entered.push(messages.findLast((message) => message.role === "user")?.content ?? "missing");
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const firstSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "Active" }),
    });
    const secondSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "Queued" }),
    });
    await jsonRequest(running.url, `/v1/sessions/${firstSession.session.id}/turns`, {
      method: "POST", body: JSON.stringify({ content: "active" }),
    });
    await started;
    await jsonRequest(running.url, `/v1/sessions/${secondSession.session.id}/turns`, {
      method: "POST", body: JSON.stringify({ content: "queued" }),
    });

    await running.app.close();
    apps.splice(apps.indexOf(running.app), 1);
    expect(observedAbort).toBe(true);
    expect(entered).toEqual(["active"]);
    await running.server.stop(true);
    servers.splice(servers.indexOf(running.server), 1);
  });

  test("does not hand off the inference slot until iterator cleanup completes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    let markCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    const cleanupReleased = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const entered: string[] = [];
    const processor: TurnProcessor = {
      providerId: "cleanup",
      modelId: "one-slot-model",
      async listModels() { return []; },
      async *stream(messages) {
        const content = messages.findLast((message) => message.role === "user")?.content ?? "missing";
        entered.push(content);
        try {
          yield { type: "text_delta" as const, delta: content };
        } finally {
          if (content === "first") {
            markCleanupStarted();
            await cleanupReleased;
          }
        }
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const firstSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "First" }),
    });
    const secondSession = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "Second" }),
    });
    const first = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${firstSession.session.id}/turns`, {
      method: "POST", body: JSON.stringify({ content: "first" }),
    });
    await cleanupStarted;
    const second = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${secondSession.session.id}/turns`, {
      method: "POST", body: JSON.stringify({ content: "second" }),
    });
    await Bun.sleep(20);

    expect(entered).toEqual(["first"]);
    releaseCleanup();
    await Promise.all([
      collectPersistedEventTypes(running.url, firstSession.session.id, first.eventId),
      collectPersistedEventTypes(running.url, secondSession.session.id, second.eventId),
    ]);
    expect(entered).toEqual(["first", "second"]);
  });

  test("executes an approved edit through a multi-round agent turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "workspace");
    mkdirSync(workspacePath);
    const dataPath = join(directory, "data");
    mkdirSync(dataPath);
    writeFileSync(join(workspacePath, "answer.txt"), "41\n");
    let modelRound = 0;
    const modelMessages: ProviderMessage[][] = [];
    const processor: TurnProcessor = {
      providerId: "scripted",
      modelId: "tool-model",
      async listModels() { return [{ id: this.modelId, provider: this.providerId }]; },
      async *stream(messages) {
        modelMessages.push(structuredClone(messages));
        const currentRound = modelRound++;
        if (currentRound === 0) {
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "call-edit",
            nameDelta: "edit_file",
            argumentsDelta: JSON.stringify({ path: "answer.txt", oldText: "41", newText: "42" }),
          };
          return;
        }
        if (currentRound === 1) {
          expect(messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-edit" });
          yield { type: "text_delta" as const, delta: "Updated the answer." };
          return;
        }
        yield { type: "text_delta" as const, delta: "The prior tool transcript is intact." };
      },
    };
    const running = startApp(join(dataPath, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Edit", workspacePath }),
    });
    expect(created.session.workspace?.root).toBe(realpathSync(workspacePath));
    const submitted = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "Set the answer to 42", permissionMode: "ask" }) },
    );
    const eventsUrl = new URL("/v1/events", running.url);
    eventsUrl.searchParams.set("session_id", created.session.id);
    eventsUrl.searchParams.set("after", String(submitted.eventId));
    const types: string[] = [];
    for await (const event of readServerSentEvents(await fetch(eventsUrl))) {
      types.push(event.type);
      if (event.type === "permission.requested") {
        const permissionId = event.payload.permissionId;
        const toolCallId = event.payload.toolCallId;
        if (typeof permissionId !== "string" || typeof toolCallId !== "string") {
          throw new Error("Permission event is malformed");
        }
        const state = await jsonRequest<{ pendingPermissions: Array<{
          id: string;
          turnId: string;
          toolCallId: string;
          summary: string;
        }> }>(
          running.url,
          `/v1/sessions/${created.session.id}`,
        );
        expect(state.pendingPermissions).toContainEqual({
          id: permissionId,
          turnId: submitted.turn.id,
          toolCallId,
          summary: expect.any(String),
        });
        await jsonRequest(running.url, `/v1/permissions/${permissionId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "allow_once" }),
        });
      }
      if (event.type === "turn.completed") break;
    }

    expect(readFileSync(join(workspacePath, "answer.txt"), "utf8")).toBe("42\n");
    expect(types).toContain("permission.requested");
    expect(types).toContain("permission.resolved");
    expect(types).toContain("tool.call_completed");
    expect(modelRound).toBe(2);

    const followUp = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "What did you change?" }) },
    );
    await collectPersistedEventTypes(running.url, created.session.id, followUp.eventId);
    expect(modelMessages[2]).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "Set the answer to 42" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{
          id: "call-edit",
          name: "edit_file",
          arguments: JSON.stringify({ path: "answer.txt", oldText: "41", newText: "42" }),
        }],
      },
      expect.objectContaining({ role: "tool", toolCallId: "call-edit" }),
      { role: "assistant", content: "Updated the answer." },
      { role: "user", content: "What did you change?" },
    ]);
  });

  test("drops only complete oldest turns after a provider-confirmed context overflow", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "demesne.sqlite");
    const requests: ProviderMessage[][] = [];
    const processor: TurnProcessor = {
      providerId: "bounded-provider",
      modelId: "bounded-model",
      async listModels() { return [{ id: this.modelId, provider: this.providerId, contextWindow: 32 }]; },
      async *stream(messages) {
        requests.push(structuredClone(messages));
        const lastUser = messages.findLast((message) => message.role === "user");
        const hasFirstTurn = messages.some((message) => message.role === "user" && message.content === "first");
        const hasSecondTurn = messages.some((message) => message.role === "user" && message.content === "second");
        if (lastUser?.content === "third" && hasFirstTurn) {
          throw new ProviderError("maximum context length exceeded", 400);
        }
        if (lastUser?.content === "coded overflow" && hasSecondTurn) {
          throw new ProviderError("maximum context length exceeded", 400, "invalid_request_error");
        }
        if (lastUser?.content === "false positive") {
          throw new ProviderError("context window configuration is invalid", 400, "invalid_request");
        }
        yield { type: "text_delta" as const, delta: `answer:${lastUser?.content ?? ""}` };
      },
    };
    const running = startApp(databasePath, processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Bounded context" }),
    });

    for (const content of ["first", "second"]) {
      const submitted = await jsonRequest<SubmitTurnResponse>(
        running.url,
        `/v1/sessions/${created.session.id}/turns`,
        { method: "POST", body: JSON.stringify({ content }) },
      );
      await collectPersistedEventTypes(running.url, created.session.id, submitted.eventId);
    }
    const third = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "third" }) },
    );
    const eventTypes = await collectPersistedEventTypes(running.url, created.session.id, third.eventId);

    expect(eventTypes).toContain("model.context_trimmed");
    const retry = requests.at(-1) ?? [];
    expect(retry.some((message) => message.role === "user" && message.content === "first")).toBe(false);
    expect(retry.some((message) => message.role === "user" && message.content === "second")).toBe(true);
    expect(retry.at(-1)).toEqual({ role: "user", content: "third" });

    await running.server.stop(true);
    servers.splice(servers.indexOf(running.server), 1);
    await running.app.close();
    apps.splice(apps.indexOf(running.app), 1);
    const restarted = startApp(databasePath, processor);
    const fourth = await jsonRequest<SubmitTurnResponse>(
      restarted.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "fourth" }) },
    );
    await collectPersistedEventTypes(restarted.url, created.session.id, fourth.eventId);
    const afterRestart = requests.at(-1) ?? [];
    expect(afterRestart.some((message) => message.role === "user" && message.content === "first")).toBe(false);
    expect(afterRestart.some((message) => message.role === "user" && message.content === "second")).toBe(true);
    expect(afterRestart.some((message) => message.role === "user" && message.content === "third")).toBe(true);

    const codedOverflow = await jsonRequest<SubmitTurnResponse>(
      restarted.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "coded overflow" }) },
    );
    const codedOverflowEvents = await collectPersistedEventTypes(
      restarted.url,
      created.session.id,
      codedOverflow.eventId,
    );
    expect(codedOverflowEvents).toContain("turn.completed");
    expect(codedOverflowEvents).toContain("model.context_trimmed");

    const falsePositive = await jsonRequest<SubmitTurnResponse>(
      restarted.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "false positive" }) },
    );
    const falsePositiveEvents = await collectPersistedEventTypes(
      restarted.url,
      created.session.id,
      falsePositive.eventId,
    );
    expect(falsePositiveEvents).toContain("turn.failed");
    expect(falsePositiveEvents).toContain("model.metrics");
    expect(falsePositiveEvents).not.toContain("model.context_trimmed");
  });

  test("proactively drops complete oldest turns at the calibrated soft limit and persists the boundary", async () => {
    // Calibrated to the system prompt; the answer-format guidance is part of it.
    const FORMAT_GUIDANCE_TOKENS = Math.ceil(Buffer.byteLength(`\n${ANSWER_FORMAT_GUIDANCE}`, "utf8") / 3 * 1.2);
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "demesne.sqlite");
    const requests: ProviderMessage[][] = [];
    const processor: TurnProcessor = {
      providerId: "planned-bounded-provider",
      modelId: "planned-bounded-model",
      contextCapacity: 2_108 + FORMAT_GUIDANCE_TOKENS,
      maxOutputTokens: 128,
      async listModels() { return [{ id: this.modelId, provider: this.providerId, contextWindow: this.contextCapacity }]; },
      async *stream(messages) {
        requests.push(structuredClone(messages));
        const lastUser = messages.findLast((message) => message.role === "user");
        const hasCurrentToolResult = messages.some((message) => message.role === "tool" && message.toolCallId === "planned-missing");
        if (lastUser?.role === "user" && lastUser.content.startsWith("third-marker") && !hasCurrentToolResult) {
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "planned-missing",
            nameDelta: "missing_tool",
            argumentsDelta: "{}",
          };
          return;
        }
        yield { type: "text_delta" as const, delta: "answer" };
      },
    };
    const running = startApp(databasePath, processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Proactively bounded context" }),
    });
    const contents = [
      `first-marker:${"a".repeat(500)}`,
      `second-marker:${"b".repeat(500)}`,
      `third-marker:${"c".repeat(500)}`,
    ];
    for (const content of contents.slice(0, 2)) {
      const submitted = await jsonRequest<SubmitTurnResponse>(
        running.url,
        `/v1/sessions/${created.session.id}/turns`,
        { method: "POST", body: JSON.stringify({ content }) },
      );
      await collectPersistedEventTypes(running.url, created.session.id, submitted.eventId);
    }

    const third = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: contents[2] }) },
    );
    const events = await collectPersistedEvents(running.url, created.session.id, third.eventId);
    const thirdRequest = requests.at(-1) ?? [];
    const started = events.find((event) => event.type === "model.request_started");
    const plan = started?.payload.contextPlan as ContextPlan | undefined;

    expect(events.map((event) => event.type)).toContain("model.context_trimmed");
    expect(plan?.budgetStatus).toBe("within_soft_limit");
    expect(plan?.actions).toContainEqual(expect.objectContaining({ kind: "drop_historical_turn" }));
    expect(thirdRequest.some((message) => message.role === "user" && message.content.startsWith("first-marker"))).toBe(false);
    expect(thirdRequest.some((message) => message.role === "user" && message.content.startsWith("second-marker"))).toBe(true);
    expect(thirdRequest.some((message) => message.role === "user" && message.content === contents[2])).toBe(true);
    expect(thirdRequest.some((message) => message.role === "tool" && message.toolCallId === "planned-missing")).toBe(true);

    await running.server.stop(true);
    servers.splice(servers.indexOf(running.server), 1);
    await running.app.close();
    apps.splice(apps.indexOf(running.app), 1);
    const persisted = new DemesneStore(databasePath);
    const persistedUsers = persisted.getCompletedModelTranscript(created.session.id)
      .flatMap((entry) => entry.message.role === "user" ? [entry.message.content] : []);
    expect(persistedUsers.some((content) => content.startsWith("first-marker"))).toBe(false);
    expect(persistedUsers.some((content) => content.startsWith("second-marker"))).toBe(true);
    expect(persistedUsers).toContain(contents[2]);
    persisted.close();
    const restarted = startApp(databasePath, processor);
    const fourth = await jsonRequest<SubmitTurnResponse>(
      restarted.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "fourth-marker" }) },
    );
    await collectPersistedEventTypes(restarted.url, created.session.id, fourth.eventId);
    const afterRestart = requests.at(-1) ?? [];
    expect(afterRestart.some((message) => message.role === "user" && message.content.startsWith("first-marker"))).toBe(false);
  });

  test("reverts a turn's file changes through /undo", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "ws");
    const dataPath = join(directory, "data");
    mkdirSync(workspacePath);
    mkdirSync(dataPath);
    writeFileSync(join(workspacePath, "target.txt"), "original\n");
    let round = 0;
    const processor: TurnProcessor = {
      providerId: "undo-provider",
      modelId: "undo-model",
      async listModels() { return [{ id: this.modelId, provider: this.providerId }]; },
      async *stream(messages) {
        if (round++ === 0) {
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "call-w",
            nameDelta: "write_file",
            argumentsDelta: JSON.stringify({ path: "created.txt", content: "brand new\n" }),
          };
          return;
        }
        void messages;
        yield { type: "text_delta" as const, delta: "wrote it" };
      },
    };
    const running = startApp(join(dataPath, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Undo", workspacePath }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "write", permissionMode: "ask" }) },
    );

    for await (const event of readServerSentEvents(await fetch(new URL(`/v1/events?session_id=${created.session.id}&after=${submitted.eventId}`, running.url)))) {
      if (event.type === "permission.requested") {
        await jsonRequest(running.url, `/v1/permissions/${event.payload.permissionId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "allow_once" }),
        });
      }
      if (event.type === "turn.completed") break;
    }
    expect(readFileSync(join(workspacePath, "created.txt"), "utf8")).toBe("brand new\n");

    const undone = await jsonRequest<{ turnId: string; files: string[] }>(
      running.url,
      `/v1/sessions/${created.session.id}/undo`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(undone.files).toEqual(["created.txt"]);
    expect(existsSync(join(workspacePath, "created.txt"))).toBe(false);
    expect(readFileSync(join(workspacePath, "target.txt"), "utf8")).toBe("original\n");

    await expect(fetch(new URL(`/v1/sessions/${created.session.id}/undo`, running.url), { method: "POST" }))
      .resolves.toMatchObject({ status: 404 });
  });

  test("undo waits for a running coding turn instead of racing its edits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "ws"), dataPath = join(directory, "data");
    mkdirSync(workspacePath); mkdirSync(dataPath);
    let round = 0;
    const gate = Promise.withResolvers<void>(), streaming = Promise.withResolvers<void>();
    const processor: TurnProcessor = {
      providerId: "undo-provider",
      modelId: "undo-model",
      async listModels() { return [{ id: this.modelId, provider: this.providerId }]; },
      async *stream() {
        const call = round++;
        if (call === 0) {
          yield { type: "tool_call_delta" as const, index: 0, idDelta: "call-w", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: "created.txt", content: "new\n" }) };
          return;
        }
        if (call === 2) { streaming.resolve(); await gate.promise; }
        yield { type: "text_delta" as const, delta: "done" };
      },
    };
    const running = startApp(join(dataPath, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Undo while running", workspacePath }),
    });
    const first = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "write", permissionMode: "ask" }) });
    for await (const event of readServerSentEvents(await fetch(new URL(`/v1/events?session_id=${created.session.id}&after=${first.eventId}`, running.url)))) {
      if (event.type === "permission.requested") {
        await jsonRequest(running.url, `/v1/permissions/${event.payload.permissionId}`, { method: "POST", body: JSON.stringify({ decision: "allow_once" }) });
      }
      if (event.type === "turn.completed") break;
    }
    await jsonRequest(running.url, `/v1/sessions/${created.session.id}/turns`, { method: "POST", body: JSON.stringify({ content: "keep going" }) });
    await streaming.promise;
    try {
      const refused = await fetch(new URL(`/v1/sessions/${created.session.id}/undo`, running.url), { method: "POST" });
      const body = await refused.json();
      expect([refused.status, JSON.stringify(body)]).toEqual([409, expect.stringContaining("Wait for running work")]);
      expect(readFileSync(join(workspacePath, "created.txt"), "utf8")).toBe("new\n");
    } finally { gate.resolve(); }
  });

  test("undo restores both sides of an overwritten file move", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "ws");
    const dataPath = join(directory, "data");
    mkdirSync(workspacePath);
    mkdirSync(dataPath);
    writeFileSync(join(workspacePath, "source.txt"), "source\n");
    writeFileSync(join(workspacePath, "destination.txt"), "destination\n");
    let round = 0;
    const processor: TurnProcessor = {
      providerId: "undo-provider",
      modelId: "undo-model",
      async listModels() { return []; },
      async *stream() {
        if (round++ === 0) {
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "call-move",
            nameDelta: "move_path",
            argumentsDelta: JSON.stringify({ from: "source.txt", to: "destination.txt", overwrite: true }),
          };
          return;
        }
        yield { type: "text_delta" as const, delta: "moved it" };
      },
    };
    const running = startApp(join(dataPath, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Undo move", workspacePath }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "move", permissionMode: "ask" }) },
    );
    for await (const event of readServerSentEvents(await fetch(new URL(`/v1/events?session_id=${created.session.id}&after=${submitted.eventId}`, running.url)))) {
      if (event.type === "permission.requested") {
        await jsonRequest(running.url, `/v1/permissions/${event.payload.permissionId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "allow_once" }),
        });
      }
      if (event.type === "turn.completed") break;
    }
    expect(existsSync(join(workspacePath, "source.txt"))).toBe(false);
    expect(readFileSync(join(workspacePath, "destination.txt"), "utf8")).toBe("source\n");

    const undone = await jsonRequest<{ files: string[] }>(running.url, `/v1/sessions/${created.session.id}/undo`, {
      method: "POST",
      body: "{}",
    });
    expect(undone.files).toEqual(["destination.txt", "source.txt"]);
    expect(readFileSync(join(workspacePath, "source.txt"), "utf8")).toBe("source\n");
    expect(readFileSync(join(workspacePath, "destination.txt"), "utf8")).toBe("destination\n");
  });

  test("undo refuses changed files and symlink substitutions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "ws");
    const dataPath = join(directory, "data");
    mkdirSync(workspacePath);
    mkdirSync(dataPath);
    writeFileSync(join(workspacePath, "target.txt"), "before\n");
    const outside = join(directory, "outside.txt");
    writeFileSync(outside, "outside\n");
    let round = 0;
    const processor: TurnProcessor = {
      providerId: "undo-provider",
      modelId: "undo-model",
      async listModels() { return []; },
      async *stream() {
        if (round++ === 0) {
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "call-write",
            nameDelta: "write_file",
            argumentsDelta: JSON.stringify({ path: "target.txt", content: "after\n" }),
          };
          return;
        }
        yield { type: "text_delta" as const, delta: "wrote it" };
      },
    };
    const running = startApp(join(dataPath, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Undo conflict", workspacePath }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "write", permissionMode: "ask" }) },
    );
    for await (const event of readServerSentEvents(await fetch(new URL(`/v1/events?session_id=${created.session.id}&after=${submitted.eventId}`, running.url)))) {
      if (event.type === "permission.requested") {
        await jsonRequest(running.url, `/v1/permissions/${event.payload.permissionId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "allow_once" }),
        });
      }
      if (event.type === "turn.completed") break;
    }

    unlinkSync(join(workspacePath, "target.txt"));
    symlinkSync(outside, join(workspacePath, "target.txt"));
    const response = await fetch(new URL(`/v1/sessions/${created.session.id}/undo`, running.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(409);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  test("requires authentication when configured", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const app = createDaemonApp({ databasePath: join(directory, "demesne.sqlite"), authToken: "private" });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    apps.push(app);
    servers.push(server);

    expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
    expect((await fetch(new URL("/v1/models", server.url))).status).toBe(401);
    expect((await fetch(new URL("/v1/runtime", server.url))).status).toBe(401);
    expect((await fetch(new URL("/v1/models", server.url), {
      headers: { Authorization: "Bearer private" },
    })).status).toBe(200);
  });

  test("exposes sanitized runtime profile status on the authenticated route", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const processor: TurnProcessor = {
      providerId: "ollama",
      modelId: "profile-model",
      async listModels() { return []; },
      async *stream() {},
      runtimeStatus() {
        return {
          profile: "balanced-32gb",
          state: "mismatch",
          expected: {
            contextWindow: 8192,
            batchSize: 512,
            microBatchSize: 512,
            parallelSequences: 1,
            keyCacheType: "q8_0",
            valueCacheType: "q8_0",
            flashAttention: "on",
            loadedModels: 1,
          },
          observed: null,
          mismatches: ["batch size expected 512, observed 1024"],
          observedAt: "2026-08-28T01:00:00.000Z",
        };
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);

    const status = await jsonRequest<{ state: string; mismatches: string[] }>(running.url, "/v1/runtime");

    expect(status.state).toBe("mismatch");
    expect(status.mismatches).toEqual(["batch size expected 512, observed 1024"]);
    expect(JSON.stringify(status)).not.toContain("llama-server");
    expect(JSON.stringify(status)).not.toContain("/models/");
  });

  test("rejects multiple inference slots for strict 32 GB runtime profiles", () => {
    for (const profile of ["balanced-32gb", "experimental-q4-kv-32gb", "experimental-q4-kv-b256-32gb"]) {
      const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
      temporaryDirectories.push(directory);
      const processor: TurnProcessor = {
        providerId: "ollama",
        modelId: "profile-model",
        async listModels() { return []; },
        async *stream() {},
        runtimeStatus() {
          return {
            profile,
            state: "pending",
            expected: null,
            observed: null,
            mismatches: [],
            observedAt: null,
          };
        },
      };

      expect(() => createDaemonApp({
        databasePath: join(directory, "demesne.sqlite"),
        processor,
        inferenceSlots: 2,
      })).toThrow("requires one inference slot");
    }
  });

  test("switches active model via /v1/model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    let currentModel = "initial-model";
    const processor: TurnProcessor = {
      providerId: "test-provider",
      get modelId() { return currentModel; },
      setModel(modelId: string) { currentModel = modelId; },
      async listModels() { return [{ id: currentModel, provider: this.providerId }]; },
      async *stream() { yield { type: "text_delta" as const, delta: "ok" }; },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);

    const initial = await jsonRequest<{ status: string; model: string }>(running.url, "/healthz");
    expect(initial.model).toBe("initial-model");

    const updated = await jsonRequest<{ status: string; model: string }>(running.url, "/v1/model", {
      method: "POST",
      body: JSON.stringify({ model: "qwen3:14b-fast" }),
    });
    expect(updated).toEqual({ status: "ok", model: "qwen3:14b-fast" });

    const postHealth = await jsonRequest<{ status: string; model: string }>(running.url, "/healthz");
    expect(postHealth.model).toBe("qwen3:14b-fast");
  });

  test("does not persist a turn when processor configuration cannot be snapshotted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    let currentModel = "initial-model";
    const processor: TurnProcessor = {
      providerId: "mutable",
      get modelId() { return currentModel; },
      setModel(modelId: string) { currentModel = modelId; },
      async listModels() { return []; },
      async *stream() { yield { type: "text_delta" as const, delta: "wrong" }; },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST", body: JSON.stringify({ title: "No orphan" }),
    });

    const response = await fetch(new URL(`/v1/sessions/${created.session.id}/turns`, running.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "must not persist" }),
    });
    const snapshot = await jsonRequest<{ session: Session }>(running.url, `/v1/sessions/${created.session.id}`);

    expect(response.status).toBe(400);
    expect(snapshot.session.turns).toEqual([]);
  });

  test("fails a provider request that does not emit before its deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const processor: TurnProcessor = {
      providerId: "stalled-provider",
      modelId: "stalled-model",
      async listModels() { return []; },
      async *stream(_messages, _tools, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor, undefined, {
      providerFirstEventTimeoutMs: 20,
      providerRequestTimeoutMs: 100,
    });
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Stalled provider" }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${created.session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ content: "wait" }),
    });
    const events = await collectPersistedEvents(running.url, created.session.id, submitted.eventId);
    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.at(-1)?.payload.message).toContain("did not emit an event");
  });

  test("preserves the append-only transcript through the soft band for a prompt-cache runtime", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const requests: ProviderMessage[][] = [];
    const processor: TurnProcessor = {
      providerId: "llama.cpp",
      modelId: "cache-aware-model",
      contextCapacity: 2_600,
      maxOutputTokens: 128,
      preservesPromptCache: true,
      async listModels() { return []; },
      async *stream(messages) {
        requests.push(structuredClone(messages));
        yield { type: "text_delta" as const, delta: "answer" };
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Cache-aware context" }),
    });
    const contents = [
      `first-marker:${"a".repeat(1_000)}`,
      `second-marker:${"b".repeat(1_000)}`,
      `third-marker:${"c".repeat(1_000)}`,
    ];
    for (const content of contents) {
      const submitted = await jsonRequest<SubmitTurnResponse>(
        running.url,
        `/v1/sessions/${created.session.id}/turns`,
        { method: "POST", body: JSON.stringify({ content }) },
      );
      await collectPersistedEventTypes(running.url, created.session.id, submitted.eventId);
    }

    const thirdRequest = requests.at(-1) ?? [];
    const state = await jsonRequest<SessionStateResponse>(running.url, `/v1/sessions/${created.session.id}`);
    const plan = state.latestProviderCall?.contextPlan;

    expect(plan?.originalEstimatedInputTokens).toBeGreaterThan(plan?.maximumPlannedInputTokens ?? Infinity);
    expect(plan?.originalEstimatedInputTokens).toBeLessThanOrEqual(plan?.hardInputLimitTokens ?? 0);
    expect(plan?.actions).toEqual([]);
    expect(thirdRequest.some((message) => message.role === "user" && message.content === contents[0])).toBe(true);
    expect(thirdRequest.some((message) => message.role === "user" && message.content === contents[1])).toBe(true);
    expect(thirdRequest.some((message) => message.role === "user" && message.content === contents[2])).toBe(true);
  });

  test("injects workspace instructions into the system prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspace = mkdtempSync(join(tmpdir(), "demesne-workspace-"));
    temporaryDirectories.push(workspace);
    writeFileSync(join(workspace, "DEMESNE.md"), "Always use tabs and run focused tests.\n");
    let systemMessage = "";
    const processor: TurnProcessor = {
      providerId: "test-provider",
      modelId: "instructions-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream(messages) {
        systemMessage = messages.find((message) => message.role === "system")?.content ?? "";
        yield { type: "text_delta", delta: "done" };
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Instructions", workspacePath: workspace }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(running.url, `/v1/sessions/${created.session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ content: "hello", permissionMode: "deny" }),
    });
    await collectPersistedEvents(running.url, created.session.id, submitted.eventId);

    expect(systemMessage).toContain("DEMESNE.md");
    expect(systemMessage).toContain("Always use tabs and run focused tests.");
    expect(systemMessage).toContain("take precedence");
  });

  test("reports the workspace git branch in session state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspace = mkdtempSync(join(tmpdir(), "demesne-git-workspace-"));
    temporaryDirectories.push(workspace);
    const init = Bun.spawn(["git", "init", "-q", "-b", "main", workspace], { stdout: "pipe", stderr: "pipe" });
    expect(await init.exited).toBe(0);

    const running = startApp(join(directory, "demesne.sqlite"));
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Git", workspacePath: workspace }),
    });
    const state = await jsonRequest<SessionStateResponse>(running.url, `/v1/sessions/${created.session.id}`);
    expect(state.session.workspace?.gitBranch).toBe("main");
  });

  test("lists workspace files for prompt mentions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspace = mkdtempSync(join(tmpdir(), "demesne-files-workspace-"));
    temporaryDirectories.push(workspace);
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "main.ts"), "export {};\n");
    writeFileSync(join(workspace, ".env"), "SECRET=1\n");

    const running = startApp(join(directory, "demesne.sqlite"));
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Files", workspacePath: workspace }),
    });
    const listing = await jsonRequest<WorkspaceFilesResponse>(running.url, `/v1/sessions/${created.session.id}/files`);
    expect(listing.files).toEqual(["src/main.ts"]);
  });

  test("persisted allowlist rules skip the permission prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "ws");
    const dataPath = join(directory, "data");
    mkdirSync(workspacePath);
    mkdirSync(dataPath);
    mkdirSync(join(workspacePath, "src"));
    writeFileSync(join(workspacePath, "src", "target.txt"), "original\n");
    const configPath = join(directory, "config.toml");
    writeFileSync(configPath, `[permissions]\nallow = ["edit_file:src"]\n`);

    let round = 0;
    const processor: TurnProcessor = {
      providerId: "allow-provider",
      modelId: "allow-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream() {
        if (round++ === 0) {
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "call-e",
            nameDelta: "edit_file",
            argumentsDelta: JSON.stringify({ path: "src/target.txt", oldText: "original", newText: "updated" }),
          };
          return;
        }
        yield { type: "text_delta" as const, delta: "edited" };
      },
    };
    const running = startApp(join(dataPath, "demesne.sqlite"), processor, undefined, {}, configPath);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Allowlist", workspacePath }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "edit", permissionMode: "ask" }) },
    );

    let permissionRequested = false;
    const eventsUrl = new URL(`/v1/events?session_id=${created.session.id}&after=${submitted.eventId}`, running.url);
    for await (const event of readServerSentEvents(await fetch(eventsUrl))) {
      if (event.type === "permission.requested") permissionRequested = true;
      if (event.type === "turn.completed") break;
    }
    expect(permissionRequested).toBe(false);
    expect(readFileSync(join(workspacePath, "src", "target.txt"), "utf8")).toBe("updated\n");
  });

  test("reviews changes and reverts a single file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "ws");
    const dataPath = join(directory, "data");
    mkdirSync(workspacePath);
    mkdirSync(dataPath);
    let round = 0;
    const processor: TurnProcessor = {
      providerId: "changes-provider",
      modelId: "changes-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream() {
        if (round++ === 0) {
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "c1",
            nameDelta: "write_file",
            argumentsDelta: JSON.stringify({ path: "a.txt", content: "A\n" }),
          };
          yield {
            type: "tool_call_delta" as const,
            index: 1,
            idDelta: "c2",
            nameDelta: "write_file",
            argumentsDelta: JSON.stringify({ path: "b.txt", content: "B\n" }),
          };
          return;
        }
        yield { type: "text_delta" as const, delta: "wrote both" };
      },
    };
    const running = startApp(join(dataPath, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Changes", workspacePath }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "write both", permissionMode: "ask" }) },
    );
    for await (const event of readServerSentEvents(await fetch(new URL(`/v1/events?session_id=${created.session.id}&after=${submitted.eventId}`, running.url)))) {
      if (event.type === "permission.requested") {
        await jsonRequest(running.url, `/v1/permissions/${event.payload.permissionId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "allow_once" }),
        });
      }
      if (event.type === "turn.completed") break;
    }

    const changes = await jsonRequest<TurnChangesResponse>(running.url, `/v1/sessions/${created.session.id}/changes`);
    expect(changes.changes.map((change) => [change.path, change.operation])).toEqual([["a.txt", "A"], ["b.txt", "A"]]);
    expect(changes.changes[0]!.diff).toEqual(["+ A"]);

    const first = await jsonRequest<UndoTurnResponse>(running.url, `/v1/sessions/${created.session.id}/undo`, {
      method: "POST",
      body: JSON.stringify({ paths: ["a.txt"] }),
    });
    expect(first).toMatchObject({ files: ["a.txt"], complete: false });
    expect(existsSync(join(workspacePath, "a.txt"))).toBe(false);
    expect(existsSync(join(workspacePath, "b.txt"))).toBe(true);

    const reviewed = await jsonRequest<TurnChangesResponse>(running.url, `/v1/sessions/${created.session.id}/changes`);
    expect(reviewed.turnId).toBe(changes.turnId);
    expect(reviewed.changes.find((change) => change.path === "a.txt")?.reverted).toBe(true);

    const second = await jsonRequest<UndoTurnResponse>(running.url, `/v1/sessions/${created.session.id}/undo`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(second).toMatchObject({ files: ["b.txt"], complete: true });
    expect(existsSync(join(workspacePath, "b.txt"))).toBe(false);
  });

  test("plan mode offers read-only tools and denies write attempts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "ws");
    const dataPath = join(directory, "data");
    mkdirSync(workspacePath);
    mkdirSync(dataPath);
    writeFileSync(join(workspacePath, "notes.txt"), "existing\n");
    let offered: string[] = [];
    let denial = "";
    let round = 0;
    const processor: TurnProcessor = {
      providerId: "plan-provider",
      modelId: "plan-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream(messages, tools) {
        if (round++ === 0) {
          offered = tools.map((tool) => tool.name);
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "w",
            nameDelta: "write_file",
            argumentsDelta: JSON.stringify({ path: "plan.txt", content: "should not exist" }),
          };
          return;
        }
        denial = messages.findLast((message) => message.role === "tool")?.content ?? "";
        yield { type: "text_delta" as const, delta: "1. Inspect notes\n2. Apply the change" };
      },
    };
    const running = startApp(join(dataPath, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Plan", workspacePath }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "plan the change", permissionMode: "deny", planOnly: true }) },
    );
    expect(submitted.turn.planOnly).toBe(true);
    for await (const event of readServerSentEvents(await fetch(new URL(`/v1/events?session_id=${created.session.id}&after=${submitted.eventId}`, running.url)))) {
      if (event.type === "turn.completed") break;
    }
    expect(offered).toContain("read_file");
    expect(offered).not.toContain("write_file");
    expect(offered).not.toContain("run_command");
    expect(denial).toContain("not available in plan mode");
    expect(existsSync(join(workspacePath, "plan.txt"))).toBe(false);
  });

  test("renames, searches, exports, and archives sessions over HTTP", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const running = startApp(join(directory, "demesne.sqlite"));
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Original" }),
    });

    const renamed = await jsonRequest<UpdateSessionResponse>(running.url, `/v1/sessions/${created.session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed session" }),
    });
    expect(renamed.session.title).toBe("Renamed session");

    const withModel = await jsonRequest<UpdateSessionResponse>(running.url, `/v1/sessions/${created.session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ preferredModel: "local-model" }),
    });
    expect(withModel.session.preferredModel).toBe("local-model");

    const searched = await jsonRequest<{ sessions: Session[] }>(running.url, "/v1/sessions?query=Renamed");
    expect(searched.sessions.map((session) => session.id)).toEqual([created.session.id]);

    const exported = await fetch(new URL(`/v1/sessions/${created.session.id}/export?format=md`, running.url));
    expect(exported.headers.get("content-type")).toContain("text/markdown");
    expect(await exported.text()).toContain("# Renamed session");

    const archived = await jsonRequest<ArchiveSessionResponse>(running.url, `/v1/sessions/${created.session.id}`, {
      method: "DELETE",
    });
    expect(archived.session.archivedAt).toBeTruthy();
    const after = await jsonRequest<{ sessions: Session[] }>(running.url, "/v1/sessions");
    expect(after.sessions).toEqual([]);

    const invalid = await fetch(new URL(`/v1/sessions/${created.session.id}/export?format=xml`, running.url));
    expect(invalid.status).toBe(400);
  });

  test("reports daemon and active session status", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processor: TurnProcessor = {
      providerId: "status-provider",
      modelId: "status-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream() {
        await gate;
        yield { type: "text_delta" as const, delta: "done" };
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const created = await jsonRequest<CreateSessionResponse>(running.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Status check" }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      running.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "wait" }) },
    );

    const active = await jsonRequest<DaemonStatusResponse>(running.url, "/v1/status");
    expect(active).toMatchObject({ provider: "status-provider", model: "status-model", inferenceSlots: 1 });
    expect(active.active).toHaveLength(1);
    expect(active.active[0]).toMatchObject({ id: created.session.id, title: "Status check" });
    expect(["queued", "running"]).toContain(active.active[0]!.turnStatus);

    release();
    await collectPersistedEvents(running.url, created.session.id, submitted.eventId);
    const idle = await jsonRequest<DaemonStatusResponse>(running.url, "/v1/status");
    expect(idle.active).toEqual([]);
  });

  test("bridges MCP tools with allowlist approval", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "ws");
    const dataPath = join(directory, "data");
    mkdirSync(workspacePath);
    mkdirSync(dataPath);
    const configPath = join(directory, "config.toml");
    writeFileSync(configPath, `[permissions]\nallow = ["mcp__stub__echo"]\n`);
    const stub = `
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1.0.0" } } });
    else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
    else if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "echo: " + message.params.arguments.text }] } });
  }
});
`;
    let offered: string[] = [];
    let toolResult = "";
    let round = 0;
    const processor: TurnProcessor = {
      providerId: "mcp-provider",
      modelId: "mcp-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream(messages, tools) {
        if (round++ === 0) {
          offered = tools.map((tool) => tool.name);
          yield {
            type: "tool_call_delta" as const,
            index: 0,
            idDelta: "m1",
            nameDelta: "mcp__stub__echo",
            argumentsDelta: JSON.stringify({ text: "hi" }),
          };
          return;
        }
        toolResult = messages.findLast((message) => message.role === "tool")?.content ?? "";
        yield { type: "text_delta" as const, delta: "mcp done" };
      },
    };
    const app = createDaemonApp({
      databasePath: join(dataPath, "demesne.sqlite"),
      processor,
      allowlistPath: configPath,
      mcpServers: { stub: { command: process.execPath, args: ["-e", stub] } },
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    apps.push(app);
    servers.push(server);
    await app.ready;

    const created = await jsonRequest<CreateSessionResponse>(server.url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "MCP", workspacePath }),
    });
    const submitted = await jsonRequest<SubmitTurnResponse>(
      server.url,
      `/v1/sessions/${created.session.id}/turns`,
      { method: "POST", body: JSON.stringify({ content: "use echo", permissionMode: "ask" }) },
    );

    let permissionRequested = false;
    for await (const event of readServerSentEvents(await fetch(new URL(`/v1/events?session_id=${created.session.id}&after=${submitted.eventId}`, server.url)))) {
      if (event.type === "permission.requested") permissionRequested = true;
      if (event.type === "turn.completed") break;
    }
    expect(permissionRequested).toBe(false);
    expect(offered).toContain("mcp__stub__echo");
    expect(toolResult).toBe("echo: hi");
  });

  test("emits a machine-readable result for scripted prompts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const processor: TurnProcessor = {
      providerId: "json-provider",
      modelId: "json-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream() {
        yield { type: "text_delta" as const, delta: "done" };
        yield { type: "usage" as const, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const cliPath = join(import.meta.dir, "../../cli/src/main.ts");
    const child = Bun.spawn(
      [process.execPath, cliPath, "--server", running.url.href, "prompt", "--output", "json", "Say done"],
      { env: isolatedCliEnv({ HOME: directory }), stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as Record<string, unknown>;
    expect(result.status).toBe("completed");
    expect(result.response).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stderr).not.toContain("Session ");
  });

  test("streams event JSON lines and a final result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const processor: TurnProcessor = {
      providerId: "stream-provider",
      modelId: "stream-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream() {
        yield { type: "text_delta" as const, delta: "streamed" };
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const cliPath = join(import.meta.dir, "../../cli/src/main.ts");
    const child = Bun.spawn(
      [process.execPath, cliPath, "--server", running.url.href, "prompt", "--output", "stream-json", "Go"],
      { env: isolatedCliEnv({ HOME: directory }), stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    await new Response(child.stderr).text();

    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({ type: "result", status: "completed", response: "streamed" });
    expect(lines.some((entry) => entry.type === "model.request_started")).toBe(true);
    expect(lines.some((entry) => entry.type === "message.delta")).toBe(true);
  });

  test("reads the prompt from stdin when no text argument is given", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const running = startApp(join(directory, "demesne.sqlite"));
    const cliPath = join(import.meta.dir, "../../cli/src/main.ts");
    const child = Bun.spawn(
      [process.execPath, cliPath, "--server", running.url.href, "prompt", "--output", "json"],
      { env: isolatedCliEnv({ HOME: directory }), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.write("Piped prompt");
    child.stdin.end();
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    await new Response(child.stderr).text();

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as Record<string, unknown>;
    expect(result.response).toBe("Request accepted: Piped prompt");
  });

  test("event stream replays backlog and delivers a concurrent live event exactly once, in order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const processor: TurnProcessor = {
      providerId: "sse-provider",
      modelId: "sse-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream() {
        yield { type: "text_delta" as const, delta: "ok" };
        yield { type: "usage" as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const url = running.url;

    // Event 1: session.created (fresh database, so ids start at 1).
    const created = await jsonRequest<CreateSessionResponse>(url, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "SSE replay" }),
    });
    expect(created.eventId).toBe(1);
    const sessionId = created.session.id;

    // Events 2, 3, 4: one session.renamed each.
    const rename = async (title: string): Promise<number> =>
      (await jsonRequest<UpdateSessionResponse>(url, `/v1/sessions/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      })).eventId as number;
    expect(await rename("rename-2")).toBe(2);
    expect(await rename("rename-3")).toBe(3);
    expect(await rename("rename-4")).toBe(4);

    // Connect at after=1 so ids 2, 3, 4 are backlogged for replay. (eventsAfter
    // is a strict `id > after`, so after=1 — not after=2 — backlogs exactly 2,3,4.)
    const eventsUrl = new URL("/v1/events", url);
    eventsUrl.searchParams.set("session_id", sessionId);
    eventsUrl.searchParams.set("after", "1");
    const controller = new AbortController();
    const events: EventEnvelope[] = [];
    const readTask = (async () => {
      for await (const event of readServerSentEvents(await fetch(eventsUrl, { signal: controller.signal }))) {
        events.push(event);
        // After two of the three backlogged events have been delivered, the
        // stream has not yet run the pull that would deliver the third, so
        // replayComplete is still false and the hub discards a live event.
        // Publish one anyway: it is written to SQLite before the hub emit, so
        // the replay path must deliver it exactly once.
        if (events.length === 2) {
          const live = await jsonRequest<UpdateSessionResponse>(url, `/v1/sessions/${sessionId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: "rename-5" }),
          });
          expect(live.eventId).toBe(5);
        }
        if (events.length >= 4) break;
      }
    })();
    const guard = setTimeout(() => controller.abort(), 2_000);
    try {
      await readTask;
    } finally {
      clearTimeout(guard);
    }

    // The invariant: the three backlogged events plus the one concurrent live
    // event, in order, each exactly once — no gap, no duplicate from both the
    // replay and the hub path.
    expect(events.map((event) => event.eventId)).toEqual([2, 3, 4, 5]);
    expect(events.filter((event) => event.type === "session.renamed")).toHaveLength(4);
  });

  test("exits non-zero and reports failures in JSON mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-test-"));
    temporaryDirectories.push(directory);
    const processor: TurnProcessor = {
      providerId: "fail-provider",
      modelId: "fail-model",
      async listModels() {
        return [{ id: this.modelId, provider: this.providerId }];
      },
      async *stream() {
        throw new ProviderError("model exploded");
      },
    };
    const running = startApp(join(directory, "demesne.sqlite"), processor);
    const cliPath = join(import.meta.dir, "../../cli/src/main.ts");
    const child = Bun.spawn(
      [process.execPath, cliPath, "--server", running.url.href, "prompt", "--output", "json", "Fail"],
      { env: isolatedCliEnv({ HOME: directory }), stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    await new Response(child.stderr).text();

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout) as Record<string, unknown>;
    expect(result.status).toBe("failed");
    expect(String(result.error)).toContain("model exploded");
  });
});

function startApp(
  databasePath: string,
  processor?: TurnProcessor,
  inferenceBoundaryHook?: InferenceBoundaryHook,
  providerLimits: { providerFirstEventTimeoutMs?: number; providerRequestTimeoutMs?: number } = {},
  allowlistPath?: string,
): {
  app: DaemonApp;
  server: Bun.Server<unknown>;
  url: URL;
} {
  const app = createDaemonApp({ databasePath, processor, inferenceBoundaryHook, allowlistPath, ...providerLimits });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  apps.push(app);
  servers.push(server);
  return { app, server, url: server.url };
}

async function collectPersistedEventTypes(baseUrl: URL, sessionId: string, after: number): Promise<string[]> {
  return (await collectPersistedEvents(baseUrl, sessionId, after)).map((event) => event.type);
}

async function collectPersistedEvents(baseUrl: URL, sessionId: string, after: number): Promise<EventEnvelope[]> {
  const eventsUrl = new URL("/v1/events", baseUrl);
  eventsUrl.searchParams.set("session_id", sessionId);
  eventsUrl.searchParams.set("after", String(after));
  const events: EventEnvelope[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    for await (const event of readServerSentEvents(await fetch(eventsUrl, { signal: controller.signal }))) {
      events.push(event);
      if (["turn.completed", "turn.cancelled", "turn.failed", "turn.interrupted"].includes(event.type)) break;
    }
  } finally {
    clearTimeout(timeout);
  }
  return events;
}

async function waitForPersistedEvent(
  baseUrl: URL,
  sessionId: string,
  after: number,
  type: EventEnvelope["type"],
): Promise<EventEnvelope> {
  const eventsUrl = new URL("/v1/events", baseUrl);
  eventsUrl.searchParams.set("session_id", sessionId);
  eventsUrl.searchParams.set("after", String(after));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    for await (const event of readServerSentEvents(await fetch(eventsUrl, { signal: controller.signal }))) {
      if (event.type === type) return event;
      if (["turn.completed", "turn.cancelled", "turn.failed", "turn.interrupted"].includes(event.type)) {
        throw new Error(`Turn reached ${event.type} before ${type}`);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  throw new Error(`Event stream ended before ${type}`);
}

async function jsonRequest<T>(baseUrl: URL, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.text();
  expect(response.ok, `POST ${path} -> ${response.status}: ${body}`).toBe(true);
  return JSON.parse(body) as T;
}
