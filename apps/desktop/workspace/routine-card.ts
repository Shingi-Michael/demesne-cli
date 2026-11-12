/// Routines a chat made (the routine tool): one quiet card on the right with
/// each routine's when and what, as the chat last left it. The Scheduled page
/// is where they're changed by hand; the card links there.

export const ROUTINE_TOOL = "routine";
export const ROUTINES_CARD = "routines";

/// The step row's verb for each action.
export const ROUTINE_VERBS: Record<string, string> = { add: "Made a routine", list: "Looked at routines", pause: "Paused a routine", resume: "Resumed a routine", remove: "Removed a routine" };

export interface ChatRoutine { id: string; when: string; prompt: string; on: boolean }

interface RoutineStep { name: string; state: string; input: Record<string, unknown>; message?: string }
interface RoutineRun { entries: readonly { type: string }[] }

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

function resultOf(step: RoutineStep): Record<string, unknown> | null {
  if (step.name !== ROUTINE_TOOL || step.state !== "done" || !step.message) return null;
  try { const value = JSON.parse(step.message) as unknown; return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}

/// A step's target: the routine's when and what.
export function routineTarget(step: RoutineStep): string {
  const result = resultOf(step);
  if (result && typeof result.when === "string") return `${result.when}, ${String(result.prompt ?? "")}`;
  return step.input.action === "add" && typeof step.input.text === "string" ? step.input.text : "";
}

/// The routines this chat made or changed, oldest first, as it last left them.
export function chatRoutines(runs: readonly RoutineRun[]): ChatRoutine[] {
  const seen = new Map<string, ChatRoutine | null>();
  for (const run of runs) for (const entry of run.entries) {
    if (entry.type !== "tool") continue;
    const result = resultOf(entry as unknown as RoutineStep);
    if (!result || typeof result.routine !== "string" || typeof result.id !== "string") continue;
    if (result.routine === "removed") { seen.set(result.id, null); continue; }
    seen.set(result.id, { id: result.id, when: String(result.when ?? ""), prompt: String(result.prompt ?? ""), on: result.on !== false });
  }
  return [...seen.values()].filter((routine): routine is ChatRoutine => routine !== null);
}

const ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2.5"/></svg>';

/// One routine: its when in the head and its what under it; more fold open.
export function routinesCardHTML(routines: readonly ChatRoutine[], open: boolean): string {
  if (!routines.length) return "";
  const one = routines.length === 1 ? routines[0]! : null;
  const line = one ? `Routine · ${h(one.when)}` : `${routines.length} routines`;
  const sum = routines.some((routine) => !routine.on) ? `<span class="card-right">${routines.every((routine) => !routine.on) ? "paused" : `${routines.filter((routine) => !routine.on).length} paused`}</span>` : "";
  const rows = routines.map((routine) => `<div class="card-row rt-row${routine.on ? "" : " off"}" title="${h(routine.prompt)}"><span class="card-label">${one ? "" : `<em>${h(routine.when)} · </em>`}${h(routine.prompt)}</span>${routine.on ? "" : '<span class="card-right">paused</span>'}</div>`).join("");
  const foot = `<div class="card-foot"><span>Runs in a new chat</span><button type="button" class="link" data-action="page-open" data-args='{"page":"scheduled"}'>Scheduled</button></div>`;
  return `<section class="card${open ? " open" : ""}" data-card="${ROUTINES_CARD}"><button type="button" class="card-head" data-action="card-fold" data-args='{"name":"${ROUTINES_CARD}"}' aria-expanded="${open}">${ICON}<span class="card-line">${line}</span><span class="card-sum">${sum}</span></button><div class="card-body">${rows}${foot}</div></section>`;
}
