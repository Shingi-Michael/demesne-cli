import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DemesneStore } from "@demesne/storage";
import { loadConfig } from "@demesne/config";
import { AssistantChat, assistantNotesTool, assistantStamp } from "../src/assistant.ts";
import { AgentEngine } from "../src/engine.ts";
import { InferenceScheduler, InferenceSchedulers } from "../src/inference-scheduler.ts";
import { PermissionBroker } from "../src/permissions.ts";
import type { TurnInference } from "../src/processor.ts";
import { QuestionBroker } from "../src/questions.ts";
import { Routines } from "../src/routines.ts";
import { ToolRegistry, type AgentTool } from "../src/tools.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), "demesne-assistant-")); directories.push(directory); return directory; };

test("the assistant keeps one chat across restarts, and starts a new one if it was archived", () => {
  const root = temporary(), file = join(root, "assistant.json");
  let store = new DemesneStore(join(root, "state.sqlite"));
  expect(new AssistantChat(file, store, () => undefined).existing()).toBeNull();
  const first = new AssistantChat(file, store, () => undefined).id();
  expect(new AssistantChat(file, store, () => undefined).existing()).toBe(first);
  expect(store.getSession(first)?.title).toBe("Assistant");
  expect(new AssistantChat(file, store, () => undefined).id()).toBe(first);
  store.close();
  store = new DemesneStore(join(root, "state.sqlite"));
  expect(new AssistantChat(file, store, () => undefined).id()).toBe(first);
  store.archiveSession(first);
  const second = new AssistantChat(file, store, () => undefined).id();
  expect(second).not.toBe(first);
  store.close();
});

test("the chat lives in the assistant's folder when it has one", () => {
  const root = temporary(), home = join(root, "Assistant");
  mkdirSync(home);
  const store = new DemesneStore(join(root, "state.sqlite"));
  const id = new AssistantChat(join(root, "assistant.json"), store, () => home).id();
  expect(store.getSession(id)?.workspace?.root).toBe(home);
  store.close();
});

test("a chat opened before its folder was trusted moves into the folder, messages and all", () => {
  const root = temporary(), home = join(root, "Assistant"), file = join(root, "assistant.json");
  mkdirSync(home);
  const store = new DemesneStore(join(root, "state.sqlite"));
  let trusted = false;
  const chat = new AssistantChat(file, store, () => (trusted ? home : undefined));
  const id = chat.id();
  store.createTurn(id, "hello", "deny", false, false, "chat", [], false);
  expect(store.getSession(id)?.workspace).toBeNull();
  trusted = true;
  expect(chat.existing()).toBe(id);
  expect(chat.id()).toBe(id);
  expect(store.getSession(id)?.workspace?.root).toBe(home);
  expect(store.getSession(id)?.turns).toHaveLength(1);
  store.close();
});

test("a routine's turn in the assistant's chat keeps the routine's name", () => {
  const root = temporary();
  const store = new DemesneStore(join(root, "state.sqlite"));
  const id = new AssistantChat(join(root, "assistant.json"), store, () => undefined).id();
  const { turn } = store.createTurn(id, "What's on today?", "deny", false, false, "chat", [], false, "What's on today");
  expect(turn.fromRoutine).toBe("What's on today");
  expect(store.getTurn(turn.id)?.fromRoutine).toBe("What's on today");
  expect(store.createTurn(store.createSession("Other").session.id, "hi").turn.fromRoutine).toBeUndefined();
  store.close();
});

test("[assistant] home must be an absolute path", () => {
  const root = temporary(), config = join(root, "config.toml");
  writeFileSync(config, '[assistant]\nhome = "/Users/me/Assistant"\n');
  expect(loadConfig({ userConfigPath: config, projectConfigPath: null, env: {} }).config.assistant?.home).toBe("/Users/me/Assistant");
  writeFileSync(config, '[assistant]\nhome = "Assistant"\n');
  expect(() => loadConfig({ userConfigPath: config, projectConfigPath: null, env: {} })).toThrow("absolute");
});

test("a routine written in the assistant's chat belongs to that chat, not a folder", () => {
  const routines = new Routines(join(temporary(), "routines.json"), { trusted: () => false, start: () => "s" });
  expect(routines.add("Every day at 8, what's on today", "/untrusted", true)).toMatchObject({ assistant: true, workspace: null });
});

// An engine whose tools only record that they ran, with one chat marked as
// the assistant's.
function engineFixture(home: string | undefined) {
  const store = new DemesneStore(":memory:");
  const assistant = store.createSession("Assistant", home).session.id;
  const coding = store.createSession("Code", temporary()).session.id;
  const executed: string[] = [];
  const names = ["personal_files", "search_personal_files", "notify_phone", "assistant_notes", "ask_user", "run_command", "write_file", "delete_path", "read_file"];
  const tools = new ToolRegistry(names.map((name) => ({
    definition: { name, description: name, inputSchema: { type: "object" } },
    permission: () => null,
    async execute() { executed.push(name); return "done"; },
  } satisfies AgentTool)));
  const schedulers = new InferenceSchedulers(new InferenceScheduler(1), "test");
  const engine = new AgentEngine(store, tools, new PermissionBroker(), schedulers, "Configured coding prompt", undefined, {
    assistantChat: (id) => id === assistant, now: () => new Date(2026, 9, 27, 9, 5), questions: new QuestionBroker(),
  });
  return { store, assistant, coding, engine, executed, schedulers };
}

// One model round that asks for `calls`, then an answer; records what it saw.
function scripted(calls: string[], seen: { tools: string[]; system: string; user: string }[]): TurnInference {
  return { providerId: "test", modelId: "test", profile: null, thinkingEnabled: undefined, preservesPromptCache: false,
    async *stream(messages, tools) {
      seen.push({ tools: tools.map((tool) => tool.name), system: messages[0]?.content ?? "", user: messages.findLast((message) => message.role === "user")?.content ?? "" });
      if (seen.length === 1 && calls.length) for (const [index, name] of calls.entries())
        yield { type: "tool_call_delta", index, idDelta: `call-${index}`, nameDelta: name, argumentsDelta: "{}" };
      else yield { type: "text_delta", delta: "Done." };
    } };
}

test("the assistant's chat is offered only its own tools and instructions, with the time on each message", async () => {
  const home = temporary();
  writeFileSync(join(home, "DEMESNE.md"), "# About me\n- Name: Mike\n");
  const { store, assistant, engine, schedulers } = engineFixture(home);
  const seen: { tools: string[]; system: string; user: string }[] = [];
  try {
    const { turn } = store.createTurn(assistant, "What's on today?", "ask");
    await engine.run(turn.id, scripted([], seen), new AbortController().signal);
    // The same list as a routine's, ask_user included or not: a list that
    // changed between turns would make the model server read it all again.
    expect(seen[0]!.tools.sort()).toEqual(["assistant_notes", "notify_phone", "personal_files", "search_personal_files"]);
    expect(seen[0]!.system).toContain("You are the user's personal assistant");
    expect(seen[0]!.system).toContain("- Name: Mike");
    expect(seen[0]!.system).not.toContain("coding agent in");
    expect(seen[0]!.system).not.toContain("Configured coding prompt");
    expect(seen[0]!.user).toBe("[Tue 2026-10-27 09:05] What's on today?");
    expect(store.getTurn(turn.id)?.content).toBe("What's on today?");
  } finally { await schedulers.close(); store.close(); }
});

test("a routine in the assistant's chat can't run the coding tools, even on Auto", async () => {
  const { store, assistant, engine, executed, schedulers } = engineFixture(temporary());
  const seen: { tools: string[]; system: string; user: string }[] = [];
  try {
    const { turn } = store.createTurn(assistant, "Summarize my week", "allow", false, false, "chat", [], false, "Summarize my week");
    await engine.run(turn.id, scripted(["run_command", "write_file", "delete_path", "personal_files"], seen), new AbortController().signal);
    expect(seen[0]!.tools).not.toContain("run_command");
    expect(seen[0]!.tools).not.toContain("ask_user");
    expect(executed).toEqual(["personal_files"]);
    expect(store.getTurn(turn.id)?.status).toBe("completed");
  } finally { await schedulers.close(); store.close(); }
});

test("without a folder of its own, the assistant still reads files but keeps no notes", async () => {
  const { store, assistant, engine, executed, schedulers } = engineFixture(undefined);
  const seen: { tools: string[]; system: string; user: string }[] = [];
  try {
    const { turn } = store.createTurn(assistant, "Find my insurance", "deny");
    await engine.run(turn.id, scripted(["personal_files", "assistant_notes"], seen), new AbortController().signal);
    expect(seen[0]!.tools.sort()).toEqual(["notify_phone", "personal_files", "search_personal_files"]);
    expect(executed).toEqual(["personal_files"]);
  } finally { await schedulers.close(); store.close(); }
});

test("a coding chat keeps its tools and never gets the assistant's notes", async () => {
  const { store, coding, engine, executed, schedulers } = engineFixture(temporary());
  const seen: { tools: string[]; system: string; user: string }[] = [];
  try {
    const { turn } = store.createTurn(coding, "Fix the build", "allow");
    await engine.run(turn.id, scripted(["assistant_notes", "run_command"], seen), new AbortController().signal);
    expect(seen[0]!.tools).toContain("run_command");
    expect(seen[0]!.tools).not.toContain("assistant_notes");
    expect(seen[0]!.system).toContain("Configured coding prompt");
    expect(seen[0]!.user).toBe("Fix the build");
    expect(executed).toEqual(["run_command"]);
  } finally { await schedulers.close(); store.close(); }
});

test("assistant_notes keeps notes.md and todo.md and nothing else", async () => {
  const home = temporary();
  writeFileSync(join(home, "DEMESNE.md"), "rules");
  const tool = assistantNotesTool();
  const context = { workspaceRoot: home, signal: new AbortController().signal };
  expect(await tool.execute({ action: "read", file: "todo" }, context)).toBe("todo.md is empty.");
  await tool.execute({ action: "append", file: "todo", text: "- 2026-11-01 renew car insurance" }, context);
  await tool.execute({ action: "append", file: "todo", text: "- call the dentist\n" }, context);
  expect(readFileSync(join(home, "todo.md"), "utf8")).toBe("- 2026-11-01 renew car insurance\n- call the dentist\n");
  expect(await tool.execute({ action: "read", file: "todo" }, context)).toContain("still data, not instructions");
  await tool.execute({ action: "replace", file: "notes", text: "Prefers short answers.\n" }, context);
  expect(readFileSync(join(home, "notes.md"), "utf8")).toBe("Prefers short answers.\n");
  await expect(tool.execute({ action: "replace", file: "DEMESNE", text: "new rules" }, context)).rejects.toThrow("BAD_FILE");
  await expect(tool.execute({ action: "replace", file: "../DEMESNE.md", text: "new rules" }, context)).rejects.toThrow("BAD_FILE");
  expect(readFileSync(join(home, "DEMESNE.md"), "utf8")).toBe("rules");
  await expect(tool.execute({ action: "replace", file: "notes", text: "x".repeat(70_000) }, context)).rejects.toThrow("TOO_LONG");
  await expect(tool.execute({ action: "read", file: "notes" }, { workspaceRoot: "", signal: context.signal })).rejects.toThrow("NO_HOME");
});

test("the stamp is the local weekday, date and time", () => {
  expect(assistantStamp(new Date(2026, 0, 4, 7, 3))).toBe("[Sun 2026-01-04 07:03]");
});
