import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@demesne/config";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { EventEnvelope } from "@demesne/protocol";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";
import { AGY_LOOK_COMMANDS, parseAgentLine, subagentArgs, subagentBrief, subagentStep } from "../src/agent-cli.ts";
import { grounded, jobKind, pickAgent, RouteBook } from "../src/subagent-route.ts";
import { parseSubagentInput, subagentDefinition } from "../src/subagent.ts";
import { agentSystemPrompt, delegateGuidance } from "../src/engine.ts";
import { claudeRun, fakeProcess } from "./agent-cli-fakes.ts";

test("a job's kind comes from its label and brief", () => {
  expect(jobKind("Find what redraws the pane", "Where is the pane drawn?")).toBe("find");
  expect(jobKind("Trace a chat switch end to end", "")).toBe("trace");
  expect(jobKind("Check recent changes", "Look at the diff")).toBe("review");
  expect(jobKind("Read every Foundry file", "Survey the whole folder")).toBe("read");
});

test("Auto picks by kind, skips tools that aren't here or are resting, then learns from the record", () => {
  const empty = { jobs: {}, restUntil: {} };
  expect(pickAgent("find", ["claude", "codex", "gemini"], empty)?.agent).toBe("claude");
  expect(pickAgent("trace", ["claude", "codex"], empty)?.agent).toBe("codex");
  expect(pickAgent("read", ["claude", "codex"], empty)?.agent).toBe("claude");
  expect(pickAgent("find", [], empty)).toBeNull();
  expect(pickAgent("find", ["claude", "codex"], { jobs: {}, restUntil: { claude: Date.now() + 60_000 } })?.agent).toBe("codex");
  const record = { jobs: { claude: { find: { ok: 2, failed: 4 } }, codex: { find: { ok: 9, failed: 1 } } }, restUntil: {} };
  const pick = pickAgent("find", ["claude", "codex"], record)!;
  expect(pick.agent).toBe("codex");
  expect(pick.why).toContain("9 of 10 good reports on this machine");
});

test("the record notes jobs and rests a tool that ran out of room", () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-route-"));
  try {
    const book = new RouteBook(join(root, "route.json"));
    book.note("codex", "find", true);
    book.note("codex", "find", false, "Usage limit reached, try again later");
    const record = book.read();
    expect(record.jobs.codex?.find).toEqual({ ok: 1, failed: 1 });
    expect(record.restUntil.codex).toBeGreaterThan(Date.now());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI sub-agents run read-only, and their steps read in the window's verbs", () => {
  expect(subagentArgs("claude", "brief")).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan", "brief"]);
  expect(subagentArgs("codex", "brief")).toContain("read-only");
  expect(subagentArgs("codex", "brief")).not.toContain("workspace-write");
  const agy = subagentArgs("gemini", "brief", {}, "/w");
  expect(agy).not.toContain("accept-edits");
  // agy 1.5.2 starts with `ls -la`: a denied look ends the run with no answer.
  expect(agy).toContain(JSON.stringify({ permissions: { allow: ["read_file(/w)", ...AGY_LOOK_COMMANDS] } }));
  expect(AGY_LOOK_COMMANDS).toContain("command(ls)");
  expect(AGY_LOOK_COMMANDS.some((rule) => /\b(find|sed|tee|rm|mv|touch)\b/.test(rule))).toBe(false);
  expect(subagentStep("Read src/a.ts")).toBe("read src/a.ts");
  expect(subagentStep("Searched pane")).toBe("search pane");
  expect(subagentStep("Ran git log")).toBe("Ran git log");
});

const isModelSubagent = (messages: ProviderMessage[]) => typeof messages[0]?.content === "string" && messages[0].content.startsWith("You are a Demesne sub-agent");
const results = (messages: ProviderMessage[]) => messages.filter((message) => message.role === "tool").map((message) => String(message.content));

async function turn(options: { agent?: AgentConfig; spawn: (argv: string[]) => ReturnType<typeof fakeProcess> }) {
  const root = mkdtempSync(join(tmpdir(), "demesne-cli-subagent-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace); mkdirSync(join(root, "data"));
  writeFileSync(join(workspace, "notes.txt"), "The pane lives in pane.ts.\n");
  writeFileSync(join(workspace, "pane.ts"), "export const pane = 1;\n");
  const spawned: string[][] = [], parent: ProviderMessage[][] = [];
  let modelSubagents = 0;
  const processor: TurnProcessor = { providerId: "test", modelId: "test", contextCapacity: 262144, maxOutputTokens: 1024,
    async listModels() { return []; },
    async *stream(messages): AsyncGenerator<ProviderStreamEvent> {
      if (isModelSubagent(messages)) { modelSubagents++; yield { type: "text_delta", delta: "Model report: pane.ts" }; yield { type: "finish", reason: "stop" }; return; }
      parent.push(structuredClone(messages));
      if (!results(messages).length) {
        yield { type: "tool_call_delta", index: 0, idDelta: "d1", nameDelta: "subagent", argumentsDelta: JSON.stringify({ description: "Find the pane", prompt: "Where is the pane drawn?" }) };
        yield { type: "finish", reason: "tool_calls" }; return;
      }
      yield { type: "text_delta", delta: "Done." }; yield { type: "finish", reason: "stop" };
    } };
  const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), processor, agent: options.agent,
    agentCli: { which: (command) => command === "claude" ? "/fake/claude" : null, home: root, spawn: (argv) => { spawned.push(argv); return options.spawn(argv); } } });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  try {
    const { session } = await client.createSession({ title: "CLI sub-agents", workspacePath: workspace, trustWorkspace: true });
    const submitted = await client.submitTurn(session.id, { content: "Why does the pane flash?" });
    const events: EventEnvelope[] = [];
    for await (const event of client.streamEvents(session.id, submitted.eventId, AbortSignal.timeout(5000))) {
      if (event.turnId !== submitted.turn.id) continue;
      events.push(event);
      if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) break;
    }
    let route = "";
    try { route = readFileSync(join(root, "data", "subagent-route.json"), "utf8"); } catch { /* none */ }
    return { events, spawned, parent, modelSubagents, route };
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}

test("Auto runs a sub-agent on Claude Code, read-only, and its report returns to the turn", async () => {
  const { events, spawned, parent, modelSubagents, route } = await turn({ spawn: () => fakeProcess(claudeRun("s1", "The pane is drawn in pane.ts:4.")) });
  expect(events.at(-1)?.type).toBe("turn.completed");
  expect(modelSubagents).toBe(0);
  expect(spawned[0]).toContain("plan");
  expect(spawned[0]!.at(-1)).toContain("Where is the pane drawn?");
  const progress = events.filter((event) => event.type === "tool.call_progress").map((event) => event.payload);
  expect(progress[0]).toMatchObject({ text: "agent:claude · starting" });
  expect(String(progress[0]?.why)).toContain("Claude Code: finding code");
  expect(progress.map((payload) => payload.text)).toContain("agent:claude · read /w/src/a.ts");
  expect(progress.some((payload) => payload.report === "The pane is drawn in pane.ts:4.")).toBe(true);
  expect(results(parent.at(-1)!)[0]).toContain("The pane is drawn in pane.ts:4.");
  expect(JSON.parse(route).jobs.claude.find).toEqual({ ok: 1, failed: 0 });
});

test("when the agent tool fails, Auto hands the job to the chat's own model", async () => {
  const { events, modelSubagents, parent, route } = await turn({ spawn: () => fakeProcess([], 1, "rate limit exceeded") });
  expect(events.at(-1)?.type).toBe("turn.completed");
  expect(modelSubagents).toBe(1);
  expect(results(parent.at(-1)!)[0]).toContain("Model report: pane.ts");
  expect(JSON.parse(route).restUntil.claude).toBeGreaterThan(Date.now());
});

test("subagent_model \"same\" keeps sub-agents on the chat's model", async () => {
  const { spawned, modelSubagents } = await turn({ agent: { subagentModel: "same" } as AgentConfig, spawn: () => fakeProcess(claudeRun("s1", "x")) });
  expect(spawned).toEqual([]);
  expect(modelSubagents).toBe(1);
});

test("the main model can name the job's kind; anything else is ignored", () => {
  expect(parseSubagentInput({ description: "Look at the pane", prompt: "x", kind: "trace" }).kind).toBe("trace");
  expect(parseSubagentInput({ description: "Look at the pane", prompt: "x", kind: "dance" }).kind).toBeUndefined();
  expect(parseSubagentInput({ description: "Look at the pane", prompt: "x" }).kind).toBeUndefined();
});

test("a report is good only when it points at files that are really in the project", () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-grounded-"));
  try {
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "src", "deep", "live.ts"), "x");
    expect(grounded("It is in src/deep/live.ts:12.", root)).toBe(true);
    expect(grounded("See `live.ts` line 4", root)).toBe(true);
    expect(grounded(`Found it at ${join(root, "src/deep/live.ts")}`, root)).toBe(true);
    expect(grounded("It is in src/missing.ts:3 and app.config.json", root)).toBe(false);
    expect(grounded("I could not find where the pane is drawn.", root)).toBe(false);
    expect(grounded("Outside: /etc/hosts.txt", root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a report with no real files counts against the tool Auto picked", async () => {
  const { route } = await turn({ spawn: () => fakeProcess(claudeRun("s1", "I looked around but could not find it.")) });
  expect(JSON.parse(route).jobs.claude.find).toEqual({ ok: 0, failed: 1 });
});

test("Antigravity as a sub-agent is told to use only its read tools, and a denial with no answer is a failure", () => {
  expect(subagentBrief("Where is the pane?", "/w", "gemini")).toStartWith("You are a read-only helper");
  expect(subagentBrief("Where is the pane?", "/w", "gemini")).toContain("Run no other shell commands");
  expect(subagentBrief("Where is the pane?", "/w", "claude")).not.toContain("list_dir");
  const denied = JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "", num_turns: 1, denied_actions: [{ action: "command", display_name: "RunCommand" }] } });
  expect(parseAgentLine("gemini", denied, "/w", { words: {} })).toEqual([{ error: "Antigravity stopped: it wasn't allowed to RunCommand" }]);
  const answered = JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "In pane.ts.", denied_actions: [{ action: "command", display_name: "RunCommand" }] } });
  expect(parseAgentLine("gemini", answered, "/w", { words: {} })).toEqual([{ answer: "In pane.ts." }]);
});

test("the chat is told when to send sub-agents, by how often you set", () => {
  expect(delegateGuidance({ often: "less", onAgents: true })).toBeNull();
  const usual = delegateGuidance({ often: "usual", onAgents: true })!;
  expect(usual).toContain("more than about four files");
  expect(usual).toContain("own Claude Code, Codex or Gemini");
  expect(delegateGuidance({ often: "usual", onAgents: false })).not.toContain("Codex");
  expect(delegateGuidance({ often: "more", onAgents: false })).toContain("one or two files");
  const prompt = (often: "less" | "usual" | "more", definitions = [subagentDefinition]) => agentSystemPrompt({ workspaceRoot: "/w", definitions, delegate: { often, onAgents: true } });
  expect(prompt("usual")).toContain("send sub-agents for that lookup");
  expect(prompt("less")).not.toContain("send sub-agents for that lookup");
  expect(prompt("usual", [])).not.toContain("send sub-agents for that lookup");
});

test("how often is read, set and saved through the sub-agent endpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-often-"));
  const saved: string[] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "test", contextCapacity: 262144, maxOutputTokens: 1024, async listModels() { return []; }, async *stream() { yield { type: "finish", reason: "stop" }; } };
  const app = createDaemonApp({ databasePath: join(root, "state.sqlite"), processor, saveSubagentOften: (often) => { saved.push(often); } });
  try {
    const call = async (init?: RequestInit) => (await app.fetch(new Request("http://localhost/v1/subagent-model", init))).json() as Promise<Record<string, unknown>>;
    expect((await call()).often).toBe("usual");
    expect(await call({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ often: "more" }) })).toMatchObject({ often: "more", saved: true });
    expect((await call()).often).toBe("more");
    expect(saved).toEqual(["more"]);
    expect((await app.fetch(new Request("http://localhost/v1/subagent-model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ often: "always" }) }))).status).toBe(400);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
