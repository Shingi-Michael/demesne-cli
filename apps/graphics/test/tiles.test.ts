import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { TileFrame } from "../tiles.cjs";
import { TileEncoder, toRGBA } from "../tile-encoder.cjs";
import { TileTransport, type TilePatch } from "../transport.ts";

// Two BGRA pixels: Chromium's byte order.
const bgra = Buffer.from([10, 20, 30, 255, 1, 2, 3, 128]);

test("BGRA becomes RGBA by swapping red and blue, alpha kept", () => {
  expect([...toRGBA(bgra)]).toEqual([30, 20, 10, 255, 3, 2, 1, 128]);
});

test.each([["workers", 2], ["no workers", 0]] as const)("the encoder compresses RGBA, inline or into a file (%s)", async (_, size) => {
  const encoder = new TileEncoder(size || 1);
  if (!size) encoder.fail(new Error("disabled for this test"));
  const directory = mkdtempSync(join(tmpdir(), "tile-encoder-"));
  try {
    const inline = await encoder.encode(bgra);
    expect("data" in inline && [...inflateSync(Buffer.from(inline.data, "base64"))]).toEqual([30, 20, 10, 255, 3, 2, 1, 128]);
    const path = join(directory, "tty-graphics-protocol-1");
    const written = await encoder.encode(bgra, path);
    expect(written).toMatchObject({ file: path });
    expect([...inflateSync(readFileSync(path))]).toEqual([30, 20, 10, 255, 3, 2, 1, 128]);
  } finally { encoder.fail(new Error("done")); rmSync(directory, { recursive: true, force: true }); }
});

test("a frame drains changed tiles as raw pixels, and only those that differ from what was sent", () => {
  const frame = new TileFrame();
  frame.reset(4, 2, 2, 2, Buffer.alloc(4 * 2 * 4), 1);
  const first = frame.drain();
  expect(first.reset).toBe(true);
  expect(first.tiles.map((tile) => [tile.id, tile.data.length])).toEqual([[0, 16], [1, 16]]);
  // Change one pixel in the right-hand tile.
  const next = Buffer.alloc(4 * 2 * 4); next[3 * 4] = 200;
  expect(frame.update(next, 4, 2, { x: 0, y: 0, width: 4, height: 2 })).toBe(true);
  expect(frame.drain().tiles.map((tile) => tile.id)).toEqual([1]);
});

test("tiles go to the terminal as zlib RGBA: by file path when written, inline otherwise", () => {
  const cell = { width: 8, height: 18 };
  const tile = (extra: Partial<TilePatch>): TilePatch => ({ id: 0, x: 0, y: 0, width: 8, height: 18, format: "rgba-zlib", ...extra });
  const batch = (tiles: TilePatch[], epoch = 1) => ({ kind: "tiles" as const, serial: 1, epoch, width: 8, height: 18, reset: true, tiles });
  const transport = new TileTransport();
  const inline = transport.apply(batch([tile({ data: "QUFBQQ==" })]), cell);
  expect(inline).toContain("a=t,t=d,f=32,o=z,s=8,v=18,");
  expect(inline).toContain(";QUFBQQ==");
  const file = "/tmp/x/tty-graphics-protocol-7";
  const byPath = transport.apply(batch([tile({ file })], 2), cell);
  expect(byPath).toContain(`a=t,t=t,f=32,o=z,s=8,v=18,`);
  expect(byPath).toContain(`;${Buffer.from(file).toString("base64")}`);
  expect(byPath).not.toContain("t=d");
  // A PNG tile keeps f=100.
  expect(transport.apply(batch([tile({ data: "QUFBQQ==", format: "png" })], 3), cell)).toContain("f=100");
});

test("with files enabled, inline tile data is written to the directory and sent by path", () => {
  const directory = mkdtempSync(join(tmpdir(), "tile-transport-"));
  try {
    const transport = new TileTransport();
    transport.useFiles(directory);
    const output = transport.apply({ kind: "tiles", serial: 1, epoch: 1, width: 8, height: 18, reset: true,
      tiles: [{ id: 0, x: 0, y: 0, width: 8, height: 18, format: "rgba-zlib", data: Buffer.from("pixels").toString("base64") }] }, { width: 8, height: 18 });
    const path = Buffer.from(/t=t,[^;]*;([^\x1b]+)/.exec(output)![1]!, "base64").toString();
    expect(path.startsWith(join(directory, "tty-graphics-protocol-"))).toBe(true);
    expect(existsSync(path) && readFileSync(path, "utf8")).toBe("pixels");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
