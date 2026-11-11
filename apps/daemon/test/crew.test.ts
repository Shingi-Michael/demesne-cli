import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { EventEnvelope } from "@demesne/protocol";
import type { ProviderMessage, ProviderStreamEvent } from "@demesne/providers";
import { createDaemonApp } from "../src/app.ts";
import { Crew, type CrewMark, parseAgentsInput } from "../src/crew.ts";
import type { TurnProcessor } from "../src/processor.ts";

function crewFixture() {
  const marks: [string, CrewMark][] = [], settled: [string, string, string][] = [];
  const turn = new AbortController();
  const crew = new Crew({ signal: turn.signal, mark: (id, mark) => marks.push([id, mark]), settle: (id, outcome, text) => settled.push([id, outcome, text]) });
  return { crew, marks, settled, turn };
}
/// A job that answers when told to, and remembers what it was asked.
function job() {
  const prompts: string[] = [];
  let answer: ((text: string) => void) | null = null, signal: AbortSignal | null = null;
  return {
    prompts, get signal() { return signal; },
    run: (prompt: string, given: AbortSignal) => { prompts.push(prompt); signal = given; return new Promise<string>((resolve, reject) => {
      answer = resolve; given.addEventListener("abort", () => reject(given.reason), { once: true });
    }); },
    answer: async (text: string) => { answer!(text); await Bun.sleep(1); },
  };
}

test("background agents: start at once, wait for a report, ask a follow-up, stop one", async () => {
  const { crew, marks, settled } = crewFixture();
  const codex = job(), claude = job();
  expect(crew.start("t1", "Trace the checkout API", "Trace POST /checkout", codex.run)).toBe("a1");
  expect(crew.start("t2", "Profile the checkout page", "Profile /checkout", claude.run)).toBe("a2");
  expect(crew.working).toBe(2);

  const waiting = crew.run({ action: "wait", seconds: 5 }, new AbortController().signal);
  await codex.answer("One query takes 1.8 s: orders by user_id.");
  const first = await waiting;
  expect(first).toContain("[Agent a1 · Trace the checkout API reported]\nOne query takes 1.8 s");
  expect(first).toContain("Still working: a2.");
  expect(marks).toContainEqual(["t1", { crew: "reported" }]);

  // A follow-up starts it again with what it already found.
  expect(await crew.run({ action: "message", id: "a1", message: "Does orders.user_id have an index?" }, new AbortController().signal)).toStartWith("Asked a1");
  expect(codex.prompts[1]).toContain("You already reported this:\nOne query takes 1.8 s");
  expect(codex.prompts[1]).toContain("Follow-up from the main agent: Does orders.user_id have an index?");
  expect(marks).toContainEqual(["t1", { asked: "Does orders.user_id have an index?" }]);

  // The chat has what it needs: it stops the other one.
  expect(await crew.run({ action: "stop", id: "a2" }, new AbortController().signal)).toBe("Stopped a2.");
  expect(claude.signal?.aborted).toBe(true);
  expect(marks).toContainEqual(["t2", { crew: "stopped" }]);

  await codex.answer("No index on orders.user_id.");
  expect(crew.hasUnread()).toBe(true);
  expect(crew.take()).toContain("No index on orders.user_id.");
  expect(crew.hasUnread()).toBe(false);

  crew.close();
  expect(settled.map(([id, outcome]) => [id, outcome])).toEqual([["t1", "completed"], ["t2", "completed"]]);
  expect(settled[0]![2]).toContain("Follow-up: Does orders.user_id have an index?");
  expect(settled[1]![2]).toBe("Stopped by the chat.");
});

test("a follow-up sent while it works waits for its report; the turn's end stops the rest", async () => {
  const { crew, marks, settled } = crewFixture();
  const one = job();
  crew.start("t1", "Find it", "Find it", one.run);
  expect(await crew.run({ action: "message", id: "a1", message: "And the tests?" }, new AbortController().signal)).toContain("still working");
  await one.answer("In app.ts.");
  expect(one.prompts).toHaveLength(2);
  expect(marks).toContainEqual(["t1", { asked: "And the tests?" }]);
  crew.close();
  expect(one.signal?.aborted).toBe(true);
  expect(marks.at(-1)).toEqual(["t1", { crew: "stopped" }]);
  expect(settled[0]![1]).toBe("completed");
});

test("Stop pressed by the person, and inputs it refuses", async () => {
  const { crew } = crewFixture();
  const one = job();
  crew.start("t1", "Find it", "Find it", one.run);
  expect(crew.stopByPerson("t1")).toBe(true);
  expect(crew.stopByPerson("t1")).toBe(false);
  expect(crew.take()).toContain("The person stopped this agent");
  await expect(crew.run({ action: "message", id: "a1", message: "more" }, new AbortController().signal)).rejects.toThrow("stopped");
  await expect(crew.run({ action: "stop", id: "a9" }, new AbortController().signal)).rejects.toThrow("no agent a9");
  expect(await crew.run({ action: "wait", seconds: 1 }, new AbortController().signal)).toContain("No agents are working");
  expect(() => parseAgentsInput({ action: "message", id: "a1" })).toThrow();
  expect(parseAgentsInput({ action: "wait", seconds: 9999 })).toEqual({ action: "wait", seconds: 600 });
});

const isSubagent = (messages: ProviderMessage[]) => typeof messages[0]?.content === "string" && messages[0].content.startsWith("You are a Demesne sub-agent");
const toolResults = (messages: ProviderMessage[]) => messages.filter((message) => message.role === "tool").map((message) => String(message.content));
const call = (id: string, name: string, args: unknown): ProviderStreamEvent => ({ type: "tool_call_delta", index: 0, idDelta: id, nameDelta: name, argumentsDelta: JSON.stringify(args) });

test("a chat starts a sub-agent in the background, keeps reading, then waits for its report", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-crew-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace); mkdirSync(join(root, "data"));
  writeFileSync(join(workspace, "checkout.ts"), "export const checkout = () => db.orders.byUser();\n");
  const parents: ProviderMessage[][] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "test", contextCapacity: 262144, maxOutputTokens: 1024,
    async listModels() { return []; }, async *stream(messages, tools) {
      if (isSubagent(messages)) {
        // The chat's own model is busy for a moment, as a real one is.
        await Bun.sleep(30);
        yield { type: "text_delta", delta: "orders.user_id has no index." }; yield { type: "finish", reason: "stop" }; return;
      }
      parents.push(structuredClone(messages));
      const results = toolResults(messages);
      if (!results.length) {
        expect(tools.map((tool) => tool.name)).toContain("agents");
        yield call("bg", "subagent", { description: "Trace the checkout API", prompt: "Trace checkout down to the database.", background: true });
        yield { type: "finish", reason: "tool_calls" }; return;
      }
      if (results.length === 1) {
        // The chat keeps working while the agent looks.
        yield call("read", "read_file", { path: "checkout.ts" }); yield { type: "finish", reason: "tool_calls" }; return;
      }
      if (results.length === 2 && !results[1]!.includes("reported]")) { yield call("wait", "agents", { action: "wait" }); yield { type: "finish", reason: "tool_calls" }; return; }
      yield { type: "text_delta", delta: "Checkout is slow: no index on orders.user_id." }; yield { type: "finish", reason: "stop" };
    } };
  const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), processor });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  try {
    const { session } = await client.createSession({ title: "Crew", workspacePath: workspace, trustWorkspace: true });
    const submitted = await client.submitTurn(session.id, { content: "why is checkout slow?" });
    const events: EventEnvelope[] = [];
    for await (const event of client.streamEvents(session.id, submitted.eventId, AbortSignal.timeout(5000))) {
      if (event.turnId !== submitted.turn.id) continue;
      events.push(event);
      if (/^turn\.(completed|failed|cancelled|interrupted)$/.test(event.type)) break;
    }
    expect(events.at(-1)?.type).toBe("turn.completed");
    const started = toolResults(parents[1]!)[0]!;
    expect(started).toStartWith("Started a1 in the background: Trace the checkout API.");
    // The report reached the chat, by agents wait or riding on a later result.
    expect(toolResults(parents.at(-1)!).join("\n")).toContain("[Agent a1 · Trace the checkout API reported]\norders.user_id has no index.");
    const progress = events.filter((event) => event.type === "tool.call_progress").map((event) => event.payload);
    expect(progress.some((payload) => payload.crew === "working")).toBe(true);
    expect(progress.some((payload) => payload.crew === "reported")).toBe(true);
    // Its row stayed open past the chat's own read, and closed with the turn.
    const order = events.map((event) => `${event.type}:${String(event.payload.name ?? "")}`);
    const subDone = order.findIndex((line) => line === "tool.call_completed:subagent"), readDone = order.findIndex((line) => line === "tool.call_completed:read_file");
    expect(readDone).toBeGreaterThan(-1);
    expect(subDone).toBeGreaterThan(readDone);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
