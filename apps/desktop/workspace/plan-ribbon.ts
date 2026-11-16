/// The plan checklist (pass 226 A): the model's update_plan steps drawn as a
/// soft glass ribbon at the top of the turn. It holds the name of the step it
/// is on, which step that is ("2 of 5"), and a fine line under them that
/// fills in green one step at a time. Clicking the ribbon unfolds a plain list
/// of the steps inside it. When the turn ends the same ribbon shrinks into a
/// small pill ("5 steps") that opens the same list.

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

/// The ribbon (while the turn runs) or the pill (once it ended). Both have the
/// same shape, so the element on screen can be kept and moved from one to the
/// other; the list is always there and folds shut when not open.
export function planRibbonHTML(plan: readonly PlanStep[], options: { runId: string; live: boolean; open: boolean }): string {
  const done = plan.filter((step) => step.status === "completed").length, total = plan.length, all = done === total;
  const current = options.live ? plan.findIndex((step) => step.status === "in_progress") : -1;
  // Between two steps nothing is in progress: the ribbon names the next one.
  const at = current >= 0 ? current : all ? total - 1 : plan.findIndex((step) => step.status !== "completed");
  const name = !options.live ? (all ? `${total} step${total === 1 ? "" : "s"}` : `${done} of ${total} steps`)
    : current < 0 && all ? "All steps done" : plan[at]!.step;
  // The step before it, for the roll when the name changes.
  const was = options.live && current > 0 ? plan[current - 1]!.step : "";
  // Each part of the line holds its light as an element of its own.
  const segs = plan.map((step, i) => `<i class="${step.status === "completed" ? "d" : i === current ? "n" : ""}"><b></b></i>`).join("");
  const rows = plan.map((step, i) => {
    const kind = step.status === "completed" ? "d" : i === current ? "n" : "";
    return `<div class="pr-row ${kind}" role="listitem"><span class="pr-bx" aria-hidden="true"></span><span class="pr-lab">${h(step.step)}</span></div>`;
  }).join("");
  const state = `${options.live ? "" : " ended"}${all ? " all" : ""}${options.open ? " open" : ""}`;
  return `<div class="plan-ribbon${state}"><div class="pr-card">`
    + `<button type="button" class="pr-bar" data-action="toggle-plan" data-args="${h(JSON.stringify({ id: options.runId }))}" aria-expanded="${options.open}" title="${h(`${done} of ${total} steps done`)}">`
    + `<span class="pr-ok" aria-hidden="true"></span>`
    + `<span class="pr-cur"><span class="pr-was" aria-hidden="true">${h(was)}</span><span class="pr-name">${h(name)}</span></span>`
    + `<span class="pr-ct">${options.live ? `${at + 1} of ${total}` : ""}</span>`
    + `<span class="pr-segs" aria-hidden="true">${segs}</span>`
    + `</button>`
    + `<div class="pr-fold"${options.open ? "" : ' aria-hidden="true"'}><div class="pr-list" role="list">${rows}</div></div>`
    + `</div></div>`;
}

/// What the ribbon on screen looks like before a redraw changes it.
export interface PlanLook { name: string; ended: boolean; width: number; height: number }
export function planLook(ribbon: Element): PlanLook {
  const card = ribbon.querySelector(".pr-card")?.getBoundingClientRect();
  return { name: ribbon.querySelector(".pr-name")?.textContent ?? "", ended: ribbon.classList.contains("ended"), width: card?.width ?? 0, height: card?.height ?? 0 };
}

const EASE = "cubic-bezier(0.2, 0.7, 0.2, 1)";

/// After a redraw brought the same ribbon to its new look: the step's name
/// rolls up once when the step changed, and the ribbon changes size smoothly
/// when it becomes the pill or the pill opens. These run on the kept
/// elements, so later redraws don't cut them short.
export function planMoved(ribbon: Element, before: PlanLook, still = matchMedia("(prefers-reduced-motion: reduce)").matches) {
  if (still) return;
  const ended = ribbon.classList.contains("ended"), card = ribbon.querySelector<HTMLElement>(".pr-card");
  const name = ribbon.querySelector<HTMLElement>(".pr-name"), was = ribbon.querySelector<HTMLElement>(".pr-was");
  if (!ended && !before.ended && name && was && before.name && name.textContent !== before.name && was.textContent) {
    const roll = { duration: 520, easing: EASE };
    was.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: "translateY(-100%)", opacity: 0 }], roll);
    name.animate([{ transform: "translateY(100%)" }, { transform: "translateY(0)" }], roll);
  }
  if (!card || (!ended && !before.ended)) return;
  const now = card.getBoundingClientRect(), turned = ended !== before.ended;
  // Opening the pill's list moves its height by itself; only the width jumps.
  const from: Keyframe = { width: `${before.width}px` }, to: Keyframe = { width: `${now.width}px` };
  if (turned) { from.height = `${before.height}px`; to.height = `${now.height}px`; }
  // The tick pops in once, as the ribbon becomes the pill (never on old turns).
  if (turned && ended) ribbon.querySelector(".pr-ok")?.animate([{ transform: "scale(0.4)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 420, easing: EASE });
  if (Math.abs(now.width - before.width) > 1 || (turned && Math.abs(now.height - before.height) > 1)) card.animate([from, to], { duration: 520, easing: EASE });
}
