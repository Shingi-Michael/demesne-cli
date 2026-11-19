import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderMessage } from "@demesne/providers";
import { DemesneStore } from "@demesne/storage";
import { AgentEngine, agentSystemPrompt } from "../src/engine.ts";
import type { TurnInference } from "../src/processor.ts";
import { NOTES_GUIDANCE, noteStates, notesFor, PLAN_NOTE, unattendedNote, withNotes, withoutNotes } from "../src/chat-notes.ts";
import { InferenceScheduler, InferenceSchedulers } from "../src/inference-scheduler.ts";
import { PermissionBroker } from "../src/permissions.ts";
import { ToolRegistry, type AgentTool } from "../src/tools.ts";

const usual = { planOnly: false, autoApprove: false, acceptEdits: false, attended: true, canAsk: true, noting: false };
const user = (content: string, notes?: { kind: string; text: string }[]): ProviderMessage => ({ role: "user", content, ...(notes ? { notes } : {}) });

test("a chat in its usual state carries no notes, and its instructions say what a note is", () => {
  expect(notesFor(noteStates(usual), [])).toEqual([]);
  expect(agentSystemPrompt({ workspaceRoot: "/workspace", definitions: [] })).toContain(NOTES_GUIDANCE);
});

test("a change is said once, with the message it came with, and again only when it changes back", () => {
  const first = notesFor(noteStates({ ...usual, autoApprove: true, context: "Drive: 1 of 6 runs used today." }), []);
  expect(first.map((note) => note.kind)).toEqual(["approvals", "context"]);
  const history = [user("Start", first)];
  // Nothing changed: nothing is said again.
  expect(notesFor(noteStates({ ...usual, autoApprove: true, context: "Drive: 1 of 6 runs used today." }), history)).toEqual([]);
  // What Drive is doing changed: only that is said.
  const second = notesFor(noteStates({ ...usual, autoApprove: true, context: "Drive: 2 of 6 runs used today." }), history);
  expect(second).toEqual([{ kind: "context", text: "Drive: 2 of 6 runs used today." }]);
  // Back to usual is said once, then not again.
  const off = notesFor(noteStates(usual), [...history, user("More", second)]);
  expect(off.map((note) => note.kind)).toEqual(["approvals", "context"]);
  expect(off[0]!.text).toStartWith("Approvals are back to usual");
  expect(notesFor(noteStates(usual), [...history, user("More", second), user("Again", off)])).toEqual([]);
});

test("plan mode and a long chat's hidden note are said with every message while they hold", () => {
  const on = noteStates({ ...usual, planOnly: true, noting: true });
  const first = notesFor(on, []);
  expect(first.map((note) => note.kind)).toEqual(["plan", "long-chat"]);
  expect(first[0]!.text).toBe(PLAN_NOTE);
  expect(notesFor(on, [user("Plan it", first)])).toEqual(first);
  const after = notesFor(noteStates(usual), [user("Plan it", first)]);
  expect(after).toEqual([{ kind: "plan", text: "Plan mode is off: edits and commands are available again." }]);
});

test("a turn nobody watches is told what is refused, and whether it may ask", () => {
  expect(unattendedNote(false)).toContain("and so is ask_user");
  expect(unattendedNote(true)).not.toContain("ask_user");
  const away = notesFor(noteStates({ ...usual, attended: false, canAsk: false }), []);
  expect(away).toEqual([{ kind: "window", text: unattendedNote(false) }]);
  expect(notesFor(noteStates(usual), [user("Go", away)])[0]!.text).toStartWith("The person is at the window again");
});

test("notes that left with compacted turns are said again", () => {
  const states = noteStates({ ...usual, sources: "## Sources the person keeps with this chat\n- a1: file notes.md" });
  const first = notesFor(states, []);
  expect(notesFor(states, [user("Kept", first)])).toEqual([]);
  // The turn that carried the note was swapped for a summary.
  expect(notesFor(states, [{ role: "assistant", content: "Earlier summary" }, user("Later")])).toEqual(first);
});

test("the provider gets a message's notes after its text; the stored message keeps them apart", () => {
  const notes = [{ kind: "plan", text: PLAN_NOTE }];
  const sent = withNotes(user("Plan the change", notes));
  expect(sent).toEqual({ role: "user", content: `Plan the change\n\n<system-note>\n${PLAN_NOTE}\n</system-note>` });
  expect(withoutNotes(sent.content as string)).toBe("Plan the change");
  expect(withoutNotes("No notes here")).toBe("No notes here");
  const plain = user("Hello");
  expect(withNotes(plain)).toBe(plain);

  const directory = mkdtempSync(join(tmpdir(), "demesne-notes-"));
  const store = new DemesneStore(join(directory, "demesne.sqlite"));
  try {
    const { session } = store.createSession("Notes");
    const { turn } = store.createTurn(session.id, "Plan the change");
    store.startTurn(turn.id);
    store.appendModelMessage(turn.id, { role: "user", content: "Plan the change", notes });
    store.appendModelMessage(turn.id, { role: "assistant", content: "1. Read." });
    store.completeTurn(turn.id);
    expect(store.getModelContextTranscript(session.id)[0]!.message).toEqual({ role: "user", content: "Plan the change", notes });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("open and show stay in the tool list on a turn nobody watches, and are refused where they run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "demesne-notes-"));
  const store = new DemesneStore(join(directory, "demesne.sqlite"));
  const executed: string[] = [];
  const tools = new ToolRegistry(["open", "show", "read_file"].map((name) => ({
    definition: { name, description: name, inputSchema: { type: "object" } },
    permission: () => null,
    async execute() { executed.push(name); return "done"; },
  } satisfies AgentTool)));
  const schedulers = new InferenceSchedulers(new InferenceScheduler(1), "test");
  const engine = new AgentEngine(store, tools, new PermissionBroker(), schedulers);
  const offered: string[][] = [], results: string[] = [];
  let round = 0;
  const model: TurnInference = { providerId: "test", modelId: "test", profile: null, thinkingEnabled: undefined, preservesPromptCache: false,
    async *stream(messages, definitions) {
      offered.push(definitions.map((tool) => tool.name));
      const last = messages.at(-1)!;
      if (last.role === "tool") { results.push(String(last.content)); yield { type: "text_delta", delta: "Done." }; return; }
      yield { type: "tool_call_delta", index: 0, idDelta: `show-${round++}`, nameDelta: "show", argumentsDelta: JSON.stringify({ path: "notes.md" }) };
    } };
  try {
    const { session } = store.createSession("Window", directory);
    await engine.run(store.createTurn(session.id, "Show me the notes", "ask").turn.id, model, new AbortController().signal);
    await engine.run(store.createTurn(session.id, "And again, on your own", "allow").turn.id, model, new AbortController().signal);
    expect(offered[2]).toEqual(offered[0]!);
    expect(offered[0]).toContain("show");
    expect(executed).toEqual(["show"]);
    expect(results[1]).toStartWith("Error: show is for a chat the person is in");
  } finally { await schedulers.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
