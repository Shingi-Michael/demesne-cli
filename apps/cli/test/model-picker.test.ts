import { describe, expect, test } from "bun:test";
import type { ModelDescriptor } from "@demesne/protocol";
import { matchModel } from "../src/model-picker.ts";

const models: ModelDescriptor[] = [
  { id: "qwen3.8-q4_0-100k-b256", provider: "llama.cpp", contextWindow: 100_000 },
  { id: "qwen3.8-q4_0-64k-b256", provider: "llama.cpp", contextWindow: 65_536 },
  { id: "qwen3.8-8k-b256:latest", provider: "ollama", contextWindow: 8_192 },
];

describe("matchModel", () => {
  test("matches an exact id first", () => {
    expect(matchModel(models, "qwen3.8-8k-b256:latest")).toEqual({ model: models[2]! });
  });

  test("matches an unambiguous prefix", () => {
    expect(matchModel(models, "qwen3.8-8k")).toEqual({ model: models[2]! });
    expect(matchModel(models, "  qwen3.8-q4_0-64k  ")).toEqual({ model: models[1]! });
  });

  test("reports ambiguity and misses", () => {
    const ambiguous = matchModel(models, "qwen3.8-q4_0");
    expect("error" in ambiguous && ambiguous.error).toContain("Ambiguous");
    expect("error" in ambiguous && ambiguous.error).toContain("100k");
    const missing = matchModel(models, "llama3");
    expect("error" in missing && missing.error).toContain("No model matches");
  });
});
