import { expect, test } from "bun:test";
import { crewRowHTML, type CrewMember } from "../crew-row.ts";

const member = (over: Partial<CrewMember>): CrewMember => ({ runId: "r", id: 1, agent: null, task: "Look around", state: "running", steps: 2, ...over });
const view = (members: CrewMember[], open = false, newest?: string) => crewRowHTML({ members, key: "r:1", open, newest, phrase: { slot: 0, model: "m", text: "Sniffing the lockfile" },
  face: (agent, mood) => `<f data-a="${agent}" data-m="${mood}"></f>` });

test("a round is one line: faces, how many are working, the saying and the newest step", () => {
  const html = view([member({ agent: "claude" }), member({ id: 2, agent: "codex", state: "done" }), member({ id: 3 })], false, "Read live.ts");
  expect(html).toContain("3 agents working");
  expect(html).toContain("Sniffing the lockfile");
  expect(html).toContain("Read live.ts");
  expect(html).toContain("1 of 3 done");
  expect(html).toContain('rs-done"><f data-a="codex" data-m="calm">');
  expect(html).not.toContain("crew-lines");
});

test("one sub-agent on your model is named Agent and finds it", () => {
  const html = view([member({ state: "done", steps: 1, durationMs: 4200, found: "It lives in hello.ts" })]);
  expect(html).toContain("Agent found it");
  expect(html).toContain("1 step · 4s");
  expect(html).not.toContain("data-subagent-phrase");
});

test("opened: a line each with its task, steps and first line found; a line opens its own steps", () => {
  const html = view([member({ agent: "claude", state: "done", steps: 5, found: "paneHead() rebuilds\\nthe pane" }), member({ id: 2, state: "failed", found: "offline" }), member({ id: 3, open: true, fold: '<div class="agent-steps">x</div>' })], true);
  expect(html).toContain("Look around");
  expect(html).toContain("5 steps");
  expect(html).toContain('data-action="step"');
  expect(html).toContain("crew-said");
  expect(html).toContain("failed");
  expect(html).toContain('<div class="agent-steps">x</div>');
});

test("all stopped", () => {
  expect(view([member({ state: "failed" }), member({ id: 2, state: "stopped" })])).toContain("2 agents stopped");
});
