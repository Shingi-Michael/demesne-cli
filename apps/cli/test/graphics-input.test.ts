import { expect, test } from "bun:test";
import { TerminalInputDecoder } from "../src/workbench/terminal-input.ts";

test("graphics and geometry replies survive every split without entering the draft", () => {
  const bytes = "a\x1b_Gi=123;OK\x1b\\\x1b[6;16;8tb";
  for (let split = 1; split < bytes.length; split++) {
    const decoder = new TerminalInputDecoder();
    const events = [...decoder.push(bytes.slice(0, split)), ...decoder.push(bytes.slice(split))];
    expect(events.filter((event) => event.kind === "text").map((event) => event.text).join("")).toBe("ab");
    expect(events.filter((event) => event.kind === "graphics-reply")).toEqual([{ kind: "graphics-reply", header: "i=123", message: "OK" }]);
    expect(events.filter((event) => event.kind === "cell-size")).toEqual([{ kind: "cell-size", width: 8, height: 16 }]);
  }
});

test("a split graphics terminator is not a user Escape", () => {
  const decoder = new TerminalInputDecoder();
  decoder.push("\x1b_Gi=123;OK\x1b");
  expect(decoder.waitingForEscape).toBe(false);
  expect(decoder.push("\\")).toEqual([{ kind: "graphics-reply", header: "i=123", message: "OK" }]);
});
