import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { ModelMessage, PermissionMode, SessionStateResponse } from "@demesne/protocol";
import { DemesneStore } from "@demesne/storage";
import { createDaemonApp, type DaemonApp, type TurnProcessor } from "../src/app.ts";
import { applyFoundryEdits, DESIGN_BRIEF, forgetFoundrySources, FORGOTTEN_SOURCE, foundryEditTool, foundryReadTool, foundrySaveTool } from "../src/foundry.ts";
import { selectToolsForTurn, turnToolGuidance } from "../src/engine.ts";

const context = { workspaceRoot: "/tmp", signal: new AbortController().signal };

test("project overview mockups keep Foundry tools instead of becoming file inspection", () => {
  const store = new DemesneStore(":memory:");
  try {
    const definitions = [foundrySaveTool(store).definition, foundryReadTool(store).definition];
    for (const request of ["Foundry: an overview of the project", "Make an overview of the project as a dashboard mockup"]) {
      expect(selectToolsForTurn(definitions, request)).toEqual(definitions);
      expect(turnToolGuidance(request)).toBeNull();
    }
  } finally { store.close(); }
});
const fixtures: { app: DaemonApp; root: string }[] = [];
afterEach(async () => {
  for (const { app, root } of fixtures.splice(0)) {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function daemon(stream: TurnProcessor["stream"]) {
  const root = mkdtempSync(join(tmpdir(), "demesne-foundry-"));
  const app = createDaemonApp({ databasePath: join(root, "state.sqlite"), heartbeat: { enabled: false }, processor: {
    providerId: "test", modelId: "foundry-test", async listModels() { return []; }, stream,
  } });
  fixtures.push({ app, root });
  const client = new DemesneClient({ server: "http://fixture", fetch: ((url, init) => Promise.resolve(app.fetch(new Request(url, init)))) as typeof fetch });
  return { client, root };
}

async function completed(client: DemesneClient, id: string): Promise<SessionStateResponse> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = await client.getSessionState(id);
    if (state.session.turns.at(-1)?.status === "completed") return state;
    if (state.session.turns.at(-1)?.status === "failed") throw new Error("Foundry turn failed");
    await Bun.sleep(5);
  }
  throw new Error("Foundry turn did not finish");
}

for (const permissionMode of ["ask", "allow", "deny"] as PermissionMode[]) {
  test(`a chat without a project can create, read and revise Foundry artifacts (${permissionMode})`, async () => {
    const offered: string[][] = [];
    let prompt = "";
    const { client } = daemon(async function* (messages, tools) {
      offered.push(tools.map(tool => tool.name));
      prompt = messages[0]!.content ?? "";
      if (!tools.some(tool => tool.name === "foundry_save")) {
        yield { type: "text_delta", delta: "Foundry is unavailable." };
        yield { type: "finish", reason: "stop" }; return;
      }
      const results = messages.filter(message => message.role === "tool");
      const id = results[0]?.content ? JSON.parse(results[0].content).id : undefined;
      const call = results.length === 0 ? { name: "foundry_save", input: { title: "Tiny garden", kind: "html", source: "<h1>Garden one</h1>" } }
        : results.length === 1 ? { name: "foundry_read", input: { id } }
        : results.length === 2 ? { name: "foundry_save", input: { id, source: "<h1>Garden two</h1>" } } : null;
      if (call) {
        yield { type: "tool_call_delta", index: 0, idDelta: `foundry-${results.length}`, nameDelta: call.name, argumentsDelta: JSON.stringify(call.input) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Saved to Foundry." };
        yield { type: "finish", reason: "stop" };
      }
    });
    const { session } = await client.createSession({ title: "Foundry without a project" });
    expect(session.workspace).toBeNull();
    await client.submitTurn(session.id, { content: "Make me a small interactive page in Foundry", permissionMode });
    await completed(client, session.id);
    expect(offered[0]).toContain("foundry_save");
    expect(offered[0]).toContain("foundry_read");
    expect(offered[0]).toContain("foundry_edit");
    expect(offered[0]).not.toContain("write_file");
    expect(offered[0]).not.toContain("run_command");
    expect(offered[0]).not.toContain("subagent");
    // Only a chat someone is in ("ask") makes pages on its own; Auto turns make one when asked.
    if (permissionMode === "ask") {
      expect(prompt).toContain("Foundry (foundry_save) is how you show the person something");
      expect(prompt).toContain("Decide by what the best answer is, not by the words used");
      expect(prompt).toContain("Make it in this turn rather than offering or asking first");
    } else expect(prompt).toContain("nobody is watching this turn");
    const { artifacts } = await client.foundryList();
    expect(artifacts).toHaveLength(1);
    const artifact = await client.foundryGet(artifacts[0]!.id);
    expect(artifact).toMatchObject({ version: 2, source: "<h1>Garden two</h1>", workspace: null, sessionId: session.id });
    expect((await client.foundryGet(artifact.id, 1)).source).toBe("<h1>Garden one</h1>");
  });
}

test("Foundry in a chat without a project does not enable filesystem tool execution", async () => {
  let result = "";
  const { client, root } = daemon(async function* (messages) {
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      result = last.content ?? "";
      yield { type: "text_delta", delta: "The file was not created." };
      yield { type: "finish", reason: "stop" }; return;
    }
    yield { type: "tool_call_delta", index: 0, idDelta: "file", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: join(root, "blocked.txt"), content: "blocked" }) };
    yield { type: "finish", reason: "tool_calls" };
  });
  const { session } = await client.createSession({ title: "No project" });
  await client.submitTurn(session.id, { content: "Create a file", permissionMode: "allow" });
  await completed(client, session.id);
  expect(result).toContain("not bound to a workspace");
  expect(existsSync(join(root, "blocked.txt"))).toBe(false);
});

test("plan mode reads and makes Foundry pages, which change no project files", async () => {
  const offered: string[][] = [];
  let saved = "";
  const { client } = daemon(async function* (messages, tools) {
    offered.push(tools.map(tool => tool.name));
    const results = messages.filter(message => message.role === "tool");
    if (results.length === 2) {
      saved = results[1]!.content ?? "";
      yield { type: "text_delta", delta: "Here it is." };
      yield { type: "finish", reason: "stop" }; return;
    }
    const call = results.length === 0 ? { name: "foundry_read", input: { id: artifact.id } }
      : { name: "foundry_save", input: { id: artifact.id, source: "Changed" } };
    yield { type: "tool_call_delta", index: 0, idDelta: `plan-${results.length}`, nameDelta: call.name, argumentsDelta: JSON.stringify(call.input) };
    yield { type: "finish", reason: "tool_calls" };
  });
  const artifact = await client.foundrySave({ title: "Original", kind: "markdown", source: "Original" });
  const { session } = await client.createSession({ title: "Plan" });
  await client.submitTurn(session.id, { content: "Plan changes to the Foundry document", planOnly: true });
  await completed(client, session.id);
  expect(offered[0]).toEqual(expect.arrayContaining(["foundry_read", "foundry_save", "foundry_edit"]));
  expect(saved).not.toContain("not available in plan mode");
  expect((await client.foundryGet(artifact.id)).version).toBe(2);
});

test("foundry_save creates an artifact and keeps every version", async () => {
  const store = new DemesneStore(":memory:");
  const save = foundrySaveTool(store);
  const created = JSON.parse(await save.execute({ title: "Landing", kind: "html", source: "<h1>One</h1>" }, context));
  expect(created.version).toBe(1);
  const revised = JSON.parse(await save.execute({ id: created.id, source: "<h1>Two</h1>", note: "Bigger title" }, context));
  expect(revised.version).toBe(2);

  const latest = store.getFoundryArtifact(created.id)!;
  expect(latest.source).toBe("<h1>Two</h1>");
  expect(latest.versions.map((item) => [item.version, item.note])).toEqual([[2, "Bigger title"], [1, ""]]);
  expect(store.getFoundryArtifact(created.id, 1)!.source).toBe("<h1>One</h1>");
  expect(store.getFoundryArtifact(created.id, 1)!.version).toBe(1);

  const read = JSON.parse(await foundryReadTool(store).execute({ id: created.id, version: 1 }, context));
  expect(read.source).toBe("<h1>One</h1>");
  expect(read.version).toBe(1);
  expect(JSON.parse(await foundryReadTool(store).execute({}, context))[0].title).toBe("Landing");

  expect(store.deleteFoundryArtifact(created.id)).toBe(true);
  expect(store.getFoundryArtifact(created.id)).toBeNull();
  store.close();
});

test("foundry_save refuses a new artifact without a kind or title", async () => {
  const store = new DemesneStore(":memory:");
  const save = foundrySaveTool(store);
  await expect(save.execute({ title: "No kind", source: "x" }, context)).rejects.toThrow("kind");
  await expect(save.execute({ kind: "svg", source: "<svg/>" }, context)).rejects.toThrow("title");
  await expect(save.execute({ id: "missing", source: "x" }, context)).rejects.toThrow();
  store.close();
});

test("artifact identity reaches live events and old replay without rewriting the journal", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const { session } = store.createSession("Foundry history");
    const { turn } = store.createTurn(session.id, "Make a mockup");
    store.startTurn(turn.id);
    const { providerCallId } = store.startProviderCall(turn.id, "fixture", "fixture");
    const input = { title: "Mockup", kind: "html", source: "<button>Interact</button>" };
    const { toolCallId } = store.recordToolCall(turn.id, providerCallId, "save", "foundry_save", JSON.stringify(input));
    const result = await foundrySaveTool(store).execute(input, { ...context, sessionId: session.id, turnId: turn.id });
    const event = store.settleToolCall(toolCallId, "completed", result);
    const artifact = JSON.parse(result);
    const expected = { id: artifact.id, title: "Mockup", kind: "html", version: 1 };
    expect(JSON.parse(event.payload.message as string)).toEqual(expected);
    expect(event.payload.message).not.toContain(input.source);
    const legacy = { ...event.payload }; delete legacy.message;
    store.database.query("UPDATE events SET payload = ? WHERE id = ?").run(JSON.stringify(legacy), event.eventId);
    expect(JSON.parse(store.eventsAfter(session.id, event.eventId - 1)[0]!.payload.message as string)).toEqual(expected);
    expect(JSON.parse(store.eventsBetween(session.id, event.eventId - 1, event.eventId)[0]!.payload.message as string)).toEqual(expected);
    const raw = store.database.query("SELECT payload FROM events WHERE id = ?").get(event.eventId) as { payload: string };
    expect(JSON.parse(raw.payload).message).toBeUndefined();
  } finally { store.close(); }
});

test("the tools carry the design brief, the kit and the library rules", () => {
  const store = new DemesneStore(":memory:");
  try {
    const text = JSON.stringify(foundrySaveTool(store).definition);
    expect(text).toContain("cdnjs.cloudflare.com");
    expect(text).toContain('href=\\"foundry://kit/base.css\\"');
    expect(text).toContain('src=\\"foundry://kit/anime.js\\"');
    expect(text).toContain("prefers-reduced-motion: reduce");
    expect(JSON.stringify(foundryEditTool(store).definition)).toContain("base_version");
    expect(DESIGN_BRIEF).toContain("phone width");
    expect(JSON.stringify(foundryReadTool(store).definition)).toContain("base_version");
  } finally { store.close(); }
});

test("foundry_edit applies exact edits to the version it read and refuses a stale base", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const save = foundrySaveTool(store), edit = foundryEditTool(store);
    const created = JSON.parse(await save.execute({ title: "Garden", kind: "html", source: "<h1>Garden</h1><p>one</p><p>one</p>" }, context));
    const edited = JSON.parse(await edit.execute({ id: created.id, base_version: 1, note: "Title",
      edits: [{ find: "<h1>Garden</h1>", replace: "<h1>Tiny garden</h1>" }, { find: "one", replace: "two", all: true }] }, context));
    expect(edited).toMatchObject({ id: created.id, version: 2, edits: 2 });
    expect(store.getFoundryArtifact(created.id)!.source).toBe("<h1>Tiny garden</h1><p>two</p><p>two</p>");
    expect(store.getFoundryArtifact(created.id)!.versions[0]!.note).toBe("Title");
    // Edit source (or another chat) moved the artifact on: version 1 is stale.
    await expect(edit.execute({ id: created.id, base_version: 1, edits: [{ find: "two", replace: "three", all: true }] }, context)).rejects.toThrow("[conflict] Foundry artifact is at version 2, not 1");
    await expect(save.execute({ id: created.id, base_version: 1, source: "<h1>Lost</h1>" }, context)).rejects.toThrow("[conflict]");
    expect(store.getFoundryArtifact(created.id)!.version).toBe(2);
    // A whole-source save with the right base still works, and one without a base keeps working.
    expect(JSON.parse(await save.execute({ id: created.id, base_version: 2, source: "<h1>Three</h1>" }, context)).version).toBe(3);
    expect(JSON.parse(await save.execute({ id: created.id, source: "<h1>Four</h1>" }, context)).version).toBe(4);
    // Misses and ambiguity are refused before anything is saved.
    await expect(edit.execute({ id: created.id, base_version: 4, edits: [{ find: "missing", replace: "x" }] }, context)).rejects.toThrow("[no_match] Edit 1");
    const saved = JSON.parse(await save.execute({ id: created.id, base_version: 4, source: "a a" }, context));
    await expect(edit.execute({ id: created.id, base_version: saved.version, edits: [{ find: "a", replace: "b" }] }, context)).rejects.toThrow("[ambiguous] Edit 1: find text occurs 2 times");
    await expect(edit.execute({ id: created.id, edits: [{ find: "a", replace: "b" }] }, context)).rejects.toThrow("base_version");
    await expect(edit.execute({ id: "missing", base_version: 1, edits: [{ find: "a", replace: "b" }] }, context)).rejects.toThrow("[not_found]");
    expect(store.getFoundryArtifact(created.id)!.version).toBe(saved.version);
  } finally { store.close(); }
});

test("applyFoundryEdits treats the replacement as plain text", () => {
  expect(applyFoundryEdits("price $1", [{ find: "$1", replace: "$&$1" }])).toBe("price $&$1");
  expect(applyFoundryEdits("x.y", [{ find: ".", replace: "-", all: true }])).toBe("x-y");
});

test("a page's source leaves the transcript once its turn is over, in the calls, the results and the Responses items", () => {
  const page = "<h1>" + "a".repeat(100) + "</h1>";
  const messages: ModelMessage[] = [
    { role: "user", content: "Make a page" },
    { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "foundry_save", arguments: JSON.stringify({ title: "Garden", kind: "html", source: page }) }],
      responses: { accountId: "acct", model: "m", output: [{ type: "reasoning", summary: [] }, { type: "function_call", call_id: "c1", name: "foundry_save", arguments: JSON.stringify({ title: "Garden", kind: "html", source: page }) }] } },
    { role: "tool", toolCallId: "c1", content: JSON.stringify({ id: "art", version: 1 }) },
    { role: "assistant", content: null, toolCalls: [{ id: "c2", name: "foundry_read", arguments: JSON.stringify({ id: "art" }) }] },
    { role: "tool", toolCallId: "c2", content: JSON.stringify({ id: "art", version: 1, source: page, versions: [] }) },
    { role: "assistant", content: null, toolCalls: [{ id: "c3", name: "foundry_edit", arguments: JSON.stringify({ id: "art", base_version: 1, edits: [{ find: "a", replace: "b" }] }) }] },
    { role: "tool", toolCallId: "c3", content: JSON.stringify({ id: "art", version: 2 }) },
    { role: "assistant", content: "Done." },
  ];
  const kept = structuredClone(messages);
  const forgotten = forgetFoundrySources(messages);
  expect(messages).toEqual(kept);
  const text = JSON.stringify(forgotten);
  expect(text).not.toContain("aaaa");
  expect(text.split(FORGOTTEN_SOURCE)).toHaveLength(4);
  const save = forgotten[1] as Extract<ModelMessage, { role: "assistant" }>;
  expect(JSON.parse(save.toolCalls![0]!.arguments)).toEqual({ title: "Garden", kind: "html", source: FORGOTTEN_SOURCE });
  expect(save.responses!.output[0]).toEqual({ type: "reasoning", summary: [] });
  expect(JSON.parse(String(save.responses!.output[1]!.arguments))).toMatchObject({ source: FORGOTTEN_SOURCE });
  expect(JSON.parse((forgotten[4] as Extract<ModelMessage, { role: "tool" }>).content)).toEqual({ id: "art", version: 1, source: FORGOTTEN_SOURCE, versions: [] });
  // Edits are the agent's own small changes; they, and everything else, stay as they were.
  expect(forgotten[5]).toEqual(messages[5]);
  expect(forgotten[0]).toBe(messages[0]);
  expect(forgotten[8]).toBe(messages[8]);
});

test("the next turn's request carries a stub where the earlier turn's page was, and the current turn keeps its own", async () => {
  const page = "<h1>Garden one</h1>" + "<p>a paragraph of the page</p>".repeat(20);
  const requests: ModelMessage[][] = [];
  const { client } = daemon(async function* (messages) {
    requests.push(structuredClone(messages));
    const results = messages.filter(message => message.role === "tool");
    const turn = messages.filter(message => message.role === "user").length;
    const call = turn === 1 && results.length === 0 ? { name: "foundry_save", input: { title: "Tiny garden", kind: "html", source: page } }
      : turn === 2 && results.length === 1 ? { name: "foundry_read", input: { id: JSON.parse(results[0]!.content).id } } : null;
    if (call) {
      yield { type: "tool_call_delta", index: 0, idDelta: `foundry-${turn}-${results.length}`, nameDelta: call.name, argumentsDelta: JSON.stringify(call.input) };
      yield { type: "finish", reason: "tool_calls" };
    } else {
      yield { type: "text_delta", delta: "Saved to Foundry." };
      yield { type: "finish", reason: "stop" };
    }
  });
  const { session } = await client.createSession({ title: "Foundry history" });
  await client.submitTurn(session.id, { content: "Make me a page", permissionMode: "ask" });
  await completed(client, session.id);
  await client.submitTurn(session.id, { content: "Now look at it", permissionMode: "ask" });
  await completed(client, session.id);
  // Turn 1, second round: the save just made is still in full.
  expect(JSON.stringify(requests[1])).toContain(page);
  // Turn 2, first round: the page is gone from history, its title and version are not.
  const later = JSON.stringify(requests[2]);
  expect(later).not.toContain("a paragraph of the page");
  expect(later).toContain(FORGOTTEN_SOURCE);
  expect(later).toContain("Tiny garden");
  // Turn 2, second round: what foundry_read gave back this turn is there in full.
  expect(JSON.stringify(requests[3])).toContain(page);
  expect(requests[3]!.filter((message) => JSON.stringify(message).includes("a paragraph of the page"))).toHaveLength(1);
});
