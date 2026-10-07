import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@demesne/protocol";
import type { AgentTool, ToolContext } from "./tools.ts";
import type { StructuredToolResult } from "./artifacts.ts";

export interface NativeWindow { id: number; application: string; title: string }
interface WindowCaptureDependencies {
  list(signal: AbortSignal): Promise<NativeWindow[]>;
  capture(id: number, signal: AbortSignal): Promise<Uint8Array>;
}

// CGWindow IDs are native window IDs, not browser tab IDs or AppleScript window indices.
const listScript = `import CoreGraphics
import Foundation
guard CGPreflightScreenCaptureAccess() else {
  print("SCREEN_RECORDING_REQUIRED")
  exit(2)
}
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let visible = windows.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }.compactMap { w -> [String: Any]? in
  guard let id = w[kCGWindowNumber as String] as? Int, let owner = w[kCGWindowOwnerName as String] as? String else { return nil }
  return ["id": id, "application": owner, "title": w[kCGWindowName as String] as? String ?? ""]
}
let data = try JSONSerialization.data(withJSONObject: visible)
print(String(data: data, encoding: .utf8)!)`;

async function run(command: string[], signal: AbortSignal): Promise<{ code: number; output: string }> {
  signal.throwIfAborted();
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  try {
    // Swift emits only window metadata; cap it rather than accepting unbounded process output.
    let output = "";
    for await (const chunk of child.stdout) {
      output += Buffer.from(chunk).toString("utf8");
      if (output.length > 1024 * 1024) { child.kill(); throw new Error("Native window listing exceeded its limit"); }
    }
    const code = await child.exited;
    signal.throwIfAborted();
    return { code, output };
  } finally { signal.removeEventListener("abort", abort); }
}

export const nativeWindowCapture: WindowCaptureDependencies = {
  async list(signal) {
    const result = await run(["/usr/bin/swift", "-e", listScript], signal);
    if (result.output.includes("SCREEN_RECORDING_REQUIRED")) throw new Error("macOS Screen Recording access is required. Enable it for the app hosting Demesne in System Settings > Privacy & Security > Screen & System Audio Recording, then restart that app.");
    if (result.code !== 0) throw new Error("Could not enumerate macOS windows. Native capture requires the Swift command-line tools and Screen Recording access.");
    return JSON.parse(result.output) as NativeWindow[];
  },
  async capture(id, signal) {
    const root = await mkdtemp(join(tmpdir(), "demesne-window-"));
    try {
      const file = join(root, "window.png");
      const result = await run(["/usr/sbin/screencapture", "-x", "-o", "-l", String(id), "-t", "png", file], signal);
      if (result.code !== 0) throw new Error("Window capture failed. Ensure the window is visible and macOS Screen Recording access is enabled; list windows again if it was closed.");
      if ((await stat(file)).size > 20 * 1024 * 1024) throw new Error("Window screenshot exceeds 20 MiB");
      return await readFile(file);
    } finally { await rm(root, { recursive: true, force: true }); }
  },
};

export function captureWindowTool(deps: WindowCaptureDependencies = nativeWindowCapture): AgentTool {
  async function execute(input: unknown, context: ToolContext): Promise<string | StructuredToolResult> {
    if (!isRecord(input) || Object.keys(input).some((key) => !["application", "title", "windowId"].includes(key))
      || typeof input.application !== "string" || !input.application.trim() || input.application.length > 200
      || (input.title !== undefined && (typeof input.title !== "string" || input.title.length > 500))
      || (input.windowId !== undefined && (!Number.isSafeInteger(input.windowId) || (input.windowId as number) <= 0))) {
      throw new Error("capture_window requires an application name and optional exact title or positive windowId");
    }
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(60_000)]);
    const application = input.application.trim().toLowerCase();
    const title = typeof input.title === "string" ? input.title.toLowerCase() : undefined;
    const windows = (await deps.list(signal)).filter((window) => window.application.toLowerCase() === application);
    const matches = windows.filter((window) => (input.windowId === undefined || window.id === input.windowId)
      && (title === undefined || window.title.toLowerCase() === title));
    signal.throwIfAborted();
    if (matches.length !== 1) {
      return `No unique matching window was captured. ${matches.length ? "Specify a windowId to select the intended window." : "Open the requested application/window or correct the title filter."}\nVisible windows for ${input.application}: ${JSON.stringify(windows)}\nDo not substitute a browser or another application's window. For Demesne, ask the user to make its terminal window visible if it is not identifiable.`;
    }
    const window = matches[0]!;
    const data = await deps.capture(window.id, signal);
    signal.throwIfAborted();
    return { text: `Captured native window ${window.id}: ${window.application} — ${window.title}`,
      images: [{ data, mimeType: "image/png", filename: "window-screenshot.png" }] };
  }
  return {
    definition: { name: "capture_window", description: "Capture a visible native macOS application window into Preview for visual inspection. Demesne is a native desktop app: use application Demesne. Do not search web-server ports for Demesne. If several windows match, returns window IDs to select explicitly; never captures the whole desktop.",
      inputSchema: { type: "object", properties: { application: { type: "string" }, title: { type: "string", description: "Exact window title, case-insensitive. Omit to list ambiguous windows." }, windowId: { type: "integer", minimum: 1 } }, required: ["application"], additionalProperties: false } },
    permission: () => ({ kind: "execute", summary: "Capture a native application window" }),
    execute: async () => { throw new Error("capture_window requires artifact-aware execution"); },
    executeWithArtifacts: execute,
  };
}
