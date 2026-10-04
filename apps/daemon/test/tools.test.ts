import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalWorkspace, listWorkspaceFiles, ToolRegistry } from "../src/tools.ts";
import { agentSystemPrompt, ANSWER_FORMAT_GUIDANCE, defaultSystemPrompt, planModeDefinitions, planModeGuidance, selectToolsForTurn, turnToolGuidance } from "../src/engine.ts";
import { applyEdits, EditApplyError } from "../src/edit-engine.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("built-in tools", () => {
  test("steers qualitative inspection away from redundant host commands", () => {
    const prompt = defaultSystemPrompt("/workspace");
    const definitions = new ToolRegistry().definitions();
    const command = definitions.find((tool) => tool.name === "run_command");

    expect(prompt).toContain("Use purpose-built tools, never run_command");
    expect(prompt).toContain("do not compute line counts, file counts, or disk usage unless requested");
    expect(command?.description).toContain("do not use for file listing, reading, searching, or unsolicited counts");
    expect(selectToolsForTurn(definitions, "give me a summary of this folder. you can tabulate it").map((tool) => tool.name))
      .toEqual(["list_files", "read_file", "read_files", "search_files"]);
    expect(turnToolGuidance("give me a summary of this folder. you can tabulate it"))
      .toContain("use one initial tool round");
    expect(selectToolsForTurn(definitions, "summarize this project and count its lines")).toEqual(definitions);
    expect(turnToolGuidance("summarize this project and count its lines")).toBeNull();
    expect(selectToolsForTurn(definitions, "summarize this repository and fix the failing tests")).toEqual(definitions);
    expect(turnToolGuidance("summarize this repository and fix the failing tests")).toBeNull();
    // Drive's real request: asking for sub-agents keeps every tool, subagent included.
    const drive = "Use subagents to read files in the current workspace. First identify available project files, then delegate distinct files or small groups to subagents for read-only inspection. Have them report the paths actually read and concise findings; summarize those results.";
    expect(selectToolsForTurn(definitions, drive)).toEqual(definitions);
    expect(turnToolGuidance(drive)).toBeNull();
    expect(selectToolsForTurn(definitions, "send a sub-agent to give me an overview of this project")).toEqual(definitions);
  });

  test("plan mode restricts tool definitions and explains the boundary", () => {
    const definitions = new ToolRegistry().definitions();
    const readOnly = planModeDefinitions(definitions, true).map((tool) => tool.name).sort();
    expect(readOnly).toEqual(["ask_user", "git_diff", "git_status", "list_files", "read_file", "read_files", "search_files"]);
    expect(planModeDefinitions(definitions, false)).toEqual(definitions);
    expect(planModeGuidance(true)).toContain("read-only");
    expect(planModeGuidance(false)).toBeNull();
  });

  test("lists workspace files for mentions without sensitive or dependency paths", () => {    const root = workspace();
    writeFileSync(join(root, "README.md"), "docs\n");
    writeFileSync(join(root, "src", "main.ts"), "export {};\n");
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    writeFileSync(join(root, "id_rsa"), "key\n");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = {};\n");

    expect(listWorkspaceFiles(root)).toEqual(["README.md", "src/main.ts"]);
    expect(listWorkspaceFiles(root, 1)).toHaveLength(1);
  });

  test("keeps reads inside the workspace and excludes sensitive files and symlinks", async () => {
    const root = workspace();
    writeFileSync(join(root, "visible.txt"), "alpha\nbeta\n");
    writeFileSync(join(root, ".env"), "SECRET=value\n");
    mkdirSync(join(root, "node_modules", "dependency"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dependency", "index.js"), "export {};\n");
    symlinkSync("/etc/passwd", join(root, "escape"));
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const listed = JSON.parse(await tools.get("list_files")!.execute({}, context));
    expect(listed.files).toEqual(["visible.txt"]);
    expect(listed.directories).toEqual(["src"]);
    expect(listed.ignoredDirectories).toEqual(["node_modules"]);
    expect(listed.returnedFiles).toBe(1);
    const rootAlias = JSON.parse(await tools.get("list_files")!.execute({ path: "/" }, context));
    expect(rootAlias.files).toEqual(listed.files);
    await expect(tools.get("read_file")!.execute({ path: "../outside" }, context)).rejects.toThrow("traversal");
    await expect(tools.get("read_file")!.execute({ path: "escape" }, context)).rejects.toThrow("symlinks");
    await expect(tools.get("read_file")!.execute({ path: ".env" }, context)).rejects.toThrow("SENSITIVE_PATH");

    // Tool definitions must be sorted alphabetically for KV cache prefix stability
    const names = tools.definitions().map((d) => d.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  test("searches text and applies conflict-checked exact edits", async () => {
    const root = workspace();
    writeFileSync(join(root, "code.ts"), "const answer = 41;\n");
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const searched = JSON.parse(await tools.get("search_files")!.execute({ query: "answer" }, context));
    expect(searched.matches).toEqual(["code.ts:1:const answer = 41;"]);
    expect(tools.get("edit_file")!.permission({ path: "code.ts", oldText: "41", newText: "42" }))
      .toEqual({ kind: "write", summary: "edit code.ts" });
    await tools.get("edit_file")!.execute({ path: "code.ts", oldText: "41", newText: "42" }, context);
    expect(readFileSync(join(root, "code.ts"), "utf8")).toBe("const answer = 42;\n");
    await expect(tools.get("edit_file")!.execute({ path: "code.ts", oldText: "missing", newText: "x" }, context))
      .rejects.toThrow("not found");
  });

  test("runs direct argv with a minimal environment", async () => {
    const root = workspace();
    process.env.DEMESNE_SECRET_CANARY = "must-not-leak";
    try {
      const tool = new ToolRegistry().get("run_command")!;
      const result = JSON.parse(await tool.execute(
        { argv: ["/usr/bin/env"], timeoutMs: 5_000 },
        { workspaceRoot: root, signal: new AbortController().signal },
      ));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("DEMESNE_SECRET_CANARY");
      expect(tool.permission({ argv: ["/usr/bin/env"] })?.kind).toBe("execute");
    } finally {
      delete process.env.DEMESNE_SECRET_CANARY;
    }
  });

  test("run_command bounds verbose output while retaining its head and tail", async () => {
    const root = workspace();
    const tool = new ToolRegistry().get("run_command")!;
    const result = JSON.parse(await tool.execute({
      argv: [process.execPath, "-e", 'process.stdout.write("HEAD" + "x".repeat(65536) + "TAIL")'],
    }, { workspaceRoot: root, signal: new AbortController().signal }));

    expect(result.exitCode).toBe(0);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutBytes).toBe(65544);
    expect(result.stdout).toStartWith("HEAD");
    expect(result.stdout).toEndWith("TAIL");
    expect(result.stdout).toContain("49160 bytes omitted");
  });

  test("edit engine falls back from exact to line to whitespace matching", () => {
    const exact = applyEdits({ current: "alpha beta\ngamma\n", hunks: [{ oldText: "beta", newText: "BETA" }] });
    expect(exact).toMatchObject({ strategy: "exact", replacements: 1, content: "alpha BETA\ngamma\n" });

    const lines = applyEdits({
      current: "function a() {\n    return 1;\n}\n",
      hunks: [{ oldText: "function a() {\n\treturn 1;\n}", newText: "function a() {\n  return 2;\n}" }],
    });
    expect(lines.strategy).toBe("lines");
    expect(lines.content).toBe("function a() {\n  return 2;\n}\n");

    const tolerant = applyEdits({
      current: "const value = compute( x,y );\n",
      hunks: [{ oldText: "compute(x, y)", newText: "compute(z)" }],
    });
    expect(tolerant.strategy).toBe("whitespace");
    expect(tolerant.content).toBe("const value = compute(z);\n");
  });

  test("edit engine reports ambiguity and not-found with hunk context", () => {
    expect(() => applyEdits({ current: "x\nx\n", hunks: [{ oldText: "x", newText: "y" }] }))
      .toThrow(EditApplyError);
    const all = applyEdits({ current: "x\nx\n", hunks: [{ oldText: "x", newText: "y", all: true }] });
    expect(all.content).toBe("y\ny\n");
    expect(all.replacements).toBe(2);

    try {
      applyEdits({ current: "one\ntwo\n", hunks: [{ oldText: "three", newText: "z" }] });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(EditApplyError);
      expect((error as EditApplyError).message).toContain("not found");
    }
  });

  test("edit_file applies multi-hunk batches atomically", async () => {
    const root = workspace();
    writeFileSync(join(root, "config.txt"), "a=1\nb=2\n");
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const result = JSON.parse(await tools.get("edit_file")!.execute({
      path: "config.txt",
      edits: [
        { oldText: "a=1", newText: "a=10" },
        { oldText: "b = 2", newText: "b=20" },
      ],
    }, context));
    expect(readFileSync(join(root, "config.txt"), "utf8")).toBe("a=10\nb=20\n");
    expect(result).toMatchObject({ strategy: "whitespace", replacements: 2 });
  });

  test("edit_file appends with newline normalization and creates missing files", async () => {
    const root = workspace();
    writeFileSync(join(root, "log.txt"), "first");
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    await tools.get("edit_file")!.execute({ path: "log.txt", mode: "append", newText: "\nsecond" }, context);
    expect(readFileSync(join(root, "log.txt"), "utf8")).toBe("first\nsecond");

    await tools.get("edit_file")!.execute({ path: "new.txt", mode: "append", newText: "hello\n" }, context);
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("hello\n");
  });

  test("edit_file keeps legacy create and empty-oldText errors intact", async () => {
    const root = workspace();
    writeFileSync(join(root, "exists.txt"), "data\n");
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const created = JSON.parse(await tools.get("edit_file")!.execute(
      { path: "fresh.txt", oldText: "", newText: "body\n" },
      context,
    ));
    expect(created.created).toBe(true);
    expect(created.strategy).toBe("create");
    await expect(tools.get("edit_file")!.execute({ path: "exists.txt", oldText: "", newText: "nope" }, context))
      .rejects.toThrow("EMPTY_OLD_TEXT");
  });

  test("read_file returns a small file whole, so a model never pages through it", async () => {
    const root = workspace();
    writeFileSync(join(root, "short.txt"), Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    // A slice of a file that fits comes back as the whole file.
    for (const input of [{ path: "short.txt", offset: 28, limit: 10 }, { path: "short.txt", limit: 5 }]) {
      const read = JSON.parse(await tools.get("read_file")!.execute(input, context));
      expect(read).toMatchObject({ totalLines: 30, range: { from: 1, to: 30 }, truncated: false, remainingLines: 0 });
      expect(read).not.toHaveProperty("nextOffset");
    }
  });

  test("long files read in large windows: at least 200 lines, default 400 (read_files 200)", async () => {
    const root = workspace();
    writeFileSync(join(root, "long.txt"), Array.from({ length: 1000 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const single = JSON.parse(await tools.get("read_file")!.execute({ path: "long.txt" }, context));
    expect(single).toMatchObject({ range: { from: 1, to: 400 }, remainingLines: 600, nextOffset: 401 });

    const slice = JSON.parse(await tools.get("read_file")!.execute({ path: "long.txt", offset: 500, limit: 20 }, context));
    expect(slice).toMatchObject({ range: { from: 500, to: 699 }, nextOffset: 700 });

    const batched = JSON.parse(await tools.get("read_files")!.execute({ files: [{ path: "long.txt" }] }, context));
    expect(batched.results[0]).toMatchObject({ range: { from: 1, to: 200 }, remainingLines: 800, nextOffset: 201 });

    const explicit = JSON.parse(await tools.get("read_files")!.execute({ files: [{ path: "long.txt", offset: 601, limit: 500 }] }, context));
    expect(explicit.results[0]).toMatchObject({ range: { from: 601, to: 1000 }, truncated: false });
    expect(explicit.results[0]).not.toHaveProperty("nextOffset");
  });

  test("list_files filters with glob patterns", async () => {
    const root = workspace();
    mkdirSync(join(root, "src", "util"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export {};\n");
    writeFileSync(join(root, "src", "util", "helper.ts"), "export {};\n");
    writeFileSync(join(root, "README.md"), "# demo\n");
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const listed = JSON.parse(await tools.get("list_files")!.execute({ pattern: "src/**/*.ts" }, context));
    expect(listed.files).toEqual(["src/app.ts", "src/util/helper.ts"]);
    expect(listed.directories).toEqual(["docs", "src"]);

    const single = JSON.parse(await tools.get("list_files")!.execute({ pattern: "*.md" }, context));
    expect(single.files).toEqual(["README.md"]);
  });

  test("search_files supports include globs and deterministic line format", async () => {
    const root = workspace();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "const needle = 1;\n");
    writeFileSync(join(root, "docs", "b.md"), "needle here\n");
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const all = JSON.parse(await tools.get("search_files")!.execute({ query: "needle" }, context));
    expect(all.matches).toEqual(["docs/b.md:1:needle here", "src/a.ts:1:const needle = 1;"]);

    const filtered = JSON.parse(await tools.get("search_files")!.execute({ query: "needle", include: "src/**" }, context));
    expect(filtered.matches).toEqual(["src/a.ts:1:const needle = 1;"]);
  });

  test("list and search defaults are bounded but accept explicit limits", async () => {
    const root = workspace();
    for (let index = 1; index <= 220; index += 1) {
      writeFileSync(join(root, `entry-${String(index).padStart(3, "0")}.txt`), `needle ${index}\n`);
    }
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const listed = JSON.parse(await tools.get("list_files")!.execute({}, context));
    expect(listed.files).toHaveLength(200);
    expect(listed.truncated).toBe(true);
    const explicitList = JSON.parse(await tools.get("list_files")!.execute({ limit: 220 }, context));
    expect(explicitList.files).toHaveLength(220);

    const searched = JSON.parse(await tools.get("search_files")!.execute({ query: "needle" }, context));
    expect(searched.matches).toHaveLength(50);
    expect(searched.truncated).toBe(true);
    const explicitSearch = JSON.parse(await tools.get("search_files")!.execute({ query: "needle", limit: 220 }, context));
    expect(explicitSearch.matches).toHaveLength(220);
  });

  test.each(["ripgrep", "fallback"] as const)("search filename globs match nested files and count only accepted lines with %s", async (backend) => {
    if (backend === "ripgrep" && !Bun.which("rg")) throw new Error("This regression requires ripgrep");
    const which = backend === "fallback" ? spyOn(Bun, "which").mockReturnValue(null) : undefined;
    try {
      const root = workspace();
      mkdirSync(join(root, "src/nested"), { recursive: true });
      mkdirSync(join(root, ".ssh"));
      writeFileSync(join(root, "a.txt"), "needle ignored\n".repeat(300));
      writeFileSync(join(root, "src/nested/parser.ts"), "needle parser\nneedle lexer\nneedle tests\n");
      writeFileSync(join(root, ".ssh/config"), "needle private\n");
      const tool = new ToolRegistry().get("search_files")!;
      const context = { workspaceRoot: root, signal: new AbortController().signal };
      for (const input of [
        { include: "*.ts" }, { include: "**/*.ts" },
        { path: "src", include: "nested/*.ts" }, { path: "src/nested/parser.ts", include: "*.ts" },
      ]) {
        const result = JSON.parse(await tool.execute({ query: "needle", limit: 2, ...input }, context));
        expect(result).toEqual({ matches: ["src/nested/parser.ts:1:needle parser", "src/nested/parser.ts:2:needle lexer"], truncated: true });
      }
      const exact = JSON.parse(await tool.execute({ query: "needle", include: "*.ts", limit: 3 }, context));
      expect(exact.matches).toHaveLength(3);
      expect(exact.truncated).toBe(false);
      expect(JSON.parse(await tool.execute({ query: "needle", path: ".ssh" }, context)).matches).toEqual([]);
      await expect(tool.execute({ query: "needle" }, { ...context, signal: AbortSignal.abort() })).rejects.toThrow();
    } finally { which?.mockRestore(); }
  });

  test("list_files enforces a byte budget for long paths", async () => {
    const root = workspace();
    for (let index = 0; index < 300; index += 1) {
      const directory = join(root, `group-${String(index).padStart(3, "0")}`);
      mkdirSync(directory);
      writeFileSync(join(directory, `${"long-name-".repeat(14)}${index}.ts`), "export {};\n");
    }
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const raw = await tools.get("list_files")!.execute({ limit: 1000 }, context);
    const listed = JSON.parse(raw);

    expect(Buffer.byteLength(raw)).toBeLessThan(32 * 1024);
    expect(listed.files.length).toBeLessThan(300);
    expect(listed.truncated).toBe(true);
  });

  test("write_file creates nested files and atomically overwrites", async () => {
    const root = workspace();
    writeFileSync(join(root, "keep.txt"), "original\n");
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const tool = tools.get("write_file")!;

    const created = JSON.parse(await tool.execute({ path: "deep/dir/new.txt", content: "body\n" }, context));
    expect(created.created).toBe(true);
    expect(readFileSync(join(root, "deep/dir/new.txt"), "utf8")).toBe("body\n");

    await tool.execute({ path: "keep.txt", content: "replaced\n" }, context);
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("replaced\n");
    expect(tool.permission({ path: "x", content: "" })).toEqual({ kind: "write", summary: "write x" });
  });

  test("read_files batches reads and fails soft per entry", async () => {
    const root = workspace();
    writeFileSync(join(root, "one.txt"), "one\n");
    writeFileSync(join(root, "two.txt"), "two\n");
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const batched = JSON.parse(await tools.get("read_files")!.execute({
      files: [{ path: "one.txt" }, { path: "missing.txt" }, { path: "two.txt", limit: 5 }],
    }, context));
    expect(batched.results).toHaveLength(3);
    expect(batched.results[0]).toMatchObject({ path: "one.txt", totalLines: 1 });
    expect(batched.results[1].error).toContain("[NOT_FOUND]");
    expect(batched.results[2]).toMatchObject({ path: "two.txt", range: { from: 1, to: 1 } });
  });

  test("git_status and git_diff report repository state read-only", async () => {
    const root = workspace();
    const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    // Name the branch explicitly: a machine without init.defaultBranch uses "master".
    run(["init", "-q", "-b", "main"]);
    run(["-c", "user.email=t@local", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "base"]);
    writeFileSync(join(root, "tracked.txt"), "hello\n");
    run(["add", "."]);
    run(["-c", "user.email=t@local", "-c", "user.name=t", "commit", "-q", "-m", "tracked"]);
    writeFileSync(join(root, "tracked.txt"), "changed\n");
    writeFileSync(join(root, "staged.txt"), "staged\n");
    run(["add", "staged.txt"]);

    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const status = JSON.parse(await tools.get("git_status")!.execute({}, context));
    expect(status.branch).toContain("main");
    expect(status.clean).toBe(false);

    const unstaged = JSON.parse(await tools.get("git_diff")!.execute({ context: 0 }, context));
    expect(unstaged.diff).toContain("+changed");

    const staged = JSON.parse(await tools.get("git_diff")!.execute({ staged: true, context: 0 }, context));
    expect(staged.diff).toContain("+staged");
  });

  test("git tools fail with a stable code outside repositories", async () => {
    const root = workspace();
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    await expect(tools.get("git_status")!.execute({}, context)).rejects.toThrow("NOT_A_REPO");
  });

  test("git tools disable repository-controlled executors", async () => {
    const root = workspace();
    const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    // Name the branch explicitly: a machine without init.defaultBranch uses "master".
    run(["init", "-q", "-b", "main"]);
    run(["-c", "user.email=t@local", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "base"]);
    const marker = join(root, "executed");
    const helper = join(root, "helper.sh");
    writeFileSync(helper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`);
    chmodSync(helper, 0o700);
    writeFileSync(join(root, ".gitattributes"), "*.txt diff=hostile\n");
    writeFileSync(join(root, "tracked.txt"), "before\n");
    run(["add", ".gitattributes", "tracked.txt"]);
    run(["-c", "user.email=t@local", "-c", "user.name=t", "commit", "-q", "-m", "tracked"]);
    run(["config", "core.fsmonitor", helper]);
    run(["config", "diff.hostile.textconv", helper]);
    writeFileSync(join(root, "tracked.txt"), "after\n");

    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    await tools.get("git_status")!.execute({}, context);
    await tools.get("git_diff")!.execute({}, context);
    expect(existsSync(marker)).toBe(false);
  });

  test("accepts a group-writable workspace without changing its mode", () => {
    const root = join(workspace(), "shared");
    mkdirSync(root); chmodSync(root, 0o775);
    expect(canonicalWorkspace(root)).toBe(root);
    expect(statSync(root).mode & 0o777).toBe(0o775);
  });

  test("rejects a workspace root replaced by a symlink", async () => {
    const root = workspace();
    const moved = `${root}-moved`;
    renameSync(root, moved);
    temporaryDirectories.push(moved);
    symlinkSync(moved, root);
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    await expect(new ToolRegistry().get("read_file")!.execute({ path: "src/missing" }, context))
      .rejects.toThrow("workspace root changed");
  });

  test("escapes control characters in permission summaries", () => {
    const tools = new ToolRegistry();
    expect(tools.get("run_command")!.permission({ argv: ["printf", "\u001b[2Jspoof\n"] })?.summary)
      .toBe('host command: "printf" "\\u001b[2Jspoof\\n"');
    expect(tools.get("delete_path")!.permission({ path: "x\u001b[2J" })?.summary)
      .toBe('delete "x\\u001b[2J"');
  });

  test("move_path renames files and directories with overwrite guards", async () => {
    const root = workspace();
    mkdirSync(join(root, "pkg"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "A\n");
    writeFileSync(join(root, "b.txt"), "B\n");
    writeFileSync(join(root, "pkg", "m.ts"), "export {};\n");
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const tool = tools.get("move_path")!;

    await tool.execute({ from: "a.txt", to: "renamed/a2.txt" }, context);
    expect(readFileSync(join(root, "renamed/a2.txt"), "utf8")).toBe("A\n");

    await expect(tool.execute({ from: "README.md" in {} ? "x" : "b.txt", to: "renamed/a2.txt" }, context))
      .rejects.toThrow("TARGET_EXISTS");
    await tool.execute({ from: "b.txt", to: "renamed/a2.txt", overwrite: true }, context);
    expect(readFileSync(join(root, "renamed/a2.txt"), "utf8")).toBe("B\n");

    await tool.execute({ from: "pkg", to: "lib" }, context);
    expect(readFileSync(join(root, "lib/m.ts"), "utf8")).toBe("export {};\n");

    await expect(tool.execute({ from: "lib", to: "lib/inner" }, context)).rejects.toThrow("INVALID_TARGET");
  });

  test("delete_path removes files, requires recursion for directories, blocks secrets", async () => {
    const root = workspace();
    mkdirSync(join(root, "dir"), { recursive: true });
    writeFileSync(join(root, "gone.txt"), "x\n");
    writeFileSync(join(root, "dir", "inner.txt"), "y\n");
    writeFileSync(join(root, ".env.local"), "SECRET=1\n");
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };
    const tool = tools.get("delete_path")!;

    const removed = JSON.parse(await tool.execute({ path: "gone.txt" }, context));
    expect(removed).toMatchObject({ deleted: true, kind: "file", bytes: 2 });

    await expect(tool.execute({ path: "dir" }, context)).rejects.toThrow("DIR_NEEDS_RECURSIVE");
    await tool.execute({ path: "dir", recursive: true }, context);
    expect(existsSync(join(root, "dir"))).toBe(false);

    await expect(tool.execute({ path: ".env.local" }, context)).rejects.toThrow("SENSITIVE_PATH");
    await expect(tool.execute({ path: "nope.txt" }, context)).rejects.toThrow("NOT_FOUND");
  });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "demesne-tools-test-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "src"));
  return canonicalWorkspace(root);
}

describe("edit_file creation via edits array", () => {
  test("collapses empty-oldText batch hunks into a create on missing files", async () => {
    const root = workspace();
    const tools = new ToolRegistry();
    const context = { workspaceRoot: root, signal: new AbortController().signal };

    const result = JSON.parse(await tools.get("edit_file")!.execute({
      path: "made/thing.txt",
      edits: [{ oldText: "", newText: "hello\n" }],
    }, context));
    expect(result.created).toBe(true);
    expect(readFileSync(join(root, "made/thing.txt"), "utf8")).toBe("hello\n");
  });
});

test("the coding agent is told how its answers are displayed, even with a configured prompt", () => {
  for (const configured of [undefined, "Custom project prompt."]) {
    expect(agentSystemPrompt({ workspaceRoot: "/workspace", definitions: [], configured })).toContain(ANSWER_FORMAT_GUIDANCE);
  }
  expect(ANSWER_FORMAT_GUIDANCE).toContain("at most 5 short columns");
});
