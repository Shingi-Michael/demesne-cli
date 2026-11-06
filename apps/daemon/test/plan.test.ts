import { expect, test } from "bun:test";
import { planSteps, updatePlanTool } from "../src/plan.ts";

const run = (input: unknown) => updatePlanTool().execute(input, { workspaceRoot: "", signal: new AbortController().signal });

test("update_plan reports how far the plan is", async () => {
  expect(await run({ steps: [{ step: "Find it", status: "completed" }, { step: "Fix it", status: "in_progress" }, { step: "Test it", status: "pending" }] }))
    .toBe("Plan updated: 1 of 3 done.");
  expect(updatePlanTool().permission({})).toBeNull();
});

test("plan steps are cleaned: blanks dropped, one in progress, unknown status pending", () => {
  expect(planSteps({ steps: [
    { step: "  Find   it ", status: "in_progress" },
    { step: "", status: "pending" },
    { step: "Fix it", status: "in_progress" },
    { step: "Test it", status: "maybe" },
  ] })).toEqual([
    { step: "Find it", status: "in_progress" },
    { step: "Fix it", status: "pending" },
    { step: "Test it", status: "pending" },
  ]);
});

test("a plan needs steps, and not too many", async () => {
  await expect(run({})).rejects.toThrow("MISSING_STEPS");
  await expect(run({ steps: [{ step: " ", status: "pending" }] })).rejects.toThrow("MISSING_STEPS");
  await expect(run({ steps: Array.from({ length: 21 }, (_, i) => ({ step: `Step ${i}`, status: "pending" })) })).rejects.toThrow("TOO_MANY_STEPS");
});
