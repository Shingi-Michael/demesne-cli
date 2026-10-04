import { describe, expect, test } from "bun:test";
import { createDesktopBridge, type DesktopInvoke } from "../frontend-bridge.ts";
import type { GraphicsSnapshot, StateUpdate } from "../../graphics/state-wire.ts";
import type { GraphicsUICommand } from "../../graphics/drive-controller.ts";

const snapshot = (revision: number): StateUpdate => ({
  kind: "snapshot", state: { revision } as GraphicsSnapshot,
});
const command = (id: string): GraphicsUICommand => ({
  id, observationId: "current", action: { kind: "compose", text: "Inspect the project." },
});
function fixture(reject = false) {
  const calls: { command: string; args?: Record<string, unknown> }[] = [], errors: unknown[] = [];
  const invoke: DesktopInvoke = <T>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return reject ? Promise.reject(new Error("Sidecar stopped.")) : Promise.resolve(undefined as T);
  };
  return { ...createDesktopBridge(invoke, (error) => errors.push(error)), calls, errors };
}

describe("desktop bridge", () => {
  test("retains updates arriving before the shared UI subscribes in FIFO order", async () => {
    const transport = fixture(), received: StateUpdate[] = [];
    transport.update(snapshot(1));
    transport.update(snapshot(2));
    const unsubscribe = transport.bridge.subscribe((update) => received.push(update));
    transport.update(snapshot(3));
    expect(received).toHaveLength(0);
    await Promise.resolve();
    expect(received.map((update) => update.kind === "snapshot" && update.state.revision)).toEqual([1, 2, 3]);
    unsubscribe();
    transport.update(snapshot(4));
    await Promise.resolve();
    expect(received).toHaveLength(3);
  });
  test("bounds startup update buffering and keeps the newest packet", async () => {
    const transport = fixture(), received: StateUpdate[] = [];
    for (let revision = 0; revision < 300; revision++) transport.update(snapshot(revision));
    transport.bridge.subscribe((update) => received.push(update));
    await Promise.resolve();
    expect(received).toHaveLength(128);
    expect(received.at(-1)).toEqual(snapshot(299));
  });
  test("delays UI commands until bootstrap rendered and ready is sent once", () => {
    const transport = fixture(), received: string[] = [];
    transport.command(command("first"));
    transport.bridge.commands((command) => received.push(command.id));
    expect(received).toEqual([]);
    transport.bridge.ready();
    transport.bridge.ready();
    transport.command(command("second"));
    expect(received).toEqual(["first", "second"]);
    expect(transport.calls).toEqual([{ command: "desktop_request", args: { method: "desktop-ready", args: {} } }]);
  });
  test("reports an unready command overflow instead of leaving Drive waiting", () => {
    const transport = fixture();
    for (let index = 0; index < 17; index++) transport.command(command(String(index)));
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.args).toEqual({
      method: "ui-result", args: { id: "16", error: "Desktop view is still opening. Observe again." },
    });
  });
  test("passes requests only through the restricted native proxy", async () => {
    const transport = fixture();
    await transport.bridge.request("submit", { text: "Build it.", sessionId: "session" });
    expect(transport.calls).toEqual([{ command: "desktop_request", args: { method: "submit", args: { text: "Build it.", sessionId: "session" } } }]);
    expect(transport.bridge.mode).toBe("desktop");
  });
  test("a failed ready request reaches the recoverable error shell", async () => {
    const transport = fixture(true);
    transport.bridge.ready();
    await Promise.resolve();
    expect(transport.errors).toHaveLength(1);
    expect(String(transport.errors[0])).toContain("Sidecar stopped");
  });
  test("isolates listener failures and removes listeners when a view unloads", async () => {
    const transport = fixture(), received: StateUpdate[] = [];
    transport.bridge.subscribe(() => { throw new Error("Broken view."); });
    transport.bridge.subscribe((update) => received.push(update));
    transport.update(snapshot(1));
    await Promise.resolve();
    expect(transport.errors).toHaveLength(1);
    expect(received).toHaveLength(1);
    transport.dispose();
    transport.update(snapshot(2));
    await Promise.resolve();
    expect(received).toHaveLength(1);
  });
  test("waits for subscriber module initialization before rendering queued packets", async () => {
    const transport = fixture(), initialized: boolean[] = [];
    let moduleInitialized = false;
    transport.update(snapshot(1));
    transport.bridge.subscribe(() => initialized.push(moduleInitialized));
    transport.update(snapshot(2));
    // Represents setupRoot and other late module-level assignments in live.ts.
    moduleInitialized = true;
    await Promise.resolve();
    expect(initialized).toEqual([true, true]);
  });
  test("does not deliver a scheduled packet after disposal", async () => {
    const transport = fixture(), received: StateUpdate[] = [];
    transport.update(snapshot(1));
    transport.bridge.subscribe((update) => received.push(update));
    transport.dispose();
    await Promise.resolve();
    expect(received).toHaveLength(0);
  });
});
