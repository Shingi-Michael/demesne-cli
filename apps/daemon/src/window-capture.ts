import { isRecord } from "@demesne/protocol";
import { captureWindow, listWindows, supported, type Shot, type ShotWindow } from "../../../packages/screen/src/index.ts";
import type { AgentTool, ToolContext } from "./tools.ts";
import type { StructuredToolResult } from "./artifacts.ts";

/// The model's window capture (pass 187): a named window, or the one the
/// user is in when no application is given, on Mac, Windows and Linux
/// (packages/screen). It returns the picture and, where the system shares
/// it, the window's text.
export interface WindowCaptureDependencies {
  list(signal: AbortSignal): Promise<ShotWindow[]>;
  capture(window: ShotWindow, signal: AbortSignal): Promise<Shot>;
}

export const nativeWindowCapture: WindowCaptureDependencies = {
  list: (signal) => listWindows({ signal }),
  capture: (window, signal) => captureWindow(window, { signal, text: true }),
};

/// A window capture's picture, which a model that sees always gets.
export const WINDOW_CAPTURE_FILE = "window-screenshot.png";
/// The model gets this much of a window's text; the picture carries the rest.
const MODEL_TEXT = 20_000;
const OWN = ["demesne", "electron"];
const describe = (windows: ShotWindow[]) => JSON.stringify(windows.slice(0, 40).map(({ id, app, title }) => ({ windowId: id, application: app, title })));

/// A window capture the chat already has (storage windowCaptures).
export interface EarlierCapture { turnId: string; app: string; title: string; picture: string; changedSince: boolean }
/// Steps that can change what a window shows, so a capture after one is new.
export const CHANGING_STEPS = ["edit_file", "write_file", "delete_path", "move_path", "run_command", "open", "ask_user", "foundry_save", "foundry_edit"] as const;
/// Your window is captured at most this often in one turn (Mike, 2026-11-20: once per screen, then reuse).
export const CAPTURES_PER_TURN = 2;

export function captureWindowTool(deps: WindowCaptureDependencies = nativeWindowCapture, earlier?: (sessionId: string) => EarlierCapture[]): AgentTool {
  async function execute(input: unknown, context: ToolContext): Promise<string | StructuredToolResult> {
    const id = isRecord(input) ? input.windowId : undefined;
    if (!isRecord(input) || Object.keys(input).some((key) => !["application", "title", "windowId"].includes(key))
      || (input.application !== undefined && (typeof input.application !== "string" || !input.application.trim() || input.application.length > 200))
      || (input.title !== undefined && (typeof input.title !== "string" || input.title.length > 500))
      || (id !== undefined && !(Number.isSafeInteger(id) && (id as number) > 0) && !(typeof id === "string" && /^[A-Za-z0-9]{1,40}$/.test(id)))) {
      throw new Error("capture_window takes an optional application name, exact title and windowId (a number or the id it listed)");
    }
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(90_000)]);
    const all = await deps.list(signal);
    signal.throwIfAborted();
    const application = typeof input.application === "string" ? input.application.trim().toLowerCase() : undefined;
    const title = typeof input.title === "string" ? input.title.toLowerCase() : undefined;
    let window: ShotWindow | undefined;
    if (application === undefined && id === undefined && title === undefined) {
      // The window the user is in, past Demesne's own.
      window = all.find((one) => one.id === "active" || !OWN.includes(one.app.toLowerCase()));
      if (!window) return `There's no window besides Demesne to capture. Visible windows: ${describe(all)}`;
    } else {
      const windows = application === undefined ? all : all.filter((one) => one.app.toLowerCase() === application);
      const matches = windows.filter((one) => (id === undefined || one.id === String(id)) && (title === undefined || one.title.toLowerCase() === title));
      if (matches.length !== 1) {
        return `No unique matching window was captured. ${matches.length ? "Specify a windowId to select the intended window." : "Open the requested application/window or correct the title filter."}\nVisible windows${input.application ? ` for ${input.application}` : ""}: ${describe(windows)}\nDo not substitute a browser or another application's window. For Demesne, ask the user to make its window visible if it is not identifiable.`;
      }
      window = matches[0]!;
    }
    // Once per screen, then reuse: the same window again in this turn, with
    // nothing done since that could change it, is the picture already here.
    const before = earlier && context.sessionId && context.turnId ? earlier(context.sessionId).filter((one) => one.turnId === context.turnId) : [];
    const same = before.findLast((one) => one.app === window.app && one.title === window.title && !one.changedSince);
    if (same) return `Not captured again: this turn already has ${window.app} — ${window.title} (image artifact ${same.picture}) and nothing that could change it ran since. Use that picture.`;
    if (before.length >= CAPTURES_PER_TURN) throw new Error(`[limit] Windows were captured ${CAPTURES_PER_TURN} times this turn (image artifacts ${before.map((one) => one.picture).join(", ")}). Hint: use those pictures and answer with what you found`);
    const shot = await deps.capture(window, signal);
    signal.throwIfAborted();
    const text = shot.text ? `\n\nText in the window${shot.text.length > MODEL_TEXT ? " (first part)" : ""}:\n${shot.text.slice(0, MODEL_TEXT)}` : shot.textNote ? `\n(${shot.textNote})` : "";
    // The window's size in points beside the picture's pixels (2 to 1 on a Retina
    // screen), so a Foundry review shows it at its own size (pass 240 A).
    const bounds = shot.bounds ?? window.bounds, pixels = pngSize(shot.png);
    const viewport = bounds && pixels && bounds.width > 0 && bounds.height > 0
      ? { width: Math.round(bounds.width), height: Math.round(bounds.height), deviceScaleFactor: Math.round(pixels.width / bounds.width * 100) / 100 } : undefined;
    return { text: `Captured window ${window.id}: ${window.app} — ${window.title}${text}`,
      images: [{ data: shot.png, mimeType: "image/png", filename: WINDOW_CAPTURE_FILE, ...(viewport && viewport.deviceScaleFactor > 0 && viewport.deviceScaleFactor <= 8 ? { viewport } : {}) }] };
  }
  return {
    definition: { name: "capture_window", description: "Capture a visible desktop window as a picture, with the window's text where the system shares it. A capture already in this chat is the screen: capture again only when the person asks, or after you changed what it shows (at most twice a turn). With no input it takes the window the user is in (besides Demesne): use it when the user says to look at their screen or window. Demesne is a native desktop app: to see Demesne itself use application Demesne; do not search web-server ports for it. If several windows match, returns window IDs to select explicitly; never captures the whole desktop.",
      inputSchema: { type: "object", properties: { application: { type: "string", description: "Application name, e.g. Safari. Omit for the window the user is in." }, title: { type: "string", description: "Exact window title, case-insensitive. Omit to list ambiguous windows." }, windowId: { type: ["integer", "string"], description: "A window id from an earlier listing." } }, additionalProperties: false } },
    permission: () => ({ kind: "execute", summary: "Capture a desktop window" }),
    execute: async () => { throw new Error("capture_window requires artifact-aware execution"); },
    executeWithArtifacts: execute,
  };
}

export const windowCaptureSupported = () => supported();

/// A PNG's width and height from its header, or null.
export function pngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.byteLength < 24 || data[0] !== 0x89 || data[1] !== 0x50 || data[12] !== 0x49 || data[13] !== 0x48) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
