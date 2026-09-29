import type { DaemonApp } from "./app.ts";

/** Inference and event streams own their deadlines and cancellation. Bun's
 * default 10-second idle cutoff otherwise expires before the 15-second SSE
 * heartbeat, including while a remote model is still prefilling its prompt. */
export function serveDaemon(app: Pick<DaemonApp, "fetch">, options: { hostname: string; port: number }) {
  return Bun.serve({ ...options, fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/v1/drive/decide"
      || request.method === "GET" && path === "/v1/events") server.timeout(request, 0);
    return app.fetch(request);
  } });
}
