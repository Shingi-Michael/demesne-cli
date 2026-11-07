/// The capture keys (pass 187 A): both Command keys on a Mac (or ⌘⇧2),
/// Ctrl+Alt+Space on Windows and Linux. The window you're in is taken as a
/// picture plus its text, and handed to the page, which lands it as a card
/// beside the chat. Nothing is drawn over the window you're looking at.
import { globalShortcut, screen, type BrowserWindow } from "electron";
import { onPage } from "./capture-keys-math.ts";
import { captureWindow, frontWindow, supported, watchBothCommands, type ShotBounds } from "../../../packages/screen/src/index.ts";

export const CAPTURE_KEYS = process.platform === "darwin" ? ["Command+Shift+2"] : ["Control+Alt+Space"];

export interface WindowShotEvent {
  action: "window-shot";
  app?: string; title?: string;
  /// The picture, PNG in base64.
  data?: string;
  text?: string; textNote?: string;
  /// Where the window was, in the page's own CSS pixels (it may lie outside the page).
  from?: ShotBounds;
  error?: string;
}


export function startCaptureKeys(options: { window: () => BrowserWindow | undefined; emit: (value: WindowShotEvent) => void; log: (line: string) => void; cacheDir: string }): () => void {
  if (!supported()) return () => {};
  let busy = false, asked = false;
  async function take(how: string) {
    if (busy) return;
    busy = true;
    const started = Date.now();
    try {
      const window = await frontWindow({ cacheDir: options.cacheDir, exclude: { pid: process.pid } });
      // The first capture on a Mac may ask once for Accessibility, which reads the window's text.
      const shot = await captureWindow(window, { cacheDir: options.cacheDir, text: true, askForText: !asked });
      asked = true;
      const own = options.window();
      let from: ShotBounds | undefined;
      if (shot.bounds && own && !own.isDestroyed()) {
        // Windows reports real pixels; the page works in Electron's.
        const bounds = process.platform === "win32" ? screen.screenToDipRect(null, shot.bounds) : shot.bounds;
        from = onPage(bounds, own.getContentBounds(), own.webContents.getZoomFactor());
      }
      options.emit({ action: "window-shot", app: shot.app, title: shot.title, data: Buffer.from(shot.png).toString("base64"), text: shot.text, textNote: shot.textNote, from });
      options.log(`window shot (${how}): ${shot.app} · ${shot.png.length} bytes · ${shot.text.length} chars · ${Date.now() - started}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log(`window shot failed (${how}): ${message}`);
      options.emit({ action: "window-shot", error: message });
    } finally { busy = false; }
  }
  const registered = CAPTURE_KEYS.filter((keys) => {
    try { return globalShortcut.register(keys, () => void take(keys)); } catch { return false; }
  });
  options.log(`capture keys: ${registered.length ? registered.join(", ") : "none could be registered"}`);
  const both = process.platform === "darwin" ? watchBothCommands(() => void take("both Command keys"), { cacheDir: options.cacheDir, log: options.log }) : null;
  return () => { for (const keys of registered) globalShortcut.unregister(keys); both?.stop(); };
}
