import { describe, expect, test } from "bun:test";
import type { Session } from "@demesne/protocol";
import { reduceSessionPicker, sessionListItem } from "../src/session-picker.ts";

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
