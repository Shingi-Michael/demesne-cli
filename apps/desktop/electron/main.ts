import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, Notification, powerSaveBlocker, protocol, shell } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Backend } from "./backend.ts";
import { POINT_CANCEL, POINT_SCRIPT } from "./point.ts";
import { APP_URL, allowAppReload, assetPath, desktopBlurs, FOUNDRY_CSP, macVibrancy, type FoundryAssembly, foundryDocument, foundryURL, localAppURL, nextZoom, openTarget, previewURL, validateRequest, ZOOM_LEVELS, ZOOM_VERSION } from "./policy.ts";

protocol.registerSchemesAsPrivileged([{ scheme: "demesne", privileges: { standard: true, secure: true, supportFetchAPI: true } }, { scheme: "foundry", privileges: { standard: true, secure: true } }]);
app.setName("Demesne");
// Match the installed Windows shortcut identity so native toasts can appear.
if (process.platform === "win32") app.setAppUserModelId("com.demesne.desktop");
const userData = app.commandLine.getSwitchValue("user-data-dir");
if (userData && isAbsolute(userData)) app.setPath("userData", userData);
let window: BrowserWindow | undefined, backend: Backend | undefined, quitting = false, exited = false;
/// The power-save blocker held while something runs, or null.
let awakeBlocker: number | null = null;
// Keep native notifications alive until the OS closes them or they are clicked.
const notifications = new Set<Notification>();
const args = process.argv.slice(1).filter(arg => /^--(workspace|server|session|model|prompt)=/.test(arg) || arg === "--setup");
function log(message: string) {
  try { const dir = app.getPath("logs"); mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, "desktop.log"), `${new Date().toISOString()} ${message}\n`); } catch {}
}
function emit(channel: string, value: unknown) { if (window && !window.isDestroyed()) window.webContents.send(channel, value); }
async function quit() {
  if (quitting) return;
  quitting = true;
  log("exit requested");
  try { unlinkSync(join(homedir(), ".demesne", "desktop.pid")); } catch {}
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
    executable: join(runtime, `demesne-host${suffix}`), args,
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
  /// Persisted marker used to detect that the installed app was replaced by a
  /// newer version, so the running renderer reloads to load it instead of
  /// serving stale code.
  const versionMarker = join(app.getPath("userData"), "version.json");
  function persistedVersion(): string | null {
    try { const value = JSON.parse(readFileSync(versionMarker, "utf8")); return typeof value.version === "string" ? value.version : null; } catch { return null; }
  }
  function persistVersion(version: string): void {
    try { writeFileSync(versionMarker, JSON.stringify({ version }) + "\n", { encoding: "utf8" }); } catch { /* best effort */ }
  }
  const currentVersion = app.getVersion();
  const previousVersion = persistedVersion();
  let updatePending = previousVersion !== null && previousVersion !== currentVersion;
  persistVersion(currentVersion);
  const desktopPidFile = join(homedir(), ".demesne", "desktop.pid");
  try {
    mkdirSync(dirname(desktopPidFile), { recursive: true });
    writeFileSync(desktopPidFile, `${process.pid}\n`, "utf8");
  } catch {}
  function reloadRenderer(reason: string) {
    if (!window || window.isDestroyed()) return;
    log(`hot reloading renderer (${reason})`);
    window.webContents.reload();
  }
  const reloadMarker = join(homedir(), ".demesne", "desktop.reload");
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  try {
    if (!existsSync(reloadMarker)) {
      mkdirSync(dirname(reloadMarker), { recursive: true });
      writeFileSync(reloadMarker, "", "utf8");
    }
    const reloadWatcher = watch(reloadMarker, () => {
      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(() => reloadRenderer("desktop.reload file modified"), 300);
      reloadDebounce.unref?.();
    });
    app.on("before-quit", () => reloadWatcher.close());
  } catch {}
  if (process.platform !== "win32") {
    process.on("SIGUSR1", () => reloadRenderer("SIGUSR1 signal"));
  }
  const glass = desktopBlurs(process.platform, process.env);
  window = new BrowserWindow({
    width: 1180, height: 820, minWidth: 900, minHeight: 620, show: false, title: "Demesne", backgroundColor: "#161617",
    // The Mac: no title bar, the traffic lights on the sidebar's glass, and
    // the window translucent under the shell (the page paints the tint).
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 17 },
      vibrancy: macVibrancy(process.env), visualEffectState: "active" as const, backgroundColor: "#00000000",
      // Full screen stays on the desktop's Space: a full-screen Space has no
      // wallpaper behind the window, so the glass would go flat there.
      simpleFullscreen: true,
    } : {}),
    // Linux, where the desktop blurs behind clear pixels (Hyprland): the
    // window is see-through and the compositor makes it glass.
    ...(process.platform === "linux" && glass ? { transparent: true, backgroundColor: "#00000000" } : {}),
    webPreferences: { additionalArguments: glass ? ["--demesne-glass"] : [], preload: join(base, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, webSecurity: true, backgroundThrottling: false },
  });
  const contents = window.webContents, session = contents.session;
  nativeTheme.on("updated", () => {
    if(nativeTheme.themeSource==="system")emit("demesne:desktop-action",{action:"appearance",dark:nativeTheme.shouldUseDarkColors});
  });
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on("will-download", event => event.preventDefault());
  await session.protocol.handle("demesne", request => {
    try { return net.fetch(pathToFileURL(assetPath(join(base, "ui"), request.url)).href); }
    catch { return new Response("Not found", { status: 404 }); }
  });
  // Foundry: an artifact renders in its own frame, served here with a policy
  // that allows only pinned libraries and fonts from a short list of hosts;
  // the frame is sandboxed without the app's origin.
  // The first show of a version carries ?assemble=1: the page is served with
  // anime.js (bundled with the app, never fetched) and the assembly script,
  // and a revision gets the version before it to find what changed.
  let assembleLibrary: string | undefined;
  await session.protocol.handle("foundry", async request => {
    if (!foundryURL(request.url)) return new Response("Not found", { status: 404 });
    try {
      const url = new URL(request.url), version = Number(url.searchParams.get("v")), id = decodeURIComponent(url.pathname.slice(1));
      const at = Number.isSafeInteger(version) && version > 0 ? version : undefined;
      const found = await backend!.request("foundry-get", { id, ...(at ? { version: at } : {}) }) as { kind: string; source: string; title: string; version: number };
      let assembly: FoundryAssembly | undefined;
      if (url.searchParams.get("assemble") === "1") {
        assembleLibrary ??= readFileSync(join(base, "ui", "vendor", "anime.umd.min.js"), "utf8");
        let previous: string | null = null;
        if (found.kind === "html" && found.version > 1) {
          try { const before = await backend!.request("foundry-get", { id, version: found.version - 1 }) as { kind: string; source: string }; if (before.kind === "html") previous = before.source; } catch {}
        }
        assembly = { library: assembleLibrary, previous };
      }
      return new Response(foundryDocument(found.kind, found.source, found.title, assembly), { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": FOUNDRY_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
    } catch (error) { return new Response(`Unavailable: ${String(error)}`, { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }); }
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", event => { if (!allowAppReload(event.url, true)) event.preventDefault(); });
  contents.on("will-frame-navigate", event => { if (!allowAppReload(event.url, event.isMainFrame) && (event.isMainFrame || !(previewURL(event.url) || foundryURL(event.url)))) event.preventDefault(); });
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
    // Hot reload the renderer when the installed app has been updated, so the
    // running window loads the new UI without the user relaunching. The host
    // process (and its daemon-owned turns) survives the renderer reload.
    if (method === "desktop-reload") { reloadRenderer("desktop-reload request"); return null; }
    // The Dock icon counts the chats that need you (macOS and Linux docks).
    if (method === "desktop-badge") {
      const count = Number((args as Record<string, unknown>).count);
      app.setBadgeCount(Number.isInteger(count) && count > 0 && count < 1000 ? count : 0);
      return null;
    }
    // Native notifications on Linux, macOS and Windows; clicking opens the chat.
    if (method === "desktop-notify") {
      const { title, body, sessionId, path } = args as Record<string, unknown>;
      if (typeof title !== "string" || typeof body !== "string") return null;
      if (!Notification.isSupported()) { log("Native notifications are unavailable on this desktop"); return null; }
      const banner = new Notification({ title: title.slice(0, 120), body: body.slice(0, 240) });
      notifications.add(banner);
      banner.once("close", () => notifications.delete(banner));
      banner.once("failed", (_event, error) => { notifications.delete(banner); log(`Notification failed: ${error}`); });
      banner.on("click", () => {
        notifications.delete(banner);
        if (window?.isMinimized()) window.restore();
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
    // Native chrome follows explicit palettes; System resolves the OS only
    // after removing any previous app override.
    if (method === "desktop-theme") {
      nativeTheme.themeSource = (args as Record<string, unknown>).system === true ? "system" : (args as Record<string, unknown>).dark === false ? "light" : "dark";
      return {dark:nativeTheme.shouldUseDarkColors};
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
    // Foundry › Export: the artifact's source, saved where you choose.
    if (method === "desktop-foundry-export") {
      const { id, version } = args as Record<string, unknown>;
      const found = await backend!.request("foundry-get", { id, ...(typeof version === "number" ? { version } : {}) }) as { kind: string; source: string; title: string };
      const extension = ({ html: "html", svg: "svg", markdown: "md" } as Record<string, string>)[found.kind] ?? "txt";
      const name = `${found.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 80) || "artifact"}.${extension}`;
      const selected = await dialog.showSaveDialog(window!, { title: "Export from Foundry", defaultPath: join(app.getPath("downloads"), name) });
      if (selected.canceled || !selected.filePath) return null;
      await writeFile(selected.filePath, found.source, "utf8");
      return { path: selected.filePath };
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
  // An update replaced the installed app: reload the renderer once so it loads
  // the new UI. The host process survives the renderer reload.
  if (updatePending) window.webContents.reload();
  // Also show initialization errors if the host cannot bootstrap.
  window.show();
}).catch(error => { log(String(error)); dialog.showErrorBox("Demesne could not start", String(error)); void quit(); });
