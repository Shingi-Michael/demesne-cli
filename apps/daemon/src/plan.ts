import { isRecord } from "@demesne/protocol";
import { toolError, type AgentTool } from "./tools.ts";

/// The plan checklist (pass 172): on a task of several steps the model lists
/// them once, then marks each one as it goes. The chat draws the latest list
/// as a ribbon at the top of the turn, so the person sees the checklist run.
/// It changes nothing and asks nothing.

export const UPDATE_PLAN = "update_plan";
export type PlanStatus = "pending" | "in_progress" | "completed";
export interface PlanStep { step: string; status: PlanStatus }

const STATUSES: readonly PlanStatus[] = ["pending", "in_progress", "completed"];
const MAX_STEPS = 20;
const STEP_MAX = 120;

/// The steps a call carries, cleaned: blank ones dropped, long ones cut, at most one in progress.
export function planSteps(input: unknown): PlanStep[] {
  if (!isRecord(input) || !Array.isArray(input.steps)) throw toolError("MISSING_STEPS", "update_plan needs steps", "pass the whole plan as steps: [{ step, status }]");
  const steps: PlanStep[] = [];
  for (const item of input.steps) {
    if (!isRecord(item) || typeof item.step !== "string") continue;
    const step = item.step.replace(/\s+/g, " ").trim().slice(0, STEP_MAX);
    if (!step) continue;
    const status = STATUSES.includes(item.status as PlanStatus) ? item.status as PlanStatus : "pending";
    steps.push({ step, status });
  }
  if (!steps.length) throw toolError("MISSING_STEPS", "the plan has no steps", "list the steps, each a few words");
  if (steps.length > MAX_STEPS) throw toolError("TOO_MANY_STEPS", `the plan has over ${MAX_STEPS} steps`, "group them into fewer, larger steps");
  // One step in progress at a time: later ones wait.
  let running = false;
  for (const step of steps) if (step.status === "in_progress") { if (running) step.status = "pending"; running = true; }
  return steps;
}

export function updatePlanTool(): AgentTool {
  return {
    definition: {
      name: UPDATE_PLAN,
      description: "Show the person a checklist of your plan for a task with 3 or more distinct steps. Call it once before starting, with every step (a few words each) and the first one in_progress; call it again with the whole list each time a step completes or the plan changes. Keep one step in_progress, mark finished ones completed. Skip it for quick or one-step asks.",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            minItems: 1,
            maxItems: MAX_STEPS,
            items: {
              type: "object",
              properties: {
                step: { type: "string", minLength: 1, maxLength: STEP_MAX },
                status: { type: "string", enum: [...STATUSES] },
              },
              required: ["step", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["steps"],
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input) {
      const steps = planSteps(input);
      const done = steps.filter((step) => step.status === "completed").length;
      return `Plan updated: ${done} of ${steps.length} done.`;
    },
  };
}
