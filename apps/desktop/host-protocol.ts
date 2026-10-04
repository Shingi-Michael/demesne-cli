import { isRecord } from "@demesne/protocol";
import type { GraphicsUICommand } from "../graphics/drive-controller.ts";
import type { GraphicsSnapshot, StateUpdate } from "../graphics/state-wire.ts";

/** The webview receives this public projection, never daemon/provider credentials. */
export interface DesktopBootstrap {
  workspace: string | null;
  recentProjects: string[];
  snapshot: GraphicsSnapshot | null;
}
export interface DesktopRequest {
  kind: "request";
  id: number;
  method: string;
  args: Record<string, unknown>;
}
export interface NativeResponse {
  kind: "native-response";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}
export type DesktopInput = DesktopRequest | NativeResponse;
export type DesktopOutput =
  | { kind: "response"; id: number; ok: true; value?: unknown }
  | { kind: "response"; id: number; ok: false; error: string }
  | { kind: "update"; update: StateUpdate }
  | { kind: "command"; command: GraphicsUICommand }
  | { kind: "native"; id: number; method: "copy" | "open"; args: { text?: string; path?: string } }
  | { kind: "protocol-error"; error: string };

export const MAX_INPUT_BYTES = 1024 * 1024;
export function parseDesktopInput(value: unknown): DesktopInput {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || Number(value.id) <= 0)
    throw new Error("Expected a positive request id");
  if (value.kind === "native-response") {
    if (typeof value.ok !== "boolean" || (value.error !== undefined && typeof value.error !== "string"))
      throw new Error("Invalid native response");
    return value as unknown as NativeResponse;
  }
  if (value.kind !== "request" || typeof value.method !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.method) || !isRecord(value.args))
    throw new Error("Expected a request method and argument object");
  return value as unknown as DesktopRequest;
}
