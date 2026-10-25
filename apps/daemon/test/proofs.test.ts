import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { EventEnvelope, ProofClaim, SubmitTurnResponse } from "@demesne/protocol";
import type { ProviderMessage, ProviderStreamEvent, ProviderToolDefinition } from "@demesne/providers";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";
import { PROOF_TOOL, VERDICT_TOOL, quoteIn, verifyClaims } from "../src/proofs.ts";

const steps = [
  { id: "call-1", name: "read_file", arguments: { path: "notes.txt" }, status: "completed", resultText: "1: The session restore lives in history.ts.\n2: Nothing here mentions the sidebar.\n" },
  { id: "call-2", name: "run_command", arguments: { argv: ["bun", "test"] }, status: "completed", resultText: " 1198 pass\n 0 fail\n" },
];
const answer = "Fixed it. **All 1198 tests pass**, and `history.ts` holds the restore. Nothing else calls `projectFor`, so it should feel snappier.";

test("a claim is kept only when it is in the answer, and proved only when its quote is in the step it names", () => {
  const claims = verifyClaims(answer, steps, { claims: [
    { text: "All 1198 tests pass", step: 2, quote: "1198 pass" },
    { text: "`history.ts` holds the restore", step: 1, quote: "lives in history.ts" },
    { text: "Nothing else calls projectFor" },
    { text: "it should feel snappier", step: 2, quote: "this line is made up" },
    { text: "the moon is made of cheese", step: 1, quote: "The session restore" },
    { text: "All 1198 tests pass, and history.ts holds the restore", step: 2, quote: "1198 pass" },
    { text: "short" },
  ] });
  expect(claims.map((claim) => [claim.text, claim.state, claim.toolCallId ?? null, claim.quote ?? null])).toEqual([
    ["All 1198 tests pass", "proved", "call-2", "1198 pass"],
    ["`history.ts` holds the restore", "proved", "call-1", "lives in history.ts"],
    ["Nothing else calls projectFor", "unchecked", null, null],
    ["it should feel snappier", "unchecked", null, null],
  ]);
  expect(new Set(claims.map((claim) => claim.id)).size).toBe(4);
});

test("quotes allow for wrapped whitespace but never for invented words", () => {
  expect(quoteIn("1198 pass\n0 fail", " 1198 pass\n 0 fail\n")).toBe(true);
  expect(quoteIn("1199 pass", " 1198 pass\n")).toBe(false);
  expect(quoteIn("   ", "anything")).toBe(false);
});

type ModelRequest = { messages: ProviderMessage[]; tools: ProviderToolDefinition[] };
const lastUser = (messages: ProviderMessage[]) => String(messages.findLast((message) => message.role === "user")?.content ?? "");
const toolResults = (messages: ProviderMessage[]) => messages.filter((message) => message.role === "tool").map((message) => String(message.content));
const call = (id: string, name: string, args: unknown): ProviderStreamEvent => ({ type: "tool_call_delta", index: 0, idDelta: id, nameDelta: name, argumentsDelta: JSON.stringify(args) });
const has = (tools: ProviderToolDefinition[], name: string) => tools.some((tool) => tool.name === name);

async function fixture(stream: (request: ModelRequest) => AsyncGenerator<ProviderStreamEvent>, run: (value: {
  client: DemesneClient; id: string; requests: ModelRequest[];
  consume: (submitted: SubmitTurnResponse) => Promise<EventEnvelope[]>;
  until: (after: number, done: (events: EventEnvelope[]) => boolean) => Promise<EventEnvelope[]>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "demesne-proofs-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace); mkdirSync(join(root, "data"));
  writeFileSync(join(workspace, "notes.txt"), "The session restore lives in history.ts.\nNothing here mentions the sidebar.\n");
  const requests: ModelRequest[] = [];
  const processor: TurnProcessor = { providerId: "test", modelId: "test", contextCapacity: 262144, maxOutputTokens: 1024,
    async listModels() { return []; }, async *stream(messages, tools) {
      const request = structuredClone({ messages, tools });
      requests.push(request);
      yield* stream(request);
    } };
  const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), processor });
  const client = new DemesneClient({ server: "http://localhost", fetch: ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch });
  const { session } = await client.createSession({ title: "Proof marks", workspacePath: workspace, trustWorkspace: true });
  const until = async (after: number, done: (events: EventEnvelope[]) => boolean) => {
    const events: EventEnvelope[] = [];
    for await (const event of client.streamEvents(session.id, after, AbortSignal.timeout(5000))) {
      events.push(event);
      if (done(events)) break;
    }
    return events;
  };
  const consume = (submitted: SubmitTurnResponse) => until(submitted.eventId, (events) => /^turn\.(completed|failed|cancelled|interrupted)$/.test(events.at(-1)!.type));
  try { await run({ client, id: session.id, requests, consume, until }); }
  finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}

test("after an answer the daemon marks its claims, and Prove it settles one with a read-only check", async () => {
  await fixture(async function* ({ messages, tools }) {
    const user = lastUser(messages);
    if (has(tools, PROOF_TOOL)) {
      expect(user).toContain("Answer:\nI read notes.txt.");
      expect(user).toContain("--- step 1: read notes.txt");
      yield call("marks", PROOF_TOOL, { claims: [
        { text: "the session restore lives in history.ts", step: 1, quote: "The session restore lives in history.ts." },
        { text: "nothing else mentions restore" },
        { text: "I read notes.txt", step: 1, quote: "a line the step never printed" },
        { text: "this sentence is not in the answer", step: 1, quote: "The session restore" },
      ] });
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (has(tools, VERDICT_TOOL)) {
      // The check reads first, then gives its verdict on what it read.
      if (!toolResults(messages).length) { yield call("check-read", "read_file", { path: "notes.txt" }); yield { type: "finish", reason: "tool_calls" }; return; }
      if (user.includes('Claim: "I read notes.txt"')) yield call("verdict", VERDICT_TOOL, { holds: true, quote: "words the file does not hold" });
      else yield call("verdict", VERDICT_TOOL, { holds: false, quote: "Nothing here mentions the sidebar.", why: "notes.txt mentions the sidebar too.", words: "notes.txt also mentions the sidebar" });
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (!toolResults(messages).length) { yield call("read", "read_file", { path: "notes.txt" }); yield { type: "finish", reason: "tool_calls" }; return; }
    yield { type: "text_delta", delta: "I read notes.txt. In short, the session restore lives in history.ts, and nothing else mentions restore anywhere in the project." };
    yield { type: "finish", reason: "stop" };
  }, async ({ client, id, consume, until }) => {
    const submitted = await client.submitTurn(id, { content: "Where is session restore?", permissionMode: "allow" });
    const events = await consume(submitted);
    expect(events.at(-1)?.type).toBe("turn.completed");
    const turnId = submitted.turn.id;
    const [marks] = await until(events.at(-1)!.eventId, (list) => list.at(-1)!.type === "turn.proofs");
    expect(marks!.turnId).toBe(turnId);
    const claims = marks!.payload.claims as ProofClaim[];
    const readId = String(events.find((event) => event.type === "tool.call_completed")!.payload.toolCallId);
    expect(claims.map((claim) => [claim.text, claim.state, claim.toolCallId ?? null])).toEqual([
      ["the session restore lives in history.ts", "proved", readId],
      ["nothing else mentions restore", "unchecked", null],
      ["I read notes.txt", "unchecked", null],
    ]);
    expect(claims[0]!.quote).toBe("The session restore lives in history.ts.");

    // Prove it: the claim is being checked (the step shows), then found false.
    const checking = await client.proofAction(id, turnId, claims[1]!.id, { action: "check" });
    expect(checking.claim.state).toBe("checking");
    const settled = await until(marks!.eventId, (list) => list.at(-1)!.type === "turn.proof" && list.at(-1)!.payload.state !== "checking");
    expect(settled.filter((event) => event.type === "turn.proof").map((event) => [event.payload.state, event.payload.step])).toEqual([
      ["checking", ""], ["checking", "read notes.txt"], ["false", "read notes.txt"],
    ]);
    const verdict = settled.at(-1)!.payload;
    expect(verdict).toMatchObject({ claimId: claims[1]!.id, why: "notes.txt mentions the sidebar too.", quote: "Nothing here mentions the sidebar.", words: "notes.txt also mentions the sidebar" });
    // A check that says "true" without lines it really read proves nothing.
    await client.proofAction(id, turnId, claims[2]!.id, { action: "check" });
    const second = await until(settled.at(-1)!.eventId, (list) => list.at(-1)!.type === "turn.proof" && list.at(-1)!.payload.state !== "checking");
    expect(second.at(-1)!.payload).toMatchObject({ claimId: claims[2]!.id, state: "unchecked", why: "The check couldn't quote what shows it." });

    // Correct the sentence keeps the true words; Drop strikes the other.
    const corrected = await client.proofAction(id, turnId, claims[1]!.id, { action: "correct" });
    expect(corrected.claim).toMatchObject({ state: "proved", words: "notes.txt also mentions the sentence".replace("sentence", "sidebar") });
    const dropped = await client.proofAction(id, turnId, claims[2]!.id, { action: "drop" });
    expect(dropped.claim.state).toBe("dropped");
    await expect(client.proofAction(id, turnId, claims[0]!.id, { action: "check" })).rejects.toThrow();
    const last = await until(second.at(-1)!.eventId, (list) => list.filter((event) => event.type === "turn.proof").length === 2);
    expect(last.map((event) => [event.payload.claimId, event.payload.state])).toEqual([[claims[1]!.id, "proved"], [claims[2]!.id, "dropped"]]);
  });
});

test("a turn with no steps, a plan, or a short answer gets no proof pass", async () => {
  await fixture(async function* ({ tools, messages }) {
    expect(has(tools, PROOF_TOOL)).toBe(false);
    if (!toolResults(messages).length && lastUser(messages) === "Read it") { yield call("read", "read_file", { path: "notes.txt" }); yield { type: "finish", reason: "tool_calls" }; return; }
    yield { type: "text_delta", delta: lastUser(messages) === "Read it" ? "Short." : "A long answer with no steps behind it, which the proof pass has nothing to pair with at all." };
    yield { type: "finish", reason: "stop" };
  }, async ({ client, id, consume, requests }) => {
    await consume(await client.submitTurn(id, { content: "Just talk", permissionMode: "allow" }));
    await consume(await client.submitTurn(id, { content: "Read it", permissionMode: "allow" }));
    await Bun.sleep(50);
    expect(requests.some((request) => has(request.tools, PROOF_TOOL))).toBe(false);
  });
});
