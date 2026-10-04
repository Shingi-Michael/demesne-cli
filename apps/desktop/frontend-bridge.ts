import type { StateUpdate } from "../graphics/state-wire.ts";
import type { GraphicsUICommand } from "../graphics/drive-controller.ts";

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
  const commands = new Set<(command: GraphicsUICommand) => void>();
  const pendingUpdates: StateUpdate[] = [];
  const pendingCommands: GraphicsUICommand[] = [];
  let ready = false;
  const request = <T = unknown>(method: string, args: Record<string, unknown> = {}) =>
    invoke<T>("desktop_request", { method, args });
  const send = <T>(listeners: Set<(value: T) => void>, value: T) => {
    for (const listener of listeners) {
      try { listener(value); } catch (error) { onError(error); }
    }
  };
  return {
    bridge: {
      mode: "desktop" as const,
      request,
      subscribe(callback: (update: StateUpdate) => void) {
        updates.add(callback);
        // StateReceiver detects any revision gap and obtains a fresh snapshot.
        for (const update of pendingUpdates.splice(0)) send(updates, update);
        return () => { updates.delete(callback); };
      },
      commands(callback: (command: GraphicsUICommand) => void) {
        commands.add(callback);
        return () => { commands.delete(callback); };
      },
      ready() {
        if (ready) return;
        ready = true;
        void request("desktop-ready").catch(onError);
        for (const command of pendingCommands.splice(0)) send(commands, command);
      },
    },
    update(update: StateUpdate) {
      if (updates.size) send(updates, update);
      else {
        pendingUpdates.push(update);
        if (pendingUpdates.length > 128) pendingUpdates.shift();
      }
    },
    command(command: GraphicsUICommand) {
      if (ready && commands.size) send(commands, command);
      else if (pendingCommands.length < 16) pendingCommands.push(command);
      else void request("ui-result", { id: command.id, error: "Desktop view is still opening. Observe again." }).catch(onError);
    },
    dispose() {
      updates.clear();
      commands.clear();
      pendingUpdates.length = pendingCommands.length = 0;
    },
  };
}
