import { expect, test } from "bun:test";
import { TerminalInputDecoder } from "../src/workbench/terminal-input.ts";

test("paste delimiters and mouse packets survive every transport boundary in order", () => {
  const input = "\x1b[200~one\ntwo\x1b[201~\x1b[<0;3;5M";
  for (let split = 1; split < input.length; split++) {
    const decoder = new TerminalInputDecoder();
    expect([...decoder.push(input.slice(0, split)), ...decoder.push(input.slice(split))]).toEqual([
      { kind: "paste", text: "one\ntwo" },
      { kind: "mouse", event: { kind: "press", button: 0, col: 2, row: 4 } },
    ]);
  }
});

test("paste treats apparent shortcuts and mouse reports as literal content", () => {
  const decoder = new TerminalInputDecoder();
  expect(decoder.push("\x1b[200~\x03\x1b[<0;3;5M\x1b[201~")).toEqual([{ kind: "paste", text: "\x03\x1b[<0;3;5M" }]);
  expect(decoder.push("\x1b")).toEqual([]);
  expect(decoder.waitingForEscape).toBe(true);
  expect(decoder.flushEscape()).toEqual([{ kind: "escape", sequence: "\x1b" }]);
});

test("fragmented focus and hover reports never leak into the draft, but remain literal within paste", () => {
  const input = "a\x1b[O\x1b[<35;3;5M\x1b[Ib";
  for (let split = 1; split < input.length; split++) {
    const decoder = new TerminalInputDecoder();
    expect([...decoder.push(input.slice(0, split)), ...decoder.push(input.slice(split))]).toEqual([
      { kind: "text", text: "a" }, { kind: "focus", focused: false },
      { kind: "mouse", event: { kind: "move", button: 3, col: 2, row: 4 } },
      { kind: "focus", focused: true }, { kind: "text", text: "b" },
    ]);
  }
  expect(new TerminalInputDecoder().push("\x1b[200~\x1b[I\x1b[O\x1b[201~")).toEqual([{ kind: "paste", text: "\x1b[I\x1b[O" }]);
});

test("Escape followed by a terminal report never consumes the report's introducer as a second Escape", () => {
  for (const [report, expected] of [
    ["\x1b[<65;229;33M", { kind: "mouse", event: { kind: "wheel", button: 1, direction: "down", col: 228, row: 32 } }],
    ["\x1b[I", { kind: "focus", focused: true }],
    ["\x1b[6;16;8t", { kind: "cell-size", height: 16, width: 8 }],
  ] as const) {
    for (const count of [1, 2]) {
      const input = "\x1b".repeat(count) + report;
      for (let split = 1; split < input.length; split++) {
        const decoder = new TerminalInputDecoder();
        expect([...decoder.push(input.slice(0, split)), ...decoder.push(input.slice(split))]).toEqual([
          { kind: "escape", sequence: "\x1b".repeat(count) }, expected,
        ]);
      }
    }
  }
});

test("incomplete mouse introducers survive the escape timeout, while actual double Escape still flushes", () => {
  const decoder = new TerminalInputDecoder();
  expect(decoder.push("\x1b[")).toEqual([]);
  expect(decoder.waitingForEscape).toBe(false);
  expect(decoder.flushEscape()).toEqual([]);
  expect(decoder.push("<65;229;33M")).toEqual([{ kind: "mouse", event: { kind: "wheel", button: 1, direction: "down", col: 228, row: 32 } }]);
  expect(decoder.push("\x1b\x1b")).toEqual([]);
  expect(decoder.waitingForEscape).toBe(true);
  expect(decoder.flushEscape()).toEqual([{ kind: "escape", sequence: "\x1b\x1b" }]);
});
