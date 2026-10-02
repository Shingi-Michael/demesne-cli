import { createHash } from "node:crypto";
import { DEFAULT_DRIVE_LIMITS, isRecord, type DriveAction, type DriveDecision, type DriveIntent, type DriveLimits, type DriveObservation, type DriveProtection, type DriveState, type DriveTokenMeter, type TokenUsage } from "@demesne/protocol";

export const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex");
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
const stopWords = new Set("a an the and or to of for in on with from by as at is are be this that it its now please then again task work concrete specific useful worthwhile next previously existing current only no not do without code changes commits commit read scope based user goal goals implementation implement add fix test review document".split(" "));
const aliases: Record<string, string> = { repair: "fix", resolve: "fix", correct: "fix", address: "fix", implement: "fix", build: "fix", add: "fix", create: "fix",
  verify: "test", validate: "test", check: "test", checks: "test", testing: "test", tests: "test", coverage: "test",
  inspect: "review", audit: "review", assess: "review", examine: "review", investigate: "review", analyze: "review", analyse: "review",
  describe: "document", explain: "document", summarize: "document", report: "document", documentation: "document",
  cancellation: "cancel", cancelling: "cancel", canceled: "cancel", cancelled: "cancel", stopping: "cancel", abort: "cancel",
  authorization: "permission", authorisation: "permission", permissions: "permission", overauthorization: "overgrant", overgranting: "overgrant",
  duplicate: "duplication", duplicated: "duplication", duplicates: "duplication", redundant: "duplication", empty: "empty", blank: "empty", missing: "missing" };

/** Deterministic intent/target overlap, not a claim of semantic equivalence.
 * Resource and no-progress budgets remain the backstop for novel paraphrases. */
export function driveIntent(text: string): DriveIntent {
  const clean = text.replace(/\b(?:no|without)\s+(?:code\s+)?(?:edits?|changes?|commits?)\b/gi, " ").replace(/read[- ]only/gi, " ");
  const words = normalize(clean).split(" ").map(word => aliases[word] ?? (word.length > 5 ? word.replace(/(?:ing|ed|s)$/, "") : word));
  const intent = words.find(word => ["fix", "test", "review", "document"].includes(word)) ?? "";
  const targets = [...new Set((clean.match(/(?:[\w@.-]+\/)+[\w@.-]+|\b[\w-]+\.(?:tsx?|jsx?|py|rs|go|swift|json|toml|md)\b/g) ?? []).map(path => path.toLowerCase()))].sort().slice(0, 32);
  return { text: text.slice(0, 600), intent, targets, words: [...new Set(words.filter(word => word.length > 1 && !stopWords.has(word)))].sort().slice(0, 128) };
}
export function similarIntent(a: DriveIntent, b: DriveIntent): boolean {
  if (a.text.length < 600 && b.text.length < 600 && normalize(a.text) === normalize(b.text)) return true;
  if (a.intent && b.intent && a.intent !== b.intent) return false;
  if (a.targets.length && b.targets.length && !a.targets.some(target => b.targets.includes(target))) return false;
  const overlap = a.words.filter(word => b.words.includes(word)).length;
  const union = new Set([...a.words, ...b.words]).size;
  return overlap >= 2 && overlap / Math.max(1, union) >= 0.7 && overlap / Math.max(1, Math.min(a.words.length, b.words.length)) >= 0.85;
}
export function newDriveProtection(limits: Partial<DriveLimits> = {}): DriveProtection {
  const resolved = { ...DEFAULT_DRIVE_LIMITS, ...limits };
  if (Object.values(resolved).some(value => !count(value) || value === 0) || resolved.maxTasks > 64 || resolved.maxWorkerRequests > 256) throw new Error("Invalid Drive limits (positive integers; at most 64 tasks and 256 worker requests).");
  return { version: 1, limits: resolved, used: { activeMs: 0, cycles: 0, tasks: 0, workerRequests: 0, planningTokens: 0, workerTokens: 0, checkIns: 0, redirects: 0 },
    stalledCycles: 0, evidence: [], navigation: [], tasks: [], submissions: [], migrated: false };
}
const strings = (value: unknown, length: number, width: number) => Array.isArray(value) && value.length <= length && value.every(item => typeof item === "string" && item.length <= width);
const meterValid = (m: unknown) => isRecord(m) && [m.inputEstimate, m.characters, m.charged, m.attempt].every(count) && [m.input, m.output, m.total].every(value => value === null || count(value));
const intentsValid = (value: unknown, maximum: number) => Array.isArray(value) && value.length <= maximum && value.every(item => isRecord(item) && typeof item.text === "string" && item.text.length <= 600
  && typeof item.intent === "string" && item.intent.length <= 32 && strings(item.words, 128, 16_000) && strings(item.targets, 32, 16_000));

export function restoreDriveProtection(state: DriveState, limits?: Partial<DriveLimits>): DriveProtection {
  const fallback = newDriveProtection(limits), saved = state.protection;
  if (saved === undefined) {
    fallback.migrated = true; fallback.used.cycles = state.step;
    fallback.used.tasks = state.autonomy ? Math.max(state.autonomy.history.length, state.autonomy.cycle - (state.autonomy.phase === "working" ? 1 : 0)) : state.status === "completed" ? 1 : 0;
    fallback.tasks = (state.autonomy?.history ?? []).map(item => driveIntent(item.task));
    for (const step of state.steps) try {
      const action = JSON.parse(step.action);
      if (action.kind === "compose" && typeof action.text === "string" && workerText(action.text) !== undefined) {
        fallback.used.workerRequests++; fallback.submissions.push(driveIntent(workerText(action.text)!));
      }
    } catch { /* Old receipts can contain display strings rather than JSON. */ }
    fallback.used.planningTokens = (state.traces ?? []).reduce((sum, trace) => sum + (trace.usage?.totalTokens ?? (trace.usage?.inputTokens ?? 0) + (trace.usage?.outputTokens ?? Math.ceil((trace.reasoning.length + trace.text.length + trace.actionDraft.length) / 4))), 0);
    return fallback;
  }
  try {
    if (!isRecord(saved) || saved.version !== 1 || !isRecord(saved.limits) || (Object.keys(DEFAULT_DRIVE_LIMITS) as (keyof DriveLimits)[]).some(key => !count(saved.limits[key]) || saved.limits[key] === 0)
      || !isRecord(saved.used) || (Object.keys(fallback.used) as (keyof DriveProtection["used"])[]).some(key => !count(saved.used[key])) || !count(saved.stalledCycles) || typeof saved.migrated !== "boolean"
      || !strings(saved.evidence, 1024, 64) || !strings(saved.navigation, 24, 64) || !intentsValid(saved.tasks, 64) || !intentsValid(saved.submissions, 256)
      || saved.planning !== undefined && !meterValid(saved.planning)
      || saved.pendingWorker !== undefined && (!isRecord(saved.pendingWorker) || typeof saved.pendingWorker.sessionId !== "string" || typeof saved.pendingWorker.hash !== "string" || !count(saved.pendingWorker.at) || !count(saved.pendingWorker.inputEstimate))
      || saved.worker !== undefined && (!isRecord(saved.worker) || typeof saved.worker.sessionId !== "string" || typeof saved.worker.turnId !== "string" || !count(saved.worker.cursor) || !meterValid(saved.worker.meter)
        || !count(saved.worker.checks) || !count(saved.worker.checkCursor) || !count(saved.worker.nextCheckAt) || typeof saved.worker.settled !== "boolean")
      || saved.trip !== undefined && (!isRecord(saved.trip) || !["budget", "loop", "journal"].includes(String(saved.trip.kind)) || typeof saved.trip.reason !== "string" || saved.trip.reason.length > 2000 || !count(saved.trip.at))) throw new Error();
    if(saved.worker){
      const w=saved.worker;
      if(w.checkpointReadyAt!==undefined&&!count(w.checkpointReadyAt) || w.editBatch!==undefined&&(!count(w.editBatch)||w.editBatch>12)
        || w.checkpoint!==undefined&&(!isRecord(w.checkpoint)||!count(w.checkpoint.cursor)||!["check_completed","edit_batch","repeated_tools","interval"].includes(String(w.checkpoint.reason)))
        || w.recentTools!==undefined&&(!Array.isArray(w.recentTools)||w.recentTools.length>12||w.recentTools.some(c=>!isRecord(c)||typeof c.id!=="string"||c.id.length>100||typeof c.key!=="string"||c.key.length!==64||typeof c.check!=="boolean")))throw new Error();
    }
    newDriveProtection(saved.limits);
    return structuredClone(saved) as DriveProtection;
  } catch {
    fallback.trip = { kind: "journal", at: Date.now(), reason: "Saved Drive protection counters are invalid. Start a new mission explicitly; Resume cannot safely reset accounting." };
    return fallback;
  }
}

export function driveBudgetReason(guard: DriveProtection, admission = true): string | undefined {
  const { used, limits } = guard;
  if (used.activeMs >= limits.maxActiveMinutes * 60_000) return `Mission active-time limit reached (${limits.maxActiveMinutes} minutes).`;
  if (used.planningTokens + used.workerTokens >= limits.maxTokens) return `Mission token limit reached (${limits.maxTokens.toLocaleString()} accounted planning + worker tokens).`;
  if (admission && used.cycles >= limits.maxCycles) return `Mission cycle limit reached (${limits.maxCycles} planning/controller cycles across all tasks).`;
  if (used.tasks >= limits.maxTasks) return `Mission task limit reached (${limits.maxTasks} completed tasks).`;
  if (admission && guard.stalledCycles >= limits.maxStalledCycles) return `No new result evidence or distinct work request in ${guard.stalledCycles} cycles. Drive may be busy without progress.`;
}
export const workerText = (text: string): string | undefined => text.trim().startsWith("/plan ") ? text.trim().slice(6).trim() : text.trim().startsWith("/") ? undefined : text.trim();

export function protectDriveDecision(guard: DriveProtection, decision: DriveDecision, screen: DriveObservation, discovering: boolean, scope?: string): string | undefined {
  const action = decision.action;
  if (action.kind === "next_task") {
    const intent = driveIntent(action.task), match = guard.tasks.find(task => similarIntent(task, intent));
    if (match) return `Proposed task revisits completed work: “${match.text}”. New proposal: “${intent.text}”.`;
  }
  if (action.kind === "compose" && workerText(action.text) !== undefined) {
    if (guard.used.workerRequests >= guard.limits.maxWorkerRequests) return `Mission worker-request limit reached (${guard.limits.maxWorkerRequests} reserved submissions).`;
    const intent = driveIntent(workerText(action.text)!);
    if (!discovering && guard.submissions.filter(prior => (!scope || prior.scope === scope) && similarIntent(prior, intent)).length >= 2) return `Repeated worker goal despite rewording or intervening tasks: “${intent.text}”. Two similar requests were already reserved.`;
  }
  // Match repeated navigation paths, not observation IDs, clocks or model notes.
  if (["key", "click", "scroll", "inspect", "wait"].includes(action.kind)) {
    const signature = fingerprint(JSON.stringify({ action: action.kind === "click" ? { kind: "click", label: screen.controls.find(item => item.id === action.target)?.label } : action,
      session: screen.sessionId, surface: screen.surface, scroll: screen.scrollRegions?.map(({ surface, offset }) => ({ surface, offset })) }));
    const trail = [...guard.navigation, signature].slice(-24); guard.navigation = trail;
    for (let period = 2; period <= 6; period++) {
      if (trail.length >= period * 3 && trail.slice(-period * 3).every((item, index, all) => index < period || item === all[index % period])) return `Navigation cycle repeated three times (${period} actions per cycle) without fresh evidence.`;
    }
  }
}
export function observeDriveProgress(guard: DriveProtection, rows: readonly string[]): boolean {
  let fresh = false;
  for (const row of rows) {
    const text = normalize(row.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "clock"));
    if (text.length < 24 || text.split(" ").length < 4 || /^(?:live|scrollback|thinking|controller|drive|step \d|session \d|context|tokens)\b/.test(text)) continue;
    const key = fingerprint(text);
    if (!guard.evidence.includes(key)) { guard.evidence.push(key); fresh = true; }
  }
  guard.evidence = guard.evidence.slice(-1024);
  if (fresh) { guard.stalledCycles = 0; guard.navigation = []; }
  return fresh;
}
export function driveResultRows(screen: DriveObservation): string[] {
  if (screen.answerRows?.length) return screen.answerRows;
  return ["diff", "log", "review", "output", "preview"].includes(screen.surface) ? screen.evidenceRows ?? screen.rows : [];
}
export function newTokenMeter(inputEstimate = 0, attempt = 1): DriveTokenMeter {
  return { inputEstimate, characters: 0, input: null, output: null, total: null, charged: 0, attempt };
}
export function chargeDriveTokens(guard: DriveProtection, meter: DriveTokenMeter, kind: "planningTokens" | "workerTokens", usage?: Partial<TokenUsage>, characters = 0): void {
  meter.characters += characters;
  if (usage) for (const [field, value] of [["input", usage.inputTokens], ["output", usage.outputTokens], ["total", usage.totalTokens]] as const) {
    if (count(value)) meter[field] = Math.max(meter[field] ?? 0, value);
  }
  const tokens = Math.max(meter.total ?? 0, (meter.input ?? meter.inputEstimate) + (meter.output ?? Math.ceil(meter.characters / 4)));
  // Usage receipts replace estimates; repeated/cumulative receipts do not add twice.
  guard.used[kind] = Math.max(0, guard.used[kind] + tokens - meter.charged); meter.charged = tokens;
}
