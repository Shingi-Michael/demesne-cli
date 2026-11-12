import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { ModelMessage, PermissionMode, SessionStateResponse } from "@demesne/protocol";
import { DemesneStore } from "@demesne/storage";
import { createDaemonApp, type DaemonApp, type TurnProcessor } from "../src/app.ts";
import { applyFoundryEdits, PARTS_GUIDE, READY_KINDS_RULES, forgetFoundrySources, FORGOTTEN_SOURCE, foundryEditTool, foundryReadTool, foundrySaveTool } from "../src/foundry.ts";
import { selectToolsForTurn, turnToolGuidance } from "../src/engine.ts";

/// Why a test page looks the way it does (pass 218 A).
const W = { direction: "Plain, for a test.", look_at: "The heading." };

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
      const call = results.length === 0 ? { name: "foundry_save", input: { title: "Tiny garden", kind: "html", description: "A test page.", why: W, source: "<h1>Garden one</h1>" } }
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
    // Revised in the same ask, so it is still one version (pass 197 A).
    expect(artifact).toMatchObject({ version: 1, source: "<h1>Garden two</h1>", workspace: null, sessionId: session.id });
    expect(artifact.versions).toHaveLength(1);
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
      : { name: "foundry_save", input: { id: artifact.id, why: W, source: "Changed" } };
    yield { type: "tool_call_delta", index: 0, idDelta: `plan-${results.length}`, nameDelta: call.name, argumentsDelta: JSON.stringify(call.input) };
    yield { type: "finish", reason: "tool_calls" };
  });
  const artifact = await client.foundrySave({ title: "Original", kind: "markdown", description: "A test page.", source: "Original" });
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
  const created = JSON.parse(await save.execute({ title: "Landing", kind: "html", description: "A test page.", why: W, source: "<h1>One</h1>" }, context));
  expect(created.version).toBe(1);
  const revised = JSON.parse(await save.execute({ id: created.id, why: W, source: "<h1>Two</h1>", note: "Bigger title" }, context));
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
  // The parts catalogue is read on demand, and names every icon parts.js draws.
  const parts = await foundryReadTool(store).execute({ id: "kit:parts" }, context);
  expect(parts).toBe(PARTS_GUIDE);
  const drawn = Object.keys(Function(`${readFileSync(join(import.meta.dir, "../../desktop/foundry-kit/parts.js"), "utf8").match(/var ICONS = (\{[\s\S]*?\n  \});/)![1].replace(/\n/g, " ")}; return ICONS;`.replace(/^/, "const ICONS = "))());
  expect(drawn.length).toBeGreaterThan(50);
  for (const name of drawn) expect(PARTS_GUIDE).toContain(` ${name}`);

  expect(store.deleteFoundryArtifact(created.id)).toBe(true);
  expect(store.getFoundryArtifact(created.id)).toBeNull();
  store.close();
});

test("foundry_save refuses a new artifact without a kind or title", async () => {
  const store = new DemesneStore(":memory:");
  const save = foundrySaveTool(store);
  await expect(save.execute({ title: "No kind", source: "x" }, context)).rejects.toThrow("kind");
  await expect(save.execute({ kind: "svg", description: "A test page.", why: W, source: "<svg/>" }, context)).rejects.toThrow("title");
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
    const input = { title: "Garden plan", kind: "html", description: "A test page.", why: W, source: "<button>Interact</button>" };
    const { toolCallId } = store.recordToolCall(turn.id, providerCallId, "save", "foundry_save", JSON.stringify(input));
    const result = await foundrySaveTool(store).execute(input, { ...context, sessionId: session.id, turnId: turn.id });
    const event = store.settleToolCall(toolCallId, "completed", result);
    const artifact = JSON.parse(result);
    const expected = { id: artifact.id, title: "Garden plan", kind: "html", version: 1, description: "A test page." };
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

test("a save that came back with the look's pictures still names its artifact (the chat's link)", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const { session } = store.createSession("Foundry pictures");
    const { turn } = store.createTurn(session.id, "Make a mockup");
    store.startTurn(turn.id);
    const { providerCallId } = store.startProviderCall(turn.id, "fixture", "fixture");
    const input = { title: "Garden plan", kind: "html", description: "A test page.", why: W, source: "<button>Interact</button>" };
    const { toolCallId } = store.recordToolCall(turn.id, providerCallId, "save", "foundry_save", JSON.stringify(input));
    const result = await foundrySaveTool(store).execute(input, { ...context, sessionId: session.id, turnId: turn.id });
    // The engine adds a line per picture after the tool's JSON.
    const withPictures = `${JSON.stringify({ ...JSON.parse(result), look: { issues: [] } })}\nImage artifact f20e2bf4: foundry-look-1280.png (960×600)\nImage artifact 5bf0f588: foundry-look-390.png (390×844)`;
    const event = store.settleToolCall(toolCallId, "completed", withPictures);
    expect(JSON.parse(event.payload.message as string)).toEqual({ id: JSON.parse(result).id, title: "Garden plan", kind: "html", version: 1, description: "A test page." });
  } finally { store.close(); }
});

test("the tools carry the design brief, the kit and the library rules", () => {
  const store = new DemesneStore(":memory:");
  try {
    const text = JSON.stringify(foundrySaveTool(store).definition);
    expect(text).toContain("cdnjs.cloudflare.com");
    expect(text).toContain('href=\\"foundry://kit/base.css\\"');
    expect(text).toContain('src=\\"foundry://kit/anime.js\\"');
    // How it should look is the design guide's (design-guide.test.ts), not the tool's.
    expect(text).toContain("follow the Design guide in your instructions");
    expect(text).not.toContain("Avoid stock AI looks");
    expect(JSON.stringify(foundryEditTool(store).definition)).toContain("base_version");
    expect(JSON.stringify(foundryReadTool(store).definition)).toContain("base_version");
  } finally { store.close(); }
});

test("foundry_edit applies exact edits to the version it read and refuses a stale base", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const save = foundrySaveTool(store), edit = foundryEditTool(store);
    const created = JSON.parse(await save.execute({ title: "Garden", kind: "html", description: "A test page.", why: W, source: "<h1>Garden</h1><p>one</p><p>one</p>" }, context));
    const edited = JSON.parse(await edit.execute({ id: created.id, base_version: 1, note: "Title", why: W,
      edits: [{ find: "<h1>Garden</h1>", replace: "<h1>Tiny garden</h1>" }, { find: "one", replace: "two", all: true }] }, context));
    expect(edited).toMatchObject({ id: created.id, version: 2, edits: 2 });
    expect(store.getFoundryArtifact(created.id)!.source).toBe("<h1>Tiny garden</h1><p>two</p><p>two</p>");
    expect(store.getFoundryArtifact(created.id)!.versions[0]!.note).toBe("Title");
    // Edit source (or another chat) moved the artifact on: version 1 is stale.
    await expect(edit.execute({ id: created.id, base_version: 1, why: W, edits: [{ find: "two", replace: "three", all: true }] }, context)).rejects.toThrow("[conflict] Foundry artifact is at version 2, not 1");
    await expect(save.execute({ id: created.id, base_version: 1, why: W, source: "<h1>Lost</h1>" }, context)).rejects.toThrow("[conflict]");
    expect(store.getFoundryArtifact(created.id)!.version).toBe(2);
    // A whole-source save with the right base still works, and one without a base keeps working.
    expect(JSON.parse(await save.execute({ id: created.id, base_version: 2, why: W, source: "<h1>Three</h1>" }, context)).version).toBe(3);
    expect(JSON.parse(await save.execute({ id: created.id, why: W, source: "<h1>Four</h1>" }, context)).version).toBe(4);
    // Misses and ambiguity are refused before anything is saved.
    await expect(edit.execute({ id: created.id, base_version: 4, why: W, edits: [{ find: "missing", replace: "x" }] }, context)).rejects.toThrow("[no_match] Edit 1");
    const saved = JSON.parse(await save.execute({ id: created.id, base_version: 4, why: W, source: "a a" }, context));
    await expect(edit.execute({ id: created.id, base_version: saved.version, edits: [{ find: "a", replace: "b" }] }, context)).rejects.toThrow("[ambiguous] Edit 1: find text occurs 2 times");
    await expect(edit.execute({ id: created.id, why: W, edits: [{ find: "a", replace: "b" }] }, context)).rejects.toThrow("base_version");
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
    { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "foundry_save", arguments: JSON.stringify({ title: "Garden", kind: "html", why: W, source: page }) }],
      responses: { accountId: "acct", model: "m", output: [{ type: "reasoning", summary: [] }, { type: "function_call", call_id: "c1", name: "foundry_save", arguments: JSON.stringify({ title: "Garden", kind: "html", why: W, source: page }) }] } },
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
  expect(JSON.parse(save.toolCalls![0]!.arguments)).toEqual({ title: "Garden", kind: "html", why: W, source: FORGOTTEN_SOURCE });
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
    const call = turn === 1 && results.length === 0 ? { name: "foundry_save", input: { title: "Tiny garden", kind: "html", description: "A test page.", why: W, source: page } }
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

test("a deck, doc or dashboard is saved as content, and the tool says how to write it", async () => {
  const store = new DemesneStore(":memory:");
  const context = { signal: new AbortController().signal, workspaceRoot: "" } as never;
  const tool = foundrySaveTool(store);
  for (const kind of ["deck", "doc", "dashboard"] as const) {
    const saved = JSON.parse(await tool.execute({ title: `A ${kind}`, kind, description: "A test page.", source: "# Q1 launch\n\n---\n\n# 3.1×\nSign-ups tripled." }, context));
    expect(saved.kind).toBe(kind);
    expect(store.getFoundryArtifact(saved.id)!.kind).toBe(kind);
  }
  await expect(tool.execute({ title: "Nope", kind: "slides", source: "x" }, context)).rejects.toThrow(/deck, doc or dashboard/);
  const words = tool.definition.description;
  for (const piece of ["kind deck", "```chart", "```stats", "label | value | delta | note", "theme: paper|ink|forest|ocean|sand|plum", "<!-- layout:"]) expect(words).toContain(piece);
  expect(READY_KINDS_RULES.length).toBeLessThan(1400);
  store.close();
});

test("one ask, one version: saves in the turn that made the latest version change it in place (pass 197 A)", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const save = foundrySaveTool(store), edit = foundryEditTool(store);
    const t1 = { ...context, turnId: "t1" }, t2 = { ...context, turnId: "t2" };
    const made = JSON.parse(await save.execute({ title: "Pricing", kind: "html", description: "A test page.", why: W, source: "<p>one</p>", note: "First take" }, t1));
    const fixed = JSON.parse(await edit.execute({ id: made.id, base_version: 1, why: W, edits: [{ find: "one", replace: "uno" }], note: "Fix button" }, t1));
    expect(fixed.version).toBe(1);
    const again = JSON.parse(await save.execute({ id: made.id, base_version: 1, why: W, source: "<p>whole</p>" }, t1));
    expect(again.version).toBe(1);
    let found = store.getFoundryArtifact(made.id)!;
    expect(found.source).toBe("<p>whole</p>");
    expect(found.versions.map((item) => [item.version, item.note])).toEqual([[1, "First take"]]);
    expect(store.listFoundryVersions()).toHaveLength(1);
    // The next ask is the next version, and its own fixes fold into it.
    const asked = JSON.parse(await edit.execute({ id: made.id, base_version: 1, why: W, edits: [{ find: "whole", replace: "two" }] }, t2));
    expect(asked.version).toBe(2);
    expect(JSON.parse(await edit.execute({ id: made.id, base_version: 2, why: W, edits: [{ find: "two", replace: "dos" }] }, t2)).version).toBe(2);
    found = store.getFoundryArtifact(made.id)!;
    expect(found.versions.map((item) => item.version)).toEqual([2, 1]);
    expect(store.getFoundryArtifact(made.id, 1)!.source).toBe("<p>whole</p>");
    // Without a turn (an outside save) every save is a version, as before.
    expect(JSON.parse(await edit.execute({ id: made.id, base_version: 2, why: W, edits: [{ find: "dos", replace: "tres" }] }, context)).version).toBe(3);
  } finally { store.close(); }
});

test("a page holds at most three options", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const save = foundrySaveTool(store), edit = foundryEditTool(store);
    const option = (name: string) => `<section data-option="${name}">x</section>`;
    const four = `<d-compare recommended="A">${["A", "B", "C", "D"].map(option).join("")}</d-compare>`;
    await expect(save.execute({ title: "Too many", kind: "html", description: "A test page.", why: W, source: four }, context)).rejects.toThrow("too_many_options");
    const three = `<d-compare recommended="A">${["A", "B", "C"].map(option).join("")}</d-compare>`;
    const made = JSON.parse(await save.execute({ title: "Three", kind: "html", description: "A test page.", why: W, source: three }, context));
    await expect(edit.execute({ id: made.id, base_version: 1, why: W, edits: [{ find: "</d-compare>", replace: `${option("D")}</d-compare>` }] }, context)).rejects.toThrow("at most 3");
  } finally { store.close(); }
});

test("every mockup is described, and its versions are named (pass 208 A)", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const save = foundrySaveTool(store), edit = foundryEditTool(store), read = foundryReadTool(store);
    await expect(save.execute({ title: "Roaster pricing", kind: "html", why: W, source: "<p>x</p>" }, context)).rejects.toThrow("needs a description");
    const made = JSON.parse(await save.execute({ title: "Roaster pricing", kind: "html", description: "Three plans for the roastery. Look at the yearly toggle.", note: "First take", why: W, source: "<p>x</p>" }, { ...context, turnId: "t1" }));
    expect(made).toMatchObject({ description: "Three plans for the roastery. Look at the yearly toggle.", note: "First take" });
    // Renaming, describing and naming the version happen with no new version.
    const named = JSON.parse(await edit.execute({ id: made.id, title: "Roastery plans", note: "Yearly first", description: "Plans, yearly first." }, context));
    expect(named).toMatchObject({ version: 1, title: "Roastery plans", note: "Yearly first", description: "Plans, yearly first." });
    expect(store.getFoundryArtifact(made.id)!.versions).toHaveLength(1);
    await expect(edit.execute({ id: made.id }, context)).rejects.toThrow("needs edits, or a title");
    // A mockup made from another says so, and reading it shows the words.
    const from = JSON.parse(await save.execute({ title: "Plans on a phone", kind: "html", description: "The plans at phone width.", based_on: made.id, why: W, source: "<p>y</p>" }, context));
    expect(store.getFoundryArtifact(from.id)!.basedOn).toEqual({ id: made.id, version: 1 });
    await expect(save.execute({ title: "Nope", kind: "html", description: "x", based_on: "missing", why: W, source: "<p>z</p>" }, context)).rejects.toThrow("based_on");
    const listed = JSON.parse(await read.execute({}, context)) as { title: string; description?: string }[];
    expect(listed.find((item) => item.title === "Roastery plans")?.description).toBe("Plans, yearly first.");
    expect(JSON.parse(await read.execute({ id: from.id }, context)).basedOn).toEqual({ id: made.id, version: 1 });
  } finally { store.close(); }
});

test("one ask that makes several mockups marks the one it would use (pass 208 A)", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const save = foundrySaveTool(store), edit = foundryEditTool(store);
    const t1 = { ...context, turnId: "t1" };
    const page = (title: string, extra: Record<string, unknown> = {}) => save.execute({ title, kind: "html", description: `${title}.`, why: W, source: `<p>${title}</p>`, ...extra }, t1);
    const calm = JSON.parse(await page("Calm"));
    // A second mockup in the ask with no pick is refused, and says how to pick.
    await expect(page("Bold")).rejects.toThrow("no_recommendation");
    const bold = JSON.parse(await page("Bold", { recommended: true }));
    expect(bold.recommended).toBe(true);
    // A third may come without a pick now that one is marked.
    const third = JSON.parse(await page("Quiet"));
    // Marking another moves the pick: one ask, one recommendation.
    expect(JSON.parse(await edit.execute({ id: calm.id, recommended: true }, t1)).recommended).toBe(true);
    const picks = store.foundryInTurn("t1").filter((item) => item.recommended).map((item) => item.id);
    expect(picks).toEqual([calm.id]);
    expect(store.listFoundryVersions().find((item) => item.artifactId === third.id)).toMatchObject({ turnId: "t1", recommended: false });
    // Another ask starts over.
    expect(JSON.parse(await save.execute({ title: "Alone", kind: "html", description: "x", why: W, source: "<p>a</p>" }, { ...context, turnId: "t2" })).version).toBe(1);
  } finally { store.close(); }
});

test("a page with several options names the one it would use (pass 208 A)", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const save = foundrySaveTool(store);
    const options = `<section data-option="A · Pills">a</section><section data-option="B · Tabs">b</section>`;
    await expect(save.execute({ title: "No pick", kind: "html", description: "x", why: W, source: `<d-compare>${options}</d-compare>` }, context)).rejects.toThrow("no_recommendation");
    expect(JSON.parse(await save.execute({ title: "Pick", kind: "html", description: "x", why: W, source: `<d-compare recommended="A">${options}</d-compare>` }, context)).version).toBe(1);
    // A page drawn without the part marks its pick on the option.
    expect(JSON.parse(await save.execute({ title: "Own", kind: "html", description: "x", why: W, source: options.replace('data-option="A · Pills"', 'data-option="A · Pills" data-recommended') }, context)).version).toBe(1);
    // One option needs no pick.
    expect(JSON.parse(await save.execute({ title: "One", kind: "html", description: "x", why: W, source: `<d-compare><section data-option="A">a</section></d-compare>` }, context)).version).toBe(1);
  } finally { store.close(); }
});

test("an older Foundry database gains descriptions, based on and picks", () => {
  const directory = mkdtempSync(join(tmpdir(), "demesne-foundry-"));
  try {
    const path = join(directory, "old.sqlite");
    const old = new DemesneStore(path);
    const made = old.saveFoundryArtifact({ title: "Old", kind: "html", source: "<p>old</p>" });
    old.close();
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const raw = new Database(path);
    raw.run("ALTER TABLE foundry_artifacts DROP COLUMN description");
    raw.run("ALTER TABLE foundry_artifacts DROP COLUMN based_on");
    raw.run("ALTER TABLE foundry_artifacts DROP COLUMN based_on_version");
    raw.run("ALTER TABLE foundry_versions DROP COLUMN recommended");
    raw.close();
    const store = new DemesneStore(path);
    expect(store.getFoundryArtifact(made.id)).toMatchObject({ title: "Old", description: "", basedOn: null });
    expect(store.getFoundryArtifact(made.id)!.versions[0]!.recommended).toBe(false);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("every new page version says why it looks that way, and keeps it (pass 218 A)", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const save = foundrySaveTool(store), edit = foundryEditTool(store);
    const t1 = { ...context, turnId: "t1" }, t2 = { ...context, turnId: "t2" };
    // A page or a drawing without a why is turned back, and says what to send.
    await expect(save.execute({ title: "Plans", kind: "html", description: "Plans.", source: "<p>a</p>" }, t1)).rejects.toThrow("why {direction, look_at, dropped}");
    await expect(save.execute({ title: "Mark", kind: "svg", description: "Mark.", why: { direction: "Warm." }, source: "<svg/>" }, t1)).rejects.toThrow("Say why");
    // Content Demesne designs needs none.
    expect(JSON.parse(await save.execute({ title: "Brief", kind: "doc", description: "A brief.", source: "# Brief" }, { ...context, turnId: "t0" })).version).toBe(1);
    const why = { direction: "Warm paper and a serif, for people who buy by taste.", look_at: "The dark middle plan.", dropped: "A comparison table; it felt like homework." };
    const saved = JSON.parse(await save.execute({ title: "Plans", kind: "html", description: "Plans.", why, source: "<p>a</p>" }, t1));
    expect(saved.why).toEqual({ direction: why.direction, look: why.look_at, dropped: why.dropped });
    expect(saved.message).toContain("say the same why");
    // Fixing its own page in the same ask keeps the why it gave.
    expect(JSON.parse(await edit.execute({ id: saved.id, base_version: 1, edits: [{ find: "a", replace: "b" }] }, t1)).why.look).toBe("The dark middle plan.");
    // A later ask makes a new version, which needs its own why.
    await expect(edit.execute({ id: saved.id, base_version: 1, edits: [{ find: "b", replace: "c" }] }, t2)).rejects.toThrow("Say why");
    await edit.execute({ id: saved.id, base_version: 1, why: { direction: "Same paper.", look_at: "The bigger price." }, edits: [{ find: "b", replace: "c" }] }, t2);
    const found = store.getFoundryArtifact(saved.id)!;
    expect(found.versions.map((item) => item.why?.look)).toEqual(["The bigger price.", "The dark middle plan."]);
    expect(found.versions[0]!.why!.dropped).toBe("");
    // The long page gets it per version, and a why can be set without a new version.
    await edit.execute({ id: saved.id, why: { direction: "Same paper.", look_at: "The price.", dropped: "Bold red." } }, t2);
    const shelf = store.listFoundryVersions().filter((item) => item.artifactId === saved.id);
    expect(shelf.map((item) => item.why?.look)).toEqual(["The price.", "The dark middle plan."]);
    expect(store.getFoundryArtifact(saved.id)!.version).toBe(2);
  } finally { store.close(); }
});

test("a mockup you can trace: its ask, a name that says what it is, what it was based on, and search (pass 219 A)", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const save = foundrySaveTool(store), edit = foundryEditTool(store), read = foundryReadTool(store);
    // One chat per ask here, so each turn is the only one in its chat.
    const ask = (content: string) => { const { session } = store.createSession("Pricing page"); const { turn } = store.createTurn(session.id, content); return { ...context, sessionId: session.id, turnId: turn.id }; };
    // The name says what it is: generic names and long ones are turned back.
    const first = ask("Make the middle plan   the obvious choice,\nand drop the table");
    for (const title of ["Mockup", "Option B", "New design", "v2", "page 3"]) await expect(save.execute({ title, kind: "html", description: "x", why: W, source: "<p>a</p>" }, first)).rejects.toThrow("doesn't say what it is");
    await expect(save.execute({ title: "A pricing page for the roastery with three plans", kind: "html", description: "x", why: W, source: "<p>a</p>" }, first)).rejects.toThrow("is 9 words");
    const plans = JSON.parse(await save.execute({ title: "Roastery pricing", kind: "html", description: "Three plans.", why: W, source: "<p>plans</p>" }, first));
    await expect(edit.execute({ id: plans.id, title: "Mockup" }, first)).rejects.toThrow("doesn't say what it is");
    // The ask that made it is kept with the version, on one line.
    expect(store.getFoundryArtifact(plans.id)!.versions[0]!.ask).toBe("Make the middle plan the obvious choice, and drop the table");
    expect(store.listFoundryVersions()[0]!.ask).toBe("Make the middle plan the obvious choice, and drop the table");
    // Read in an ask, then made: based on what was read, without being told.
    const second = ask("Now show me the pricing on a phone");
    await read.execute({ id: plans.id }, second);
    const phone = JSON.parse(await save.execute({ title: "Roastery pricing, phone", kind: "html", description: "Stacked.", why: W, source: "<p>phone</p>" }, second));
    expect(store.getFoundryArtifact(phone.id)!.basedOn).toEqual({ id: plans.id, version: 1 });
    // An ask that read nothing makes something based on nothing.
    const other = JSON.parse(await save.execute({ title: "Opening hours", kind: "html", description: "Hours.", why: W, source: "<p>hours</p>" }, ask("Opening hours card")));
    expect(store.getFoundryArtifact(other.id)!.basedOn).toBeNull();
    // Search finds by every word, in names, descriptions and the asks that made them.
    const titles = async (query: string) => JSON.parse(await read.execute({ query }, context)).map((item: { title: string }) => item.title).sort();
    expect(await titles("roastery")).toEqual(["Roastery pricing", "Roastery pricing, phone"]);
    expect(await titles("obvious middle")).toEqual(["Roastery pricing"]);
    expect(await titles("hours")).toEqual(["Opening hours"]);
    expect(await titles("nothing like this")).toEqual([]);
  } finally { store.close(); }
});
