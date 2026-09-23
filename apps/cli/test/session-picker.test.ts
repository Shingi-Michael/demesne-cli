import { describe, expect, test } from "bun:test";
import type { Session } from "@demesne/protocol";
import { filterDialogIndices, reduceDialogPicker, reduceSessionPicker, sessionListItem } from "../src/session-picker.ts";

describe("session picker", () => {
  test("navigates, wraps, and accepts direct numeric selection", () => {
    expect(reduceSessionPicker(0, 3, "k", { name: "k" })).toEqual({ index: 2, decision: "continue" });
    expect(reduceSessionPicker(2, 3, "j", { name: "j" })).toEqual({ index: 0, decision: "continue" });
    expect(reduceSessionPicker(1, 3, "", { name: "home" })).toEqual({ index: 0, decision: "continue" });
    expect(reduceSessionPicker(0, 3, "3", { name: "3" })).toEqual({ index: 2, decision: "select" });
    expect(reduceSessionPicker(1, 3, "", { name: "enter" })).toEqual({ index: 1, decision: "select" });
  });

  test("cancels without losing the current selection", () => {
    expect(reduceSessionPicker(1, 3, "", { name: "escape" })).toEqual({ index: 1, decision: "cancel" });
    expect(reduceSessionPicker(1, 3, "", { name: "c", ctrl: true })).toEqual({ index: 1, decision: "cancel" });
  });

  test("retains exact IDs while deriving truthful display metadata", () => {
    const session = {
      id: "exact-session-id-12345678",
      title: "Runtime hardening",
      updatedAt: "2026-08-30T00:00:00.000Z",
      turns: [{ status: "completed" }],
      workspace: { id: "workspace", root: "/tmp/project" },
    } as Session;
    expect(sessionListItem(session)).toEqual({
      id: "exact-session-id-12345678",
      title: "Runtime hardening",
      turnCount: 1,
      updatedAt: "2026-08-30T00:00:00.000Z",
      status: "completed",
      root: "/tmp/project",
    });
  });
});

describe("dialog picker filter", () => {
  const items = ["parser hardening", "parser: unicode guards", "runtime tuning", "unrelated work"];

  test("filters by case-insensitive subsequence and ranks whole substrings first", () => {
    expect(filterDialogIndices(items, "")).toEqual([0, 1, 2, 3]);
    expect(filterDialogIndices(items, "parse")).toEqual([0, 1]);
    expect(filterDialogIndices(items, "prs")).toEqual([0, 1]);
    expect(filterDialogIndices(items, "runtime")).toEqual([2]);
    expect(filterDialogIndices(items, "zzz")).toEqual([]);
  });

  test("typing appends to the query and resets the selection", () => {
    let state = { index: 2, query: "" };
    state = reduceDialogPicker(state, items.length, {}, "p").state;
    expect(state.query).toBe("p");
    expect(state.index).toBe(0);
  });

  test("backspace edits the query one grapheme at a time", () => {
    let state = { index: 0, query: "parse" };
    state = reduceDialogPicker(state, items.length, { name: "backspace" }, "").state;
    expect(state.query).toBe("pars");
    state = reduceDialogPicker(state, items.length, { name: "backspace" }, "").state;
    expect(state.query).toBe("par");
  });

  test("navigation stays inside the filtered list and selects in it", () => {
    let state = { index: 0, query: "" };
    state = reduceDialogPicker(state, 2, { name: "down" }, "").state;
    expect(state.index).toBe(1);
    state = reduceDialogPicker(state, 2, { name: "down" }, "").state;
    expect(state.index).toBe(0);
    const decision = reduceDialogPicker({ index: 1, query: "" }, 2, { name: "enter" }, "");
    expect(decision.decision).toBe("select");
    const cancelled = reduceDialogPicker({ index: 1, query: "" }, 2, { name: "escape" }, "");
    expect(cancelled.decision).toBe("cancel");
  });

  test("digits jump to a row only while the filter is empty", () => {
    const jump = reduceDialogPicker({ index: 0, query: "" }, items.length, {}, "3");
    expect(jump.decision).toBe("continue");
    expect(jump.state.index).toBe(2);
    const typed = reduceDialogPicker({ index: 0, query: "ru" }, items.length, {}, "3");
    expect(typed.decision).toBe("continue");
    expect(typed.state.query).toBe("ru3");
  });

  test("j and k are searchable letters", () => {
    expect(reduceDialogPicker({ index: 0, query: "" }, items.length, {}, "k").state.query).toBe("k");
    expect(reduceDialogPicker({ index: 0, query: "rt" }, items.length, {}, "k").state.query).toBe("rtk");
  });
});
