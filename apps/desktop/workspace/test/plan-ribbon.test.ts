import { expect, test } from "bun:test";
import { planOf, planRibbonHTML } from "../plan-ribbon.ts";

const call = (steps: unknown, extra: Record<string, unknown> = {}) => ({ name: "update_plan", input: { steps }, state: "done", ...extra });
const plan = [{ step: "Find it", status: "completed" }, { step: "Fix <it>", status: "in_progress" }, { step: "Test it", status: "pending" }];

test("the plan is the newest update_plan call that reads cleanly", () => {
  expect(planOf([])).toBeNull();
  expect(planOf([call([{ step: "Old", status: "pending" }]), { name: "read_file", input: {} }, call(plan), call([{ step: "Half", status: "pend" }], { drafting: true })]))
    .toEqual(plan as never);
  expect(planOf([call(plan), call([], { state: "done" })])).toEqual(plan as never);
  expect(planOf([call([{ step: "A", status: "weird" }])])).toEqual([{ step: "A", status: "pending" }]);
});

test("while it runs: segments, the step it is on, and Checklist 1/3 closed", () => {
  const html = planRibbonHTML(plan as never, { runId: "t1", live: true, open: false });
  expect(html).toContain('<i class="d"></i><i class="n"></i><i class=""></i>');
  expect(html).toContain('<span class="pr-cur">Fix &lt;it&gt;</span>');
  expect(html).toContain('<span class="pr-ct">1/3</span>');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("pr-list");
});

test("open, it lists the steps: ticked, current, still to do", () => {
  const html = planRibbonHTML(plan as never, { runId: "t1", live: true, open: true });
  expect(html.match(/class="pr-row [dn]?"/g)).toEqual(['class="pr-row d"', 'class="pr-row n"', 'class="pr-row "']);
  expect(html).toContain('data-action="toggle-plan"');
});

test("an ended turn folds to a pill", () => {
  const done = plan.map((step) => ({ ...step, status: "completed" }));
  expect(planRibbonHTML(done as never, { runId: "t1", live: false, open: false })).toContain("<b>3 steps</b>");
  expect(planRibbonHTML(plan as never, { runId: "t1", live: false, open: false })).toContain("<b>1 of 3 steps</b>");
});
