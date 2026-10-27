import { describe, expect, test } from "bun:test";
import { matchedRanges, matchesWords } from "../model-search";

const sol = "GPT-6.1-Sol Codex codex/gpt-6.1-sol";

describe("model search", () => {
  test("finds a model typed the way people say it", () => {
    for (const query of ["codex gpt 6.1 sol", "gpt 6.1", "Sol codex", "gpt-6.1-sol", "codex/gpt", "6.1 sol"]) expect(matchesWords(sol, query)).toBe(true);
  });
  test("every word has to be there", () => {
    expect(matchesWords(sol, "codex terra")).toBe(false);
    expect(matchesWords("GPT-6-Luna Codex codex/gpt-6-luna", "6.1")).toBe(false);
  });
  test("an empty search matches everything", () => {
    expect(matchesWords(sol, "  ")).toBe(true);
  });
  test("marks each word's stretch once, merged and in order", () => {
    expect(matchedRanges("GPT-6.1-Sol", "sol gpt 6.1")).toEqual([[0, 3], [4, 7], [8, 11]]);
    expect(matchedRanges("GPT-6.1-Sol", "gpt gp")).toEqual([[0, 3]]);
  });
});
