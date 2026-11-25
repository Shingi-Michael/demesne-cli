import { expect, test } from "bun:test";
import { DESIGN_RULES } from "../src/design-guide.ts";
import { FLOW_MAX_SCREENS, flowProblem, PARTS_GUIDE } from "../src/foundry.ts";

// Piece 2 of pass 274, whole flows: the screens of one journey in a <d-flow>,
// each a place, with controls that lead from one to the next.

const flow = (inside: string) => `<!doctype html><html><body><d-flow>${inside}</d-flow></body></html>`;
const screen = (name: string, to?: string) => `<section data-view="${name}"><h1>${name}</h1>${to ? `<button data-go="${to}">Continue</button>` : ""}</section>`;

test("a flow is two to twelve screens, each named once, and everything in it leads to a screen that exists", () => {
  expect(flowProblem("<main><h1>One page</h1></main>")).toBeNull();
  expect(flowProblem(flow(screen("Find a time", "Your details") + screen("Your details", "Confirm") + screen("Confirm", "find a time")))).toBeNull();
  expect(flowProblem(flow(screen("Find a time", "Your details")))).toContain("at least two screens, and this has 1");
  expect(flowProblem(flow(Array.from({ length: FLOW_MAX_SCREENS + 1 }, (_, at) => screen(`S${at}`, "S0")).join("")))).toContain(`up to ${FLOW_MAX_SCREENS} screens, not ${FLOW_MAX_SCREENS + 1}`);
  expect(flowProblem(flow(screen("Confirm", "Booked") + screen("confirm") + screen("Booked")))).toContain('Two screens of the flow are called "Confirm"');
  expect(flowProblem(flow(screen("Find a time", "Pay") + screen("Confirm")))).toContain('goes to "Pay", which is not a screen. Hint: its screens are Find a time, Confirm');
  expect(flowProblem(flow(screen("Find a time") + screen("Confirm")))).toContain("Nothing in the flow leads anywhere");
  expect(flowProblem("<d-flow><section data-view='A'></section>")).toContain("not closed");
});

test("the model is told about flows: one line in the rules, the part in the catalogue", () => {
  expect(DESIGN_RULES.some((rule) => rule.includes("Several screens are one page, in <d-flow> (kit:parts)"))).toBe(true);
  expect(PARTS_GUIDE).toContain('<d-flow><section data-view="Find a time">');
});
