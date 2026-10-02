import { DRIVE_CHECKPOINTS, parseDriveReview, type DriveReview, type DriveCheckpointReason } from "./drive-review.ts";
import { parseDriveFacts, parseDriveLedger, driveReopenReason, type DriveFacts, type DriveLedger, type DriveMode } from "./drive-tasks.ts";
import { isRecord, ProtocolValidationError, type TokenUsage } from "./index.ts";

export const DRIVE_KEYS = ["up", "down", "left", "right", "pageup", "pagedown", "home", "end", "return", "escape", "tab", "shift+tab",
  "ctrl+b", "ctrl+g", "ctrl+x", "ctrl+t", "alt+h", "alt+r", "alt+d", "alt+v", "alt+enter", "alt+up", "alt+down"] as const;
export type DriveKey = typeof DRIVE_KEYS[number];
export const DRIVE_INSPECTIONS = ["answer", "diff", "checks", "log"] as const;
export type DriveInspectAction = { kind: "inspect"; target: typeof DRIVE_INSPECTIONS[number]; item?: string; position?: "start" | "continue" | "end" };
export type DriveAction = { kind: "click"; target: string } | { kind: "key"; key: DriveKey }
  | { kind: "compose"; text: string } | { kind: "scroll"; row: number; column: number; amount: number }
  | { kind: "set_criteria"; criteria: string[] } | { kind: "reopen_task"; taskId: string; reason: string }
  | DriveInspectAction | { kind: "complete"; basis?: "answer" | "verified-work" } | { kind: "next_task"; task: string } | { kind: "redirect"; text: string } | { kind: "blocked" | "wait" | "idle" | "keep_working" };
export interface DriveNavigation {
  document: string; turn: string; latest: boolean; answer: boolean; readingHeld: boolean;
  files: string[]; checks: string[]; item?: string;
}
export interface DriveInspection {
  sessionId: string; document: string; turn: string; target: DriveInspectAction["target"];
  pages: { observationId: string; surface: string; item?: string; rows: string[]; answer: boolean; latest: boolean; offset?: number; maximum?: number }[];
  truncated: boolean; actions: number; result: string;
}
/** Remove only an answer card's rail and padding: the redesign's left rail
 * (`▎`, plus a trailing pane edge on full-width rows) or the earlier boxed
 * card's `│ … │`. The result remains an exact
 * substring of the rendered row, so quotes retain their provenance. */
export function driveAnswerText(row: string): string {
  const trimmed = row.trim();
  if (trimmed.startsWith("│") && trimmed.endsWith("│")) return trimmed.slice(1, -1).trim();
  if (!trimmed.startsWith("▎")) return trimmed;
  // A full-width screen row also ends at the neighbouring pane's edge.
  const inner = trimmed.slice(1).trim();
  return inner.endsWith("│") ? inner.slice(0, -1).trim() : inner;
}
export interface DriveObservation {
  id: string; sessionId: string; workspace: string; title: string;
  mode: "input" | "streaming" | "approval" | "dialog";
  ready: boolean; draft: string; surface: string; width: number; height: number;
  rows: string[];
  /** Rendered pane geometry and keyboard focus, not inferred from screen text. */
  focus?: "composer" | "content" | "dialog";
  panes?: { surface: string; row: number; column: number; width: number; height: number }[];
  /** Visible result rows with the Drive notes panel excluded. */
  evidenceRows?: string[];
  /** Visible text from completed assistant answers, excluding requests/thinking/Drive. */
  answerRows?: string[];
  /** Visible completed answer from the latest turn, for next-work consultation. */
  latestAnswerRows?: string[];
  /** Actual scroll offsets; positive scrolling moves toward larger offsets. */
  scrollRegions?: { surface: string; row: number; column: number; width: number; height: number; offset: number; maximum: number }[];
  controls: { id: string; label: string; row: number; column: number; width: number }[];
  artifactId?: string;
  navigation?: DriveNavigation;
}
export interface DriveEvidence { observationId: string; quote: string }
export interface DriveDecision {
  action: DriveAction; note: string; notes: string; completed: string[]; remaining: string[]; evidence: DriveEvidence[];
  /// A question's full answer, when completing with basis: answer. `note`
  /// stays a one-line status for the panel.
  answer?: string;
}
export interface DriveStep { step: number; action: string; note: string; result: string; at: string }
export interface DriveMemory { notes: string; completed: string[]; remaining: string[]; evidence: DriveEvidence[]; steps: DriveStep[]; feedback?: string }
export interface DriveAutonomy {
  consultationTurnId?: string; consultations?: number;
  phase: "working" | "discovering"; task: string; cycle: number; consulted: boolean;
  history: { task: string; summary: string; at: string }[];
}
export interface DriveRequest {
  mode?: DriveMode; ledger?: DriveLedger; facts?: DriveFacts;
  mission: string; homeSessionId: string; memory: DriveMemory; observation: DriveObservation;
  autonomy?: DriveAutonomy;
  inspection?: DriveInspection;
  review?: DriveReview;
  checkIn?: { turnId: string; cursor: number; freshEvidence?: boolean; reason?: DriveCheckpointReason };
  /// Whether the model thinks for this decision. The client decides: judging
  /// a finished turn does; navigation, waiting and check-ins don't.
  thinking?: boolean;
}
export interface DriveResponse { review?: DriveReview; skipped?: string; decision: DriveDecision; model: string; provider: string; imageInspected: boolean }
export type DriveProgress = { type: "review.ready"; review: DriveReview } | { type: "queued" }
  | { type: "attempt"; attempt: number; model: string; provider: string; thinking?: boolean }
  | { type: "reasoning.delta" | "text.delta" | "action.delta"; delta: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "correction"; message: string };
export type DriveRecovery = "transient" | "decision";
export type DriveStreamEvent = DriveProgress | { type: "result"; response: DriveResponse } | { type: "error"; message: string; recovery?: DriveRecovery };
export class DrivePlanningError extends Error {
  constructor(message: string, readonly recovery?: DriveRecovery) { super(message); this.name = "DrivePlanningError"; }
}
/** Only planning is retried; the UI executor never blindly replays an action. */
export function driveFailureKind(error: unknown): DriveRecovery | undefined {
  if (error instanceof DrivePlanningError && error.recovery) return error.recovery;
  if (error instanceof ProtocolValidationError) return "decision";
  if (!isRecord(error) || error.name === "AbortError") return;
  const status = error.status ?? error.statusCode;
  if ([408, 429, 502, 503, 504].includes(Number(status))) return "transient";
  if (typeof status === "number" && status >= 400 && status < 500) return;
  const message = `${typeof error.code === "string" ? error.code : ""} ${typeof error.message === "string" ? error.message : ""}`;
  if (/socket connection|connection (?:was )?(?:closed|reset|refused)|fetch failed|failed to fetch|network error|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|timed out|total timeout|before the timeout|HTTP (?:408|429|502|503|504)|rate.limit|temporarily unavailable/i.test(message)) return "transient";
}
export interface DriveTrace {
  id: string; step: number; attempt: number; model: string | null;
  status: "queued" | "thinking" | "drafting" | "acting" | "completed" | "corrected" | "failed" | "stopped";
  startedAt: number; completedAt: number | null;
  reasoning: string; text: string; actionDraft: string; action: string; note: string; result: string;
  usage?: TokenUsage; truncated?: boolean;
  source?: "controller";
  /// Whether this attempt ran with thinking on ("thought") or off ("quick").
  thinking?: boolean;
}
export type DriveStatus = "running" | "waiting" | "paused" | "blocked" | "completed" | "stopped" | "idle";
export interface DriveLimits {
  maxActiveMinutes: number; maxCycles: number; maxTasks: number; maxWorkerRequests: number; maxTokens: number; maxStalledCycles: number;
  checkInIntervalSeconds: number; maxCheckIns: number; maxRedirects: number;
}
export const DEFAULT_DRIVE_LIMITS: DriveLimits = { maxActiveMinutes: 240, maxCycles: 512, maxTasks: 16, maxWorkerRequests: 48, maxTokens: 2_000_000, maxStalledCycles: 24,
  checkInIntervalSeconds: 120, maxCheckIns: 24, maxRedirects: 3 };
export interface DriveIntent { scope?: string; text: string; words: string[]; targets: string[]; intent: string }
export interface DriveTokenMeter { inputEstimate: number; characters: number; input: number | null; output: number | null; total: number | null; charged: number; attempt: number }
export interface DriveProtection {
  version: 1; limits: DriveLimits;
  used: { activeMs: number; cycles: number; tasks: number; workerRequests: number; planningTokens: number; workerTokens: number; checkIns: number; redirects: number };
  stalledCycles: number; evidence: string[]; navigation: string[]; tasks: DriveIntent[]; submissions: DriveIntent[];
  /** Older journals have incomplete usage history; never imply exact billing. */
  migrated: boolean;
  planning?: DriveTokenMeter;
  pendingWorker?: { sessionId: string; hash: string; at: number; inputEstimate: number };
  worker?: { sessionId: string; turnId: string; cursor: number; meter: DriveTokenMeter; checks: number; checkCursor: number; nextCheckAt: number; settled: boolean;
    checkpoint?: {reason:DriveCheckpointReason;cursor:number}; checkpointReadyAt?:number; editBatch?:number;
    recentTools?: {id:string;key:string;check:boolean}[];
  };
  trip?: { kind: "budget" | "loop" | "journal"; reason: string; at: number };
}
export interface DriveState extends DriveMemory {
  mode?: DriveMode; ledger?: DriveLedger; facts?: DriveFacts;
  id: string; mission: string; homeSessionId: string; workspace: string; status: DriveStatus;
  activity: string; step: number; model: string | null; updatedAt: string;
  /** Operator-visible provider output. Never sent back as planning memory. */
  traces?: DriveTrace[];
  /** The answer a completed question mission delivered (shown under Details). */
  answer?: string;
  autonomy?: DriveAutonomy;
  recovery?: { kind: DriveRecovery; attempt: number; limit: number; retryAt: number; message: string };
  protection?: DriveProtection;
}

export function parseDriveStreamEvent(value: unknown): DriveStreamEvent {
  if (!isRecord(value)) invalid("stream", "expected an event object");
  if (value.type === "review.ready") return {type:"review.ready",review:parseDriveReview(value.review)};
  if (value.type === "queued") return { type: "queued" };
  if (value.type === "attempt") return { type: "attempt", attempt: coordinate(value.attempt, 3, "stream.attempt"),
    model: text(value.model, 1000, "stream.model"), provider: text(value.provider, 1000, "stream.provider") };
  if (value.type === "reasoning.delta" || value.type === "text.delta" || value.type === "action.delta")
    return { type: value.type, delta: text(value.delta, 2_100_000, "stream.delta", true) };
  if (value.type === "correction") return { type: value.type, message: text(value.message, 8000, "stream.message") };
  if (value.type === "error") {
    if (value.recovery !== undefined && value.recovery !== "transient" && value.recovery !== "decision") invalid("stream.recovery", "expected transient or decision");
    return { type: "error", message: text(value.message, 8000, "stream.message"), ...(value.recovery ? { recovery: value.recovery } : {}) };
  }
  if (value.type === "usage" && isRecord(value.usage)) {
    const usage = value.usage;
    const count = (field: string): number | null => usage[field] === null ? null : coordinate(usage[field], Number.MAX_SAFE_INTEGER, `stream.usage.${field}`);
    return { type: "usage", usage: { inputTokens: count("inputTokens"), outputTokens: count("outputTokens"), totalTokens: count("totalTokens"),
      ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: coordinate(usage.cachedInputTokens, Number.MAX_SAFE_INTEGER, "stream.usage.cachedInputTokens") } : {}) } };
  }
  if (value.type === "result" && isRecord(value.response) && typeof value.response.imageInspected === "boolean") return { type: "result", response: {
    decision: parseDriveDecision(value.response.decision), model: text(value.response.model, 1000, "stream.model"),
    ...(value.response.review !== undefined ? {review:parseDriveReview(value.response.review)} : {}),
    ...(typeof value.response.skipped === "string" ? {skipped:text(value.response.skipped,2000,"stream.skipped")} : {}),
    provider: text(value.response.provider, 1000, "stream.provider"), imageInspected: value.response.imageInspected,
  } };
  invalid("stream.type", "expected a Drive progress, result, or error event");
}

function invalid(path: string, requirement: string): never { throw new ProtocolValidationError(`Agent Drive ${path}: ${requirement}`); }
function text(value: unknown, limit: number, path: string, empty = false): string {
  if (typeof value !== "string" || value.length > limit || !empty && !value.trim()) invalid(path, `expected ${empty ? "a" : "a non-empty"} string of at most ${limit} characters`);
  return value;
}
function list(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > 32) invalid(path, "expected an array of at most 32 strings");
  return value.map((item, index) => text(item, 1000, `${path}[${index}]`));
}
function evidence(value: unknown, path: string): DriveEvidence[] {
  if (!Array.isArray(value) || value.length > 32) invalid(path, "expected an array of at most 32 evidence quotes");
  return value.map((item, index) => {
    if (!isRecord(item)) invalid(`${path}[${index}]`, "expected an object");
    return { observationId: text(item.observationId, 100, `${path}[${index}].observationId`), quote: text(item.quote, 2000, `${path}[${index}].quote`) };
  });
}
function coordinate(value: unknown, max: number, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= max) invalid(path, `expected an integer from 0 to ${max - 1}`);
  return value as number;
}
export function parseDriveDecision(value: unknown): DriveDecision {
  if (!isRecord(value) || !isRecord(value.action)) invalid("action", "expected an object with a kind");
  const raw = value.action;
  let action: DriveAction;
  if (raw.kind === "click") action = { kind: "click", target: text(raw.target, 100, "action.target") };
  else if (raw.kind === "compose") {
    const content = text(raw.text, 16_000, "action.text");
    if (!driveComposerAllowed(content)) throw new ProtocolValidationError("Drive can compose work and inspection commands only");
    action = { kind: "compose", text: content };
  } else if (raw.kind === "inspect") {
    if (!DRIVE_INSPECTIONS.includes(raw.target as DriveInspectAction["target"])) invalid("action.target", "expected answer, diff, checks, or log");
    if (raw.position !== undefined && !["start", "continue", "end"].includes(String(raw.position))) invalid("action.position", "expected start, continue, or end");
    action = { kind: "inspect", target: raw.target as DriveInspectAction["target"],
      ...(raw.item !== undefined ? { item: text(raw.item, 4096, "action.item", true) || undefined } : {}),
      ...(raw.position !== undefined ? { position: raw.position as DriveInspectAction["position"] } : {}) };
  } else if (raw.kind === "key") {
    if (!DRIVE_KEYS.includes(raw.key as DriveKey)) invalid("action.key", `expected one of: ${DRIVE_KEYS.join(", ")}`);
    action = { kind: "key", key: raw.key as DriveKey };
  } else if (raw.kind === "scroll") {
    if (!Number.isSafeInteger(raw.amount) || raw.amount === 0 || Math.abs(raw.amount as number) > 12) invalid("action.amount", "expected a non-zero integer from -12 to 12");
    action = { kind: "scroll", row: coordinate(raw.row, 250, "action.row"), column: coordinate(raw.column, 500, "action.column"), amount: raw.amount as number };
  }
  else if (raw.kind === "set_criteria") {
    const criteria = list(raw.criteria, "action.criteria");
    if (!criteria.length) invalid("action.criteria", "specify at least one acceptance criterion");
    action = { kind: "set_criteria", criteria };
  } else if (raw.kind === "reopen_task") action = { kind: "reopen_task", taskId: text(raw.taskId,100,"action.taskId"), reason: text(raw.reason,2000,"action.reason") };
  else if (raw.kind === "complete") {
    if (raw.basis !== undefined && raw.basis !== "answer" && raw.basis !== "verified-work") invalid("action.basis", "expected answer or verified-work");
    action = { kind: "complete", ...(raw.basis !== undefined ? { basis: raw.basis } : {}) };
  } else if (raw.kind === "next_task") action = { kind: "next_task", task: text(raw.task, 8000, "action.task") };
  else if (raw.kind === "redirect") {
    const content = text(raw.text, 16_000, "action.text");
    if (content.trimStart().startsWith("/")) invalid("action.text", "redirect must be a coding instruction, not a slash command");
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(content)) invalid("action.text", "redirect cannot contain terminal control characters");
    action = { kind: "redirect", text: content };
  } else if (raw.kind === "blocked" || raw.kind === "wait" || raw.kind === "idle" || raw.kind === "keep_working") action = { kind: raw.kind };
  else invalid("action.kind", "expected click, key, compose, scroll, inspect, complete, next_task, idle, blocked, wait, keep_working, or redirect");
  return { ...(typeof value.answer === "string" && value.answer.trim() ? { answer: text(value.answer, 16_000, "answer") } : {}),
    action, note: text(value.note, 2000, "note"), notes: text(value.notes, 8000, "notes", true), completed: list(value.completed, "completed"), remaining: list(value.remaining, "remaining"), evidence: evidence(value.evidence, "evidence") };
}
export function driveComposerAllowed(value: string): boolean {
  const command = value.trim().split(/\s/, 1)[0]!;
  return !command.startsWith("/") || ["/sessions", "/resume", "/context", "/status", "/help", "/diff", "/plan"].includes(command);
}
export function parseDriveAutonomy(value: unknown): DriveAutonomy {
  if (!isRecord(value) || !["working", "discovering"].includes(String(value.phase)) || typeof value.consulted !== "boolean"
    || !Array.isArray(value.history) || value.history.length > 8) invalid("autonomy", "expected a working/discovering phase, consulted flag, and at most 8 completed tasks");
  const cycle = coordinate(value.cycle, Number.MAX_SAFE_INTEGER, "autonomy.cycle");
  if (!cycle) invalid("autonomy.cycle", "expected a positive cycle number");
  return { ...(value.consultations !== undefined ? { consultations: coordinate(value.consultations, 3, "autonomy.consultations") } : {}), ...(value.consultationTurnId !== undefined ? { consultationTurnId: text(value.consultationTurnId,100,"autonomy.consultationTurnId") } : {}), phase: value.phase as DriveAutonomy["phase"], task: text(value.task, 8000, "autonomy.task"), cycle, consulted: value.consulted,
    history: value.history.map((item, index) => {
      if (!isRecord(item)) invalid(`autonomy.history[${index}]`, "expected a completed task");
      return { task: text(item.task, 8000, `autonomy.history[${index}].task`), summary: text(item.summary, 2000, `autonomy.history[${index}].summary`), at: text(item.at, 100, `autonomy.history[${index}].at`) };
    }) };
}

/** One contextual rule set for the daemon's correction and the CLI's final gate. */
export function validateDriveDecisionContext(decision: DriveDecision, request: DriveRequest): void {
  const { action } = decision, screen = request.observation;
  const rows = screen.evidenceRows ?? (screen.surface === "drive" ? [] : screen.rows);
  if (request.checkIn) {
    if (screen.mode !== "streaming" || screen.sessionId !== request.homeSessionId) invalid("checkIn", "check-ins observe a running coder turn in the home session");
    if (action.kind !== "keep_working" && action.kind !== "redirect") invalid("checkIn.action", "use keep_working or redirect; running work cannot be completed or navigated by a check-in");
    if (action.kind === "redirect" && !decision.evidence.length) invalid("checkIn.evidence", "quote concrete visible activity that contradicts the task before interrupting");
    const reviewed=request.review;
    if (reviewed && (reviewed.turnId !== request.checkIn.turnId || reviewed.sessionId !== request.homeSessionId || reviewed.status !== "running" || reviewed.waitingForHuman)) invalid("checkIn.review", "review no longer describes an eligible running worker");
    for (const item of decision.evidence) if (item.observationId !== (reviewed?.id ?? screen.id) || !(reviewed?.rows ?? rows).some(row => row.includes(item.quote))) invalid("checkIn.evidence", "quote an exact substring from the fresh review rows (when supplied), otherwise current visible coder activity; history and Drive notes cannot justify interruption");
    return;
  }
  if (action.kind === "keep_working" || action.kind === "redirect") invalid("action.kind", "keep_working and redirect are only available during a live check-in");
  const inspected = request.inspection && request.inspection.sessionId === screen.sessionId
    && request.inspection.document === screen.navigation?.document && request.inspection.turn === screen.navigation.turn ? request.inspection.pages : [];
  const inspectedQuote = (item: DriveEvidence) => inspected.find((page) => page.observationId === item.observationId && page.rows.some((row) => row.includes(item.quote)));
  if (action.kind === "inspect") {
    if (!screen.navigation) invalid("action.inspect", "this client does not support controller inspection; use the visible controls");
    if (screen.navigation.turn === "0") invalid("action.inspect", "this session has no turn to inspect yet; compose the request to the coding agent first");
    if (action.target === "answer" && !screen.navigation.answer) invalid("action.inspect", "the selected turn has no completed answer");
    if (action.target === "diff" && (!screen.navigation.files.length || action.item && !screen.navigation.files.includes(action.item))) invalid("action.item", "choose a path from navigation.files");
    if (action.target === "checks" && (!screen.navigation.checks.length || action.item && !screen.navigation.checks.includes(action.item))) invalid("action.item", "choose a check id from navigation.checks");
  }
  // Alt+Enter expands an open Diff; anywhere else it types a newline into the
  // composer, which leaves a draft that stops Drive.
  if (action.kind === "key" && action.key === "alt+enter" && !screen.surface?.startsWith("diff") && !screen.panes?.some((pane) => pane.surface.startsWith("diff")))
    invalid("action.key", "alt+enter only expands an open Diff (open one with alt+d or inspect target=diff); elsewhere it types a newline into the composer. Alt+V opens Preview, which shows images and pages the agent produced, not the workbench itself");
  if (action.kind === "click" && !screen.controls.some((control) => control.id === action.target)) invalid("action.target", "choose an id from observation.controls");
  if (action.kind === "scroll" && (action.row >= screen.height || action.column >= screen.width)) invalid("action.scroll", "coordinates must be inside the observed screen");
  if (action.kind === "compose" && (!action.text.trimStart().startsWith("/") || /^\/plan(?:\s|$)/.test(action.text.trimStart())) && screen.sessionId !== request.homeSessionId)
    invalid("action.compose", `return to the mission session with /resume ${request.homeSessionId} before submitting work`);
  for (const [index, item] of decision.evidence.entries()) {
    if (item.observationId === screen.id && screen.mode !== "streaming" && rows.some((row) => row.includes(item.quote))
      || inspectedQuote(item) || request.memory.evidence.some((saved) => saved.observationId === item.observationId && saved.quote === item.quote)) continue;
    invalid(`evidence[${index}]`, `rejected quote ${JSON.stringify(item.quote).slice(0, 220)}. Copy an exact substring from ONE current eligible result row, with observationId ${screen.id}, or use verified memory.evidence. Drive's own panel is not evidence. Use [] while navigating.`);
  }
  const task = request.ledger?.tasks.find(task => task.id === request.ledger!.currentTaskId);
  if (request.facts && (request.facts.sessionId !== request.homeSessionId || request.facts.workspace !== screen.workspace)) invalid("facts", "recorded facts belong to a different session or workspace");
  if (action.kind === "set_criteria") {
    if (!task || task.status !== "active" || task.workerTurns.length || task.attempts?.requests || task.completions.length) invalid("action.set_criteria", "acceptance criteria can only be set before the task's first worker turn");
    return;
  }
  if (action.kind === "reopen_task") {
    const target = request.ledger?.tasks.find(task => task.id === action.taskId);
    if (!target || target.status !== "completed" || !driveReopenReason(target,request.facts)) invalid("action.reopen_task", "completed work needs a relevant changed file, a new current failed check, or an explicit human reopen command; rewording the goal is not evidence");
    if (task?.status === "active") invalid("action.reopen_task", "finish the active task before reopening another");
    return;
  }
  if (action.kind === "compose" && task?.status === "completed" && request.autonomy?.phase !== "discovering") invalid("action.compose", "this task is already complete; do not send more work without reopening it");
  if (action.kind === "next_task" || action.kind === "idle") {
    if (request.mode === "bounded") invalid("action.next_task", "bounded missions finish after verification; continuous discovery was not requested");
    if (request.facts && (!request.autonomy?.consultationTurnId || request.facts.latestTurn?.id !== request.autonomy.consultationTurnId || request.facts.latestTurn?.status !== "completed")) invalid("consultation", "inspect the specific completed consultation turn before selecting more work");
    if (request.autonomy?.phase !== "discovering" || !request.autonomy.consulted)
      invalid(`action.${action.kind}`, "finish the current task, then visibly compose a focused question to the coding agent about useful next work and inspect its answer first");
    if (screen.sessionId !== request.homeSessionId || screen.mode !== "input" || !screen.ready)
      invalid(`action.${action.kind}`, "inspect the coding agent's settled answer in the home session first");
    if (!decision.evidence.some((item) => item.observationId === screen.id && screen.latestAnswerRows?.some((row) => row.includes(item.quote)) || inspectedQuote(item)?.latest))
      invalid(`action.${action.kind}`, "quote a specific suggestion or assessment from observation.latestAnswerRows (the latest settled answer to your consultation), not an older reply, before choosing next work or becoming idle");
    if (action.kind === "next_task" && request.autonomy.history.some((item) => item.task.trim().toLowerCase() === action.task.trim().toLowerCase()))
      invalid("action.next_task", "that task is already finished; select a distinct useful improvement from the agent's answer");
    if (action.kind === "idle" && decision.remaining.length) invalid("action.idle", "remaining work must be empty; continue useful work instead of becoming idle");
    return;
  }
  if (action.kind !== "complete") return;
  if (task?.status === "completed") invalid("action.complete", "this task is already complete; choose unfinished work or become idle");
  if (request.facts) {
    const turn = request.facts.selectedTurn;
    if (!turn || turn.status !== "completed" || (task?.workerTurns.length && !task.workerTurns.includes(turn.id))) invalid("action.complete", "inspect a completed worker turn for this task; a cancelled, failed or unrelated turn is not completion");
    if (action.basis !== "answer" && request.facts.checks.some(check => check.turnId === turn.id && (check.status !== "completed" || check.freshness !== "current"))) invalid("action.complete", "this turn has failed, running or outdated checks; inspect the current results before finishing");
  }
  if (request.autonomy?.phase === "discovering") invalid("action.complete", "the previous task is already finished. Ask the coding agent about next improvements, inspect its answer, then use next_task or idle");
  if (decision.remaining.length) invalid("action.complete", "remaining must be empty before finishing; inspect or finish the outstanding items first");
  if (screen.sessionId !== request.homeSessionId) invalid("action.complete", `return to /resume ${request.homeSessionId} and inspect the result before finishing`);
  const fresh = decision.evidence.filter((item) => item.observationId === screen.id && rows.some((row) => row.includes(item.quote)));
  if (screen.mode !== "input" || !screen.ready) invalid("action.complete", "wait until the home session is ready and inspect the settled result");
  if (action.basis === "answer") {
    if (!fresh.some((item) => screen.answerRows?.some((row) => row.includes(item.quote))) && !decision.evidence.some((item) => inspectedQuote(item)?.answer))
      invalid("action.complete", "answer completion requires a fresh quote from observation.answerRows (a completed assistant answer). Read the relevant answer in the home conversation first; requests, thinking, and Drive notes do not qualify");
  } else if ((!["diff", "log", "review", "output", "preview"].includes(screen.surface) || !fresh.length)
    && !decision.evidence.some((item) => ["diff", "log", "review", "output", "preview"].includes(inspectedQuote(item)?.surface ?? ""))) {
    invalid("action.complete", `verified-work completion requires fresh result evidence from Diff, execution log, review, output, or Preview; current surface is ${screen.surface}. Open and inspect the result (Ctrl+B for log, Alt+D for Diff). For an advisory/question mission, use basis: answer with a quote from observation.answerRows and deliver the answer in note. Do not claim implementation or checks were verified from an assistant summary`);
  }
}
export function parseDriveInspection(value: unknown): DriveInspection {
  if (!isRecord(value) || !DRIVE_INSPECTIONS.includes(value.target as DriveInspectAction["target"]) || typeof value.truncated !== "boolean"
    || !Array.isArray(value.pages) || value.pages.length > 12) invalid("inspection", "expected a bounded controller inspection");
  const pages = value.pages.map((page, i) => {
    if (!isRecord(page) || !Array.isArray(page.rows) || page.rows.length > 250 || typeof page.answer !== "boolean" || typeof page.latest !== "boolean") invalid(`inspection.pages[${i}]`, "expected visible result rows and answer provenance");
    return { observationId: text(page.observationId, 100, "inspection.observationId"), surface: text(page.surface, 100, "inspection.surface"),
      ...(page.item !== undefined ? { item: text(page.item, 4096, "inspection.item") } : {}),
      ...(page.offset !== undefined || page.maximum !== undefined ? { maximum: coordinate(page.maximum, Number.MAX_SAFE_INTEGER, "inspection.maximum"), offset: coordinate(page.offset, Number(page.maximum) + 1, "inspection.offset") } : {}),
      rows: page.rows.map((row) => text(row, 2000, "inspection.row", true)), answer: page.answer, latest: page.latest && page.answer };
  });
  if (pages.reduce((sum, page) => sum + page.rows.reduce((n, row) => n + row.length, 0), 0) > 24_000) invalid("inspection.pages", "visible evidence exceeds 24,000 characters");
  return { sessionId: text(value.sessionId, 100, "inspection.sessionId"), document: text(value.document, 100, "inspection.document"), turn: text(value.turn, 100, "inspection.turn"),
    target: value.target as DriveInspectAction["target"], pages, truncated: value.truncated, actions: coordinate(value.actions, 65, "inspection.actions"), result: text(value.result, 2000, "inspection.result") };
}
export function parseDriveRequest(value: unknown): DriveRequest {
  if (!isRecord(value) || !isRecord(value.observation) || !isRecord(value.memory)) invalid("request", "expected observation and memory objects");
  const raw = value.observation, memory = value.memory;
  const width = coordinate(raw.width, 501, "observation.width"), height = coordinate(raw.height, 251, "observation.height");
  if (width < 1 || height < 1 || !["input", "streaming", "approval", "dialog"].includes(String(raw.mode)) || typeof raw.ready !== "boolean"
    || !Array.isArray(raw.rows) || raw.rows.length > height || !Array.isArray(raw.controls) || raw.controls.length > 160) invalid("observation", "expected positive dimensions, a valid mode, boolean ready, rows within height, and at most 160 controls");
  const observation: DriveObservation = {
    id: text(raw.id, 100, "observation.id"), sessionId: text(raw.sessionId, 100, "observation.sessionId"), workspace: text(raw.workspace, 4096, "observation.workspace"), title: text(raw.title, 500, "observation.title", true),
    mode: raw.mode as DriveObservation["mode"], ready: raw.ready, draft: text(raw.draft, 128_000, "observation.draft", true), surface: text(raw.surface, 100, "observation.surface"), width, height,
    rows: raw.rows.map((line, index) => text(line, 2000, `observation.rows[${index}]`, true)),
    controls: raw.controls.map((item, index) => {
      const path = `observation.controls[${index}]`;
      if (!isRecord(item)) invalid(path, "expected an object");
      return { id: text(item.id, 100, `${path}.id`), label: text(item.label, 1000, `${path}.label`, true), row: coordinate(item.row, height, `${path}.row`), column: coordinate(item.column, width, `${path}.column`), width: coordinate(item.width, width + 1, `${path}.width`) };
    }), ...(raw.artifactId !== undefined ? { artifactId: text(raw.artifactId, 100, "observation.artifactId") } : {}),
  };
  if (raw.focus !== undefined) {
    if (!["composer", "content", "dialog"].includes(String(raw.focus))) invalid("observation.focus", "expected composer, content, or dialog");
    observation.focus = raw.focus as DriveObservation["focus"];
  }
  if (raw.panes !== undefined) {
    if (!Array.isArray(raw.panes) || raw.panes.length > 8) invalid("observation.panes", "expected at most 8 visible panes");
    observation.panes = raw.panes.map((pane, index) => {
      const path = `observation.panes[${index}]`;
      if (!isRecord(pane)) invalid(path, "expected an object");
      const row = coordinate(pane.row, height, `${path}.row`), column = coordinate(pane.column, width, `${path}.column`);
      const paneWidth = coordinate(pane.width, width - column + 1, `${path}.width`), paneHeight = coordinate(pane.height, height - row + 1, `${path}.height`);
      if (!paneWidth || !paneHeight) invalid(path, "expected positive pane dimensions");
      return { surface: text(pane.surface, 100, `${path}.surface`), row, column, width: paneWidth, height: paneHeight };
    });
  }
  if (raw.evidenceRows !== undefined) {
    if (!Array.isArray(raw.evidenceRows) || raw.evidenceRows.length > height) invalid("observation.evidenceRows", "expected rows within the screen height");
    observation.evidenceRows = raw.evidenceRows.map((line, index) => text(line, 2000, `observation.evidenceRows[${index}]`, true));
  }
  if (raw.answerRows !== undefined) {
    if (!Array.isArray(raw.answerRows) || raw.answerRows.length > height) invalid("observation.answerRows", "expected rows within the screen height");
    observation.answerRows = raw.answerRows.map((line, index) => text(line, 2000, `observation.answerRows[${index}]`, true));
  }
  if (raw.latestAnswerRows !== undefined) {
    if (!Array.isArray(raw.latestAnswerRows) || raw.latestAnswerRows.length > height) invalid("observation.latestAnswerRows", "expected rows within the screen height");
    observation.latestAnswerRows = raw.latestAnswerRows.map((line, index) => text(line, 2000, `observation.latestAnswerRows[${index}]`, true));
  }
  if (raw.scrollRegions !== undefined) {
    if (!Array.isArray(raw.scrollRegions) || raw.scrollRegions.length > 16) invalid("observation.scrollRegions", "expected at most 16 visible scroll regions");
    observation.scrollRegions = raw.scrollRegions.map((item, index) => {
      const path = `observation.scrollRegions[${index}]`;
      if (!isRecord(item)) invalid(path, "expected a scroll region");
      const row = coordinate(item.row, height, `${path}.row`), column = coordinate(item.column, width, `${path}.column`);
      const maximum = coordinate(item.maximum, Number.MAX_SAFE_INTEGER, `${path}.maximum`);
      return { surface: text(item.surface, 100, `${path}.surface`), row, column,
        width: coordinate(item.width, width - column + 1, `${path}.width`), height: coordinate(item.height, height - row + 1, `${path}.height`),
        offset: coordinate(item.offset, maximum + 1, `${path}.offset`), maximum };
    });
  }
  if (raw.navigation !== undefined) {
    const nav = raw.navigation;
    if (!isRecord(nav) || typeof nav.latest !== "boolean" || typeof nav.answer !== "boolean" || typeof nav.readingHeld !== "boolean"
      || !Array.isArray(nav.files) || nav.files.length > 128 || !Array.isArray(nav.checks) || nav.checks.length > 128) invalid("observation.navigation", "expected bounded navigation metadata");
    observation.navigation = { document: text(nav.document, 100, "navigation.document"), turn: text(nav.turn, 100, "navigation.turn"), latest: nav.latest, answer: nav.answer, readingHeld: nav.readingHeld,
      files: nav.files.map((file) => text(file, 4096, "navigation.file")), checks: nav.checks.map((check) => text(check, 100, "navigation.check")),
      ...(nav.item !== undefined ? { item: text(nav.item, 4096, "navigation.item") } : {}) };
  }
  if (!Array.isArray(memory.steps) || memory.steps.length > 64) invalid("memory.steps", "expected at most 64 steps");
  if (value.mode !== undefined && !["bounded","continuous"].includes(String(value.mode))) invalid("mode", "expected bounded or continuous");
  return { ...(value.mode !== undefined ? { mode: value.mode as DriveMode } : {}), ...(value.ledger !== undefined ? { ledger: parseDriveLedger(value.ledger) } : {}), ...(value.facts !== undefined ? { facts: parseDriveFacts(value.facts) } : {}), mission: text(value.mission, 8000, "mission"), homeSessionId: text(value.homeSessionId, 100, "homeSessionId"), observation,
    ...(value.autonomy !== undefined ? { autonomy: parseDriveAutonomy(value.autonomy) } : {}),
    ...(value.inspection !== undefined ? { inspection: parseDriveInspection(value.inspection) } : {}),
    ...(value.review !== undefined ? {review:parseDriveReview(value.review)} : {}),
    ...(value.checkIn !== undefined ? { checkIn: parseDriveCheckIn(value.checkIn) } : {}),
    ...(typeof value.thinking === "boolean" ? { thinking: value.thinking } : {}),
    memory: { notes: text(memory.notes, 8000, "memory.notes", true), completed: list(memory.completed, "memory.completed"), remaining: list(memory.remaining, "memory.remaining"), evidence: evidence(memory.evidence, "memory.evidence"),
      ...(memory.feedback !== undefined ? { feedback: text(memory.feedback, 8000, "memory.feedback") } : {}),
      steps: memory.steps.map((step, index) => {
        const path = `memory.steps[${index}]`;
        if (!isRecord(step)) invalid(path, "expected an object");
        return { step: coordinate(step.step, Number.MAX_SAFE_INTEGER, `${path}.step`), action: text(step.action, 20_000, `${path}.action`), note: text(step.note, 2000, `${path}.note`), result: text(step.result, 2000, `${path}.result`), at: text(step.at, 100, `${path}.at`) };
      }) } };
}
function parseDriveCheckIn(value: unknown): NonNullable<DriveRequest["checkIn"]> {
  if (!isRecord(value)) invalid("checkIn", "expected a turn and event cursor");
  if(value.freshEvidence !== undefined && typeof value.freshEvidence !== "boolean") invalid("checkIn.freshEvidence","expected boolean");
  if(value.reason !== undefined && !DRIVE_CHECKPOINTS.includes(value.reason as DriveCheckpointReason)) invalid("checkIn.reason","unknown checkpoint");
  return { turnId: text(value.turnId, 100, "checkIn.turnId"), cursor: coordinate(value.cursor, Number.MAX_SAFE_INTEGER, "checkIn.cursor"), ...(value.freshEvidence !== undefined ? {freshEvidence:value.freshEvidence as boolean}:{}), ...(value.reason !== undefined?{reason:value.reason as DriveCheckpointReason}:{}) };
}
