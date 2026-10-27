import { describe, expect, test } from "bun:test";
import { billing, modelCardHTML, thinkingWords } from "../model-card";

const word = (level: string) => level[0]!.toUpperCase() + level.slice(1);

describe("model card", () => {
  test("says how each provider is paid for", () => {
    expect(billing("Codex").tone).toBe("plan");
    expect(billing("OpenRouter").tone).toBe("credits");
    expect(billing("ChatGPT").tone).toBe("credits");
    expect(billing("Qwen on PC").tone).toBe("own");
  });
  test("names the thinking range", () => {
    expect(thinkingWords(["low", "medium", "high", "ultra"], word)).toBe("4 levels, up to Ultra");
    expect(thinkingWords(undefined, word)).toBe("None");
  });
  test("draws the name, plan, facts, record and id", () => {
    const html = modelCardHTML({ id: "codex/gpt-6.1-sol", displayName: "GPT-6.1-Sol", provider: "Codex", contextWindow: 500_000, maxOutputTokens: 128_000, reasoningLevels: ["low", "ultra"] }, { record: "38 turns · all finished", levelWord: word });
    for (const part of ["GPT-6.1-Sol", "your plan", "500k", "128k", "2 levels, up to Ultra", "38 turns", "codex/gpt-6.1-sol"]) expect(html).toContain(part);
  });
  test("a model never used says so, and an id equal to its name isn't repeated", () => {
    const html = modelCardHTML({ id: "qwen3.8-27b", provider: "Qwen on PC" }, { levelWord: word });
    expect(html).toContain("Not used yet");
    expect(html).not.toContain("mc-id");
    expect(html).not.toContain("Context");
  });
  test("escapes names", () => {
    expect(modelCardHTML({ id: "<x>", provider: "p" }, { levelWord: word })).not.toContain("<x>");
  });
});
