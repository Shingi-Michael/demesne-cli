import { describe, expect, test } from "bun:test";
import { derivePersistedRule } from "../src/allow-rules.ts";

describe("derivePersistedRule", () => {
  test("scopes path tools to the containing directory", () => {
    expect(derivePersistedRule("edit_file", { path: "src/util/a.ts" })).toBe("edit_file:src/util");
    expect(derivePersistedRule("write_file", JSON.stringify({ path: "src/new.ts" }))).toBe("write_file:src");
    expect(derivePersistedRule("move_path", { from: "src/a.ts", to: "lib/a.ts" })).toBe("move_path:src");
    expect(derivePersistedRule("delete_path", { path: "docs/old.md" })).toBe("delete_path:docs");
  });

  test("persists root-level files as their exact path", () => {
    expect(derivePersistedRule("edit_file", { path: "README.md" })).toBe("edit_file:README.md");
    expect(derivePersistedRule("edit_file", { path: "./src/a.ts" })).toBe("edit_file:src");
  });

  test("persists exact argv for whitespace-free commands", () => {
    expect(derivePersistedRule("run_command", { argv: ["git", "status"] })).toBe("run_command:git status");
    expect(derivePersistedRule("run_command", { argv: ["bun", "test", "--filter", "unit"] }))
      .toBe("run_command:bun test --filter unit");
  });

  test("returns null for unsupported or ambiguous requests", () => {
    expect(derivePersistedRule("run_command", { argv: ["echo", "hello world"] })).toBeNull();
    expect(derivePersistedRule("run_command", { argv: [] })).toBeNull();
    expect(derivePersistedRule("run_command", { argv: "git status" })).toBeNull();
    expect(derivePersistedRule("edit_file", {})).toBeNull();
    expect(derivePersistedRule(undefined, { path: "a.ts" })).toBeNull();
  });
});
