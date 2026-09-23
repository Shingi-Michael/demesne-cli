import { describe, expect, test } from "bun:test";
import { createPainter, HARNESS, SLASH_COMMANDS, visibleLength } from "@demesne/brand";
import { renderHarnessDiff, renderHarnessHelp, renderHarnessStatus, renderHarnessWelcome } from "../src/harness-panels.ts";

const painter = createPainter(false, "dark");
const color = createPainter(true, "dark");

describe("renderHarnessHelp", () => {
  test("opens as a bounded unit and lists every command on the grid", () => {
    const lines = renderHarnessHelp(SLASH_COMMANDS, 100, painter);
    expect(lines[0]).toStartWith(`${" ".repeat(HARNESS.rail)}┌ help ─`);
    const joined = lines.join("\n");
    for (const command of SLASH_COMMANDS) {
      if (command.id === "help") continue;
      expect(joined).toContain(command.name);
    }
    expect(joined).toContain("SESSION");
    expect(joined).toContain("CONTROL");
  });

  test("documents the keybindings so the harness is discoverable", () => {
    const joined = renderHarnessHelp(SLASH_COMMANDS, 100, painter).join("\n");
    expect(joined).toContain("KEYS");
    expect(joined).toContain("ctrl+t");
    expect(joined).toContain("focus content / prompt");
    expect(joined).toContain("session / activity / transcript");
    expect(joined).toContain("select turn");
    expect(joined).toContain("esc esc");
    expect(joined).toContain("compose in $EDITOR");
  });

  test("aligns every description on one column and stays inside the width", () => {
    for (const width of [60, 100, 140]) {
      const lines = renderHarnessHelp(SLASH_COMMANDS, width, color);
      const columns = new Set<number>();
      for (const line of lines) {
        expect(visibleLength(line)).toBeLessThanOrEqual(width);
        const match = /^ {6}(\S.*)  (\S.*)$/.exec(line);
        if (match) columns.add(6 + match[1]!.length + 2);
      }
      // One shared description column proves the grid held across sections.
      expect(columns.size).toBe(1);
    }
  });

  test("merges custom commands into their section", () => {
    const custom = {
      id: "custom:review" as const,
      name: "/review" as const,
      aliases: [],
      argument: "optional" as const,
      argumentLabel: "arguments",
      description: "Review the working tree",
      section: "session" as const,
    };
    const joined = renderHarnessHelp([...SLASH_COMMANDS, custom], 100, painter).join("\n");
    expect(joined).toContain("/review");
    expect(joined).toContain("Review the working tree");
  });
});

describe("renderHarnessDiff", () => {
  const changes = [
    { path: "src/lexer.ts", operation: "A" as const, reverted: false, diff: ["+ if (c > 0x7f) continue;"] },
    { path: "src/token.ts", operation: "M" as const, reverted: true, diff: ["- old", "+ new"] },
    { path: "assets/logo.png", operation: "M" as const, reverted: false, binary: true, diff: [] },
  ];

  test("places every path on the tool target column", () => {
    const lines = renderHarnessDiff(changes, "4f2a9c1e-long", 100, painter);
    expect(lines[0]).toStartWith(`${" ".repeat(HARNESS.rail)}┌ changes ─`);
    const paths = lines.filter((line) => line.includes("src/") || line.includes("assets/"));
    expect(paths.length).toBe(3);
    for (const line of paths) {
      const index = line.search(/src\/|assets\//);
      expect(index).toBe(HARNESS.toolTarget);
    }
  });

  test("names the operation as a verb and reports state in the meta column", () => {
    const joined = renderHarnessDiff(changes, "4f2a9c1e", 100, painter).join("\n");
    expect(joined).toContain("added");
    expect(joined).toContain("edited");
    expect(joined).toContain("reverted");
    expect(joined).toContain("binary");
    expect(joined).toContain("turn 4f2a9c1e");
  });

  test("indents diff bodies under their file and skips binary content", () => {
    const lines = renderHarnessDiff(changes, "4f2a9c1e", 100, painter);
    const added = lines.find((line) => line.includes("+ if (c > 0x7f) continue;"));
    expect(added).toBeDefined();
    expect(added!.indexOf("+ if")).toBe(HARNESS.toolTarget);
    expect(lines.some((line) => line.includes("binary"))).toBe(true);
  });

  test("stays inside narrow widths", () => {
    for (const line of renderHarnessDiff(changes, "4f2a9c1e", 46, painter)) {
      expect(visibleLength(line)).toBeLessThanOrEqual(46);
    }
  });
});

describe("renderHarnessWelcome", () => {
  const base = {
    model: "qwen3.8-27b",
    provider: "llama.cpp",
    contextWindow: 100_000,
    workspace: "/Users/me/projects/demesne-cli",
    branch: "main",
    permissionMode: "ask" as const,
    runtime: null,
    width: 100,
    paint: painter,
  };

  test("states the four things that determine what the agent may do", () => {
    const joined = renderHarnessWelcome(base).join("\n");
    expect(joined).toStartWith(`${" ".repeat(HARNESS.rail)}┌ demesne ─`);
    expect(joined).toContain("qwen3.8-27b · llama.cpp");
    // Shortened the same way as the header, so the two agree on the workspace.
    expect(joined).toContain("…/projects/demesne-cli · main");
    expect(joined).toContain("approval on write and execute");
    expect(joined).toContain("100,000 token window");
  });

  test("warns when the policy denies writes instead of implying approval", () => {
    const joined = renderHarnessWelcome({ ...base, permissionMode: "deny" }).join("\n");
    expect(joined).toContain("writes and commands are denied");
    expect(joined).not.toContain("approval on write");
  });

  test("points at the commands and telemetry keys", () => {
    const joined = renderHarnessWelcome(base).join("\n");
    expect(joined).toContain("/ for commands");
    expect(joined).toContain("ctrl+t for telemetry");
  });

  test("includes the runtime only when one is configured", () => {
    expect(renderHarnessWelcome(base).join("\n")).not.toContain("runtime");
    const verified = renderHarnessWelcome({
      ...base,
      runtime: {
        profile: "llama-ngram-mod-f16-kv-100k-b256-32gb",
        state: "verified",
        expected: null,
        observed: null,
        mismatches: [],
        observedAt: null,
      },
    }).join("\n");
    expect(verified).toContain("runtime");
    expect(verified).toContain("✓ llama-ngram-mod-f16-kv-100k-b256-32gb");
  });

  test("aligns values on one column and stays inside narrow widths", () => {
    for (const width of [46, 80, 120]) {
      const lines = renderHarnessWelcome({ ...base, width });
      for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(width);
      const columns = new Set<number>();
      for (const line of lines) {
        const match = /^ {6}(\S.*)  (\S.*)$/.exec(line);
        if (match) columns.add(6 + match[1]!.length + 2);
      }
      expect(columns.size).toBeLessThanOrEqual(1);
    }
  });
});

describe("renderHarnessStatus", () => {
  const base = {
    title: "parser hardening",
    sessionId: "4f2a9c1e-0000-0000-0000-000000000000",
    turnCount: 12,
    model: "qwen3.8-27b",
    provider: "llama.cpp",
    contextWindow: 100_000,
    workspace: "/Users/me/projects/demesne-cli",
    branch: "main",
    runtime: null,
    width: 100,
    paint: painter,
  };

  test("reports identity, model, context, and workspace", () => {
    const joined = renderHarnessStatus(base).join("\n");
    expect(joined).toStartWith(`${" ".repeat(HARNESS.rail)}┌ status ─`);
    expect(joined).toContain("parser hardening");
    expect(joined).toContain("4f2a9c1e");
    expect(joined).toContain("qwen3.8-27b · llama.cpp");
    expect(joined).toContain("100,000 token window");
    expect(joined).toContain("main");
  });

  test("shows a verified runtime and its speculation", () => {
    const joined = renderHarnessStatus({
      ...base,
      runtime: {
        profile: "llama-ngram-mod-f16-kv-100k-b256-32gb",
        state: "verified",
        expected: null,
        observed: {
          model: "qwen3.8-27b",
          contextWindow: 100_000,
          batchSize: 256,
          microBatchSize: 256,
          parallelSequences: 1,
          keyCacheType: "f16",
          valueCacheType: "f16",
          flashAttention: "on",
          loadedModels: 1,
          runnerProcesses: 1,
          speculationType: "ngram-mod",
        },
        mismatches: [],
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    }).join("\n");
    expect(joined).toContain("✓ llama-ngram-mod-f16-kv-100k-b256-32gb · ngram-mod");
  });

  test("reports a mismatch count instead of claiming verification", () => {
    const joined = renderHarnessStatus({
      ...base,
      runtime: {
        profile: "balanced-32gb",
        state: "mismatch",
        expected: null,
        observed: null,
        mismatches: ["contextWindow", "batchSize"],
        observedAt: null,
      },
    }).join("\n");
    expect(joined).toContain("× balanced-32gb · 2 mismatch");
  });

  test("omits branch and runtime rows when unknown", () => {
    const joined = renderHarnessStatus({ ...base, branch: null, contextWindow: undefined }).join("\n");
    expect(joined).not.toContain("branch");
    expect(joined).not.toContain("runtime");
    expect(joined).toContain("window unknown");
  });

  test("stays inside narrow widths", () => {
    for (const line of renderHarnessStatus({ ...base, width: 46 })) {
      expect(visibleLength(line)).toBeLessThanOrEqual(46);
    }
  });
});
