import { driveFailureKind, type DriveProgress, type DriveResponse, type DriveStreamEvent } from "@demesne/protocol";

/** One streamed decision, never reconnected/replayed as a second inference. */
export function driveStream(parent: AbortSignal, run: (signal: AbortSignal, progress: (event: DriveProgress) => Promise<void>) => Promise<DriveResponse>): Response {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter(), encoder = new TextEncoder();
  const send = async (event: DriveStreamEvent) => {
    signal.throwIfAborted();
    await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const abort = () => { void writer.abort(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  void writer.closed.catch((error) => controller.abort(error));
  const heartbeat = setInterval(() => {
    if (!signal.aborted && (writer.desiredSize ?? 0) > 0) void writer.write(encoder.encode(": heartbeat\n\n")).catch((error) => controller.abort(error));
  }, 15_000);
  heartbeat.unref();
  void (async () => {
    try {
      await send({ type: "queued" });
      await send({ type: "result", response: await run(signal, send) });
    } catch (error) {
      if (!signal.aborted) await send({ type: "error", message: (error instanceof Error ? error.message : "Drive planning failed").slice(0, 8000), recovery: driveFailureKind(error) }).catch(() => {});
    } finally {
      clearInterval(heartbeat); signal.removeEventListener("abort", abort);
      await writer.close().catch(() => {});
    }
  })();
  return new Response(stream.readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
