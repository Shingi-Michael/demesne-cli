import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { PipeWriter, isDisconnect } from "../pipe-writer.cjs";

test("asynchronous EPIPE closes once and blocks later writes and acknowledgements", async () => {
  const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
  const stopped = Promise.withResolvers<Error | undefined>();
  let writes = 0, closes = 0, acknowledgements = 0;
  const stream = new Writable({ write(_chunk, _encoding, callback) { writes++; setImmediate(() => callback(error)); } });
  const writer = new PipeWriter(stream, e => { closes++; stopped.resolve(e); });
  writer.write("frame\n", () => acknowledgements++);
  expect(await stopped.promise).toBe(error);
  await Bun.sleep(10); // callback(error), error and close must remain idempotent.
  expect(writer.closed).toBe(true); expect(writer.write("late frame\n")).toBe(false);
  expect({ writes, closes, acknowledgements }).toEqual({ writes: 1, closes: 1, acknowledgements: 0 });
});

test("a successful write completing after shutdown cannot send an acknowledgement", async () => {
  let complete!: () => void, acknowledged = false, closed = 0;
  const stream = new Writable({ write(_chunk, _encoding, callback) { complete = callback; } });
  const writer = new PipeWriter(stream, () => closed++);
  writer.write("frame", () => { acknowledged = true; });
  writer.close(); complete(); await Bun.sleep(0);
  expect(acknowledged).toBe(false); expect(closed).toBe(1); stream.destroy();
});

test("backpressure is not a broken connection and successful writes still acknowledge", async () => {
  let complete!: () => void, acknowledged = false, closes = 0;
  const stream = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { complete = callback; } });
  const writer = new PipeWriter(stream, () => { closes++; });
  expect(writer.write("frame", () => { acknowledged = true; })).toBe(false);
  expect(writer.closed).toBe(false); complete(); await Bun.sleep(0);
  expect(acknowledged).toBe(true); expect(closes).toBe(0);
  writer.close(); stream.destroy();
});

test("already closed and synchronously broken pipes close without throwing", () => {
  const dead = new Writable({ write(_chunk, _encoding, callback) { callback(); } }); dead.destroy();
  let closes = 0; const writer = new PipeWriter(dead, () => closes++);
  expect(writer.write("frame")).toBe(false); expect(closes).toBe(1);
  const broken = new Writable(); broken.write = (() => { throw Object.assign(new Error("closed"), { code: "EPIPE" }); }) as typeof broken.write;
  const second = new PipeWriter(broken, () => closes++);
  expect(() => second.write("frame")).not.toThrow(); expect(closes).toBe(2);
});

test("disconnects are distinguished from unrelated I/O failures", () => {
  for (const code of ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]) expect(isDisconnect(Object.assign(new Error(), { code }))).toBe(true);
  expect(isDisconnect()).toBe(true);
  expect(isDisconnect(Object.assign(new Error(), { code: "ENOSPC" }))).toBe(false);
});
