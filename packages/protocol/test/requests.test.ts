import { describe, expect, test } from "bun:test";
import { parseSubmitTurnRequest, parseUndoSessionRequest, parseUpdateSessionRequest, ProtocolValidationError } from "../src/index.ts";

describe("undo request validation", () => {
  test("accepts empty, turn-scoped, and path-scoped requests", () => {
    expect(parseUndoSessionRequest({})).toEqual({});
    expect(parseUndoSessionRequest({ turnId: "turn-1" })).toEqual({ turnId: "turn-1" });
    expect(parseUndoSessionRequest({ paths: [" a.ts ", "b.ts"] })).toEqual({ paths: ["a.ts", "b.ts"] });
    expect(parseUndoSessionRequest({ turnId: "turn-1", paths: ["a.ts"] }))
      .toEqual({ turnId: "turn-1", paths: ["a.ts"] });
  });

  test("rejects malformed selectors", () => {
    expect(() => parseUndoSessionRequest({ turnId: "" })).toThrow(ProtocolValidationError);
    expect(() => parseUndoSessionRequest({ paths: "a.ts" })).toThrow(ProtocolValidationError);
    expect(() => parseUndoSessionRequest({ paths: [""] })).toThrow(ProtocolValidationError);
    expect(() => parseUndoSessionRequest({ paths: Array.from({ length: 101 }, (_, index) => `f${index}`) }))
      .toThrow(ProtocolValidationError);
  });
});

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
