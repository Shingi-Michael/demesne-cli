import { describe, expect, test } from "bun:test";
import { createPainter, HARNESS, SLASH_COMMANDS, visibleLength } from "@demesne/brand";
import { renderHarnessHelp, renderHarnessStatus } from "../src/harness-panels.ts";

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
    expect(joined).toContain("toggle telemetry");
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
