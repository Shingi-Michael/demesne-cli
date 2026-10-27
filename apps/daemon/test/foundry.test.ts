import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { PermissionMode, SessionStateResponse } from "@demesne/protocol";
import { DemesneStore } from "@demesne/storage";
import { createDaemonApp, type DaemonApp, type TurnProcessor } from "../src/app.ts";
import { applyFoundryEdits, DESIGN_BRIEF, foundryEditTool, foundryReadTool, foundrySaveTool } from "../src/foundry.ts";
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
      if (tools.some(tool => tool.name === "proof_marks")) { yield { type: "finish", reason: "stop" }; return; }
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
    expect(prompt).toContain("Foundry is available in this chat");
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

test("plan mode can read Foundry but rejects artifact changes without a project", async () => {
  const offered: string[][] = [];
  let denial = "";
  const { client } = daemon(async function* (messages, tools) {
    offered.push(tools.map(tool => tool.name));
    const results = messages.filter(message => message.role === "tool");
    if (results.length === 2) {
      denial = results[1]!.content ?? "";
      yield { type: "text_delta", delta: "Plan only." };
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
  expect(offered[0]).toContain("foundry_read");
  expect(offered[0]).not.toContain("foundry_save");
  expect(offered[0]).not.toContain("foundry_edit");
  expect(denial).toContain("not available in plan mode");
  expect((await client.foundryGet(artifact.id)).version).toBe(1);
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

test("the tools carry the design brief and the library rules", () => {
  const store = new DemesneStore(":memory:");
  try {
    const text = JSON.stringify(foundrySaveTool(store).definition);
    expect(text).toContain("cdnjs.cloudflare.com");
    expect(text).toContain("prefers-color-scheme: dark");
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
