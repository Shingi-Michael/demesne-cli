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

export function captureWindowTool(deps: WindowCaptureDependencies = nativeWindowCapture): AgentTool {
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
    const shot = await deps.capture(window, signal);
    signal.throwIfAborted();
    const text = shot.text ? `\n\nText in the window${shot.text.length > MODEL_TEXT ? " (first part)" : ""}:\n${shot.text.slice(0, MODEL_TEXT)}` : shot.textNote ? `\n(${shot.textNote})` : "";
    return { text: `Captured window ${window.id}: ${window.app} — ${window.title}${text}`,
      images: [{ data: shot.png, mimeType: "image/png", filename: WINDOW_CAPTURE_FILE }] };
  }
  return {
    definition: { name: "capture_window", description: "Capture a visible desktop window as a picture, with the window's text where the system shares it. With no input it takes the window the user is in (besides Demesne): use it when the user says to look at their screen or window. Demesne is a native desktop app: to see Demesne itself use application Demesne; do not search web-server ports for it. If several windows match, returns window IDs to select explicitly; never captures the whole desktop.",
      inputSchema: { type: "object", properties: { application: { type: "string", description: "Application name, e.g. Safari. Omit for the window the user is in." }, title: { type: "string", description: "Exact window title, case-insensitive. Omit to list ambiguous windows." }, windowId: { type: ["integer", "string"], description: "A window id from an earlier listing." } }, additionalProperties: false } },
    permission: () => ({ kind: "execute", summary: "Capture a desktop window" }),
    execute: async () => { throw new Error("capture_window requires artifact-aware execution"); },
    executeWithArtifacts: execute,
  };
}

export const windowCaptureSupported = () => supported();
