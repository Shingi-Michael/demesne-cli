import { expect, test } from "bun:test";
import { formatThreadNote, parseThreadNote, THREAD_NOTE_MAX_CHARS } from "@demesne/protocol";
import { toolTarget } from "@demesne/workbench/history.ts";
import { messageThreadTool } from "../src/threads.ts";

// What an orchestrator tells a thread is a short note that says what it is for.

const context = { sessionId: "orch" } as never;

test("a note carries its purpose and reads back the same", () => {
  const note = formatThreadNote({ purpose: "  The person wants\n3 ", text: "Use 3, not 2.\n\nKeep the test." });
  expect(note).toBe("From the orchestrator · The person wants 3\n\nUse 3, not 2.\n\nKeep the test.");
  expect(parseThreadNote(note)).toEqual({ purpose: "The person wants 3", text: "Use 3, not 2.\n\nKeep the test." });
  expect(parseThreadNote("Use 3, not 2.")).toBeNull();
  expect(formatThreadNote({ purpose: "x".repeat(200), text: "y" }).split("\n")[0]!.length).toBe("From the orchestrator · ".length + 80);
});

test("message_thread sends the note with its purpose, and refuses one with no purpose or too long", async () => {
  const sent: string[] = [];
  const tool = messageThreadTool({ message: (_from, _thread, text) => { sent.push(text); return { title: "Bump a", how: "steered" }; } });
  expect(tool.definition.inputSchema.required).toEqual(["thread", "purpose", "text"]);
  expect(await tool.execute({ thread: "bump a", purpose: "The person wants 3", text: "Use 3, not 2." }, context)).toContain('Told "Bump a"');
  expect(sent).toEqual(["From the orchestrator · The person wants 3\n\nUse 3, not 2."]);
  await expect(tool.execute({ thread: "bump a", text: "Use 3, not 2." }, context)).rejects.toThrow("needs a purpose");
  await expect(tool.execute({ thread: "bump a", purpose: "Everything", text: "x".repeat(THREAD_NOTE_MAX_CHARS + 1) }, context)).rejects.toThrow(`Keep it under ${THREAD_NOTE_MAX_CHARS}`);
  expect(sent).toHaveLength(1);
  // Its step in the orchestrator's chat names the thread and the purpose.
  expect(toolTarget("message_thread", { thread: "Bump a", purpose: "The person wants 3", text: "Use 3, not 2." })).toBe("Bump a · The person wants 3");
});
