import { describe, expect, test } from "bun:test";
import { applyFooterScrollRegion, resetFooterScrollRegion } from "../src/terminal-control.ts";

describe("fixed footer terminal control", () => {
  test("preserves the cursor while changing and resetting the scroll region", () => {
    expect(applyFooterScrollRegion(24)).toBe("\x1b7\x1b[1;23r\x1b8");
    expect(applyFooterScrollRegion(5)).toBe("\x1b7\x1b[r\x1b8");
    expect(resetFooterScrollRegion(24)).toBe("\x1b7\x1b[24;1H\x1b[2K\x1b[r\x1b8");
  });
});
