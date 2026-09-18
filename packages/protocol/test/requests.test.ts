import { describe, expect, test } from "bun:test";
import { parseSubmitTurnRequest, ProtocolValidationError } from "../src/index.ts";

describe("turn request validation", () => {
  test("accepts explicit thinking controls", () => {
    expect(parseSubmitTurnRequest({ content: "Explain this", thinkingEnabled: true })).toEqual({
      content: "Explain this",
      thinkingEnabled: true,
    });
    expect(parseSubmitTurnRequest({ content: "Answer directly", thinkingEnabled: false })).toEqual({
      content: "Answer directly",
      thinkingEnabled: false,
    });
  });

  test("rejects invalid thinking controls", () => {
    expect(() => parseSubmitTurnRequest({ content: "Explain this", thinkingEnabled: "yes" }))
      .toThrow(ProtocolValidationError);
  });
});
