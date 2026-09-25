import { expect, test } from "bun:test";
import { createPainter, visibleLength } from "@demesne/brand";
import { sidebarRail } from "../src/workbench/sidebar-rail.ts";

test("the Figma rail retains its three targets, state pip, label and bottom brackets", () => {
  const paint = createPainter(true);
  for (const width of [3, 6]) for (const height of [10, 24, 36]) {
    const result = sidebarRail(width, height, paint, false, null);
    expect(result.rows).toHaveLength(height);
    result.rows.forEach((row) => expect(visibleLength(row)).toBe(width));
    expect(result.rows[0]).toContain(paint.text("▪", "citron"));
    expect(result.zones.map((zone) => zone.action)).toEqual(["files", "diff", "preview"]);
    expect(result.rows.at(-1)).toContain(width === 6 ? "[ ]" : "[]");
  }
  expect(sidebarRail(6, 24, paint, true, "preview").rows[0]).toContain(paint.text("▪", "thinking"));
  expect(sidebarRail(6, 24, paint, false, "preview").rows[7]).toContain("[▣]");
});
