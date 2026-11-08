import { expect, test } from "bun:test";
import { researchArgs } from "../src/agent-cli.ts";
import { citedPages, opensPage, parseJudgment, parseResearchInput, runResearch, type ResearchDeps, type ResearchState } from "../src/research.ts";

const notes = (n: number) => Array.from({ length: n }, (_, i) => `- claim ${i} — https://example.com/${i} — "quote"`).join("\n");

function deps(over: Partial<ResearchDeps> = {}): ResearchDeps & { states: ResearchState[]; prompts: string[]; noted: [string, boolean][] } {
  const states: ResearchState[] = [], prompts: string[] = [], noted: [string, boolean][] = [];
  return {
    states, prompts, noted,
    agents: ["claude", "codex", "gemini"],
    signal: new AbortController().signal,
    runAgent: async (agent, prompt, _signal, step) => { prompts.push(`${agent}:${prompt.split("\n")[1]}`); step("Looked up https://a.example/x"); step("Searched local models"); return prompt.startsWith("You are checking") ? "CONFIRMED\nhttps://b.example" : notes(3); },
    runModel: async (prompt, _signal, step) => { prompts.push(`model:${prompt.split("\n")[1]}`); step("web fetch https://m.example"); return notes(2); },
    runJudge: async () => '{"agree": 7, "disagree": ["Scout speed: 25 vs 40 tok/s"], "recheck": [{"claim": "Qwen fits in 20 GB", "from": 1}]}',
    note: (agent, ok) => noted.push([agent, ok]),
    update: (state) => states.push(state),
    ...over,
  };
}

test("questions spread across the agents at once, then the judge and a recheck on another agent", async () => {
  const d = deps();
  const out = await runResearch({ topic: "local models", questions: ["which fit", "how fast", "memory"] }, d);
  expect(out.state.lanes.map((lane) => lane.agent)).toEqual(["claude", "codex", "gemini"]);
  expect(out.state.lanes.every((lane) => lane.state === "done" && lane.pages === 3)).toBe(true);
  expect(out.state.agree).toBe(7);
  expect(out.state.disagree).toBe(1);
  // Found by Claude Code (researcher 1), so checked by someone else.
  expect(out.state.checks).toEqual([{ claim: "Qwen fits in 20 GB", agent: "codex", verdict: "confirmed" }]);
  expect(out.state.phase).toBe("done");
  expect(d.states.map((state) => state.phase)).toContain("judging");
  expect(d.states.map((state) => state.phase)).toContain("checking");
  expect(out.text).toContain("Researched by Claude Code");
  expect(out.text).toContain("Scout speed");
  expect(out.text).toContain("foundry_save");
});

test("an agent that fails hands its question to the chat's model", async () => {
  const d = deps({ runAgent: async (agent, prompt) => { if (agent === "codex") throw new Error("usage limit reached"); return notes(4); } });
  const out = await runResearch({ topic: "t", questions: ["a", "b"] }, d);
  expect(out.state.lanes.map((lane) => lane.agent)).toEqual(["claude", null]);
  expect(out.state.lanes[1]!.pages).toBe(2);
  expect(d.noted).toContainEqual(["codex", false]);
  expect(out.text).toContain("a sub-agent on your model");
});

test("with no agent tools the chat's model does all of it", async () => {
  const d = deps({ agents: [], runJudge: async () => "not json" });
  const out = await runResearch({ topic: "t", questions: ["a", "b", "c"] }, d);
  expect(out.state.lanes.every((lane) => lane.agent === null && lane.state === "done")).toBe(true);
  expect(out.state.checks).toEqual([]);
  expect(d.prompts.every((prompt) => prompt.startsWith("model:"))).toBe(true);
});

test("every researcher failing says so instead of judging", async () => {
  const d = deps({ agents: [], runModel: async () => { throw new Error("offline"); } });
  const out = await runResearch({ topic: "t", questions: ["a", "b"] }, d);
  expect(out.state.lanes.every((lane) => lane.state === "failed")).toBe(true);
  expect(out.text).toContain("failed");
});

test("input, judgment and page counting", () => {
  expect(() => parseResearchInput({ topic: "t", questions: ["one"] })).toThrow();
  expect(parseResearchInput({ topic: " t ", questions: ["a", "a", "b"], judge: "codex" })).toEqual({ topic: "t", questions: ["a", "b"], judge: "codex" });
  expect(parseJudgment('Here: {"agree": 3, "disagree": [], "recheck": [{"claim": "x", "from": 9}]}', 2)).toEqual({ agree: 3, disagree: [], recheck: [{ claim: "x", from: 0 }] });
  expect(parseJudgment("nope", 2).agree).toBe(0);
  expect(opensPage("Looked up https://x.dev/a")).toBe(true);
  expect(opensPage("Searched https://x.dev")).toBe(false);
  expect(citedPages("a https://x.dev/1 b https://x.dev/1 c https://y.dev")).toBe(2);
});

test("research runs turn each tool's web search on, still read-only", () => {
  const claude = researchArgs("claude", "brief");
  expect(claude.slice(0, 3)).toEqual(["-p", "--allowedTools", "WebSearch,WebFetch"]);
  expect(claude).toContain("plan");
  const codex = researchArgs("codex", "brief");
  expect(codex).toContain("read-only");
  expect(codex).toContain('web_search="live"');
  expect(researchArgs("gemini", "brief")[1]).toContain("researcher");
});
