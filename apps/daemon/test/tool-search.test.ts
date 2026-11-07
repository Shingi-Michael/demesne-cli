import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderToolDefinition } from "@demesne/providers";
import type { SessionStateResponse } from "@demesne/protocol";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import { createDaemonApp, type DaemonApp, type TurnProcessor } from "../src/app.ts";
import { moreToolsSection, searchTools, splitTools, summary, TOOL_SEARCH } from "../src/tool-search.ts";

const tool = (name: string, description: string, padding = 0): ProviderToolDefinition => ({ name, description: description + " x".repeat(padding), inputSchema: { type: "object", properties: {} } });
const definitions = [
  tool("read_file", "Read numbered lines."),
  tool("edit_file", "Edit a file."),
  tool("foundry_save", "Save a page, deck or document to Foundry. It keeps versions.", 1500),
  tool("git_history", "Show recent commits and who changed a file.", 400),
  tool("notify_phone", "Send a push notification to the user's phone.", 200),
];

test("everyday tools go whole; the rest wait behind tool_search", () => {
  const { sent, deferrable } = splitTools(definitions, new Set());
  expect(sent.map((one) => one.name)).toEqual(["read_file", "edit_file", TOOL_SEARCH]);
  expect(deferrable.map((one) => one.name)).toEqual(["foundry_save", "git_history", "notify_phone"]);
  const loaded = splitTools(definitions, new Set(["git_history"])).sent.map((one) => one.name);
  expect(loaded).toEqual(["read_file", "edit_file", "git_history", TOOL_SEARCH]);
  expect(splitTools(definitions, new Set(["foundry_save", "git_history", "notify_phone"])).sent.map((one) => one.name)).not.toContain(TOOL_SEARCH);
});

test("small sets aren't worth deferring", () => {
  const few = [tool("read_file", "Read."), tool("remember", "Remember a rule.")];
  expect(splitTools(few, new Set())).toEqual({ sent: few, deferrable: [] });
});

test("the list is one line per tool and never changes as tools load", () => {
  expect(summary(tool("a", "Save a page to Foundry. It keeps versions."))).toBe("Save a page to Foundry.");
  const { deferrable } = splitTools(definitions, new Set());
  const section = moreToolsSection(deferrable);
  expect(section).toContain("- foundry_save: Save a page, deck or document to Foundry.");
  expect(section).toContain("- notify_phone: Send a push notification to the user's phone.");
  expect(moreToolsSection(splitTools(definitions, new Set(["git_history"])).deferrable)).toBe(section);
});

test("tool_search finds by name, then by words", () => {
  const { deferrable } = splitTools(definitions, new Set());
  expect(searchTools(deferrable, { names: ["Foundry_Save"] }).found.map((one) => one.name)).toEqual(["foundry_save"]);
  expect(searchTools(deferrable, { query: "who changed this file, commits" }).found[0]!.name).toBe("git_history");
  expect(searchTools(deferrable, { query: "phone notification" }).found[0]!.name).toBe("notify_phone");
  const none = searchTools(deferrable, { query: "zzz" });
  expect(none.found).toEqual([]);
  expect(none.result).toContain("foundry_save, git_history, notify_phone");
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

test("a chat loads a tool once and keeps it for later turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-tool-search-")), workspace = mkdtempSync(join(tmpdir(), "demesne-tool-search-project-"));
  apps.push({ app: { close: async () => {} } as DaemonApp, root: workspace });
  const offered: string[][] = [], prompts: string[] = [], results: string[] = [];
  const stream: TurnProcessor["stream"] = async function* (messages, tools) {
    offered.push(tools.map((one) => one.name));
    prompts.push(String(messages[0]?.content ?? ""));
    for (const message of messages) if (message.role === "tool") results.push(String(message.content));
    const last = messages.at(-1);
    if (last?.role === "user" && String(last.content).includes("history")) {
      yield { type: "tool_call_delta", index: 0, idDelta: "search-1", nameDelta: TOOL_SEARCH, argumentsDelta: JSON.stringify({ names: ["git_history"] }) };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", delta: "Done." };
    yield { type: "finish", reason: "stop" };
  };
  const app = createDaemonApp({ databasePath: join(root, "state.sqlite"), heartbeat: { enabled: false }, deferTools: true, processor: { providerId: "test", modelId: "m", async listModels() { return []; }, stream } });
  apps.push({ app, root });
  const client = new DemesneClient({ server: "http://fixture", fetch: ((url, init) => Promise.resolve(app.fetch(new Request(url, init)))) as typeof fetch });
  const { session } = await client.createSession({ title: "Search", workspacePath: workspace, trustWorkspace: true });
  await client.submitTurn(session.id, { content: "show me the history of app.ts" });
  await completed(client, session.id, 1);
  expect(offered[0]).toContain(TOOL_SEARCH);
  expect(offered[0]).toContain("read_file");
  expect(offered[0]).not.toContain("git_history");
  expect(offered[0]).not.toContain("foundry_save");
  expect(prompts[0]).toContain("More tools (load with tool_search first");
  expect(prompts[0]).toContain("- git_history:");
  expect(offered[1]).toContain("git_history");
  expect(results.join("\n")).toContain('"loaded":["git_history"]');
  await client.submitTurn(session.id, { content: "thanks" });
  await completed(client, session.id, 2);
  expect(offered[2]).toContain("git_history");
  expect(prompts[2]).toBe(prompts[1]);
});
