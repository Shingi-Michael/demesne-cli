import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { driveFailureKind, DrivePlanningError, isRecord, parseDriveAutonomy, parseDriveDecision, validateDriveDecisionContext, type DriveAction, type DriveInspectAction, type DriveInspection, type DriveLimits, type DriveObservation, type DriveProgress, type DriveRequest, type DriveResponse, type DriveState, type ReplayEvent, type SessionStateResponse } from "@demesne/protocol";
import { beginDriveTrace, restoreDriveTraces, settleDriveTrace, updateDriveTrace } from "./drive-trace.ts";
import { chargeDriveTokens, driveBudgetReason, driveIntent, driveResultRows, fingerprint, newDriveProtection, newTokenMeter, observeDriveProgress, protectDriveDecision, restoreDriveProtection, similarIntent, workerText } from "./drive-protection.ts";

export type DriveControl = "pause" | "resume" | "stop";
export interface DriveServices {
  observe(): DriveObservation;
  perform(action: DriveAction, observation: DriveObservation, signal: AbortSignal): Promise<string>;
  decide(request: DriveRequest, signal: AbortSignal, progress: (event: DriveProgress) => void): Promise<DriveResponse>;
  changed(state: DriveState | null): void;
  path?: string;
  delayMs?: number;
  continuous?: boolean;
  retryDelaysMs?: readonly number[];
  limits?: Partial<DriveLimits>;
  now?: () => number;
  cancelWorker?(turnId: string, signal: AbortSignal): Promise<boolean>;
  inspect?(action: DriveInspectAction, observation: DriveObservation, signal: AbortSignal, activity: (text: string) => void): Promise<DriveInspection>;
}

/// A mission journal is private, atomically replaced and never automatically
/// resumed. A process lock prevents two workbenches driving the same journal.
export class DriveJournal {
  private owned = false;
  constructor(readonly path: string) {}
  load(): DriveState | null {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as DriveState;
      if (!value || typeof value.mission !== "string" || typeof value.homeSessionId !== "string" || typeof value.workspace !== "string"
        || typeof value.id !== "string" || !Array.isArray(value.steps) || !Array.isArray(value.evidence)) return null;
      if (value.steps.some((step) => !step || !Number.isSafeInteger(step.step) || typeof step.note !== "string" || typeof step.result !== "string" || typeof step.action !== "string" || typeof step.at !== "string")) return null;
      parseDriveDecision({ action: { kind: "wait" }, note: value.activity, notes: value.notes, completed: value.completed, remaining: value.remaining, evidence: value.evidence });
      const traces = restoreDriveTraces(value.traces);
      const rejected = traces.at(-1);
      const feedback = typeof value.feedback === "string" && value.feedback.trim() ? value.feedback.slice(0, 8000)
        : rejected?.status === "failed" ? `Last rejected decision ${rejected.action.slice(0, 2000)}: ${rejected.result}`.slice(0, 8000)
        : value.status === "blocked" ? value.activity.slice(0, 8000) : undefined;
      return { ...value, feedback, traces, recovery: undefined, autonomy: value.autonomy ? parseDriveAutonomy(value.autonomy) : undefined,
        step: Number.isSafeInteger(value.step) ? value.step : 0, steps: value.steps.slice(-64),
        status: ["completed", "stopped", "idle"].includes(value.status) ? value.status : "paused",
        activity: ["completed", "stopped", "idle"].includes(value.status) ? value.activity : "Restored mission. Resume to inspect the current UI and continue." };
    } catch { return null; }
  }
  save(state: DriveState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, this.path);
  }
  acquire(): void {
    if (this.owned) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    try { writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(lock, "utf8"));
      let alive = true;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      }
      if (alive) throw new Error("Agent Drive is already open in another workbench for this workspace.");
      unlinkSync(lock); writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    }
    this.owned = true;
  }
  release(): void {
    if (!this.owned) return;
    try { if (readFileSync(`${this.path}.lock`, "utf8") === String(process.pid)) unlinkSync(`${this.path}.lock`); } catch {}
    this.owned = false;
  }
}

export class AgentDrive {
  state: DriveState | null;
  private readonly journal?: DriveJournal;
  private pending: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSavedAt = 0;
  private epoch = 0;
  private allowance = 256;
  private repeated = { signature: "", count: 0 };
  private lastSubmission = "";
  private duplicateSubmissions = 0;
  private recoveryAttempts = 0;
  private nextAttemptAt = 0;
  private skipped = 0;
  private inspection: DriveInspection | undefined;
  /// Turns (and collected answer pages) already judged with thinking, so the
  /// follow-up steps on them stay quick.
  private judged = new Set<string>();
  private pendingInspection: { action: DriveInspectAction; sessionId: string; document: string; turn: string } | undefined;
  private autoInspectedTurn = "";
  private inspectionRetries = 0;
  private guardTimer: ReturnType<typeof setTimeout> | null = null;
  private guardAt: number | null = null;
  private pendingCorrection: { turnId: string; text: string } | undefined;

  constructor(private services: DriveServices) {
    this.journal = services.path ? new DriveJournal(services.path) : undefined;
    this.state = this.journal?.load() ?? null;
    if (this.state && services.continuous && !this.state.autonomy) {
      const finished = this.state.status === "completed";
      this.state.autonomy = { phase: finished ? "discovering" : "working", task: this.state.mission, cycle: 1, consulted: false,
        history: finished ? [{ task: this.state.mission, summary: this.state.activity, at: this.state.updatedAt }] : [] };
    }
    if (this.state) {
      this.state.protection = restoreDriveProtection(this.state, services.limits);
      if (this.state.protection.trip) { this.state.status = "blocked"; this.state.activity = this.protectionMessage(this.state.protection.trip.reason); }
    }
    services.changed(this.state);
  }
  /// Whether this decision's model call thinks. Judgment steps do: the
  /// mission's first decision, a newly finished turn not yet judged, answer
  /// pages just collected, and any step after a failed decision or a repeated
  /// action. Everything else — navigation, waiting on the coder — is quick.
  private thinkingFor(observation: DriveObservation, state: DriveState, recovering: boolean): boolean {
    if (recovering || this.repeated.count >= 2 || !state.steps.length) return true;
    if (observation.mode !== "input") return false;
    const turn = observation.navigation?.turn ?? "";
    if (this.inspection) {
      const key = `${turn}:pages:${this.inspection.document}`;
      if (!this.judged.has(key)) { this.judged.add(key); return true; }
    }
    const finished = Boolean(observation.navigation?.latest && observation.navigation.answer) || Boolean(observation.latestAnswerRows?.length);
    if (finished && turn && !this.judged.has(turn)) { this.judged.add(turn); return true; }
    return false;
  }

  start(mission: string): void {
    mission = mission.trim();
    if (!mission || mission.length > 8000) throw new Error("Use /drive <mission> (up to 8,000 characters).");
    const observed = this.services.observe();
    if (!observed.workspace || !observed.sessionId) throw new Error("Open a workspace session before starting Drive.");
    this.halt(); this.journal?.acquire();
    this.lastSubmission = ""; this.duplicateSubmissions = 0; this.repeated = { signature: "", count: 0 }; this.allowance = 256; this.judged.clear();
    this.state = { id: crypto.randomUUID(), mission, homeSessionId: observed.sessionId, workspace: observed.workspace, status: "running",
      activity: "Recovering the mission from the visible conversation.", step: 0, model: null, updatedAt: new Date().toISOString(),
      notes: "", completed: [], remaining: [mission.slice(0, 1000)], evidence: [], steps: [], protection: newDriveProtection(this.services.limits),
      ...(this.services.continuous ? { autonomy: { phase: "working", task: mission, cycle: 1, consulted: false, history: [] } as const } : {}) };
    this.startGuardClock(); this.publish(); this.schedule();
  }
  control(control: DriveControl): void {
    if (!this.state) throw new Error("No saved Drive mission. Start one with /drive <mission>.");
    if (this.state.status === "completed" && !this.state.autonomy) throw new Error("This Drive mission is complete. Start another with /drive <mission>.");
    if (this.state.status === "stopped" && control !== "resume") return;
    this.journal?.acquire();
    if (control === "resume") {
      const reason = this.state.protection?.trip?.reason ?? driveBudgetReason(this.state.protection!);
      if (reason) { this.protectionStop(reason); throw new Error(this.state.activity); }
      this.halt(); this.journal?.acquire(); this.allowance = 256;
      if (this.state.status === "idle" && this.state.autonomy) this.state.autonomy.consulted = false;
      this.repeated = { signature: "", count: 0 };
      this.state.status = "running"; this.state.activity = "Resuming from the current UI; completed actions will not be replayed.";
      this.startGuardClock(); this.publish(); this.schedule();
    } else {
      this.halt(); this.state.status = control === "stop" ? "stopped" : "paused";
      this.state.activity = control === "stop" ? "Drive stopped. Resume continues this mission from the current UI." : "Drive paused. Current coding work can finish; Resume continues review.";
      this.publish(); this.journal?.release();
    }
  }
  intervene(): void {
    if (!this.active) return;
    this.halt(); this.state!.status = "paused";
    this.state!.activity = "Paused for your input. Click Resume to continue the mission."; this.publish(); this.journal?.release();
  }
  dispose(): void { if (this.active) this.control("pause"); else this.halt(); this.journal?.release(); }
  get active(): boolean { return this.state?.status === "running" || this.state?.status === "waiting"; }
  private halt(): void {
    this.accountClock(); this.guardAt = null;
    if (this.guardTimer) clearTimeout(this.guardTimer); this.guardTimer = null;
    if (this.state) settleDriveTrace(this.state, "stopped", "Planning paused before completion.");
    this.epoch++; this.pending?.abort(); this.pending = null;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.progressTimer) clearTimeout(this.progressTimer); this.progressTimer = null;
    if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = null;
    this.recoveryAttempts = 0; this.nextAttemptAt = 0; this.skipped = 0;
    this.inspection = undefined; this.pendingInspection = undefined; this.autoInspectedTurn = ""; this.inspectionRetries = 0;
    this.pendingCorrection = undefined;
    if (this.state) this.state.recovery = undefined;
  }
  private publish(persist = true): void {
    if (!this.state) return;
    this.accountClock();
    if (!this.active) { this.guardAt = null; if (this.guardTimer) clearTimeout(this.guardTimer); this.guardTimer = null; }
    if (this.progressTimer) clearTimeout(this.progressTimer); this.progressTimer = null;
    this.state.updatedAt = new Date().toISOString();
    try {
      if (persist) {
        if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = null;
        this.journal?.save(this.state); this.lastSavedAt = Date.now();
      } else if (this.journal && !this.saveTimer) {
        this.saveTimer = setTimeout(() => { this.saveTimer = null; this.publish(); }, Math.max(1, 500 - (Date.now() - this.lastSavedAt)));
        this.saveTimer.unref();
      }
    }
    catch (error) { this.halt(); this.state.status = "blocked"; this.state.activity = `Could not save Drive progress: ${error instanceof Error ? error.message : error}`; this.journal?.release(); }
    this.services.changed(structuredClone(this.state));
  }
  private schedule(): void {
    if (!this.active || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.step(); }, Math.max(this.services.delayMs ?? 400, this.nextAttemptAt - Date.now()));
    this.timer.unref();
  }
  private block(message: string): void {
    if (this.state) settleDriveTrace(this.state, "failed", message);
    this.halt(); if (!this.state) return;
    this.state.feedback = `Last rejected decision ${this.state.traces?.at(-1)?.action.slice(0, 2000) ?? ""}: ${message}`.slice(0, 8000);
    this.state.status = "blocked"; this.state.activity = message; this.publish(); this.journal?.release();
  }
  private recover(error: unknown): boolean {
    const kind = driveFailureKind(error);
    const delays = this.services.retryDelaysMs ?? [1000, 3000, 8000];
    const limit = kind === "decision" ? Math.min(2, delays.length) : delays.length;
    if (!kind || this.recoveryAttempts >= limit || !this.state) return false;
    const message = error instanceof Error ? error.message : String(error);
    settleDriveTrace(this.state, "failed", message);
    const attempt = ++this.recoveryAttempts;
    this.nextAttemptAt = Date.now() + (delays[attempt - 1] ?? 1000);
    this.state.recovery = { kind, attempt, limit, retryAt: this.nextAttemptAt, message: message.slice(0, 2000) };
    this.state.feedback = `No new UI action was executed. ${kind === "transient" ? "Planning connection interrupted" : "Decision rejected"}: ${message}. Re-observe and choose the next valid action; do not assume the rejected action happened.`.slice(0, 8000);
    this.state.status = "waiting";
    this.state.activity = `${kind === "transient" ? "Planning connection interrupted" : "Correcting the next action"}. Retrying from a fresh observation (${attempt}/${limit})…`;
    this.publish(); return true;
  }

  private now(): number { return this.services.now?.() ?? Date.now(); }
  private accountClock(): void {
    if (this.guardAt === null || !this.state?.protection) return;
    const now = this.now(); this.state.protection.used.activeMs += Math.max(0, now - this.guardAt); this.guardAt = now;
  }
  private startGuardClock(): void {
    this.guardAt = this.now();
    const tick = () => {
      this.guardTimer = null;
      if (!this.active) return;
      this.accountClock();
      if (!this.checkProtection(false)) return;
      if (Date.now() - this.lastSavedAt >= 5000) this.publish();
      const remaining = this.state!.protection!.limits.maxActiveMinutes * 60_000 - this.state!.protection!.used.activeMs;
      this.guardTimer = setTimeout(tick, Math.max(1, Math.min(1000, remaining))); this.guardTimer.unref();
    };
    this.guardTimer = setTimeout(tick, 1000); this.guardTimer.unref();
  }
  private protectionMessage(reason: string): string { return `Drive protection stopped this mission: ${reason} Progress is saved. Resume keeps these limits; use /drive <revised mission> to start a fresh mission deliberately.`; }
  private protectionStop(reason: string, kind: "budget" | "loop" = "budget"): void {
    if (!this.state) return;
    const guard = this.state.protection!, first = !guard.trip, worker = guard.worker;
    const cancel = first && worker && !worker.settled && this.services.cancelWorker;
    guard.trip ??= { kind, reason: reason.slice(0, 2000), at: this.now() };
    this.block(this.protectionMessage(guard.trip.reason) + (cancel ? " Cancellation requested for the tracked coder turn." : ""));
    if (cancel && worker) {
      const state = this.state, epoch = this.epoch, savedAt = state.updatedAt;
      const record = (result: string) => {
        if (epoch !== this.epoch || state !== this.state) return;
        state.activity = this.protectionMessage(guard.trip!.reason) + ` ${result}`;
        try {
          this.journal?.acquire();
          if (this.journal && this.journal.load()?.updatedAt !== savedAt) { this.journal.release(); return; }
          this.publish(); this.journal?.release();
        } catch { this.services.changed(structuredClone(state)); }
      };
      // One exact-turn cancellation, never a retry or a queued correction. A
      // failure stays visible; it cannot reactivate Drive or replay work.
      void this.services.cancelWorker!(worker.turnId, AbortSignal.timeout(10_000)).then(cancelled => {
        record(cancelled ? "Tracked coder cancellation acknowledged." : "Coder had already settled.");
      }, error => {
        record(`Coder cancellation could not be confirmed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
  private checkProtection(admission = true): boolean {
    const guard = this.state?.protection;
    if (!guard) return true;
    const reason = guard.trip?.reason ?? driveBudgetReason(guard, admission);
    if (!reason) return true;
    this.protectionStop(reason, guard.stalledCycles >= guard.limits.maxStalledCycles ? "loop" : "budget"); return false;
  }
  private guardCycle(): boolean {
    if (!this.checkProtection()) return false;
    this.state!.protection!.used.cycles++; this.state!.protection!.stalledCycles++;
    return true;
  }
  private planningProgress(event: DriveProgress): boolean {
    const guard = this.state!.protection!;
    if (event.type === "attempt" && guard.planning && event.attempt > guard.planning.attempt) guard.planning = newTokenMeter(guard.planning.inputEstimate + Math.ceil(guard.planning.characters / 4), event.attempt);
    if (guard.planning) chargeDriveTokens(guard, guard.planning, "planningTokens", event.type === "usage" ? event.usage : undefined,
      event.type === "reasoning.delta" || event.type === "text.delta" || event.type === "action.delta" ? event.delta.length : 0);
    // The reserved final cycle is allowed to finish; resource limits interrupt
    // even a silent/long-running plan without reducing its configured output cap.
    if (guard.used.planningTokens + guard.used.workerTokens >= guard.limits.maxTokens) { this.protectionStop(driveBudgetReason(guard)!); return false; }
    return true;
  }
  private finishPlanning(response: DriveResponse): boolean {
    const guard = this.state!.protection!;
    if (guard.planning && !guard.planning.characters && guard.planning.output === null) chargeDriveTokens(guard, guard.planning, "planningTokens", undefined, JSON.stringify(response).length);
    this.accountClock(); return this.checkProtection(false);
  }

  workerStarted(sessionId: string, content: string, turnId: string): void {
    const guard = this.state?.protection, pending = guard?.pendingWorker;
    if (!guard || !pending || pending.sessionId !== sessionId || pending.hash !== fingerprint(content.trim())) return;
    guard.worker = { sessionId, turnId, cursor: 0, meter: newTokenMeter(pending.inputEstimate), checks: 0, checkCursor: 0,
      nextCheckAt: this.now() + guard.limits.checkInIntervalSeconds * 1000, settled: false }; guard.pendingWorker = undefined;
    if (this.active) this.publish();
  }
  workerEvent(event: ReplayEvent, replay = false): void {
    const guard = this.state?.protection, worker = guard?.worker;
    if (!guard || !worker || event.sessionId !== worker.sessionId || event.turnId !== worker.turnId || event.eventId <= worker.cursor) return;
    worker.cursor = event.throughEventId ?? event.eventId;
    if (/^turn\.(completed|cancelled|failed|interrupted)$/.test(event.type)) worker.settled = true;
    if (event.type === "model.request_started") {
      const plan = event.payload.contextPlan;
      const estimate = isRecord(plan) && Number.isSafeInteger(plan.estimatedInputTokens) && Number(plan.estimatedInputTokens) >= 0 ? Number(plan.estimatedInputTokens) : worker.meter.inputEstimate;
      worker.meter = newTokenMeter(estimate, worker.meter.attempt + 1);
    }
    const chars = ["message.delta", "reasoning.delta", "tool.call_draft"].includes(event.type) && typeof event.payload.delta === "string" ? event.payload.delta.length : 0;
    if (chars || event.type === "model.usage" || event.type === "model.request_started") chargeDriveTokens(guard, worker.meter, "workerTokens", event.type === "model.usage" ? event.payload : undefined, chars);
    const over = guard.used.planningTokens + guard.used.workerTokens >= guard.limits.maxTokens;
    if (over && !guard.trip) {
      const reason = driveBudgetReason(guard)!;
      if (this.active && !replay) { this.protectionStop(reason); return; }
      guard.trip = { kind: "budget", reason, at: this.now() };
      this.state!.status = "blocked"; this.state!.activity = this.protectionMessage(reason);
      if (!replay) this.services.changed(structuredClone(this.state));
    }
    // A paused CLI has released the journal lock. Keep live accounting in memory;
    // durable event cursors let a new owner recover it without double charging.
    if (!replay && this.active && (chars || event.type === "model.usage" || event.type === "model.request_started")) this.publish(false);
  }
  reconcileWorker(snapshot: SessionStateResponse, events: readonly ReplayEvent[]): void {
    const pending = this.state?.protection?.pendingWorker;
    if (pending?.sessionId === snapshot.session.id) {
      const turn = snapshot.session.turns.find(turn => Date.parse(turn.createdAt) >= pending.at && fingerprint(turn.content.trim()) === pending.hash);
      if (turn) this.workerStarted(snapshot.session.id, turn.content, turn.id);
    }
    for (const event of events) this.workerEvent(event, true);
    if (this.state) this.services.changed(structuredClone(this.state));
  }

  private reserveWorker(text: string, screen: DriveObservation): void {
    const guard = this.state!.protection!, intent = driveIntent(workerText(text)!);
    if (!guard.submissions.some(prior => similarIntent(prior, intent))) { guard.stalledCycles = 0; guard.navigation = []; }
    guard.submissions.push(intent); guard.used.workerRequests++;
    guard.pendingWorker = { sessionId: screen.sessionId, hash: fingerprint(workerText(text)!), at: this.now(), inputEstimate: Math.ceil(text.length / 4) };
  }
  private async checkIn(observation: DriveObservation): Promise<void> {
    const state = this.state!, guard = state.protection!, worker = guard.worker!;
    if (guard.used.checkIns >= guard.limits.maxCheckIns) { this.protectionStop(`Mission check-in limit reached (${guard.limits.maxCheckIns} reviews).`); return; }
    if (!this.guardCycle()) return;
    const epoch = this.epoch, controller = this.pending = new AbortController();
    guard.used.checkIns++; worker.checks++; worker.checkCursor = worker.cursor; worker.nextCheckAt = this.now() + guard.limits.checkInIntervalSeconds * 1000;
    const trace = beginDriveTrace(state); trace.note = "Checking the coder's live direction; leave aligned work running.";
    state.status = "running"; state.activity = "Checking in on the coder; review uses the next available model slot."; this.publish();
    let cancellationStarted = false;
    try {
      if (!this.active || controller.signal.aborted) return;
      observation = this.services.observe();
      if (observation.mode !== "streaming" || observation.sessionId !== state.homeSessionId || worker.settled) return;
      const request: DriveRequest = { mission: state.mission, homeSessionId: state.homeSessionId, observation, checkIn: { turnId: worker.turnId, cursor: worker.cursor }, thinking: false,
        ...(state.autonomy ? { autonomy: structuredClone(state.autonomy) } : {}), memory: { notes: state.notes, completed: state.completed, remaining: state.remaining,
          evidence: [], steps: state.steps.slice(-6), ...(state.feedback ? { feedback: state.feedback } : {}) } };
      guard.planning = newTokenMeter(Math.ceil(JSON.stringify(request).length / 4)); chargeDriveTokens(guard, guard.planning, "planningTokens");
      if (!this.checkProtection(false)) return;
      this.publish();
      const response = await this.services.decide(request, controller.signal, event => {
        if (epoch !== this.epoch || controller.signal.aborted || !this.active) return;
        updateDriveTrace(state, event);
        if (this.planningProgress(event)) this.publish(false);
      });
      if (epoch !== this.epoch || controller.signal.aborted || !this.active) return;
      if (!this.finishPlanning(response)) return;
      const decision = parseDriveDecision(response.decision); validateDriveDecisionContext(decision, request);
      const current = this.services.observe();
      const record = { step: ++state.step, action: JSON.stringify(decision.action), note: decision.note, result: "", at: new Date().toISOString() };
      state.steps = [...state.steps, record].slice(-64);
      const latestTrace = state.traces!.at(-1)!; latestTrace.action = record.action; latestTrace.note = decision.note; latestTrace.status = "acting";
      if (worker !== guard.worker || worker.settled || current.mode !== "streaming" || current.sessionId !== observation.sessionId) record.result = "Coder activity settled or changed during check-in; no interruption performed.";
      else if (decision.action.kind === "keep_working") record.result = "Check-in agrees with the coder's direction. Work continues without interruption.";
      else if (decision.action.kind === "redirect") {
        const live = current.evidenceRows ?? current.rows;
        if (!decision.evidence.some(item => live.some(row => row.includes(item.quote)))) record.result = "The cited activity is no longer visible. Stale redirection discarded; coder continues.";
        else {
          if (guard.used.redirects >= guard.limits.maxRedirects) { this.protectionStop(`Mission correction limit reached (${guard.limits.maxRedirects} coder interruptions).`, "loop"); return; }
          const reason = protectDriveDecision(guard, { ...decision, action: { kind: "compose", text: decision.action.text } }, current, false);
          if (reason) { this.protectionStop(reason, "loop"); return; }
          guard.used.redirects++;
          record.result = `Prepared interruption of ${worker.turnId}; correction will be sent only after cancellation and settlement.`;
          state.feedback = `Check-in requested a correction: ${decision.action.text}`;
          this.publish();
          if (!this.active || controller.signal.aborted) return;
          cancellationStarted = true;
          const cancelled = await this.services.cancelWorker!(worker.turnId, controller.signal);
          if (epoch !== this.epoch || controller.signal.aborted) return;
          if (cancelled) {
            this.pendingCorrection = { turnId: worker.turnId, text: decision.action.text };
            record.result = "Coder cancellation acknowledged. Waiting for the turn to settle before typing the targeted correction.";
          } else record.result = "Coder already settled; no correction automatically submitted.";
        }
      }
      state.activity = record.result; settleDriveTrace(state, "completed", record.result); this.publish();
    } catch (error) {
      if (epoch !== this.epoch || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Check-in failed.";
      if (cancellationStarted || !driveFailureKind(error)) this.block(message);
      else {
        settleDriveTrace(state, "failed", message); state.status = "waiting";
        state.activity = "Check-in unavailable; coder continues. A later bounded check-in can reassess.";
        state.feedback = message; this.publish();
      }
    } finally {
      if (epoch === this.epoch && state.traces?.at(-1)?.status === "queued") settleDriveTrace(state, "stopped", "Coder settled before the check-in began.");
      if (this.pending === controller) this.pending = null; this.schedule();
    }
  }
  private async sendCorrection(observation: DriveObservation): Promise<void> {
    const correction = this.pendingCorrection!, state = this.state!;
    if (observation.sessionId !== state.homeSessionId || state.protection!.worker?.turnId !== correction.turnId) {
      this.pendingCorrection = undefined; this.block("Session changed before the check-in correction; re-observe on Resume."); return;
    }
    if (!this.guardCycle()) return;
    const action = { kind: "compose" as const, text: correction.text };
    const reason = protectDriveDecision(state.protection!, { action, note: "Check-in correction", notes: "", completed: [], remaining: [], evidence: [] }, observation, false);
    if (reason) { this.protectionStop(reason, "loop"); return; }
    const epoch = this.epoch, controller = this.pending = new AbortController();
    this.pendingCorrection = undefined;
    const trace = beginDriveTrace(state); trace.source = "controller"; trace.status = "acting"; trace.action = JSON.stringify(action); trace.note = "Sending the check-in correction after the coder stopped.";
    const record = { step: ++state.step, action: trace.action, note: trace.note, result: "Prepared correction; never replay automatically after restart.", at: new Date().toISOString() };
    state.steps = [...state.steps, record].slice(-64); this.reserveWorker(action.text, observation);
    state.status = "running"; state.activity = trace.note; this.publish();
    try {
      if (!this.active || controller.signal.aborted) return;
      record.result = await this.services.perform(action, this.services.observe(), controller.signal);
      if (epoch !== this.epoch || controller.signal.aborted) return;
      state.feedback = record.result.startsWith("Sent through the visible composer:") ? undefined : `Correction was not confirmed: ${record.result}. Inspect before trying again.`;
      if (/^(UI changed|Input changed)/.test(record.result)) state.protection!.pendingWorker = undefined;
      settleDriveTrace(state, "completed", record.result); this.publish();
    } catch (error) { if (epoch === this.epoch && !controller.signal.aborted) this.block(error instanceof Error ? error.message : "Correction could not be sent."); }
    finally { if (this.pending === controller) this.pending = null; this.schedule(); }
  }

  private async inspect(action: DriveInspectAction, observation: DriveObservation): Promise<void> {
    const state = this.state!, epoch = this.epoch, controller = this.pending = new AbortController();
    const trace = beginDriveTrace(state); trace.source = "controller"; trace.model = null; trace.status = "acting";
    trace.action = JSON.stringify(action); trace.note = `Collecting visible ${action.target} evidence without model inference.`;
    const record = { step: ++state.step, action: trace.action, note: trace.note, result: "Prepared; inspecting current UI before action.", at: new Date().toISOString() };
    state.steps = [...state.steps, record].slice(-64); state.status = "running"; state.activity = trace.note; this.publish();
    this.autoInspectedTurn = `${observation.sessionId}:${observation.navigation?.document}:${observation.navigation?.turn}`;
    try {
      if (!this.active || controller.signal.aborted) return;
      const packet = await this.services.inspect!(action, this.services.observe(), controller.signal, (text) => {
        if (epoch !== this.epoch || controller.signal.aborted) return;
        state.activity = text; this.publish(false);
      });
      if (epoch !== this.epoch || controller.signal.aborted) return;
      record.result = packet.result; this.pendingInspection = undefined;
      observeDriveProgress(state.protection!, packet.pages.flatMap(page => page.rows));
      if (packet.pages.length) { this.inspection = packet; this.inspectionRetries = 0; state.feedback = undefined; }
      else {
        this.inspection = undefined; state.feedback = packet.result;
        if (++this.inspectionRetries <= 2 && packet.result.startsWith("UI changed")) this.pendingInspection = { action, sessionId: observation.sessionId,
          document: observation.navigation!.document, turn: observation.navigation!.turn };
      }
      state.activity = packet.result; settleDriveTrace(state, "completed", packet.result); this.publish();
    } catch (error) {
      if (epoch === this.epoch && !controller.signal.aborted) this.block(error instanceof Error ? error.message : "Controller inspection failed.");
    } finally { if (this.pending === controller) this.pending = null; this.schedule(); }
  }

  /// One observe → decide → visible action cycle. No turn or workspace tool API
  /// is available here. Tests can step deterministically through real UI routes.
  async step(): Promise<void> {
    if (!this.active || this.pending || !this.state) return;
    this.accountClock();
    if (!this.checkProtection(false)) return;
    if (Date.now() < this.nextAttemptAt) { this.schedule(); return; }
    const state = this.state, epoch = this.epoch;
    let observation = this.services.observe();
    observeDriveProgress(state.protection!, driveResultRows(observation));
    if (observation.workspace !== state.workspace) { this.block("Returned to a different workspace. Return to the mission workspace and Resume."); return; }
    if (observation.mode === "streaming" || observation.mode === "approval" || !observation.ready) {
      const worker = state.protection!.worker;
      if (this.services.cancelWorker && !this.pendingCorrection && observation.mode === "streaming" && observation.sessionId === state.homeSessionId
        && !observation.navigation?.readingHeld && !observation.draft && worker && !worker.settled && worker.checks < 3 && worker.cursor > worker.checkCursor
        && this.now() >= worker.nextCheckAt && (observation.evidenceRows ?? observation.rows).some(row => row.trim().length >= 40)) {
        await this.checkIn(observation); return;
      }
      const activity = observation.mode === "approval" ? "Waiting for your existing tool approval." : observation.mode === "streaming" ? "Watching the coding agent; review follows when the turn settles." : "Waiting for the workbench to finish loading.";
      if (state.activity !== activity || state.status !== "waiting") { state.status = "waiting"; state.activity = activity; this.publish(); }
      this.schedule(); return;
    }
    if (observation.draft.trim()) { this.block("There is an existing composer draft. Submit or clear it, then Resume Drive."); return; }
    if (this.pendingCorrection) { await this.sendCorrection(observation); return; }
    if (this.inspection && (this.inspection.document !== observation.navigation?.document || this.inspection.turn !== observation.navigation?.turn || this.inspection.sessionId !== observation.sessionId)) this.inspection = undefined;
    if (this.pendingInspection && (observation.mode !== "input" || this.pendingInspection.sessionId !== observation.sessionId
      || this.pendingInspection.document !== observation.navigation?.document || this.pendingInspection.turn !== observation.navigation?.turn)) {
      this.pendingInspection = undefined; this.inspectionRetries = 0;
      state.feedback = "The selected session or turn changed before controller inspection. Re-evaluate the current view; no pending inspection was replayed.";
    }
    if (this.services.inspect && observation.navigation) {
      if (this.pendingInspection && observation.navigation.readingHeld) {
        if (state.activity !== "Controller inspection is waiting for your Live view.") {
          state.status = "waiting"; state.activity = "Controller inspection is waiting for your Live view."; this.publish();
        }
        this.schedule(); return;
      }
      const automatic = observation.mode === "input" && observation.sessionId === state.homeSessionId && observation.navigation.latest && observation.navigation.answer && !observation.navigation.readingHeld
        && this.autoInspectedTurn !== `${observation.sessionId}:${observation.navigation.document}:${observation.navigation.turn}`;
      if (this.pendingInspection || automatic) {
        if (!this.guardCycle()) return;
        if (--this.allowance < 0) { this.block("Drive reached 256 UI steps. Progress is saved; Resume to continue."); return; }
        await this.inspect(this.pendingInspection?.action ?? { kind: "inspect", target: "answer" }, observation); return;
      }
    }
    if (!this.guardCycle()) return;
    if (--this.allowance < 0) { this.block("Drive reached 256 UI steps. Progress is saved; Resume to continue."); return; }
    const controller = this.pending = new AbortController();
    let actionStarted = false;
    beginDriveTrace(state);
    const recovering = state.recovery?.kind === "decision";
    state.recovery = undefined;
    state.status = "running"; state.activity = state.autonomy?.phase === "discovering" ? "Finding useful next work with the coding agent." : "Reading the visible workbench and choosing the next action."; this.publish();
    try {
      if (!this.active || controller.signal.aborted) return;
      // The first trace adds the activity card. Observe after it is rendered so
      // Drive's own status update cannot move controls beneath its decision.
      observation = this.services.observe();
      const request: DriveRequest = { mission: state.mission, homeSessionId: state.homeSessionId,
        ...(state.autonomy ? { autonomy: structuredClone(state.autonomy) } : {}),
        ...(this.inspection ? { inspection: this.inspection } : {}),
        memory: { notes: state.notes, completed: state.completed, remaining: state.remaining, evidence: state.evidence, steps: state.steps.slice(-12), ...(state.feedback ? { feedback: state.feedback } : {}) }, observation,
        thinking: this.thinkingFor(observation, state, recovering) };
      state.protection!.planning = newTokenMeter(Math.ceil(JSON.stringify(request).length / 4));
      chargeDriveTokens(state.protection!, state.protection!.planning, "planningTokens");
      if (state.protection!.used.planningTokens + state.protection!.used.workerTokens >= state.protection!.limits.maxTokens) { this.protectionStop(driveBudgetReason(state.protection!)!); return; }
      this.publish();
      const response = await this.services.decide(request, controller.signal, (event) => {
          if (epoch !== this.epoch || controller.signal.aborted || !this.active) return;
          updateDriveTrace(state, event);
          if (!this.planningProgress(event)) return;
          if (!this.progressTimer) {
            this.progressTimer = setTimeout(() => { this.progressTimer = null; this.publish(Date.now() - this.lastSavedAt >= 500); }, 50);
            this.progressTimer.unref();
          }
        });
      if (epoch !== this.epoch || controller.signal.aborted || !this.active) return;
      if (!this.finishPlanning(response)) return;
      const decision = parseDriveDecision(response.decision);
      const trace = state.traces!.at(-1)!;
      trace.action = JSON.stringify(decision.action); trace.note = decision.note; trace.model = `${response.provider} / ${response.model}`; trace.status = "acting";
      if (["complete", "next_task", "idle", "inspect"].includes(decision.action.kind) && observation.navigation) {
        const current = this.services.observe();
        if (current.sessionId !== observation.sessionId || current.mode !== "input" || !current.ready
          || current.navigation?.document !== observation.navigation.document || current.navigation.turn !== observation.navigation.turn)
          throw new DrivePlanningError("The session changed while judging the result. Reinspect current evidence before completing or selecting next work.", "decision");
      }
      const protection = protectDriveDecision(state.protection!, decision, observation, state.autonomy?.phase === "discovering");
      if (protection) { this.protectionStop(protection, protection.startsWith("Mission") ? "budget" : "loop"); return; }
      validateDriveDecisionContext(decision, request);
      const confirmed = decision.evidence;
      Object.assign(state, { notes: decision.notes, completed: decision.completed, remaining: decision.remaining, model: `${response.provider} / ${response.model}`, activity: decision.note });
      state.evidence = [...new Map([...state.evidence, ...confirmed].map((item) => [JSON.stringify(item), item])).values()].slice(-32);
      const signature = JSON.stringify({ action: decision.action, surface: observation.surface, scrollRegions: observation.scrollRegions,
        screen: (observation.evidenceRows ?? observation.rows).join("\n").replace(/\b\d{2}:\d{2}:\d{2}\b|\+\d{2}:\d{2}/g, "clock") });
      this.repeated = { signature, count: signature === this.repeated.signature ? this.repeated.count + 1 : 1 };
      if (this.repeated.count >= 4) throw new DrivePlanningError("Drive repeated an action without changing the visible UI. Use another route: keyboard navigation, an expanded pane, or a different visible control; inspect actual scroll offsets before retrying.", "decision");
      if (decision.action.kind === "compose") {
        const content = decision.action.text.trim();
        if (!content.startsWith("/")) {
          if (content === this.lastSubmission && this.duplicateSubmissions >= 1) throw new DrivePlanningError("Drive repeated the same work request. Review the saved results and ask a targeted follow-up instead.", "decision");
        }
      }
      state.feedback = undefined;
      const record = { step: ++state.step, action: JSON.stringify(decision.action), note: decision.note, result: "Prepared; inspecting current UI before action.", at: new Date().toISOString() };
      state.steps = [...state.steps, record].slice(-64);
      // Persist intent before operating. A restart always re-observes, never
      // replays an ambiguous Enter/click that may already have taken effect.
      this.publish();
      if (!this.active || controller.signal.aborted) return;
      if (decision.action.kind === "inspect") {
        if (!this.services.inspect) throw new Error("Controller inspection is unavailable in this client.");
        this.pendingInspection = { action: decision.action, sessionId: observation.sessionId, document: observation.navigation!.document, turn: observation.navigation!.turn };
        record.result = "Controller inspection scheduled; navigation needs no further model decisions.";
        settleDriveTrace(state, "completed", record.result); this.publish(); return;
      }
      if (decision.action.kind === "complete" || decision.action.kind === "blocked") {
        state.status = decision.action.kind === "complete" ? "completed" : "blocked"; record.result = decision.note;
        settleDriveTrace(state, decision.action.kind === "complete" ? "completed" : "failed", decision.note);
        // An answered question (basis: answer) ends the mission; finished work
        // (verified-work) moves on to finding the next useful task.
        if (decision.action.kind === "complete" && state.autonomy && decision.action.basis !== "answer") {
          const autonomy = state.autonomy;
          autonomy.history = [...autonomy.history, { task: autonomy.task, summary: decision.note, at: new Date().toISOString() }].slice(-8);
          autonomy.phase = "discovering"; autonomy.consulted = false;
          state.status = "running"; state.activity = "Task finished and reviewed. Asking the coding agent what is worth doing next.";
          this.allowance = 256; this.repeated = { signature: "", count: 0 };
        }
        if (decision.action.kind === "complete") {
          state.protection!.used.tasks++; state.protection!.tasks.push(driveIntent(state.autonomy?.task ?? state.mission));
        }
        this.recoveryAttempts = 0; this.nextAttemptAt = 0;
        this.publish(); if (!this.active) this.journal?.release(); return;
      }
      if (decision.action.kind === "next_task" || decision.action.kind === "idle") {
        if (decision.action.kind === "next_task") {
          Object.assign(state.autonomy!, { phase: "working", task: decision.action.task, cycle: state.autonomy!.cycle + 1, consulted: false });
          state.completed = []; state.remaining = [decision.action.task.slice(0, 1000)]; state.evidence = [];
          this.allowance = 256; this.lastSubmission = ""; this.duplicateSubmissions = 0;
          record.result = `Next task selected: ${decision.action.task}`.slice(0, 2000);
        } else { state.status = "idle"; record.result = decision.note; }
        this.repeated = { signature: "", count: 0 }; this.recoveryAttempts = 0; this.nextAttemptAt = 0;
        settleDriveTrace(state, "completed", record.result); this.publish(); if (!this.active) this.journal?.release(); return;
      }
      actionStarted = true;
      if (decision.action.kind === "compose" && workerText(decision.action.text) !== undefined) {
        this.reserveWorker(decision.action.text, observation);
        this.publish();
        if (!this.active || controller.signal.aborted) return;
      }
      record.result = decision.action.kind === "wait" ? "Waiting for the next observation." : await this.services.perform(decision.action, observation, controller.signal);
      if (epoch !== this.epoch || controller.signal.aborted) return;
      this.recoveryAttempts = 0; this.nextAttemptAt = 0;
      const skipped = /^(UI changed|Control moved|Input changed|Scroll did not move)/.test(record.result);
      if (skipped && decision.action.kind === "compose") state.protection!.pendingWorker = undefined;
      if (skipped) {
        this.skipped++;
        state.feedback = `${record.result} No completed action should be inferred. ${this.skipped >= 3 ? "Several actions have been skipped; use fresh controls, keyboard navigation, or expand the pane rather than repeatedly reopening it." : "Observe the current screen and adapt the next action."}`;
        if (this.skipped >= 3) this.nextAttemptAt = Date.now() + 1000;
      } else this.skipped = 0;
      if (decision.action.kind === "compose" && record.result.startsWith("Sent through the visible composer:")) {
        const content = decision.action.text.trim();
        if (!content.startsWith("/")) {
          this.duplicateSubmissions = content === this.lastSubmission ? this.duplicateSubmissions + 1 : 0; this.lastSubmission = content;
        }
        if (state.autonomy?.phase === "discovering" && (!content.startsWith("/") || /^\/plan\s+\S/.test(content))) state.autonomy.consulted = true;
      }
      settleDriveTrace(state, "completed", record.result);
      this.publish();
    } catch (error) {
      if (epoch === this.epoch && !controller.signal.aborted && (actionStarted || !this.recover(error))) this.block(error instanceof Error ? error.message : "Drive could not continue.");
    } finally { if (this.pending === controller) this.pending = null; this.schedule(); }
  }
}
