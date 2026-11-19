import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderToolDefinition } from "@demesne/providers";
import type { SessionStateResponse } from "@demesne/protocol";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { createDaemonApp, type DaemonApp, type TurnProcessor } from "../src/app.ts";
import { builtinsWait, called, draftOfUse, moreToolsSection, rewriteCalled, searchTools, shownTools, splitTools, summary, TOOL_SEARCH, USE_TOOL, useToolAnswer } from "../src/tool-search.ts";

const tool = (name: string, description: string, padding = 0): ProviderToolDefinition => ({ name, description: description + " x".repeat(padding), inputSchema: { type: "object", properties: {} } });
const definitions = [
  tool("read_file", "Read numbered lines."),
  tool("edit_file", "Edit a file."),
  tool("foundry_save", "Save a page, deck or document to Foundry. It keeps versions.", 1500),
  tool("git_history", "Show recent commits and who changed a file.", 400),
  tool("notify_phone", "Send a push notification to the user's phone.", 200),
];

/// A window small enough that the tools above would crowd it.
const SMALL = 4_000;

test("on a small window everyday tools go whole; the rest wait behind tool_search and use_tool", () => {
  const { sent, deferrable } = splitTools(definitions, SMALL);
  expect(sent.map((one) => one.name)).toEqual(["read_file", "edit_file", TOOL_SEARCH, USE_TOOL]);
  expect(deferrable.map((one) => one.name)).toEqual(["foundry_save", "git_history", "notify_phone"]);
  // The same definitions give the same list, whatever was used before.
  expect(splitTools(definitions, SMALL)).toEqual({ sent, deferrable });
});

test("on a large window Demesne's own tools all go whole, so the tool list never changes; MCP tools still wait", () => {
  expect(builtinsWait(definitions, SMALL)).toBe(true);
  expect(builtinsWait(definitions, 272_000)).toBe(false);
  // A window nobody told us is taken to be a large one.
  expect(builtinsWait(definitions)).toBe(false);
  expect(splitTools(definitions, 272_000)).toEqual({ sent: definitions, deferrable: [] });
  expect(splitTools(definitions)).toEqual({ sent: definitions, deferrable: [] });
  const withServers = [...definitions, tool("mcp__linear__list_issues", "[linear] List issues.", 900), tool("mcp__linear__create_issue", "[linear] Create an issue.", 900)];
  const { sent, deferrable } = splitTools(withServers, 272_000);
  expect(sent.map((one) => one.name)).toEqual([...definitions.map((one) => one.name), TOOL_SEARCH, USE_TOOL]);
  expect(deferrable.map((one) => one.name)).toEqual(["mcp__linear__list_issues", "mcp__linear__create_issue"]);
});

test("small sets aren't worth deferring", () => {
  const few = [tool("read_file", "Read."), tool("remember", "Remember a rule.")];
  expect(splitTools(few, 100)).toEqual({ sent: few, deferrable: [] });
});

test("the list is one line per tool", () => {
  expect(summary(tool("a", "Save a page to Foundry. It keeps versions."))).toBe("Save a page to Foundry.");
  const section = moreToolsSection(splitTools(definitions, SMALL).deferrable);
  expect(section).toContain("tool_search shows how one is called, use_tool calls it");
  expect(section).toContain("- foundry_save: Save a page, deck or document to Foundry.");
  expect(section).toContain("- notify_phone: Send a push notification to the user's phone.");
});

test("tool_search finds by name, then by words, and answers with how each is called", () => {
  const { deferrable } = splitTools(definitions, SMALL);
  const byName = searchTools(deferrable, { names: ["Foundry_Save"] });
  expect(byName.found.map((one) => one.name)).toEqual(["foundry_save"]);
  expect(JSON.parse(byName.result).tools).toEqual([{ name: "foundry_save", description: definitions[2]!.description, parameters: definitions[2]!.inputSchema }]);
  expect(searchTools(deferrable, { query: "who changed this file, commits" }).found[0]!.name).toBe("git_history");
  expect(searchTools(deferrable, { query: "phone notification" }).found[0]!.name).toBe("notify_phone");
  const none = searchTools(deferrable, { query: "zzz" });
  expect(none.found).toEqual([]);
  expect(none.result).toContain("foundry_save, git_history, notify_phone");
});

test("a use_tool call counts as the tool inside it", () => {
  const wrapped = { id: "1", name: USE_TOOL, arguments: JSON.stringify({ name: "git_history", input: { action: "log" } }) };
  expect(called(wrapped)).toEqual({ id: "1", name: "git_history", arguments: '{"action":"log"}', wrapped: true });
  const direct = { id: "2", name: "read_file", arguments: '{"path":"a.ts"}' };
  expect(called(direct)).toEqual({ ...direct, wrapped: false });
  // Not a whole call: it stays use_tool.
  expect(called({ id: "3", name: USE_TOOL, arguments: '{"name":' }).name).toBe(USE_TOOL);
  // Rewriting the arguments keeps the wrapper.
  expect(rewriteCalled(wrapped.name, wrapped.arguments, (name, args) => name === "git_history" ? args.replace("log", "blame") : null)).toBe(JSON.stringify({ name: "git_history", input: { action: "blame" } }));
  expect(rewriteCalled(direct.name, direct.arguments, () => '{"path":"b.ts"}')).toBe('{"path":"b.ts"}');
  expect(rewriteCalled(wrapped.name, wrapped.arguments, () => null)).toBeNull();
});

test("a use_tool call is drawn as its tool while the model writes it", () => {
  expect(draftOfUse('{"na')).toBeNull();
  expect(draftOfUse('{"name":"foundry_save","input":{"title":"A')).toEqual({ name: "foundry_save", arguments: '{"title":"A' });
  // The wrapper's closing brace is not the tool's.
  expect(draftOfUse('{"name": "foundry_save", "input": {"title":"A"}}')).toEqual({ name: "foundry_save", arguments: '{"title":"A"}' });
});

test("what a chat was shown is read from the conversation", () => {
  const messages = [
    { role: "user", content: "history please" },
    { role: "assistant", content: null, toolCalls: [{ id: "s1", name: TOOL_SEARCH, arguments: '{"names":["git_history"]}' }] },
    { role: "tool", toolCallId: "s1", content: JSON.stringify({ tools: [{ name: "git_history" }] }) },
    { role: "assistant", content: null, toolCalls: [{ id: "u1", name: USE_TOOL, arguments: JSON.stringify({ name: "notify_phone", input: {} }) }, { id: "r1", name: "read_file", arguments: "{}" }] },
  ];
  expect([...shownTools(messages)].sort()).toEqual(["git_history", "notify_phone"]);
  expect(shownTools(messages.slice(0, 1)).size).toBe(0);
});

test("use_tool answers with how a tool is called, or what is wrong", () => {
  const { sent, deferrable } = splitTools(definitions, SMALL), names = new Set(sent.map((one) => one.name));
  const first = useToolAnswer(deferrable, names, { name: "git_history", input: {} });
  expect(first.show?.name).toBe("git_history");
  expect(JSON.parse(first.result)).toMatchObject({ notRun: true, tool: { name: "git_history" } });
  // What a tool needs said with it comes with how it is called.
  const guide = (definition: ProviderToolDefinition) => definition.name === "foundry_save" ? "# Design guide" : null;
  expect(JSON.parse(useToolAnswer(deferrable, names, { name: "foundry_save", input: {} }, guide).result).tool.guide).toBe("# Design guide");
  expect(JSON.parse(searchTools(deferrable, { names: ["foundry_save", "git_history"] }, guide).result).tools.map((one: { guide?: string }) => one.guide)).toEqual(["# Design guide", undefined]);
  expect(useToolAnswer(deferrable, names, { name: "read_file", input: {} }).result).toContain("Call it directly");
  expect(useToolAnswer(deferrable, names, { name: "nope", input: {} }).result).toContain("foundry_save, git_history, notify_phone");
});

const apps: { app: DaemonApp; root: string }[] = [];
afterEach(async () => { for (const { app, root } of apps.splice(0)) { await app.close(); rmSync(root, { recursive: true, force: true }); } });

async function completed(client: DemesneClient, id: string, turns: number): Promise<SessionStateResponse> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const state = await client.getSessionState(id);
    const last = state.session.turns.at(-1);
    if (state.session.turns.length === turns && last?.status === "completed") return state;
    if (last?.status === "failed") throw new Error("turn failed");
    await Bun.sleep(5);
  }
  throw new Error("turn did not finish");
}

test("on a small window a waiting tool runs through use_tool and the tool list never changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-tool-search-")), workspace = mkdtempSync(join(tmpdir(), "demesne-tool-search-project-"));
  apps.push({ app: { close: async () => {} } as DaemonApp, root: workspace });
  const offered: string[][] = [], prompts: string[] = [];
  let results: string[] = [];
  const use = (id: string, name: string, input: unknown) => ({ type: "tool_call_delta" as const, index: 0, idDelta: id, nameDelta: USE_TOOL, argumentsDelta: JSON.stringify({ name, input }) });
  const stream: TurnProcessor["stream"] = async function* (messages, tools) {
    offered.push(tools.map((one) => one.name));
    prompts.push(String(messages[0]?.content ?? ""));
    results = messages.filter((message) => message.role === "tool").map((message) => String(message.content));
    const last = messages.at(-1), asked = [...messages].reverse().find((message) => message.role === "user");
    const said = String(asked?.content ?? "");
    if (last?.role === "user" && said.includes("guess")) { yield use("guess-1", "git_status_all", {}); yield { type: "finish", reason: "tool_calls" }; return; }
    if (last?.role === "user" && said.includes("history")) {
      // Straight to use_tool, without asking how the tool is called.
      yield use("use-1", "git_history", { action: "log" });
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (last?.role === "tool" && String(last.content).includes('"notRun":true')) { yield use("use-2", "git_history", { action: "log" }); yield { type: "finish", reason: "tool_calls" }; return; }
    if (last?.role === "user" && said.includes("again")) { yield use("use-3", "git_history", { action: "log" }); yield { type: "finish", reason: "tool_calls" }; return; }
    yield { type: "text_delta", delta: "Done." };
    yield { type: "finish", reason: "stop" };
  };
  const app = createDaemonApp({ databasePath: join(root, "state.sqlite"), heartbeat: { enabled: false }, deferTools: true, processor: { providerId: "test", modelId: "m", contextCapacity: 32_768, maxOutputTokens: 1_024, async listModels() { return []; }, stream } });
  apps.push({ app, root });
  const client = new DemesneClient({ server: "http://fixture", fetch: ((url, init) => Promise.resolve(app.fetch(new Request(url, init)))) as typeof fetch });
  const { session } = await client.createSession({ title: "Search", workspacePath: workspace, trustWorkspace: true });
  await client.submitTurn(session.id, { content: "show me the history of app.ts" });
  await completed(client, session.id, 1);
  const steps = () => { const database = new Database(join(root, "state.sqlite"), { readonly: true }); try { return (database.query("SELECT name, arguments_json FROM tool_calls ORDER BY rowid").all() as { name: string; arguments_json: string }[]); } finally { database.close(); } };
  expect(offered[0]).toContain(TOOL_SEARCH);
  expect(offered[0]).toContain(USE_TOOL);
  expect(offered[0]).toContain("read_file");
  expect(offered[0]).not.toContain("git_history");
  expect(offered[0]).not.toContain("foundry_save");
  expect(prompts[0]).toContain("More tools (not in your tool list");
  expect(prompts[0]).toContain("- git_history:");
  // The first call is answered with the tool's parameters, the second runs.
  expect(results[0]).toContain('"notRun":true');
  expect(results[0]).toContain('"name":"git_history"');
  expect(results[1]).not.toContain("notRun");
  // The step the person sees is the tool itself.
  expect(steps().map((step) => step.name)).toEqual([USE_TOOL, "git_history"]);
  expect(steps()[1]!.arguments_json).toBe('{"action":"log"}');
  await client.submitTurn(session.id, { content: "once again" });
  await completed(client, session.id, 2);
  // Known from the conversation: it runs at once.
  expect(steps().map((step) => step.name)).toEqual([USE_TOOL, "git_history", "git_history"]);
  await client.submitTurn(session.id, { content: "guess a name" });
  await completed(client, session.id, 3);
  expect(results.at(-1)).toContain("git_status_all is not one of them");
  // Nothing ever joined the tool list or the instructions.
  for (const list of offered) expect(list).toEqual(offered[0]!);
  for (const prompt of prompts) expect(prompt).toBe(prompts[0]!);
});
