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
import { subagentArgs, subagentStep } from "../src/agent-cli.ts";
import { jobKind, pickAgent, RouteBook } from "../src/subagent-route.ts";
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
  expect(pick.why).toContain("9 of 10 finished on this machine");
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
  expect(agy).toContain(JSON.stringify({ permissions: { allow: ["read_file(/w)"] } }));
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
