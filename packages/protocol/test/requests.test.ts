import { describe, expect, test } from "bun:test";
import { parseSubmitTurnRequest, parseUpdateSessionRequest, ProtocolValidationError } from "../src/index.ts";

describe("session update validation", () => {
  test("accepts a title, a preferred model, or both", () => {
    expect(parseUpdateSessionRequest({ title: "  Renamed  " })).toEqual({ title: "Renamed" });
    expect(parseUpdateSessionRequest({ preferredModel: "local-model" })).toEqual({ preferredModel: "local-model" });
    expect(parseUpdateSessionRequest({ preferredModel: null })).toEqual({ preferredModel: null });
    expect(parseUpdateSessionRequest({ title: "Both", preferredModel: "m" })).toEqual({ title: "Both", preferredModel: "m" });
  });

  test("rejects empty updates and invalid fields", () => {
    expect(() => parseUpdateSessionRequest({})).toThrow(ProtocolValidationError);
    expect(() => parseUpdateSessionRequest({ title: "   " })).toThrow(ProtocolValidationError);
    expect(() => parseUpdateSessionRequest({ title: 42 })).toThrow(ProtocolValidationError);
    expect(() => parseUpdateSessionRequest({ preferredModel: 42 })).toThrow(ProtocolValidationError);
    expect(() => parseUpdateSessionRequest({ preferredModel: "" })).toThrow(ProtocolValidationError);
    expect(() => parseUpdateSessionRequest({ title: "x".repeat(201) })).toThrow(ProtocolValidationError);
  });
});

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
