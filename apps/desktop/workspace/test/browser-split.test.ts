import { expect, test } from "bun:test";
import { handOverAsk, keyInputs, pagePoint, splitFoot, splitOpen, splitWidth } from "../browser-split.ts";

// Pass 248 D: the chat's browser beside the chat. When it opens, where a click
// lands on the page, and which keys reach a page that is yours.

const step = (action: string, state = "done", more: Record<string, unknown> = {}, id = action) => ({ type: "tool", name: "browser", input: { action, ...more }, state, toolCallId: id });
const run = (id: string, ...entries: ReturnType<typeof step>[]) => ({ id, entries: [{ type: "text" }, ...entries] });
const closed = { open: false, openedTurn: null, closedTurn: null, closedAsk: null };

test("the first browser step of a turn opens the split once, and closing keeps it closed for that turn", () => {
  expect(splitOpen(closed, run("t1"))).toEqual({ open: false, openedTurn: null });
  expect(splitOpen(closed, run("t1", step("open")))).toEqual({ open: true, openedTurn: "t1" });
  // You closed it during t1: it stays closed for t1, and the next turn that browses opens it again.
  expect(splitOpen({ ...closed, openedTurn: "t1", closedTurn: "t1" }, run("t1", step("open"), step("click")))).toEqual({ open: false, openedTurn: "t1" });
  expect(splitOpen({ ...closed, openedTurn: "t1", closedTurn: "t1" }, run("t2", step("open")))).toEqual({ open: true, openedTurn: "t2" });
  // No turn running: it stays as it is, so the last page stays until you close it.
  expect(splitOpen({ ...closed, open: true, openedTurn: "t1" }, undefined)).toEqual({ open: true, openedTurn: "t1" });
  expect(splitOpen(closed, run("t1", step("close")))).toEqual({ open: false, openedTurn: null });
});

test("a hand-over opens it again, unless you closed it while that one was asking", () => {
  const asking = run("t1", step("open"), step("hand_over", "running", { reason: "Sign in to the admin" }, "call-9"));
  expect(handOverAsk(asking)).toEqual({ reason: "Sign in to the admin", toolCallId: "call-9" });
  expect(handOverAsk(run("t1", step("hand_over", "done", { reason: "x" })))).toBeNull();
  expect(splitOpen({ ...closed, openedTurn: "t1", closedTurn: "t1" }, asking).open).toBe(true);
  expect(splitOpen({ ...closed, openedTurn: "t1", closedTurn: "t1", closedAsk: "call-9" }, asking).open).toBe(false);
});

test("a click on the picture lands on the same spot of the page", () => {
  const box = { left: 100, top: 50, width: 640, height: 400 }, page = { width: 1280, height: 800 };
  expect(pagePoint(420, 250, box, page)).toEqual({ x: 640, y: 400 });
  expect(pagePoint(100, 50, box, page)).toEqual({ x: 0, y: 0 });
  expect(pagePoint(2000, -10, box, page)).toEqual({ x: 1280, y: 0 });
});

test("keys become the page's own key events; a paste comes as text instead", () => {
  expect(keyInputs({ key: "a" })).toEqual([{ type: "keyDown", keyCode: "a" }, { type: "char", keyCode: "a" }, { type: "keyUp", keyCode: "a" }]);
  expect(keyInputs({ key: "A", shiftKey: true })).toEqual([{ type: "keyDown", keyCode: "A", modifiers: ["shift"] }, { type: "char", keyCode: "A", modifiers: ["shift"] }, { type: "keyUp", keyCode: "A", modifiers: ["shift"] }]);
  expect(keyInputs({ key: "Enter" })).toEqual([{ type: "keyDown", keyCode: "Enter" }, { type: "char", keyCode: "\r" }, { type: "keyUp", keyCode: "Enter" }]);
  expect(keyInputs({ key: "ArrowLeft" }).map((e) => e.keyCode)).toEqual(["Left", "Left"]);
  expect(keyInputs({ key: " " })).toEqual([{ type: "keyDown", keyCode: "Space" }, { type: "char", keyCode: " " }, { type: "keyUp", keyCode: "Space" }]);
  expect(keyInputs({ key: "a", metaKey: true })).toEqual([{ type: "keyDown", keyCode: "a", modifiers: ["meta"] }, { type: "keyUp", keyCode: "a", modifiers: ["meta"] }]);
  expect(keyInputs({ key: "v", metaKey: true })).toEqual([]);
  expect(keyInputs({ key: "Shift", shiftKey: true })).toEqual([]);
});

test("the browser side keeps room for a page and for the chat", () => {
  expect(splitWidth(200, 1400)).toBe(360);
  expect(splitWidth(1300, 1400)).toBe(1020);
  expect(splitWidth(700, 1400)).toBe(700);
});

test("the line under the page says what is happening, and what is asked of you", () => {
  expect(splitFoot({ reason: "Sign in to the admin" }, null, true)).toEqual({ tone: "ask", words: "Sign in to the admin, then hand it back. The model can't see what you type." });
  expect(splitFoot(null, "Clicked “Pay”", true)).toEqual({ tone: "now", words: "Clicked “Pay”" });
  expect(splitFoot(null, null, true).tone).toBe("");
});
