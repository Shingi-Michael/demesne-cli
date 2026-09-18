import { describe, expect, test } from "bun:test";
import { createPainter, visibleLength } from "@demesne/brand";
import { approvalOptions, formatApprovalSelection, reduceApprovalSelection } from "../src/approval-selection.ts";

describe("approval selection defaults", () => {
  test("defaults unsandboxed host execution to deny", () => {
    const result = approvalOptions(false);
    expect(result.options[result.selectedIndex]).toBe("deny");
  });

  test("retains allow-once as the edit approval default", () => {
    const result = approvalOptions(true);
    expect(result.options[result.selectedIndex]).toBe("allow_once");
    expect(result.options).toContain("allow_session");
  });

  test("navigates and reports Ctrl-C as turn cancellation", () => {
    expect(reduceApprovalSelection(0, true, { name: "right" }).selectedIndex).toBe(1);
    expect(reduceApprovalSelection(1, true, { name: "enter" }).decision).toBe("allow_session");
    expect(reduceApprovalSelection(0, false, { name: "c", ctrl: true })).toEqual({
      selectedIndex: 0,
      decision: "deny",
      cancelledTurn: true,
    });
  });

  test("renders approval controls on one bounded physical line", () => {
    for (const width of [40, 80, 120]) {
      const line = formatApprovalSelection(1, true, width, createPainter(true));
      expect(line).not.toContain("\n");
      expect(visibleLength(line)).toBeLessThanOrEqual(width);
    }
  });
});

describe("approval selection persistence", () => {
  test("offers the persisted option only when a rule can be saved", () => {
    expect(approvalOptions(true, true).options).toEqual(["allow_once", "allow_session", "allow_always", "deny"]);
    expect(approvalOptions(false, true).options).toEqual(["allow_once", "allow_always", "deny"]);
    expect(approvalOptions(true, false).options).not.toContain("allow_always");
    expect(approvalOptions(false, false).options).not.toContain("allow_always");
  });

  test("selects the persisted option with s and keeps host execution failing safe", () => {
    expect(reduceApprovalSelection(0, true, { name: "s" }, true).decision).toBe("allow_always");
    expect(reduceApprovalSelection(0, false, { name: "s" }, true).decision).toBe("allow_always");
    expect(reduceApprovalSelection(0, false, { name: "s" }, false).decision).toBeNull();
    const host = approvalOptions(false, true);
    expect(host.options[host.selectedIndex]).toBe("deny");
  });

  test("renders the persisted option within the width", () => {
    const wide = formatApprovalSelection(2, true, 120, createPainter(false), true);
    expect(wide).toContain("Always allow (save)");
    for (const width of [40, 80, 120]) {
      const line = formatApprovalSelection(2, true, width, createPainter(true), true);
      expect(line).not.toContain("\n");
      expect(visibleLength(line)).toBeLessThanOrEqual(width);
    }
  });
});
