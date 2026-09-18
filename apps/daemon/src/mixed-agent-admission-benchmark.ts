import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readServerSentEvents,
  type CreateSessionResponse,
  type EventEnvelope,
  type EventType,
  type SessionStateResponse,
  type SubmitTurnResponse,
  type TurnStatus,
} from "@demesne/protocol";
import { createDaemonApp, type DaemonApp } from "./app.ts";
import type { InferenceBoundaryHook } from "./inference-scheduler.ts";
import {
  calculateHostMemoryDelta,
  readHostMemorySnapshot,
  readHostPowerSnapshot,
  readOllamaRunnerSnapshot,
  type HostMemorySnapshot,
  type HostPowerSnapshot,
  type OllamaRunnerSnapshot,
} from "./provider-benchmark.ts";
import type { TurnProcessor } from "./processor.ts";

export const MIXED_AGENT_ADMISSION_BENCHMARK_SCHEMA_VERSION = 1 as const;

export type MixedAgentScenarioId =
  | "read-only-completion"
  | "queued-cancellation"
  | "approved-edit-completion"
  | "recoverable-tool-failure"
  | "permission-wait-cancellation";

export interface MixedAgentScenarioContract {
  id: MixedAgentScenarioId;
  prompt: string;
  permissionMode: "ask" | "deny";
  expectedStatus: TurnStatus;
  response: { mode: "exact" | "required"; marker: string } | null;
  requiredEventOrder: readonly EventType[];
  providerStarts: { minimum: number; maximum: number };
  providerOutcomes: readonly ("completed" | "failed" | "cancelled" | "interrupted")[];
  initialFiles: Readonly<Record<string, string>>;
  finalFiles: Readonly<Record<string, string>>;
  control: "none" | "approve_permission" | "cancel_permission" | "cancel_queued";
}

export const MIXED_AGENT_SCENARIOS: readonly MixedAgentScenarioContract[] = [
  {
    id: "read-only-completion",
    prompt: "SCENARIO:read-only-completion\nRead input.txt without modifying files. End with exactly: READ_ONLY_COMPLETE",
    permissionMode: "deny",
    expectedStatus: "completed",
    response: { mode: "required", marker: "READ_ONLY_COMPLETE" },
    requiredEventOrder: [
      "agent.started",
      "model.request_started",
      "model.request_completed",
      "tool.call_requested",
      "tool.call_started",
      "tool.call_completed",
      "model.request_started",
      "model.request_completed",
      "message.completed",
      "turn.completed",
    ],
    providerStarts: { minimum: 2, maximum: 2 },
    providerOutcomes: ["completed", "completed"],
    initialFiles: { "input.txt": "deterministic read-only input\n" },
    finalFiles: { "input.txt": "deterministic read-only input\n" },
    control: "none",
  },
  {
    id: "queued-cancellation",
    prompt: "SCENARIO:queued-cancellation\nWait for provider admission. This turn is expected to be cancelled before it starts.",
    permissionMode: "deny",
    expectedStatus: "cancelled",
    response: null,
    requiredEventOrder: ["turn.cancelled"],
    providerStarts: { minimum: 0, maximum: 0 },
    providerOutcomes: [],
    initialFiles: { "queued.txt": "unchanged\n" },
    finalFiles: { "queued.txt": "unchanged\n" },
    control: "cancel_queued",
  },
  {
    id: "approved-edit-completion",
    prompt: "SCENARIO:approved-edit-completion\nEdit approved.txt, replacing 0 with 1. After the edit succeeds, end with exactly: APPROVED_EDIT_COMPLETE",
    permissionMode: "ask",
    expectedStatus: "completed",
    response: { mode: "required", marker: "APPROVED_EDIT_COMPLETE" },
    requiredEventOrder: [
      "model.request_started",
      "model.request_completed",
      "tool.call_requested",
      "permission.requested",
      "permission.resolved",
      "tool.call_started",
      "tool.call_completed",
      "model.request_started",
      "model.request_completed",
      "turn.completed",
    ],
    providerStarts: { minimum: 2, maximum: 4 },
    providerOutcomes: ["completed"],
    initialFiles: { "approved.txt": "0\n" },
    finalFiles: { "approved.txt": "1\n" },
    control: "approve_permission",
  },
  {
    id: "recoverable-tool-failure",
    prompt: "SCENARIO:recoverable-tool-failure\nFirst call read_file for missing.txt. After that expected failure, call read_file for recovery.txt. Do not use other tools. End with exactly: RECOVERED_AFTER_TOOL_FAILURE",
    permissionMode: "deny",
    expectedStatus: "completed",
    response: { mode: "required", marker: "RECOVERED_AFTER_TOOL_FAILURE" },
    requiredEventOrder: [
      "model.request_started",
      "model.request_completed",
      "tool.call_requested",
      "tool.call_failed",
      "model.request_started",
      "model.request_completed",
      "tool.call_requested",
      "tool.call_started",
      "tool.call_completed",
      "model.request_started",
      "model.request_completed",
      "turn.completed",
    ],
    providerStarts: { minimum: 3, maximum: 3 },
    providerOutcomes: ["completed", "completed", "completed"],
    initialFiles: { "recovery.txt": "unchanged\n" },
    finalFiles: { "recovery.txt": "unchanged\n" },
    control: "none",
  },
  {
    id: "permission-wait-cancellation",
    prompt: "SCENARIO:permission-wait-cancellation\nEdit cancelled.txt, replacing 0 with 1. This permission wait is expected to be cancelled.",
    permissionMode: "ask",
    expectedStatus: "cancelled",
    response: null,
    requiredEventOrder: [
      "model.request_started",
      "model.request_completed",
      "tool.call_requested",
      "permission.requested",
      "tool.call_cancelled",
      "turn.cancelled",
    ],
    providerStarts: { minimum: 1, maximum: 2 },
    providerOutcomes: ["completed"],
    initialFiles: { "cancelled.txt": "0\n" },
    finalFiles: { "cancelled.txt": "0\n" },
    control: "cancel_permission",
  },
] as const;

export interface MixedAgentAdmissionBenchmarkConfig {
  maximumInFlightTasks: number;
  repetitions: number;
  timeoutMs: number;
}

export interface MixedAgentAdmissionBenchmarkDependencies {
  processor: TurnProcessor;
  inferenceBoundaryHook?: InferenceBoundaryHook;
  memorySnapshot?: () => HostMemorySnapshot | null;
  powerSnapshot?: () => HostPowerSnapshot | null;
  runnerSnapshot?: () => OllamaRunnerSnapshot | null;
  now?: () => number;
}

export interface MixedAgentAdmissionRecord {
  scenarioId: MixedAgentScenarioId;
  admissionOrder: number;
  admittedAt: string;
  admittedAtElapsedMs: number;
  inFlightCount: number;
  terminalCountAtAdmission: number;
}

export interface MixedAgentProviderRound {
  providerCallId: string;
  outcome: "completed" | "failed" | "cancelled" | "interrupted" | null;
  eventTypes: EventType[];
  queueDurationMs: number | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface MixedAgentTaskObservation {
  scenarioId: MixedAgentScenarioId;
  admissionOrder: number;
  sessionId: string;
  turnId: string;
  workspacePath: string;
  status: TurnStatus;
  responseText: string;
  terminalAt: string;
  terminalAtElapsedMs: number;
  eventTypes: EventType[];
  eventCounts: Partial<Record<EventType, number>>;
  providerStartCount: number;
  providerRounds: MixedAgentProviderRound[];
  finalWorkspace: Array<{ path: string; content: string }>;
  pendingPermissions: number;
  score: {
    terminalStatusValid: boolean;
    responseValid: boolean;
    lifecycleValid: boolean;
    providerStartsValid: boolean;
    providerOutcomesValid: boolean;
    workspaceValid: boolean;
    eventIntegrityValid: boolean;
    expectedCancellationFailureValid: boolean;
  };
  success: boolean;
}

export interface MixedAgentAdmissionBenchmarkReport {
  schemaVersion: typeof MIXED_AGENT_ADMISSION_BENCHMARK_SCHEMA_VERSION;
  startedAt: string;
  completedAt: string;
  config: MixedAgentAdmissionBenchmarkConfig & {
    inferenceSlots: 1;
    scenarioOrder: MixedAgentScenarioId[];
    provider: string;
    model: string;
  };
  admissions: MixedAgentAdmissionRecord[];
  tasks: MixedAgentTaskObservation[];
  provider: {
    totalStarts: number;
    outcomes: Record<"completed" | "failed" | "cancelled" | "interrupted" | "unsettled", number>;
    eventCounts: Partial<Record<EventType, number>>;
  };
  memory: {
    before: HostMemorySnapshot | null;
    after: HostMemorySnapshot | null;
    delta: ReturnType<typeof calculateHostMemoryDelta>;
  };
  power: { before: HostPowerSnapshot | null; after: HostPowerSnapshot | null };
  runner: { before: OllamaRunnerSnapshot | null; after: OllamaRunnerSnapshot | null };
  summary: {
    successfulScenarios: number;
    totalScenarios: number;
    scenarioSuccess: boolean;
    eventIntegrityValid: boolean;
    rollingAdmissionValid: boolean;
    expectedCancellationFailureValid: boolean;
    functionalValid: boolean;
    memoryEligible: boolean;
    experimentValid: boolean;
  };
}

export async function runMixedAgentAdmissionBenchmark(
  config: MixedAgentAdmissionBenchmarkConfig,
  dependencies: MixedAgentAdmissionBenchmarkDependencies,
): Promise<MixedAgentAdmissionBenchmarkReport> {
  validateConfig(config);
  const now = dependencies.now ?? performance.now.bind(performance);
  const startedAt = new Date().toISOString();
  const started = now();
  const root = mkdtempSync(join(tmpdir(), "demesne-mixed-agent-admission-"));
  const dataDirectory = join(root, "data");
  mkdirSync(dataDirectory, { mode: 0o700 });
  const scenarioPlan = Array.from({ length: config.repetitions }, () => MIXED_AGENT_SCENARIOS).flat();
  const workspaces = scenarioPlan.map((scenario, index) => {
    const workspace = join(root, `workspace-${index}-${scenario.id}`);
    materializeWorkspace(workspace, scenario.initialFiles);
    return workspace;
  });

  const readOnlyGates = Array.from({ length: config.repetitions }, () => {
    let release!: () => void;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    return { completed, release };
  });
  const releaseReadOnly = (repetition: number) => readOnlyGates[repetition]?.release();
  const processor = gatedProcessor(dependencies.processor, readOnlyGates.map((gate) => gate.completed));
  const app = createDaemonApp({
    databasePath: join(dataDirectory, "demesne.sqlite"),
    processor,
    inferenceSlots: 1,
    inferenceBoundaryHook: dependencies.inferenceBoundaryHook,
  });
  const memorySnapshot = dependencies.memorySnapshot ?? readHostMemorySnapshot;
  const powerSnapshot = dependencies.powerSnapshot ?? readHostPowerSnapshot;
  const runnerSnapshot = dependencies.runnerSnapshot ?? readOllamaRunnerSnapshot;
  const memoryBefore = memorySnapshot();
  const powerBefore = powerSnapshot();
  const runnerBefore = runnerSnapshot();
  let memoryAfter: HostMemorySnapshot | null = null;
  let powerAfter: HostPowerSnapshot | null = null;
  let runnerAfter: OllamaRunnerSnapshot | null = null;
  let admissions: MixedAgentAdmissionRecord[] = [];
  let tasks: MixedAgentTaskObservation[] = [];

  try {
    ({ admissions, tasks } = await runRollingAdmission(
      app,
      config,
      scenarioPlan,
      workspaces,
      now,
      started,
      releaseReadOnly,
    ));
    memoryAfter = memorySnapshot();
    powerAfter = powerSnapshot();
    runnerAfter = runnerSnapshot();
  } finally {
    readOnlyGates.forEach((gate) => gate.release());
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }

  const memoryDelta = calculateHostMemoryDelta(memoryBefore, memoryAfter);
  const scenarioSuccess = tasks.length === scenarioPlan.length && tasks.every((task) => task.success);
  const eventIntegrity = tasks.length === scenarioPlan.length
    && tasks.every((task) => task.score.eventIntegrityValid);
  const rollingAdmissionValid = validateRollingAdmission(admissions, scenarioPlan, config.maximumInFlightTasks);
  const expectedCancellationFailureValid = tasks.length === scenarioPlan.length
    && tasks.every((task) => task.score.expectedCancellationFailureValid);
  const functionalValid = scenarioSuccess && eventIntegrity && rollingAdmissionValid
    && expectedCancellationFailureValid;
  const memoryEligible = memoryDelta.swapOutBytes === 0;
  const providerRounds = tasks.flatMap((task) => task.providerRounds);
  const providerEvents = tasks.flatMap((task) => task.eventTypes.filter((type) => type.startsWith("model.")));
  return {
    schemaVersion: MIXED_AGENT_ADMISSION_BENCHMARK_SCHEMA_VERSION,
    startedAt,
    completedAt: new Date().toISOString(),
    config: {
      ...config,
      inferenceSlots: 1,
      scenarioOrder: scenarioPlan.map((scenario) => scenario.id),
      provider: dependencies.processor.providerId,
      model: dependencies.processor.modelId,
    },
    admissions,
    tasks,
    provider: {
      totalStarts: providerRounds.length,
      outcomes: {
        completed: providerRounds.filter((round) => round.outcome === "completed").length,
        failed: providerRounds.filter((round) => round.outcome === "failed").length,
        cancelled: providerRounds.filter((round) => round.outcome === "cancelled").length,
        interrupted: providerRounds.filter((round) => round.outcome === "interrupted").length,
        unsettled: providerRounds.filter((round) => round.outcome === null).length,
      },
      eventCounts: countEvents(providerEvents),
    },
    memory: { before: memoryBefore, after: memoryAfter, delta: memoryDelta },
    power: { before: powerBefore, after: powerAfter },
    runner: { before: runnerBefore, after: runnerAfter },
    summary: {
      successfulScenarios: tasks.filter((task) => task.success).length,
      totalScenarios: scenarioPlan.length,
      scenarioSuccess,
      eventIntegrityValid: eventIntegrity,
      rollingAdmissionValid,
      expectedCancellationFailureValid,
      functionalValid,
      memoryEligible,
      experimentValid: functionalValid && memoryEligible,
    },
  };
}

async function runRollingAdmission(
  app: DaemonApp,
  config: MixedAgentAdmissionBenchmarkConfig,
  scenarioPlan: readonly MixedAgentScenarioContract[],
  workspaces: string[],
  now: () => number,
  started: number,
  releaseReadOnly: (repetition: number) => void,
): Promise<{ admissions: MixedAgentAdmissionRecord[]; tasks: MixedAgentTaskObservation[] }> {
  const admissions: MixedAgentAdmissionRecord[] = [];
  const observations = new Array<MixedAgentTaskObservation>(scenarioPlan.length);
  let next = 0;
  let inFlight = 0;
  let terminalCount = 0;
  let observedCount = 0;

  return await new Promise<{ admissions: MixedAgentAdmissionRecord[]; tasks: MixedAgentTaskObservation[] }>((resolve, reject) => {
    let failed = false;
    const admit = () => {
      while (!failed && inFlight < config.maximumInFlightTasks && next < scenarioPlan.length) {
        const index = next;
        const scenario = scenarioPlan[index]!;
        next += 1;
        inFlight += 1;
        admissions.push({
          scenarioId: scenario.id,
          admissionOrder: index,
          admittedAt: new Date().toISOString(),
          admittedAtElapsedMs: Math.max(0, now() - started),
          inFlightCount: inFlight,
          terminalCountAtAdmission: terminalCount,
        });
        let terminalNotified = false;
        const onTerminal = () => {
          if (terminalNotified || failed) return;
          terminalNotified = true;
          if (scenario.control === "cancel_queued") {
            releaseReadOnly(Math.floor(index / MIXED_AGENT_SCENARIOS.length));
          }
          inFlight -= 1;
          terminalCount += 1;
          admit();
        };
        void runScenario(app, scenario, workspaces[index]!, index, config.timeoutMs, now, started, onTerminal)
          .then((observation) => {
            observations[index] = observation;
            observedCount += 1;
            if (observedCount === scenarioPlan.length) {
              resolve({ admissions, tasks: observations });
            }
          })
          .catch((error) => {
            if (failed) return;
            failed = true;
            reject(error);
          });
      }
    };
    admit();
  }).finally(() => {
    for (let repetition = 0; repetition < config.repetitions; repetition += 1) releaseReadOnly(repetition);
  });
}

async function runScenario(
  app: DaemonApp,
  scenario: MixedAgentScenarioContract,
  workspacePath: string,
  admissionOrder: number,
  timeoutMs: number,
  now: () => number,
  started: number,
  onTerminal: () => void,
): Promise<MixedAgentTaskObservation> {
  const created = await jsonRequest<CreateSessionResponse>(app, "/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ title: scenario.id, workspacePath }),
  });
  const submitted = await jsonRequest<SubmitTurnResponse>(app, `/v1/sessions/${created.session.id}/turns`, {
    method: "POST",
    body: JSON.stringify({
      content: scenario.prompt,
      permissionMode: scenario.permissionMode,
      thinkingEnabled: false,
    }),
  });
  if (scenario.control === "cancel_queued") {
    await jsonRequest(app, `/v1/turns/${submitted.turn.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  let terminalAt = "";
  let terminalAtElapsedMs = 0;
  const events = await collectControlledEvents(app, created.session.id, submitted, scenario, timeoutMs, () => {
    terminalAt = new Date().toISOString();
    terminalAtElapsedMs = Math.max(0, now() - started);
    onTerminal();
  });
  const state = await jsonRequest<SessionStateResponse>(app, `/v1/sessions/${created.session.id}`);
  const turn = state.session.turns.find((candidate) => candidate.id === submitted.turn.id);
  if (!turn) throw new Error(`Mixed-agent benchmark turn disappeared: ${submitted.turn.id}`);
  const { rounds, valid: providerEventIntegrity } = collectProviderRoundSummary(events);
  const eventTypes = events.map((event) => event.type);
  const finalWorkspace = snapshotWorkspace(workspacePath);
  const terminalStatusValid = turn.status === scenario.expectedStatus;
  const responseValid = scenario.response === null
    ? true
    : scenario.response.mode === "exact"
      ? turn.responseText === scenario.response.marker
      : turn.responseText.includes(scenario.response.marker);
  const lifecycleValid = containsOrdered(eventTypes, scenario.requiredEventOrder);
  const providerStartsValid = rounds.length >= scenario.providerStarts.minimum
    && rounds.length <= scenario.providerStarts.maximum;
  const actualOutcomes = rounds.map((round) => round.outcome);
  const providerOutcomesValid = scenario.providerStarts.minimum === scenario.providerStarts.maximum
    ? arraysEqual(actualOutcomes, scenario.providerOutcomes)
    : actualOutcomes.every((outcome) => outcome !== null && scenario.providerOutcomes.includes(outcome));
  const workspaceValid = workspaceEquals(finalWorkspace, scenario.finalFiles);
  const terminalEvents = eventTypes.filter((type) => isTerminalEvent(type));
  const eventIntegrityValid = providerEventIntegrity
    && events.every((event, index) => event.sessionId === created.session.id
      && event.turnId === submitted.turn.id
      && (index === 0 || event.eventId > events[index - 1]!.eventId))
    && terminalEvents.length === 1
    && terminalEvents[0] === `turn.${scenario.expectedStatus}`;
  const expectedCancellationFailureValid = validateExpectedCancellationFailure(
    scenario.id,
    turn.status,
    eventTypes,
    rounds.length,
    state.pendingPermissions.length,
  );
  const score = {
    terminalStatusValid,
    responseValid,
    lifecycleValid,
    providerStartsValid,
    providerOutcomesValid,
    workspaceValid,
    eventIntegrityValid,
    expectedCancellationFailureValid,
  };
  return {
    scenarioId: scenario.id,
    admissionOrder,
    sessionId: created.session.id,
    turnId: submitted.turn.id,
    workspacePath,
    status: turn.status,
    responseText: turn.responseText,
    terminalAt,
    terminalAtElapsedMs,
    eventTypes,
    eventCounts: countEvents(eventTypes),
    providerStartCount: rounds.length,
    providerRounds: rounds,
    finalWorkspace,
    pendingPermissions: state.pendingPermissions.length,
    score,
    success: Object.values(score).every(Boolean),
  };
}

async function collectControlledEvents(
  app: DaemonApp,
  sessionId: string,
  submitted: SubmitTurnResponse,
  scenario: MixedAgentScenarioContract,
  timeoutMs: number,
  onTerminal: () => void,
): Promise<EventEnvelope[]> {
  const response = await app.fetch(new Request(
    `http://daemon/v1/events?session_id=${encodeURIComponent(sessionId)}&after=${submitted.eventId}`,
  ));
  if (!response.ok) throw new Error(`Mixed-agent event stream returned HTTP ${response.status}`);
  const iterator = readServerSentEvents(response)[Symbol.asyncIterator]();
  const events: EventEnvelope[] = [];
  let permissionControlled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(
      `Mixed-agent scenario ${scenario.id} timed out after ${timeoutMs}ms`,
    )), timeoutMs);
  });
  try {
    while (true) {
      const result = await Promise.race([iterator.next(), timedOut]);
      if (result.done) throw new Error(`Mixed-agent event stream closed before ${scenario.id} became terminal`);
      const event = result.value;
      events.push(event);
      if (event.type === "permission.requested" && !permissionControlled) {
        const permissionId = typeof event.payload.permissionId === "string" ? event.payload.permissionId : null;
        if (!permissionId) throw new Error(`Mixed-agent scenario ${scenario.id} emitted a malformed permission request`);
        const state = await jsonRequest<SessionStateResponse>(app, `/v1/sessions/${sessionId}`);
        if (!state.pendingPermissions.some((permission) => permission.id === permissionId)) {
          throw new Error(`Mixed-agent scenario ${scenario.id} permission was not persisted`);
        }
        permissionControlled = true;
        if (scenario.control === "approve_permission") {
          await jsonRequest(app, `/v1/permissions/${permissionId}`, {
            method: "POST",
            body: JSON.stringify({ decision: "allow_once" }),
          });
        } else if (scenario.control === "cancel_permission") {
          await jsonRequest(app, `/v1/turns/${submitted.turn.id}/cancel`, {
            method: "POST",
            body: JSON.stringify({}),
          });
        } else {
          throw new Error(`Mixed-agent scenario ${scenario.id} requested unexpected permission`);
        }
      }
      if (isTerminalEvent(event.type)) {
        onTerminal();
        return events;
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    await iterator.return?.(undefined);
  }
}

function collectProviderRoundSummary(events: EventEnvelope[]): {
  rounds: MixedAgentProviderRound[];
  valid: boolean;
} {
  type MutableRound = MixedAgentProviderRound & { terminalEvents: number; metricsEvents: number; usageEvents: number };
  const rounds = new Map<string, MutableRound>();
  let valid = true;
  for (const event of events) {
    const providerCallId = typeof event.payload.providerCallId === "string" ? event.payload.providerCallId : null;
    if (!providerCallId) continue;
    if (event.type === "model.request_started") {
      if (rounds.has(providerCallId)) {
        valid = false;
        continue;
      }
      rounds.set(providerCallId, {
        providerCallId,
        outcome: null,
        eventTypes: [event.type],
        queueDurationMs: null,
        durationMs: null,
        timeToFirstTokenMs: null,
        inputTokens: null,
        outputTokens: null,
        terminalEvents: 0,
        metricsEvents: 0,
        usageEvents: 0,
      });
      continue;
    }
    const round = rounds.get(providerCallId);
    if (!round) {
      if (isProviderLifecycleEvent(event.type)) valid = false;
      continue;
    }
    if (!event.type.startsWith("model.")) continue;
    round.eventTypes.push(event.type);
    if (event.type === "model.metrics") {
      round.metricsEvents += 1;
      round.queueDurationMs = numberOrNull(event.payload.queueDurationMs);
      round.durationMs = numberOrNull(event.payload.durationMs);
      round.timeToFirstTokenMs = numberOrNull(event.payload.timeToFirstTokenMs);
    }
    if (event.type === "model.usage") {
      round.usageEvents += 1;
      round.inputTokens = numberOrNull(event.payload.inputTokens);
      round.outputTokens = numberOrNull(event.payload.outputTokens);
    }
    if (event.type === "model.request_completed") round.outcome = "completed";
    if (event.type === "model.request_failed") round.outcome = "failed";
    if (event.type === "model.request_cancelled") round.outcome = "cancelled";
    if (event.type === "model.request_interrupted") round.outcome = "interrupted";
    if (["model.request_completed", "model.request_failed", "model.request_cancelled", "model.request_interrupted"]
      .includes(event.type)) round.terminalEvents += 1;
  }
  const values = [...rounds.values()];
  valid = valid && values.every((round) => round.terminalEvents === 1
    && round.metricsEvents === 1 && round.usageEvents <= 1 && round.outcome !== null);
  return {
    valid,
    rounds: values.map(({ terminalEvents: _terminal, metricsEvents: _metrics, usageEvents: _usage, ...round }) => round),
  };
}

function gatedProcessor(processor: TurnProcessor, queuedCancellationsCompleted: Promise<void>[]): TurnProcessor {
  let readOnlyRepetition = 0;
  return {
    get providerId() { return processor.providerId; },
    get modelId() { return processor.modelId; },
    get contextCapacity() { return processor.contextCapacity; },
    get maxOutputTokens() { return processor.maxOutputTokens; },
    get temperature() { return processor.temperature; },
    get seed() { return processor.seed; },
    listModels: (signal) => processor.listModels(signal),
    runtimeStatus: processor.runtimeStatus ? () => processor.runtimeStatus!() : undefined,
    async *stream(messages, tools, signal, thinkingEnabled) {
      const prompt = messages.findLast((message) => message.role === "user")?.content;
      const hasToolResult = messages.some((message) => message.role === "tool");
      if (prompt === MIXED_AGENT_SCENARIOS[0]!.prompt && !hasToolResult) {
        const queuedCancellationCompleted = queuedCancellationsCompleted[readOnlyRepetition];
        readOnlyRepetition += 1;
        if (!queuedCancellationCompleted) throw new Error("Mixed-agent read-only repetition has no cancellation gate");
        await Promise.race([
          queuedCancellationCompleted,
          new Promise<never>((_, reject) => signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          )),
        ]);
      }
      yield* processor.stream(messages, tools, signal, thinkingEnabled);
    },
  };
}

function validateExpectedCancellationFailure(
  scenarioId: MixedAgentScenarioId,
  status: TurnStatus,
  eventTypes: EventType[],
  providerStarts: number,
  pendingPermissions: number,
): boolean {
  if (scenarioId === "recoverable-tool-failure") {
    return status === "completed" && eventTypes.filter((type) => type === "tool.call_failed").length === 1;
  }
  if (scenarioId === "permission-wait-cancellation") {
    return status === "cancelled" && pendingPermissions === 0
      && eventTypes.includes("permission.requested") && eventTypes.includes("tool.call_cancelled");
  }
  if (scenarioId === "queued-cancellation") {
    return status === "cancelled" && providerStarts === 0 && !eventTypes.includes("model.request_started");
  }
  return status === "completed";
}

function validateRollingAdmission(
  admissions: MixedAgentAdmissionRecord[],
  scenarioPlan: readonly MixedAgentScenarioContract[],
  maximumInFlightTasks: number,
): boolean {
  if (admissions.length !== scenarioPlan.length) return false;
  return admissions.every((admission, index) => admission.admissionOrder === index
    && admission.scenarioId === scenarioPlan[index]?.id
    && admission.inFlightCount === Math.min(index + 1, maximumInFlightTasks)
    && admission.terminalCountAtAdmission === Math.max(0, index - maximumInFlightTasks + 1)
    && admission.inFlightCount <= maximumInFlightTasks
    && (index === 0 || admission.admittedAtElapsedMs >= admissions[index - 1]!.admittedAtElapsedMs));
}

function materializeWorkspace(workspace: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(workspace, path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    writeFileSync(absolute, content, { encoding: "utf8", mode: 0o600 });
  }
}

function snapshotWorkspace(root: string, directory = root): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...snapshotWorkspace(root, absolute));
    else if (entry.isFile() && statSync(absolute).isFile()) {
      files.push({ path: absolute.slice(root.length + 1), content: readFileSync(absolute, "utf8") });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function workspaceEquals(
  actual: Array<{ path: string; content: string }>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  return actual.length === expectedEntries.length && actual.every((file, index) =>
    file.path === expectedEntries[index]?.[0] && file.content === expectedEntries[index]?.[1]
  );
}

function containsOrdered(actual: readonly EventType[], required: readonly EventType[]): boolean {
  let index = 0;
  for (const type of actual) {
    if (type === required[index]) index += 1;
  }
  return index === required.length;
}

function arraysEqual<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function countEvents(types: readonly EventType[]): Partial<Record<EventType, number>> {
  const counts: Partial<Record<EventType, number>> = {};
  for (const type of types) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

function isTerminalEvent(type: EventType): boolean {
  return ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(type);
}

function isProviderLifecycleEvent(type: EventType): boolean {
  return [
    "model.usage",
    "model.metrics",
    "model.request_completed",
    "model.request_failed",
    "model.request_cancelled",
    "model.request_interrupted",
  ].includes(type);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function jsonRequest<T = unknown>(app: DaemonApp, path: string, init?: RequestInit): Promise<T> {
  const response = await app.fetch(new Request(`http://daemon${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  }));
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Mixed-agent benchmark ${path} returned HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

function validateConfig(config: MixedAgentAdmissionBenchmarkConfig): void {
  if (!Number.isSafeInteger(config.repetitions) || config.repetitions < 1 || config.repetitions > 10) {
    throw new Error("repetitions must be an integer between 1 and 10");
  }
  if (!Number.isSafeInteger(config.maximumInFlightTasks)
    || config.maximumInFlightTasks < 2
    || config.maximumInFlightTasks > MIXED_AGENT_SCENARIOS.length * config.repetitions) {
    throw new Error(`maximumInFlightTasks must be an integer between 2 and ${MIXED_AGENT_SCENARIOS.length * config.repetitions}`);
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 30 * 60_000) {
    throw new Error("timeoutMs must be an integer between 100 and 1800000");
  }
}
