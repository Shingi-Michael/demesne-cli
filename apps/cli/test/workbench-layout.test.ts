import { describe, expect, test } from "bun:test";
import { computeWorkbenchLayout } from "../src/workbench/layout.ts";

describe("computeWorkbenchLayout", () => {
  test("places header, input, and footer without overlap on a standard terminal", () => {
    const layout = computeWorkbenchLayout(120, 32, { sidebar: "auto", inputLines: 3 });
    expect(layout.header.row).toBe(0);
    expect(layout.footer.row).toBe(31);
    expect(layout.input.row + layout.input.height).toBe(layout.footer.row);
    expect(layout.conversation.row).toBe(layout.header.height);
    expect(layout.conversation.row + layout.conversation.height).toBe(layout.input.row);
    expect(layout.sidebar).not.toBeNull();
    expect(layout.sidebar!.row).toBe(layout.conversation.row);
    expect(layout.sidebar!.height).toBe(layout.conversation.height);
    expect(layout.dividerColumn).toBe(120 - layout.sidebar!.width - 1);
    expect(layout.conversation.width + layout.sidebar!.width + 1).toBe(120);
  });

  test("hides the sidebar on narrow terminals or when requested", () => {
    expect(computeWorkbenchLayout(80, 24, { sidebar: "auto" }).sidebar).toBeNull();
    expect(computeWorkbenchLayout(120, 32, { sidebar: "hidden" }).sidebar).toBeNull();
    expect(computeWorkbenchLayout(80, 24, { sidebar: "wide" }).sidebar).not.toBeNull();
  });

  test("grows the input area for palettes and clamps it on short terminals", () => {
    const tall = computeWorkbenchLayout(100, 30, { sidebar: "auto", inputLines: 9 });
    expect(tall.input.height).toBe(9);
    const short = computeWorkbenchLayout(60, 10, { sidebar: "hidden", inputLines: 9 });
    expect(short.input.height).toBeLessThanOrEqual(6);
    expect(short.input.row).toBeGreaterThan(short.header.row);
  });

  test("enforces a minimum usable size", () => {
    const tiny = computeWorkbenchLayout(10, 2);
    expect(tiny.width).toBe(40);
    expect(tiny.height).toBe(10);
    expect(tiny.conversation.height).toBeGreaterThan(0);
  });
});
