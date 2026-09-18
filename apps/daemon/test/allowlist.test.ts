import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowRuleMatches, ConfigAllowlist, parseAllowRule } from "../src/allowlist.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-allowlist-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("parseAllowRule", () => {
  test("parses bare tools, path scopes, and command argv", () => {
    expect(parseAllowRule("list_files")).toEqual({ tool: "list_files", raw: "list_files" });
    expect(parseAllowRule("edit_file:src")).toEqual({ tool: "edit_file", pathPrefix: "src", raw: "edit_file:src" });
    expect(parseAllowRule("run_command:git status")).toEqual({
      tool: "run_command",
      argv: ["git", "status"],
      raw: "run_command:git status",
    });
  });

  test("rejects a bare run_command rule and malformed entries", () => {
    expect(parseAllowRule("run_command")).toBeNull();
    expect(parseAllowRule("")).toBeNull();
    expect(parseAllowRule("edit_file:")).toBeNull();
    expect(parseAllowRule(":src")).toBeNull();
  });
});

describe("allowRuleMatches", () => {
  test("matches an exact argv prefix with word boundaries", () => {
    const rule = parseAllowRule("run_command:git status")!;
    expect(allowRuleMatches(rule, "run_command", { argv: ["git", "status"] })).toBe(true);
    expect(allowRuleMatches(rule, "run_command", { argv: ["git", "status", "--short"] })).toBe(true);
    expect(allowRuleMatches(rule, "run_command", { argv: ["git", "statusx"] })).toBe(false);
    expect(allowRuleMatches(rule, "run_command", { argv: ["git"] })).toBe(false);
    expect(allowRuleMatches(rule, "run_command", { argv: "git status" })).toBe(false);
    expect(allowRuleMatches(rule, "edit_file", { path: "src/a.ts" })).toBe(false);
  });

  test("matches a path scope only at directory boundaries", () => {
    const rule = parseAllowRule("edit_file:src")!;
    expect(allowRuleMatches(rule, "edit_file", { path: "src/a.ts" })).toBe(true);
    expect(allowRuleMatches(rule, "edit_file", { path: "src/deep/b.ts" })).toBe(true);
    expect(allowRuleMatches(rule, "edit_file", { path: "src" })).toBe(true);
    expect(allowRuleMatches(rule, "edit_file", { path: "src2/a.ts" })).toBe(false);
    expect(allowRuleMatches(rule, "edit_file", { path: "./src/a.ts" })).toBe(true);
    expect(allowRuleMatches(parseAllowRule("move_path:src")!, "move_path", { from: "src/a.ts", to: "lib/a.ts" })).toBe(true);
    expect(allowRuleMatches(parseAllowRule("move_path:lib")!, "move_path", { from: "src/a.ts", to: "lib/a.ts" })).toBe(false);
  });

  test("a bare tool rule matches any input for that tool", () => {
    const rule = parseAllowRule("edit_file")!;
    expect(allowRuleMatches(rule, "edit_file", { path: "anything.ts" })).toBe(true);
    expect(allowRuleMatches(rule, "write_file", { path: "anything.ts" })).toBe(false);
  });
});

describe("ConfigAllowlist", () => {
  test("loads valid rules and reports invalid entries", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "config.toml");
    writeFileSync(path, `
[permissions]
allow = ["edit_file:src", "run_command:git status", "run_command", ""]
`);
    const allowlist = new ConfigAllowlist(path);
    expect(allowlist.rulesFor()).toEqual([
      { tool: "edit_file", pathPrefix: "src", raw: "edit_file:src" },
      { tool: "run_command", argv: ["git", "status"], raw: "run_command:git status" },
    ]);
    expect(allowlist.invalidEntries()).toEqual(["run_command", ""]);
  });

  test("returns no rules for a missing file or missing section", () => {
    const directory = temporaryDirectory();
    expect(new ConfigAllowlist(join(directory, "missing.toml")).rulesFor()).toEqual([]);
    const path = join(directory, "config.toml");
    writeFileSync(path, `theme = "dark"\n`);
    expect(new ConfigAllowlist(path).rulesFor()).toEqual([]);
  });

  test("reloads when the file mtime changes", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "config.toml");
    writeFileSync(path, `[permissions]\nallow = ["edit_file:src"]\n`);
    const allowlist = new ConfigAllowlist(path);
    expect(allowlist.rulesFor()).toHaveLength(1);

    writeFileSync(path, `[permissions]\nallow = ["edit_file:src", "write_file:docs"]\n`);
    const future = new Date(Date.now() + 2_000);
    utimesSync(path, future, future);
    expect(allowlist.rulesFor()).toHaveLength(2);
  });

  test("keeps previous rules when the file becomes unparseable", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "config.toml");
    writeFileSync(path, `[permissions]\nallow = ["edit_file:src"]\n`);
    const allowlist = new ConfigAllowlist(path);
    expect(allowlist.rulesFor()).toHaveLength(1);

    writeFileSync(path, `[permissions\nallow = `);
    const future = new Date(Date.now() + 2_000);
    utimesSync(path, future, future);
    expect(allowlist.rulesFor()).toHaveLength(1);
  });
});
