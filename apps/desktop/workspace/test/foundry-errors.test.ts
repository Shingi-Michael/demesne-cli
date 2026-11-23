import { expect, test } from "bun:test";
import { errorLine, errorMessage, frameKey, readError } from "../foundry-errors.ts";

test("errors come back: a frame's address names the mockup version it shows", () => {
  expect(frameKey("foundry://artifact/a1?v=3&stack=1&at=5")).toBe("a1:3");
  expect(frameKey("foundry://artifact/a%2Db?v=12")).toBe("a-b:12");
  expect(frameKey("https://example.com/?v=1")).toBeNull();
});

test("only the frame's own error messages are read, made short and safe", () => {
  expect(readError({ demesne: "error", action: "fresh" })).toBe("fresh");
  expect(readError({ demesne: "error", action: "error", message: "x is not defined", line: 12, stack: "at go" })).toEqual({ message: "x is not defined", line: 12, stack: "at go" });
  expect(readError({ demesne: "error", action: "error", message: "y".repeat(500), line: -3 })).toEqual({ message: "y".repeat(300), line: 0, stack: "" });
  expect(readError({ demesne: "note", action: "error", message: "nope" })).toBeNull();
  expect(readError({ demesne: "error", action: "error", message: "  " })).toBeNull();
  expect(readError("error")).toBeNull();
});

test("the line under the mockup says what broke, how many more, and offers to send it", () => {
  expect(errorLine(undefined)).toBe("");
  expect(errorLine({ errors: [] })).toBe("");
  const line = errorLine({ errors: [{ message: "Cannot read <total>", line: 4, stack: "" }, { message: "b", line: 0, stack: "" }] });
  expect(line).toContain("This page hit an error:");
  expect(line).toContain("Cannot read &lt;total&gt; <span class=\"fd-quiet\">line 4</span>");
  expect(line).toContain("and 1 more");
  expect(line).toContain('<button type="button" class="fd-err-send">Send to the chat</button>');
  expect(errorLine({ errors: [{ message: "a", line: 0, stack: "" }], sending: true })).toContain("Sending…");
  expect(errorLine({ errors: [{ message: "a", line: 0, stack: "" }], sent: "“Orders”" })).toContain("Sent to “Orders”");
  expect(errorLine({ errors: [{ message: "a", line: 0, stack: "" }], failed: "Not sent: offline" })).toContain("Not sent: offline");
});

test("the chat is told the mockup, the error and to fix only that", () => {
  const text = errorMessage({ id: "a1", title: "Orders board", version: 3 }, [{ message: "total is undefined", line: 9, stack: "TypeError: x\n    at add (page:9)\n    at click" }]);
  expect(text).toContain('The Foundry mockup "Orders board" (id a1, v3) hit this error while I was using it:');
  expect(text).toContain("- total is undefined (line 9)");
  expect(text).toContain("at add (page:9)");
  expect(text).toContain("foundry_read it, then one foundry_edit");
});
