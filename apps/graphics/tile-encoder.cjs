// Tile encoding off the renderer's main thread. Chromium's bitmaps are BGRA;
// tiles leave as RGBA (Kitty f=32) compressed with fast zlib (o=z). PNG's
// filtering and default compression cost ~6x more per tile, which made
// scrolling lag: a scroll changes every tile, and Retina has 4x the pixels.
// A small worker pool converts and compresses tiles in parallel.
const { Worker, isMainThread, parentPort } = require("node:worker_threads");
const { deflate, deflateSync } = require("node:zlib");
const { writeFileSync } = require("node:fs");
const { availableParallelism } = require("node:os");

// BGRA → RGBA, one 32-bit operation per pixel (swap the red and blue bytes).
function toRGBA(bgra) {
  const out = Buffer.allocUnsafe(bgra.length);
  const from = new Uint32Array(bgra.buffer, bgra.byteOffset, bgra.length / 4);
  const to = new Uint32Array(out.buffer, out.byteOffset, out.length / 4);
  for (let i = 0; i < from.length; i++) {
    const pixel = from[i];
    to[i] = (pixel & 0xff00ff00) | ((pixel >>> 16) & 0xff) | ((pixel & 0xff) << 16);
  }
  return out;
}
const encodeSync = (bgra) => deflateSync(toRGBA(bgra), { level: 1 });

if (!isMainThread) {
  parentPort.on("message", ({ id, data, path }) => {
    try {
      const out = encodeSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      // With a path, the tile goes straight to the terminal's file: only the
      // path travels on. Otherwise it is copied back (Electron can't transfer
      // zlib's output buffers; a compressed tile is a few kilobytes).
      if (path) { writeFileSync(path, out, { mode: 0o600 }); parentPort.postMessage({ id, path, bytes: out.length }); }
      else parentPort.postMessage({ id, out });
    } catch (error) { parentPort.postMessage({ id, error: String(error) }); }
  });
}

class TileEncoder {
  constructor(size = Math.max(1, Math.min(4, availableParallelism() - 1))) {
    this.pending = new Map();
    this.serial = 0;
    this.next = 0;
    try {
      this.workers = Array.from({ length: size }, () => {
        const worker = new Worker(__filename);
        worker.unref();
        worker.on("message", ({ id, out, path, bytes, error }) => {
          const task = this.pending.get(id);
          if (!task) return;
          this.pending.delete(id);
          if (error) task.reject(new Error(error));
          else task.resolve(path ? { file: path, bytes } : { data: Buffer.from(out).toString("base64"), bytes: out.length });
        });
        worker.on("error", (error) => this.fail(error));
        return worker;
      });
    } catch {
      this.workers = [];
    }
  }
  /// Resolves to the compressed RGBA tile: `{ file }` when given a path (the
  /// worker wrote it there), else base64 `{ data }`. Without workers it still
  /// compresses on the thread pool, so a frame's tiles never encode serially.
  encode(bgra, path) {
    if (!this.workers.length) return new Promise((resolve, reject) => deflate(toRGBA(bgra), { level: 1 }, (error, out) => {
      if (error) return reject(error);
      if (!path) return resolve({ data: out.toString("base64"), bytes: out.length });
      try { writeFileSync(path, out, { mode: 0o600 }); resolve({ file: path, bytes: out.length }); } catch (failure) { reject(failure); }
    }));
    const id = ++this.serial, worker = this.workers[this.next++ % this.workers.length];
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Copied, not transferred: the frame keeps each tile to diff the next paint.
      worker.postMessage({ id, data: bgra, path });
    });
  }
  fail(error) {
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }
}
module.exports = { TileEncoder, toRGBA, encodeSync };
