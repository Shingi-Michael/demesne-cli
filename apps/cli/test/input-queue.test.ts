import { describe, expect, test } from "bun:test";
import { queueSummary, reduceQueuedInput, settleQueuedInput, QUEUED_INPUT_LIMIT } from "../src/input-queue.ts";

function type(queue: string, text: string): string {
  let next = queue;
  for (const character of text) next = reduceQueuedInput(next, { name: character }, character);
  return next;
}

describe("reduceQueuedInput", () => {
  test("appends printable text", () => {
    expect(type("", "fix the tests")).toBe("fix the tests");
  });

  test("ignores control shortcuts so terminal keys keep working", () => {
    expect(reduceQueuedInput("draft", { name: "c", ctrl: true }, "c")).toBe("draft");
    expect(reduceQueuedInput("draft", { name: "r", ctrl: true }, "r")).toBe("draft");
    expect(reduceQueuedInput("draft", { name: "b", meta: true }, "b")).toBe("draft");
  });

  test("treats plain enter and tab as no-ops but inserts explicit newlines", () => {
    expect(reduceQueuedInput("draft", { name: "return" }, "\r")).toBe("draft");
    expect(reduceQueuedInput("draft", { name: "tab" }, "\t")).toBe("draft");
    expect(reduceQueuedInput("draft", { name: "return", shift: true }, "")).toBe("draft\n");
    expect(reduceQueuedInput("draft", { name: "j", ctrl: true }, "")).toBe("draft\n");
  });

  test("backspaces by grapheme", () => {
    expect(reduceQueuedInput("a👍", { name: "backspace" }, "")).toBe("a");
    expect(reduceQueuedInput("", { name: "backspace" }, "")).toBe("");
  });

  test("strips control characters and normalizes pasted text", () => {
    expect(type("", "a\tb\u0007c")).toBe("a  bc");
  });

  test("clamps the queue to the limit", () => {
    const queued = type("", "x".repeat(QUEUED_INPUT_LIMIT + 100));
    expect(queued).toHaveLength(QUEUED_INPUT_LIMIT);
  });
});

describe("queueSummary", () => {
  test("collapses whitespace and truncates long input", () => {
    expect(queueSummary("  fix\n  the   tests ")).toBe("fix the tests");
    expect(queueSummary("")).toBeNull();
    expect(queueSummary("   ")).toBeNull();
    expect(queueSummary("x".repeat(80))).toHaveLength(40);
  });
});

describe("settleQueuedInput", () => {
  test("sends the queue after a completed turn", () => {
    expect(settleQueuedInput("  also add a test  ", "completed")).toEqual({ send: "also add a test" });
  });

  test("returns the queue to the editor unsent after a stop or failure", () => {
    expect(settleQueuedInput("also add a test\n", "stopped")).toEqual({ draft: "also add a test" });
    expect(settleQueuedInput("retry with logging", "failed")).toEqual({ draft: "retry with logging" });
  });

  test("does nothing with an empty queue", () => {
    expect(settleQueuedInput(undefined, "stopped")).toEqual({});
    expect(settleQueuedInput("   \n", "completed")).toEqual({});
  });
});
