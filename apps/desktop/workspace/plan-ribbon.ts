/// The plan checklist (pass 172): the model's update_plan steps drawn as a
/// ribbon at the top of the turn. Segments fill in green, the step it is on
/// is named, and "Checklist 2/6 ▾" opens a plain list of the steps. When the
/// turn ends it folds into a small pill that opens the same list.

export type PlanStatus = "pending" | "in_progress" | "completed";
export interface PlanStep { step: string; status: PlanStatus }

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

interface PlanCall { name: string; input: Record<string, unknown>; state?: string; drafting?: boolean }

export const UPDATE_PLAN = "update_plan";

/// The plan as the model last set it: the newest update_plan call whose steps read cleanly.
export function planOf(calls: readonly PlanCall[]): PlanStep[] | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!;
    if (call.name !== UPDATE_PLAN || call.drafting || call.state === "failed" || call.state === "denied") continue;
    const steps = Array.isArray(call.input.steps) ? call.input.steps : [];
    const plan: PlanStep[] = [];
    for (const item of steps) {
      if (!item || typeof item !== "object") continue;
      const { step, status } = item as Record<string, unknown>;
      if (typeof step !== "string" || !step.trim()) continue;
      plan.push({ step: step.replace(/\s+/g, " ").trim(), status: status === "completed" || status === "in_progress" ? status : "pending" });
    }
    if (plan.length) return plan;
  }
  return null;
}

const ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="4" height="4" rx="1"/><path d="M8.5 4.5H14M8.5 11.5H14"/><rect x="2" y="9.5" width="4" height="4" rx="1"/></svg>';

/// The ribbon (while the turn runs) or the pill (once it ended), with the list when open.
export function planRibbonHTML(plan: readonly PlanStep[], options: { runId: string; live: boolean; open: boolean }): string {
  const done = plan.filter((step) => step.status === "completed").length, total = plan.length;
  const current = options.live ? plan.findIndex((step) => step.status === "in_progress") : -1;
  const args = h(JSON.stringify({ id: options.runId }));
  const list = options.open
    ? `<div class="pr-list" role="list">${plan.map((step, i) => {
      const kind = step.status === "completed" ? "d" : i === current ? "n" : "";
      return `<div class="pr-row ${kind}" role="listitem"><span class="pr-bx" aria-hidden="true">${kind === "d" ? "✓" : ""}</span><span class="pr-lab">${h(step.step)}</span></div>`;
    }).join("")}</div>`
    : "";
  if (!options.live) {
    const all = done === total;
    return `<div class="plan-ribbon ended${options.open ? " open" : ""}"><button type="button" class="pr-pill" data-action="toggle-plan" data-args="${args}" aria-expanded="${options.open}">${all ? '<span class="pr-ok" aria-hidden="true">✓</span>' : ""}<b>${all ? `${total} step${total === 1 ? "" : "s"}` : `${done} of ${total} steps`}</b><span class="pr-ar">Checklist ▾</span></button>${list}</div>`;
  }
  const segs = plan.map((step, i) => `<i class="${step.status === "completed" ? "d" : i === current ? "n" : ""}"></i>`).join("");
  const name = current >= 0 ? plan[current]!.step : done === total ? "All steps done" : "";
  return `<div class="plan-ribbon${options.open ? " open" : ""}"><div class="pr-bar"><span class="pr-segs" aria-hidden="true">${segs}</span><span class="pr-cur">${h(name)}</span><button type="button" class="pr-ck" data-action="toggle-plan" data-args="${args}" aria-expanded="${options.open}" title="${h(`${done} of ${total} steps done`)}">${ICON}<span class="pr-lt">Checklist</span> <span class="pr-ct">${done}/${total}</span><span class="pr-ar">▾</span></button></div>${list}</div>`;
}
