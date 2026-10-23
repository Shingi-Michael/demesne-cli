import { describe, expect, test } from "bun:test";
import { LAND_H, LAND_W, mapCaption, parcelAt, recency, squarify, survey } from "../estate.ts";

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
