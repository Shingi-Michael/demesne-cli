import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_HISTORY_LIMIT, PromptHistory } from "../src/prompt-history.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-history-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PromptHistory", () => {
  test("returns recent entries first without duplicates", () => {
    const history = new PromptHistory(null);
    history.add("first");
    history.add("second");
    history.add("first");
    expect(history.entries()).toEqual(["first", "second"]);
  });

  test("suppresses an immediate repeat but not a later one", () => {
    const history = new PromptHistory(null);
    history.add("same");
    history.add("same");
    history.add("other");
    history.add("same");
    expect(history.entries()).toEqual(["same", "other"]);
  });

  test("ignores empty prompts", () => {
    const history = new PromptHistory(null);
    expect(history.add("   ")).toBe(false);
    expect(history.add("")).toBe(false);
    expect(history.entries()).toEqual([]);
  });

  test("persists across loads with mode 0600", () => {
    const path = join(temporaryDirectory(), "history.jsonl");
    const first = PromptHistory.load(path);
    first.add("persisted prompt", "/workspace");
    const second = PromptHistory.load(path);
    expect(second.entries()).toEqual(["persisted prompt"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("\"workspace\":\"/workspace\"");
  });

  test("skips malformed and truncated lines", () => {
    const path = join(temporaryDirectory(), "history.jsonl");
    writeFileSync(path, [
      "{\"text\":\"valid\",\"at\":\"2026-01-01T00:00:00.000Z\"}",
      "not json",
      "{\"text\":123}",
      "{\"text\":\"also valid\",\"at\":\"2026-01-02T00:00:00.000Z\"}",
      "{\"text\":\"trunc",
    ].join("\n"));
    expect(PromptHistory.load(path).entries()).toEqual(["also valid", "valid"]);
  });

  test("rewrites the file once the cap is crossed", () => {
    const path = join(temporaryDirectory(), "history.jsonl");
    const history = PromptHistory.load(path);
    for (let index = 0; index < PROMPT_HISTORY_LIMIT + 5; index += 1) {
      history.add(`prompt ${index}`);
    }
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(PROMPT_HISTORY_LIMIT);
    expect(history.entries()).toHaveLength(PROMPT_HISTORY_LIMIT);
    expect(history.entries()[0]).toBe(`prompt ${PROMPT_HISTORY_LIMIT + 4}`);
  });

  test("searches case-insensitively in recency order", () => {
    const history = new PromptHistory(null);
    history.add("Fix the parser");
    history.add("Run the tests");
    history.add("fix the docs");
    expect(history.search("FIX")).toEqual(["fix the docs", "Fix the parser"]);
    expect(history.search("")).toEqual(["fix the docs", "Run the tests", "Fix the parser"]);
    expect(history.search("nothing")).toEqual([]);
  });
});
