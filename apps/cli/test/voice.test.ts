import { describe, expect, test } from "bun:test";
import { narrateToolIntent, narrateToolOutcome, narrateTurnEnd, narrateWaiting } from "../src/voice.ts";

describe("narrateToolOutcome", () => {
  test("narrates reads, edits, and commands in the first person", () => {
    expect(narrateToolOutcome("read_file", { path: "src/lexer.ts" }, { state: "done" })).toBe("I read src/lexer.ts.");
    expect(narrateToolOutcome("read_files", { paths: ["a.ts", "b.ts"] }, { state: "done" })).toBe("I read 2 files.");
    expect(narrateToolOutcome("edit_file", { path: "src/lexer.ts" }, { state: "done" })).toBe("I changed src/lexer.ts.");
    expect(narrateToolOutcome("run_command", { argv: ["bun", "test"] }, { state: "done", exitCode: 0 }))
      .toBe("I ran `bun test` — it passed.");
    expect(narrateToolOutcome("run_command", { argv: ["bun", "test"] }, { state: "done", exitCode: 1 }))
      .toBe("I ran `bun test` — exit 1.");
  });
  test("keeps composite commands readable", () => {
    expect(narrateToolOutcome("run_command", { argv: ["bun", "t", "x"] }, { state: "done", exitCode: 0 }))
      .toBe("I ran `bun t x` — it passed.");
  });

  test("distinguishes created and written files", () => {
    expect(narrateToolOutcome("write_file", { path: "new.ts" }, { state: "done", created: true })).toBe("I created new.ts.");
    expect(narrateToolOutcome("write_file", { path: "old.ts" }, { state: "done" })).toBe("I wrote old.ts.");
  });

  test("describes moves, deletes, and git checks", () => {
    expect(narrateToolOutcome("move_path", { from: "a.ts", to: "lib/a.ts" }, { state: "done" }))
      .toBe("I moved a.ts to lib/a.ts.");
    expect(narrateToolOutcome("delete_path", { path: "old.md" }, { state: "done" })).toBe("I deleted old.md.");
    expect(narrateToolOutcome("git_status", {}, { state: "done" })).toBe("I checked git.");
  });

  test("narrates failures and denials honestly", () => {
    expect(narrateToolOutcome("read_file", { path: "x.ts" }, { state: "failed", message: "EACCES: denied" }))
      .toContain("couldn’t read x.ts.");
    expect(narrateToolOutcome("write_file", { path: "x.ts" }, { state: "denied" }))
      .toContain("didn’t write x.ts.");
  });

  test("namespaces MCP tools", () => {
    expect(narrateToolOutcome("mcp__files__read_file", { path: "/tmp/x" }, { state: "done" }))
      .toBe("I used files’s read_file.");
  });

  test("handles missing arguments gracefully", () => {
    expect(narrateToolOutcome("run_command", {}, { state: "done" })).toBe("I ran a command — it passed.");
    expect(narrateToolOutcome("search_files", {}, { state: "done" })).toBe("I searched for something.");
    expect(narrateToolOutcome("unknown_tool", {}, { state: "done" })).toBe("I finished with unknown_tool.");
  });
});

describe("narrateToolIntent", () => {
  test("describes a pending action in the first person", () => {
    expect(narrateToolIntent("edit_file", { path: "src/lexer.ts" })).toBe("I’m changing src/lexer.ts.");
    expect(narrateToolIntent("run_command", { argv: ["rm", "x"] })).toBe("I’m running `rm x`.");
  });
});

describe("narrateTurnEnd", () => {
  test("closes turns in the agent's voice", () => {
    expect(narrateTurnEnd("completed", "1.2s · 1 round · 3 tools")).toBe("I’m done — 1.2s · 1 round · 3 tools");
    expect(narrateTurnEnd("stopped", "after 4.1s I kept 3 findings")).toBe("I stopped — after 4.1s I kept 3 findings");
    expect(narrateTurnEnd("failed", "the provider timed out")).toBe("I hit a problem — the provider timed out");
  });
});

describe("narrateWaiting", () => {
  test("asks for approval in the first person", () => {
    expect(narrateWaiting("write_file: src/x.ts")).toBe("I need your go-ahead: write_file: src/x.ts");
  });
});