import { describe, expect, test } from "bun:test";
import {
  buildRetrievalFixture,
  LLAMA_CONTEXT_RETRIEVAL_SCHEMA_VERSION,
  ollamaModelNamesMatch,
  retrievalMatches,
} from "../src/llama-context-retrieval-benchmark.ts";

describe("llama.cpp context retrieval benchmark", () => {
  test("pins a deterministic single needle at the configured depth", () => {
    const fixture = buildRetrievalFixture(10_000, 0.75);
    expect(LLAMA_CONTEXT_RETRIEVAL_SCHEMA_VERSION).toBe(1);
    expect(fixture.prompt.match(/DEMESNE_NEEDLE_7F3A9C2E/g)).toHaveLength(1);
    expect(fixture.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(buildRetrievalFixture(10_000, 0.75).digest).toBe(fixture.digest);
  });

  test("requires an exact response", () => {
    expect(retrievalMatches(" DEMESNE_NEEDLE_7F3A9C2E\n", "DEMESNE_NEEDLE_7F3A9C2E")).toBe(true);
    expect(retrievalMatches("The answer is DEMESNE_NEEDLE_7F3A9C2E", "DEMESNE_NEEDLE_7F3A9C2E")).toBe(false);
  });

  test("matches Ollama's canonical latest tag", () => {
    expect(ollamaModelNamesMatch("qwen3.8-mlx-affine-100k:latest", "qwen3.8-mlx-affine-100k")).toBe(true);
    expect(ollamaModelNamesMatch("localhost:5000/team/model:latest", "localhost:5000/team/model")).toBe(true);
    expect(ollamaModelNamesMatch("model:q4", "model:latest")).toBe(false);
  });

  test("builds a deterministic long copy payload for ngram speculation", () => {
    const fixture = buildRetrievalFixture(10_000, 0.5, 8);
    expect(fixture.expected.split(" ")).toHaveLength(128);
    expect(fixture.prompt).toContain(`recovery_key=${fixture.expected}`);
    expect(buildRetrievalFixture(10_000, 0.5, 8).digest).toBe(fixture.digest);
  });

  test("rejects unsafe fixture parameters", () => {
    expect(() => buildRetrievalFixture(999, 0.5)).toThrow("at least 1000");
    expect(() => buildRetrievalFixture(10_000, 0)).toThrow("between zero and one");
    expect(() => buildRetrievalFixture(10_000, 1)).toThrow("between zero and one");
    expect(() => buildRetrievalFixture(10_000, 0.5, 33)).toThrow("between zero and 32");
  });
});
