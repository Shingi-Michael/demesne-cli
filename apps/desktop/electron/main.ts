import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, Notification, powerSaveBlocker, protocol, shell } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Backend } from "./backend.ts";
import { POINT_CANCEL, POINT_SCRIPT } from "./point.ts";
import { APP_URL, allowAppReload, assetPath, desktopBlurs, localAppURL, nextZoom, openTarget, previewURL, validateRequest, ZOOM_LEVELS, ZOOM_VERSION } from "./policy.ts";

protocol.registerSchemesAsPrivileged([{ scheme: "demesne", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName("Demesne");
const userData = app.commandLine.getSwitchValue("user-data-dir");
if (userData && isAbsolute(userData)) app.setPath("userData", userData);
let window: BrowserWindow | undefined, backend: Backend | undefined, quitting = false, exited = false;
/// The power-save blocker held while something runs, or null.
let awakeBlocker: number | null = null;
const args = process.argv.slice(1).filter(arg => /^--(workspace|server|session|model|prompt)=/.test(arg) || arg === "--setup");
function log(message: string) {
  try { const dir = app.getPath("logs"); mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, "desktop.log"), `${new Date().toISOString()} ${message}\n`); } catch {}
}
function emit(channel: string, value: unknown) { if (window && !window.isDestroyed()) window.webContents.send(channel, value); }
async function quit() {
  if (quitting) return;
  quitting = true;
  log("exit requested");
  await backend?.close();
  exited = true;
  app.quit();
}
app.on("before-quit", event => { if (!exited) { event.preventDefault(); void quit(); } });
app.on("activate", () => { window?.show(); window?.focus(); });

void app.whenReady().then(async () => {
  const base = app.getAppPath();
  const resources = app.isPackaged ? process.resourcesPath : join(base, "..");
  const runtime = join(resources, "backend");
  const suffix = process.platform === "win32" ? ".exe" : "";
  backend = new Backend({
    executable: join(runtime, `demesne-desktop-host${suffix}`), args,
    env: { ...process.env, DEMESNE_DAEMON_BIN: join(runtime, `demesned${suffix}`), DEMESNE_NATIVE_RUNTIME_DIR: runtime },
    emit, log,
    async native(method, args) {
      if (method === "copy") {
        if (typeof args.text !== "string" || Buffer.byteLength(args.text) > 1_100_000) throw new Error("Invalid clipboard text");
        clipboard.writeText(args.text);
      } else if (method === "open") {
        const kind = openTarget(args.path), value = args.path as string;
        if (kind === "url") await shell.openExternal(value);
        else { if (!existsSync(value)) throw new Error("The item to open is unavailable"); const error = await shell.openPath(value); if (error) throw new Error(error); }
      } else throw new Error("Unsupported native action");
    },
  });
  const zoomPath = join(app.getPath("userData"), "zoom.json");
  let zoom = 1;
  // Only a zoom chosen in this app counts: the redesign is drawn at its own
  // size, so a level inherited from the previous shell is dropped once.
  try { const saved = JSON.parse(readFileSync(zoomPath, "utf8")); if (saved.version === ZOOM_VERSION && ZOOM_LEVELS.includes(saved.zoom)) zoom = saved.zoom; } catch {}
  const glass = desktopBlurs(process.platform, process.env);
  window = new BrowserWindow({
    width: 1180, height: 820, minWidth: 900, minHeight: 620, show: false, title: "Demesne", backgroundColor: "#161617",
    // The Mac: no title bar, the traffic lights on the sidebar's glass, and
    // the window translucent under the shell (the page paints the tint).
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 17 },
      vibrancy: "fullscreen-ui" as const, visualEffectState: "active" as const, backgroundColor: "#00000000",
      // Full screen stays on the desktop's Space: a full-screen Space has no
      // wallpaper behind the window, so the glass would go flat there.
      simpleFullscreen: true,
    } : {}),
    // Linux, where the desktop blurs behind clear pixels (Hyprland): the
    // window is see-through and the compositor makes it glass.
    ...(process.platform === "linux" && glass ? { transparent: true, backgroundColor: "#00000000" } : {}),
    webPreferences: { additionalArguments: glass ? ["--demesne-glass"] : [], preload: join(base, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, webSecurity: true },
  });
  const contents = window.webContents, session = contents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on("will-download", event => event.preventDefault());
  await session.protocol.handle("demesne", request => {
    try { return net.fetch(pathToFileURL(assetPath(join(base, "ui"), request.url)).href); }
    catch { return new Response("Not found", { status: 404 }); }
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", event => { if (!allowAppReload(event.url, true)) event.preventDefault(); });
  contents.on("will-frame-navigate", event => { if (!allowAppReload(event.url, event.isMainFrame) && (event.isMainFrame || !previewURL(event.url))) event.preventDefault(); });
  contents.on("will-attach-webview", event => event.preventDefault());
  // Simple full screen sends no full-screen events, so the page hears of it
  // through the resize that comes with it.
  let fullscreen = false;
  const fullscreenChanged = () => {
    const on = Boolean(window?.isFullScreen() || window?.isSimpleFullScreen());
    if (on !== fullscreen) { fullscreen = on; emit("demesne:desktop-action", { action: "fullscreen", on }); }
  };
  window.on("enter-full-screen", fullscreenChanged).on("leave-full-screen", fullscreenChanged).on("resize", fullscreenChanged);
  contents.on("render-process-gone", (_event, details) => { log(`renderer exited: ${details.reason}`); window?.show(); });
  ipcMain.handle("demesne:request", async (event, method: unknown, args: unknown) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || !localAppURL(event.senderFrame.url)) throw new Error("Desktop actions are restricted to the main application window");
    validateRequest(method, args);
    if (quitting) throw new Error("The desktop app is closing");
    if (method === "desktop-ready") { window?.show(); window?.focus(); return null; }
    if (method === "quit" || method === "desktop-quit") { void quit(); return null; }
    // The Dock icon counts the chats that need you (macOS and Linux docks).
    if (method === "desktop-badge") {
      const count = Number((args as Record<string, unknown>).count);
      app.setBadgeCount(Number.isInteger(count) && count > 0 && count < 1000 ? count : 0);
      return null;
    }
    // A Mac banner for a chat that needs you; clicking it opens that chat.
    if (method === "desktop-notify") {
      const { title, body, sessionId, path } = args as Record<string, unknown>;
      if (!Notification.isSupported() || typeof title !== "string" || typeof body !== "string") return null;
      const banner = new Notification({ title: title.slice(0, 120), body: body.slice(0, 240) });
      banner.on("click", () => {
        window?.show();
        window?.focus();
        emit("demesne:desktop-action", { action: "open-chat", sessionId: typeof sessionId === "string" ? sessionId : undefined, path: typeof path === "string" ? path : undefined });
      });
      banner.show();
      return null;
    }
    // Point at it: the picker runs in the named live preview frame and
    // answers with the element clicked there, or null on Esc.
    if (method === "desktop-point") {
      const { frame: name, cancel } = args as Record<string, unknown>;
      const frames = contents.mainFrame.framesInSubtree.filter(frame => frame !== contents.mainFrame && previewURL(frame.url) && (cancel || frame.name === name));
      if (cancel) { await Promise.all(frames.map(frame => frame.executeJavaScript(POINT_CANCEL).catch(() => null))); return null; }
      if (typeof name !== "string" || !frames[0]) throw new Error("The preview is not showing");
      return frames[0].executeJavaScript(POINT_SCRIPT, true);
    }
    // Settings › General: keeps the Mac from sleeping while a chat or Drive
    // works. The display may still sleep.
    if (method === "desktop-awake") {
      const on = (args as Record<string, unknown>).on === true;
      if (on && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start("prevent-app-suspension");
      if (!on && awakeBlocker !== null) { powerSaveBlocker.stop(awakeBlocker); awakeBlocker = null; }
      return { on: awakeBlocker !== null };
    }
    // The glass follows the app's theme, not the system's.
    if (method === "desktop-theme") {
      nativeTheme.themeSource = (args as Record<string, unknown>).dark === false ? "light" : "dark";
      return null;
    }
    // Settings' text size: an exact level, or none to read the current one.
    if (method === "desktop-zoom") {
      const level = Number((args as Record<string, unknown>).zoom);
      if (ZOOM_LEVELS.includes(level)) setZoom(level);
      return { zoom };
    }
    if (method === "desktop-select-project") {
      const selected = await dialog.showOpenDialog(window!, { title: "Open a Demesne project", properties: ["openDirectory"] });
      return selected.canceled ? backend!.request("desktop-bootstrap") : backend!.request("desktop-open-project", { ...args as Record<string, unknown>, path: selected.filePaths[0] });
    }
    // A folder for a chat to move into: the path, or null when cancelled.
    if (method === "desktop-pick-folder") {
      const selected = await dialog.showOpenDialog(window!, { title: "Move this chat to a project", properties: ["openDirectory"] });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    }
    return backend!.request(method, args as Record<string, unknown>);
  });
  const applyZoom = (step: number) => setZoom(nextZoom(zoom, step));
  function setZoom(level: number) { zoom = level; contents.setZoomFactor(zoom); try { mkdirSync(app.getPath("userData"), { recursive: true }); writeFileSync(zoomPath, JSON.stringify({ zoom, version: ZOOM_VERSION })); } catch (error) { log(String(error)); } };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { label: "File", submenu: [{ label: "Open project…", accelerator: "CmdOrCtrl+O", click: () => emit("demesne:desktop-action", { action: "open-project" }) }, { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => emit("demesne:desktop-action", { action: "settings" }) }, { type: "separator" }, { role: process.platform === "darwin" ? "close" : "quit" }] },
    { role: "editMenu" },
    { label: "View", submenu: [{ label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => applyZoom(1) }, { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => applyZoom(-1) }, { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => applyZoom(0) }, { label: "Toggle Full Screen", accelerator: process.platform === "darwin" ? "Ctrl+Cmd+F" : "F11", click: () => {
      if (!window) return;
      if (process.platform === "darwin") window.setSimpleFullScreen(!window.isSimpleFullScreen());
      else window.setFullScreen(!window.isFullScreen());
      fullscreenChanged();
    } }] },
    { role: "windowMenu" },
  ]));
  // Remove the Linux window menu entirely: Alt must not bring it back.
  // Handle its useful accelerators directly without a native menu attached.
  if (process.platform === "linux") {
    window.removeMenu();
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.alt || input.meta) return;
      const key = input.key.toLowerCase();
      if (input.control && ["o", ",", "q", "=", "+", "-", "0"].includes(key)) {
        event.preventDefault();
        if (key === "o") emit("demesne:desktop-action", { action: "open-project" });
        else if (key === ",") emit("demesne:desktop-action", { action: "settings" });
        else if (key === "q") void quit();
        else applyZoom(key === "0" ? 0 : key === "-" ? -1 : 1);
      } else if (!input.control && !input.shift && key === "f11") {
        event.preventDefault();
        window?.setFullScreen(!window.isFullScreen());
      }
    });
  }
  window.on("close", event => {
    if (quitting) return;
    event.preventDefault();
    if (process.platform === "darwin") window?.hide(); else void quit();
  });
  await window.loadURL(APP_URL);
  contents.setZoomFactor(zoom);
  // Also show initialization errors if the host cannot bootstrap.
  window.show();
}).catch(error => { log(String(error)); dialog.showErrorBox("Demesne could not start", String(error)); void quit(); });
