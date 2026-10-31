import { describe, expect, test } from "bun:test";
import type { ProviderMessage } from "@demesne/providers";
import { keepLines, NoteFilter, renderNotes, splitNote, turnNote } from "../src/turn-notes.ts";

describe("turn notes", () => {
  test("the filter hides the note even when its tag arrives in pieces", () => {
    const filter = new NoteFilter();
    const shown = ["Done. The tests pass.\n\n<tu", "rn-no", "te>\nDecided: keep the lexer\n</turn-note>"].map((delta) => filter.push(delta)).join("") + filter.end();
    expect(shown).toBe("Done. The tests pass.");
  });

  test("text that only looks like the tag's start is shown at the round's end", () => {
    const filter = new NoteFilter();
    expect(filter.push("a < b and <t")).toBe("a < b and");
    expect(filter.end()).toBe(" <t");
  });

  test("a turn's note reads its ask, changes, commands and the model's lines", () => {
    const messages: ProviderMessage[] = [
      { role: "user", content: "Fix the parser" },
      { role: "assistant", content: null, toolCalls: [
        { id: "e", name: "edit_file", arguments: JSON.stringify({ path: "src/parser.ts" }) },
        { id: "r", name: "run_command", arguments: JSON.stringify({ command: "bun test" }) },
        { id: "w", name: "write_file", arguments: JSON.stringify({ path: "src/lexer.ts" }) },
      ] },
      { role: "tool", toolCallId: "e", content: JSON.stringify({ path: "src/parser.ts", replaced: 1 }) },
      { role: "tool", toolCallId: "r", content: JSON.stringify({ exitCode: 1, stdout: "1 fail" }) },
      { role: "tool", toolCallId: "w", content: JSON.stringify({ error: "Permission denied" }) },
      { role: "assistant", content: "Fixed the parser.\n<turn-note>\nDecided: a shared lexer, because both parsers need it\nKeep: the port is 4317\n</turn-note>" },
    ];
    expect(turnNote(messages)).toBe([
      "You asked: Fix the parser",
      "Changed: src/parser.ts",
      "Ran: bun test ✗ (exit 1)",
      "Failed: write_file src/lexer.ts: Permission denied",
      "Decided: a shared lexer, because both parsers need it",
      "Replied: Fixed the parser.",
    ].join("\n"));
    expect(splitNote(messages.at(-1)!.content as string).text).toBe("Fixed the parser.");
  });

  test("Keep holds the user's standing rules and the model's Keep lines, once each", () => {
    const keep = keepLines([
      { role: "user", content: "Make the button blue. Never push to main without asking." },
      { role: "assistant", content: "Done.<turn-note>Keep: the port is 4317</turn-note>" },
      { role: "user", content: "never push to main without asking!" },
    ], ["Branches: only main"]);
    expect(keep).toEqual(["Branches: only main", "Never push to main without asking.", "the port is 4317"]);
  });

  test("the stitched notes put Keep first, then each turn in order", () => {
    expect(renderNotes(["Never push"], ["You asked: a\nReplied: b", "You asked: c"])).toBe([
      "Summary of earlier turns, kept as notes. The full turns are in History.",
      "### Keep\nThe user's standing rules and lasting facts, word for word:\n- Never push",
      "### Turn notes, oldest first\n1. You asked: a\n   Replied: b\n2. You asked: c",
    ].join("\n\n"));
  });
});
