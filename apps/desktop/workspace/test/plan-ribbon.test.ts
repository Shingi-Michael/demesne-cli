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

test("while it runs: the step it is on, which step that is, and the line, with the list shut", () => {
  const html = planRibbonHTML(plan as never, { runId: "t1", live: true, open: false });
  expect(html).toStartWith('<div class="plan-ribbon"><div class="pr-card">');
  expect(html).toContain('<i class="d"><b></b></i><i class="n"><b></b></i><i class=""><b></b></i>');
  expect(html).toContain('<span class="pr-was" aria-hidden="true">Find it</span><span class="pr-name">Fix &lt;it&gt;</span>');
  expect(html).toContain('<span class="pr-ct">2 of 3</span>');
  expect(html).toContain('title="1 of 3 steps done"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('<div class="pr-fold" aria-hidden="true">');
});

test("between two steps it names the next one; with all done it says so", () => {
  const between = [{ step: "Find it", status: "completed" }, { step: "Fix it", status: "pending" }];
  const html = planRibbonHTML(between as never, { runId: "t1", live: true, open: false });
  expect(html).toContain('<span class="pr-was" aria-hidden="true"></span><span class="pr-name">Fix it</span>');
  expect(html).toContain('<span class="pr-ct">2 of 2</span>');
  expect(html).not.toContain('class="n"');
  const done = between.map((step) => ({ ...step, status: "completed" }));
  expect(planRibbonHTML(done as never, { runId: "t1", live: true, open: false })).toContain('<span class="pr-name">All steps done</span><');
});

test("open, it lists the steps inside the ribbon: ticked, current, still to do", () => {
  const html = planRibbonHTML(plan as never, { runId: "t1", live: true, open: true });
  expect(html).toStartWith('<div class="plan-ribbon open">');
  expect(html.match(/class="pr-row [dn]?"/g)).toEqual(['class="pr-row d"', 'class="pr-row n"', 'class="pr-row "']);
  expect(html).toContain('data-action="toggle-plan"');
  expect(html).toContain('<div class="pr-fold"><div class="pr-list" role="list">');
});

test("an ended turn is the same ribbon as a pill", () => {
  const done = plan.map((step) => ({ ...step, status: "completed" }));
  const pill = planRibbonHTML(done as never, { runId: "t1", live: false, open: false });
  expect(pill).toStartWith('<div class="plan-ribbon ended all">');
  expect(pill).toContain('<span class="pr-name">3 steps</span><');
  expect(pill).toContain('<span class="pr-ct"></span>');
  const part = planRibbonHTML(plan as never, { runId: "t1", live: false, open: true });
  expect(part).toStartWith('<div class="plan-ribbon ended open">');
  expect(part).toContain('<span class="pr-name">1 of 3 steps</span><');
  expect(part.match(/class="pr-row [dn]?"/g)).toEqual(['class="pr-row d"', 'class="pr-row "', 'class="pr-row "']);
  // Running or ended, the shape is the same, so the element on screen is kept.
  const shape = (html: string) => html.replace(/>[^<]+</g, "><").replace(/ (class|title|aria-[a-z]+|data-args)="[^"]*"/g, "");
  expect(shape(pill)).toBe(shape(planRibbonHTML(done as never, { runId: "t1", live: true, open: true })));
});
