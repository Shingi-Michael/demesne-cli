// No daemon, credentials or workspace access. Verify an actual sandboxed renderer.
const { app, BrowserWindow, ipcMain } = require("electron");
const { join } = require("node:path");
app.setPath("userData", process.env.DEMESNE_PIXEL_CACHE);
if (process.env.DEMESNE_GRAPHICS_GPU === "0") app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
const timer = setTimeout(() => { console.error("Graphics startup probe timed out"); app.exit(1); }, 15000);
app.whenReady().then(async () => {
  app.dock?.hide();
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: {
    offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: join(__dirname, "runtime-probe-preload.cjs"),
  } });
  // On Linux, capturePage can reject with UnknownVizError before the offscreen
  // compositor has presented a surface; the first full paint is then the frame.
  const firstPaint = new Promise(resolve => win.webContents.on("paint", (_event, _dirty, image) => {
    const size = image.getSize();
    if (size.width === 64 && size.height === 64) resolve(image);
  }));
  const sandboxed = new Promise(resolve => ipcMain.once("demesne-runtime-probe", (event, value) => {
    resolve(event.sender === win.webContents && value?.sandboxed === true);
  }));
  await win.loadURL('data:text/html,<html><body style="background:rgb(90,169,230)">ready</body></html>');
  if (!await sandboxed || app.commandLine.hasSwitch("no-sandbox") ||
      await win.webContents.executeJavaScript('typeof process !== "undefined" || typeof require !== "undefined"')) {
    throw new Error("Renderer sandbox verification failed");
  }
  const frame = await win.webContents.capturePage().catch(() => firstPaint);
  if (frame.isEmpty()) throw new Error("Renderer produced no pixels");
  clearTimeout(timer);
  process.stdout.write('DEMESNE_GRAPHICS_READY\n', () => app.exit(0));
}).catch(error => { console.error(error.message); app.exit(1); });
