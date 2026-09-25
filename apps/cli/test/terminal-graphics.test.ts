import { expect, test } from "bun:test";
import { fitImage, graphicsProbe, TerminalGraphics } from "../src/terminal-graphics.ts";

test("image layout accounts for rectangular terminal cells", () => {
  expect(fitImage(100, 100, { row: 0, column: 0, columns: 40, rows: 20 }, { width: 8, height: 16 }))
    .toEqual({ row: 0, column: 0, columns: 40, rows: 20 });
  expect(fitImage(0, 100, { row: 0, column: 0, columns: 40, rows: 20 }, { width: 8, height: 16 })).toBeNull();
});

test("image placements reuse bytes across resize and clean up only owned IDs", () => {
  const graphics = new TerminalGraphics(123);
  const image = { key: "hash", png: new Uint8Array(9000), placement: { row: 2, column: 50, columns: 20, rows: 10 } };
  const first = graphics.update(image);
  expect(first).toContain("a=t,t=d,f=100,i=123");
  expect(first).toContain("m=1");
  expect(first).toContain("m=0");
  expect(graphics.update(image)).toBe("");
  const resized = graphics.update({ ...image, placement: { ...image.placement, columns: 15 } });
  expect(resized).not.toContain("a=t");
  expect(resized).toContain("a=p,i=123");
  expect(graphics.clear()).toContain("a=d,d=I,i=123");
  expect(graphics.clear()).toBe("");
  expect(graphicsProbe(123)).toContain("a=q");
});
