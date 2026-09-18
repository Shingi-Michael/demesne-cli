import { describe, expect, test } from "bun:test";
import {
  formatDesktopNotification,
  shouldNotifyApproval,
  shouldNotifyCompletion,
} from "../src/notifications.ts";

describe("formatDesktopNotification", () => {
  test("emits an OSC 9 sequence with the Demesne prefix", () => {
    expect(formatDesktopNotification("Turn complete")).toBe("\x1b]9;Demesne: Turn complete\x07");
  });

  test("strips control characters and collapses whitespace", () => {
    expect(formatDesktopNotification("evil\x07\x1b[2J  message")).toBe("\x1b]9;Demesne: evil [2J message\x07");
    expect(formatDesktopNotification("  padded  ")).toBe("\x1b]9;Demesne: padded\x07");
  });
});

describe("notification gating", () => {
  test("approval notifications require an enabled interactive terminal", () => {
    expect(shouldNotifyApproval({ enabled: true, isTTY: true })).toBe(true);
    expect(shouldNotifyApproval({ enabled: false, isTTY: true })).toBe(false);
    expect(shouldNotifyApproval({ enabled: true, isTTY: false })).toBe(false);
  });

  test("environment kill switch wins", () => {
    expect(shouldNotifyApproval({ enabled: true, isTTY: true, env: { DEMESNE_NO_NOTIFICATIONS: "1" } })).toBe(false);
    expect(shouldNotifyApproval({ enabled: true, isTTY: true, env: { DEMESNE_NO_NOTIFICATIONS: "true" } })).toBe(false);
    expect(shouldNotifyApproval({ enabled: true, isTTY: true, env: {} })).toBe(true);
  });

  test("completion notifications respect the minimum duration", () => {
    const base = { enabled: true, isTTY: true, minimumDurationMs: 30_000 };
    expect(shouldNotifyCompletion({ ...base, durationMs: 29_999 })).toBe(false);
    expect(shouldNotifyCompletion({ ...base, durationMs: 30_000 })).toBe(true);
    expect(shouldNotifyCompletion({ ...base, durationMs: 90_000, enabled: false })).toBe(false);
  });
});
