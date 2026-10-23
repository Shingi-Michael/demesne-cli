import { describe, expect, test } from "bun:test";
import { LAND_H, LAND_W, mapCaption, markLayer, parcelAt, parcelOf, placeMarks, recency, squarify, survey } from "../estate.ts";

const districts = [
  { path: "apps/desktop", lines: 13900, files: 67, changedAt: null },
  { path: "apps/daemon", lines: 12000, files: 50, changedAt: null },
  { path: "packages/storage", lines: 2400, files: 9, changedAt: null },
  { path: "docs", lines: 600, files: 4, changedAt: null },
];

describe("estate", () => {
  test("squarify fills the box with areas in proportion", () => {
    const boxes = squarify([6, 6, 4, 3, 2, 2, 1], 0, 0, 600, 400);
    const total = boxes.reduce((sum, box) => sum + box.w * box.h, 0);
    expect(total).toBeCloseTo(600 * 400, 3);
    expect(boxes[0]!.w * boxes[0]!.h).toBeCloseTo((6 / 24) * 600 * 400, 3);
  });

  test("each parcel's land is close to its share of the lines", () => {
    const land = survey(districts);
    const counts = new Map<number, number>();
    for (const owner of land.owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    const total = districts.reduce((sum, district) => sum + district.lines, 0);
    land.parcels.forEach((parcel, index) => {
      const share = (counts.get(index) ?? 0) / land.owner.length;
      expect(Math.abs(share - parcel.district.lines / total)).toBeLessThan(0.03);
    });
    // The largest parcel is under its own centre.
    const biggest = land.parcels[0]!;
    expect(parcelAt(land, biggest.cx, biggest.cy)).toBe(0);
    expect(parcelAt(land, -1, 10)).toBe(-1);
    expect(parcelAt(land, LAND_W + 1, LAND_H / 2)).toBe(-1);
  });

  test("the same project is surveyed the same way", () => {
    expect(survey(districts).parcels.map((parcel) => [Math.round(parcel.cx), Math.round(parcel.cy)]))
      .toEqual(survey(districts).parcels.map((parcel) => [Math.round(parcel.cx), Math.round(parcel.cy)]));
  });

  test("captions and recency", () => {
    const now = Date.UTC(2026, 9, 23, 9);
    expect(recency({ ...districts[0]!, changedAt: now - 3600_000 }, now)).toBe("today");
    expect(recency({ ...districts[0]!, changedAt: now - 3 * 86400_000 }, now)).toBe("week");
    expect(recency(districts[0]!, now)).toBe("quiet");
    expect(mapCaption(districts, null, now)).toBe("28.9k lines in 4 places");
    expect(mapCaption(districts, districts[2]!, now)).toBe("packages/storage · 2.4k lines · 9 files · quiet · click to work here");
  });
});

describe("marks", () => {
  const land = survey([...districts, { path: "", lines: 900, files: 3, changedAt: null }]);
  const index = (path: string | null) => land.parcels.findIndex((parcel) => parcel.district.path === path);

  test("a file belongs to the deepest folder that holds it", () => {
    expect(parcelOf(land, "apps/desktop/workspace/live.ts")).toBe(index("apps/desktop"));
    expect(parcelOf(land, "README.md")).toBe(index(""));
    expect(parcelOf(land, "nowhere/x.ts")).toBe(-1);
  });

  test("marks stand inside their parcel and name themselves", () => {
    const placed = placeMarks(land, [
      { key: "a", label: "Sidebar rename", tone: "work", parcel: index("apps/desktop"), detail: "", sessionId: "s1" },
      { key: "b", label: "Emoji ids", tone: "wait", parcel: index("apps/desktop"), from: index("docs"), detail: "", sessionId: "s2" },
    ]);
    for (const item of placed) expect(parcelAt(land, item.x, item.y)).toBe(item.mark.parcel);
    expect(placed[1]!.y).not.toBe(placed[0]!.y);
    const svg = markLayer(land, placed);
    expect(svg).toContain('data-action="select-session"');
    expect(svg).toContain("Sidebar rename");
    expect(svg).toContain("mk-ring");
    expect(svg).toContain('class="trail wait"');
  });
});
