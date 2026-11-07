import { expect, test } from "bun:test";
import type { ResearchState } from "../../../../packages/protocol/src/index.ts";
import { researchRowHTML } from "../research-row.ts";

const state = (over: Partial<ResearchState> = {}): ResearchState => ({
  topic: "local coding models", phase: "researching", pages: 14, judge: null, checks: [],
  lanes: [{ question: "which fit", agent: "claude", state: "done", pages: 7 }, { question: "how fast", agent: "codex", state: "running", pages: 7 }, { question: "memory", agent: null, state: "running", pages: 0 }],
  ...over,
});
const view = (research: ResearchState | undefined, tool: Record<string, unknown> = { state: "running" }, open = false) =>
  researchRowHTML({ research, tool: { input: { topic: "local coding models" }, ...tool } as never, open, key: "r:1", icon: "<i></i>", face: (agent, mood) => `<f data-a="${agent}" data-m="${mood}"></f>` });

test("one quiet line: faces, Researching and pages, a finished face greys out", () => {
  const html = view(state());
  expect(html).toContain("Researching");
  expect(html).toContain("14 pages");
  expect((html.match(/<f /g) ?? []).length).toBe(3);
  expect(html).toContain('ask-face rs-done"><f data-a="claude" data-m="calm">');
  expect(html).not.toContain("ask-lines");
});

test("the judge's part and the finished line", () => {
  expect(view(state({ phase: "judging" }))).toContain("Putting it together");
  const done = view(state({ phase: "done", pages: 35 }), { state: "done", durationMs: 220_000 });
  expect(done).toContain("Researched");
  expect(done).toContain("35 pages · 3m 40s");
});

test("opened: who took which question and the judge's check", () => {
  const html = view(state({ phase: "done", agree: 12, disagree: 2, checks: [{ claim: "x", agent: "codex", verdict: "confirmed" }] }), { state: "done" }, true);
  expect(html).toContain("Claude Code");
  expect(html).toContain("which fit");
  expect(html).toContain("Demesne");
  expect(html).toContain("12 claims agree · 2 disagree · confirmed by Codex");
});

test("before the first update and after a failure", () => {
  expect(view(undefined)).toContain("starting…");
  expect(view(undefined, { state: "failed" })).toContain("Research stopped");
});
