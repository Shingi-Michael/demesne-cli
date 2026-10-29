import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneStore } from "@demesne/storage";
import { loadConfig } from "@demesne/config";
import { AssistantChat } from "../src/assistant.ts";
import { Routines } from "../src/routines.ts";

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
