import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearInstructionCache,
  composeSystemPrompt,
  INSTRUCTION_MAX_BYTES,
  loadProjectInstructions,
} from "../src/instructions.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-instructions-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  clearInstructionCache();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("loadProjectInstructions", () => {
  test("returns null without a workspace or without instruction files", () => {
    expect(loadProjectInstructions(undefined)).toBeNull();
    const directory = temporaryDirectory();
    expect(loadProjectInstructions(directory)).toBeNull();
  });

  test("prefers DEMESNE.md over AGENTS.md", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "AGENTS.md"), "agent rules\n");
    writeFileSync(join(directory, "DEMESNE.md"), "demesne rules\n");
    const instructions = loadProjectInstructions(directory);
    expect(instructions?.relativePath).toBe("DEMESNE.md");
    expect(instructions?.content).toBe("demesne rules");
  });

  test("falls back to AGENTS.md so existing repositories work unchanged", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "AGENTS.md"), "agent rules\n");
    const instructions = loadProjectInstructions(directory);
    expect(instructions?.relativePath).toBe("AGENTS.md");
    expect(instructions?.content).toBe("agent rules");
  });

  test("treats an empty instruction file as absent", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "DEMESNE.md"), "\n  \n");
    expect(loadProjectInstructions(directory)).toBeNull();
  });

  test("ignores a directory named like an instruction file", () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, "DEMESNE.md"));
    expect(loadProjectInstructions(directory)).toBeNull();
  });

  test("truncates oversized files and appends a notice", () => {
    const directory = temporaryDirectory();
    const oversized = "x".repeat(INSTRUCTION_MAX_BYTES + 100);
    writeFileSync(join(directory, "DEMESNE.md"), oversized);
    const instructions = loadProjectInstructions(directory);
    expect(instructions?.truncated).toBe(true);
    expect(instructions?.content).toContain("truncated at 32 KiB");
    expect(Buffer.byteLength(instructions?.content ?? "")).toBeLessThan(INSTRUCTION_MAX_BYTES + 200);
  });

  test("re-reads a changed file and caches unchanged content", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "DEMESNE.md");
    writeFileSync(path, "first\n");
    expect(loadProjectInstructions(directory)?.content).toBe("first");
    expect(loadProjectInstructions(directory)?.content).toBe("first");

    // Force a distinct mtime so the cache key cannot collide on coarse clocks.
    writeFileSync(path, "second\n");
    const future = new Date(Date.now() + 2_000);
    utimesSync(path, future, future);
    expect(loadProjectInstructions(directory)?.content).toBe("second");
  });
});

describe("composeSystemPrompt", () => {
  test("returns the base prompt unchanged without instructions", () => {
    expect(composeSystemPrompt("base", null)).toBe("base");
  });

  test("frames instructions as workspace-specific and authoritative", () => {
    const composed = composeSystemPrompt("base", {
      absolutePath: "/workspace/DEMESNE.md",
      relativePath: "DEMESNE.md",
      content: "Use tabs.",
      truncated: false,
    });
    expect(composed).toStartWith("base");
    expect(composed).toContain("DEMESNE.md");
    expect(composed).toContain("take precedence");
    expect(composed).toEndWith("Use tabs.");
  });
});
