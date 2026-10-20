import type { StateUpdate } from "../graphics/state-wire.ts";

export type DesktopInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** Install once per webview. Subscriptions precede host bootstrap, so packets
 * arriving while the shared UI module loads are retained until it subscribes. */
export function createDesktopBridge(
  invoke: DesktopInvoke,
  onError: (error: unknown) => void,
) {
  const updates = new Set<(update: StateUpdate) => void>();
  const pendingUpdates: StateUpdate[] = [];
  let ready = false, drainingUpdates = false, disposed = false;
  const request = <T = unknown>(method: string, args: Record<string, unknown> = {}) =>
    invoke<T>("desktop_request", { method, args });
  const send = <T>(listeners: Set<(value: T) => void>, value: T) => {
    for (const listener of listeners) {
      try { listener(value); } catch (error) { onError(error); }
    }
  };
  const drainUpdates = () => {
    if (disposed || drainingUpdates || !updates.size || !pendingUpdates.length) return;
    drainingUpdates = true;
    // live.ts subscribes before its remaining module-level UI elements exist.
    // Deliver only after module evaluation completes, including packets arriving
    // between subscription and this drain; all updates retain their FIFO order.
    queueMicrotask(() => {
      try {
        while (!disposed && updates.size && pendingUpdates.length)
          send(updates, pendingUpdates.shift()!);
      } finally {
        drainingUpdates = false;
      }
    });
  };
  return {
    bridge: {
      mode: "desktop" as const,
      request,
      subscribe(callback: (update: StateUpdate) => void) {
        if (disposed) return () => {};
        updates.add(callback);
        drainUpdates();
        return () => { updates.delete(callback); };
      },
      ready() {
        if (ready || disposed) return;
        ready = true;
        void request("desktop-ready").catch(onError);
      },
    },
    update(update: StateUpdate) {
      if (disposed) return;
      pendingUpdates.push(update);
      // StateReceiver detects a gap if a very slow mount exceeds this bound.
      if (pendingUpdates.length > 128) pendingUpdates.shift();
      drainUpdates();
    },
    dispose() {
      disposed = true;
      updates.clear();
      pendingUpdates.length = 0;
    },
  };
}
