import { describe, expect, test } from "bun:test";
import { extractMouseEvents, parseMouseSequence, chunkMayContainMouse } from "../src/mouse.ts";

describe("mouse sequence decoding", () => {
  test("decodes SGR click press and release into zero-based cells", () => {
    // `\x1b[<0;34;10M` is a left-button press at column 34, row 10 (1-based).
    const press = parseMouseSequence("\x1b[<0;34;10M");
    expect(press).toEqual({ kind: "press", button: 0, col: 33, row: 9 });
    const release = parseMouseSequence("\x1b[<0;34;10m");
    expect(release).toEqual({ kind: "release", button: 0, col: 33, row: 9 });
  });

  test("decodes wheel directions, including with modifiers", () => {
    expect(parseMouseSequence("\x1b[<64;10;5M")).toMatchObject({ kind: "wheel", direction: "up" });
    expect(parseMouseSequence("\x1b[<65;10;5M")).toMatchObject({ kind: "wheel", direction: "down" });
    expect(parseMouseSequence("\x1b[<68;10;5M")).toMatchObject({ kind: "wheel", direction: "up" });
  });

  test("classifies drag motion so the harness can ignore it", () => {
    expect(parseMouseSequence("\x1b[<32;1;1M")?.kind).toBe("drag");
  });

  test("preserves horizontal wheel directions across encodings and modifiers", () => {
    for (const modifier of [0, 4, 8, 16, 28]) {
      for (const [button, direction] of [[66, "left"], [67, "right"]] as const) {
        const code = button + modifier;
        expect(parseMouseSequence(`\x1b[<${code};10;5M`)).toMatchObject({ kind: "wheel", direction });
        expect(parseMouseSequence(`\x1b[M${String.fromCharCode(code + 32, 42, 37)}`)).toMatchObject({ kind: "wheel", direction });
      }
    }
  });

  test("distinguishes unpressed motion and modifiers from clicking or dragging", () => {
    expect(parseMouseSequence("\x1b[<35;8;4M")).toEqual({ kind: "move", button: 3, col: 7, row: 3 });
    expect(parseMouseSequence("\x1b[<51;8;4M")?.kind).toBe("move");
    expect(parseMouseSequence("\x1b[<48;8;4M")?.kind).toBe("drag");
  });

  test("decodes the X10 fallback encoding", () => {
    // Byte values +32: button 0, column 5, row 3.
    const event = parseMouseSequence("\x1b[M %#");
    expect(event).toEqual({ kind: "press", button: 0, col: 4, row: 2 });
  });

  test("rejects non-mouse sequences", () => {
    expect(parseMouseSequence("\x1b[A")).toBeNull();
    expect(parseMouseSequence("hello")).toBeNull();
    expect(parseMouseSequence("")).toBeNull();
  });

  test("flags chunks that carry mouse bytes without decoding them", () => {
    expect(chunkMayContainMouse("\x1b[<0;34;10M")).toBe(true);
    expect(chunkMayContainMouse("plain typing")).toBe(false);
    expect(chunkMayContainMouse("mix\x1b[M   ")).toBe(true);
  });
});

describe("mouse extraction from raw chunks", () => {
  test("extracts every sequence in one chunk", () => {
    const chunk = "\x1b[<0;34;10M\x1b[<64;10;5M";
    const decoded = extractMouseEvents(chunk);
    expect(decoded.events).toHaveLength(2);
    expect(decoded.events[0]).toMatchObject({ kind: "press" });
    expect(decoded.events[1]).toMatchObject({ kind: "wheel", direction: "up" });
    expect(decoded.rest).toBe("");
  });

  test("carries an incomplete SGR tail into the next chunk", () => {
    const first = extractMouseEvents("\x1b[<0");
    expect(first.events).toEqual([]);
    const second = extractMouseEvents(";34;10M", first.rest);
    expect(second.events).toEqual([{ kind: "press", button: 0, col: 33, row: 9 }]);
    expect(second.rest).toBe("");
  });

  test("drops torn garbage instead of leaking it into later typing", () => {
    const torn = extractMouseEvents("\x1b[<0;34");
    expect(torn.events).toEqual([]);
    // The next chunk completes the sequence.
    const completed = extractMouseEvents(";10M", torn.rest);
    expect(completed.events).toHaveLength(1);
  });

  test("drops text that surrounds an unparseable mouse prefix", () => {
    const decoded = extractMouseEvents("abc\x1b[<xyz");
    expect(decoded.events).toEqual([]);
    expect(decoded.rest).toBe("");
  });

  test("handles multiple sequences with text between them", () => {
    const decoded = extractMouseEvents("\x1b[<64;1;1Mmid\x1b[<65;1;1M");
    expect(decoded.events).toHaveLength(2);
    expect(decoded.rest).toBe("");
  });
});
