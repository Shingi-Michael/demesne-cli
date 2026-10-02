// Chromium renders offscreen; only changed tiles cross the terminal bridge.
const { app, BrowserWindow, nativeImage, ipcMain } = require("electron");
const { createInterface } = require("node:readline");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
const { TileFrame } = require("./tiles.cjs");
const { InputQueue } = require("./input-queue.cjs");
app.disableHardwareAcceleration(); // Software output avoids GPU-to-CPU readback for this 2D UI.
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.setPath("userData", process.env.DEMESNE_PIXEL_CACHE);
app.whenReady().then(() => app.dock?.hide());
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const frame = new TileFrame(),
  queue = new InputQueue();
const metrics = {
  paintEvents: 0,
  captures: 0,
  encodedTiles: 0,
  encodedPixels: 0,
  encodeMs: 0,
  inputReceived: 0,
  inputProcessed: 0,
};
let uiReady,
  latestState,
  requestSerial = 0;
const pendingRequests = new Map();
let win,
  ready = false,
  width = 1200,
  height = 720,
  scale = 1,
  epoch = 0,
  config;
let serial = 0,
  inFlight = 0,
  scheduled = false,
  processing = false,
  diagnosticScheduled = false,
  resizePaint = null;
ipcMain.handle("demesne:request", (event, request) => {
  if (
    !config.live ||
    event.sender !== win?.webContents ||
    typeof request?.method !== "string" ||
    request.method.length > 80 ||
    JSON.stringify(request.args).length > 260000
  )
    throw new Error("Invalid UI request");
  const id = ++requestSerial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("The daemon did not respond in time."));
    }, 30000);
    pendingRequests.set(id, { resolve, reject, timer });
    send({ kind: "request", id, method: request.method, args: request.args });
  });
});
ipcMain.on("demesne:ready", (event) => {
  if (event.sender === win?.webContents) uiReady?.();
});
function appState(state) {
  latestState = state;
  if (win && !win.isDestroyed()) win.webContents.send("demesne:update", state);
}
function flush() {
  scheduled = false;
  if (!ready || inFlight || !frame.dirty?.size) return;
  const start = performance.now();
  const batch = frame.drain((data, width, height) =>
    nativeImage
      .createFromBitmap(data, { width, height })
      .toPNG()
      .toString("base64"),
  );
  if (!batch.tiles.length) return;
  metrics.encodeMs += performance.now() - start;
  metrics.encodedTiles += batch.tiles.length;
  metrics.encodedPixels += batch.tiles.reduce(
    (sum, tile) => sum + tile.width * tile.height,
    0,
  );
  inFlight = ++serial;
  // One batch is allowed in flight. Later paints merge into the retained bitmap
  // until stdout has drained; no dropped delta can leave a stale tile behind.
  send({
    kind: "tiles",
    serial,
    ...batch,
    ...(config.metrics
      ? {
          metrics: {
            ...metrics,
            coalescedInputs: queue.coalesced,
            maxPendingInputs: queue.maximum,
          },
        }
      : {}),
  });
}
function schedule() {
  if (!scheduled && !inFlight) {
    scheduled = true;
    setImmediate(flush);
  }
}
function paint(_event, dirty, image) {
  metrics.paintEvents++;
  const size = image.getSize();
  if (
    resizePaint &&
    size.width === width &&
    size.height === height &&
    dirty.x === 0 &&
    dirty.y === 0 &&
    dirty.width >= width &&
    dirty.height >= height
  ) {
    const resolve = resizePaint;
    resizePaint = null;
    seed(image);
    resolve();
    return;
  }
  if (!ready) return;
  if (frame.update(image.toBitmap(), size.width, size.height, dirty))
    schedule();
}
function seed(image) {
  const size = image.getSize();
  if (size.width !== width || size.height !== height) return false;
  frame.reset(
    width,
    height,
    config.cell.width * 32,
    config.cell.height * 4,
    image.toBitmap(),
    epoch,
  );
  ready = true;
  schedule();
  return true;
}
async function capture() {
  metrics.captures++;
  return await win.webContents.capturePage();
}
function diagnostic() {
  if (!config?.diagnostics || diagnosticScheduled) return;
  diagnosticScheduled = true;
  setImmediate(async () => {
    diagnosticScheduled = false;
    if (!win || win.isDestroyed()) return;
    const state = await win.webContents.executeJavaScript(
      '({scale:window.devicePixelRatio,live:window.demesneInspect?.(),value:document.querySelector("textarea")?.value??"",focus:document.activeElement.tagName,width:innerWidth,height:innerHeight,scroll:document.querySelector(".stage")?.scrollTop??0,operation:(()=>{const r=document.querySelector(".operation")?.getBoundingClientRect();if(!r)return null;return {x:r.x+r.width/2,y:r.y+r.height/2}})()})',
    );
    send({ kind: "state", state });
  });
}
async function start(options) {
  config = options;
  width = config.width;
  height = config.height;
  scale = config.scale || 1;
  epoch = config.epoch ?? 0;
  config.cell ??= { width: 8, height: 18 };
  await app.whenReady();
  app.dock?.hide();
  win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    useContentSize: true,
    backgroundColor: config.theme.ink,
    webPreferences: {
      preload: join(__dirname, "bridge.cjs"),
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
    callback({
      cancel:
        !details.url.startsWith("file:") &&
        !details.url.startsWith("data:image/"),
    }),
  );
  win.webContents.setFrameRate(60);
  win.webContents.on("paint", paint);
  win.webContents.debugger.attach("1.3");
  const appReady = new Promise((resolve) => {
    uiReady = resolve;
  });
  await win.loadFile(join(__dirname, config.live ? "live.html" : "index.html"));
  if (config.live) {
    let timer;
    try {
      await Promise.race([
        appReady,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("The interface failed to initialize")),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (latestState) appState(latestState);
  win.webContents.setZoomFactor(scale);
  await win.webContents.insertCSS(
    `:root{${Object.entries(config.theme)
      .map(([key, value]) => `--${key}:${value}`)
      .join(";")}}`,
  );
  await win.webContents.executeJavaScript(
    "document.fonts.ready.then(() => true)",
  );
  const initial = await capture();
  if (config.snapshot) {
    writeFileSync(config.snapshot, initial.toPNG());
    send({ kind: "snapshot", path: config.snapshot });
    app.quit();
    return;
  }
  if (!seed(initial))
    throw new Error("Initial render size does not match the terminal viewport");
  win.webContents.focus();
  const layout = config.layout
    ? await win.webContents.executeJavaScript(
        '(()=>{const r=document.querySelector("textarea").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()',
      )
    : undefined;
  send({ kind: "ready", layout });
  diagnostic();
}
async function resize(msg) {
  epoch = msg.epoch;
  width = msg.width;
  height = msg.height;
  config.cell = msg.cell;
  const nextScale = msg.scale ?? scale;
  const scaleChanged = nextScale !== scale;
  scale = config.scale = nextScale;
  if (
    !scaleChanged &&
    frame.bitmap &&
    frame.width === width &&
    frame.height === height
  ) {
    frame.reset(
      width,
      height,
      config.cell.width * 32,
      config.cell.height * 4,
      frame.bitmap,
      epoch,
    );
    schedule();
    return;
  }
  ready = false;
  // Resizing temporarily replaces Chromium's compositor surface. Wait for its
  // first complete paint instead of asking capturePage for an evicted surface.
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resizePaint = null;
      reject(new Error("Timed out waiting for the resized frame"));
    }, 3000);
    resizePaint = () => {
      clearTimeout(timeout);
      resolve();
    };
    if (scaleChanged) win.webContents.setZoomFactor(scale);
    win.setContentSize(width, height);
    win.webContents.invalidate();
  });
}
async function diagnosticCapture(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, (await capture()).toPNG());
      return;
    } catch (error) {
      if (attempt === 2) {
        send({ kind: "diagnostic-error", message: String(error) });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
}
// Chromium's regular sendInputEvent requires a focused OS window. The offscreen
// renderer has none, so its application input bridge uses Chromium's input API.
async function input(event) {
  const command = (name, params) =>
    win.webContents.debugger.sendCommand(name, params);
  if (event.type.startsWith("mouse")) {
    const type = {
      mouseDown: "mousePressed",
      mouseUp: "mouseReleased",
      mouseMove: "mouseMoved",
      mouseWheel: "mouseWheel",
    }[event.type];
    await command("Input.dispatchMouseEvent", {
      type,
      x: event.x,
      y: event.y,
      button: event.button || "none",
      buttons: event.modifiers?.some((m) => m.endsWith("ButtonDown")) ? 1 : 0,
      clickCount: event.clickCount || 0,
      ...(event.type === "mouseWheel"
        ? { deltaX: event.deltaX, deltaY: event.deltaY }
        : {}),
    });
  } else {
    const names = {
      Return: ["Enter", 13],
      Tab: ["Tab", 9],
      Backspace: ["Backspace", 8],
      Delete: ["Delete", 46],
      Escape: ["Escape", 27],
      Left: ["ArrowLeft", 37],
      Up: ["ArrowUp", 38],
      Right: ["ArrowRight", 39],
      Down: ["ArrowDown", 40],
      Home: ["Home", 36],
      End: ["End", 35],
      PageUp: ["PageUp", 33],
      PageDown: ["PageDown", 34],
    };
    const [key, vk] = names[event.keyCode] || [
      event.keyCode,
      event.keyCode.charCodeAt(0),
    ];
    const modifiers = (event.modifiers || []).reduce(
      (n, m) => n | ({ alt: 1, control: 2, meta: 4, shift: 8 }[m] || 0),
      0,
    );
    await command("Input.dispatchKeyEvent", {
      type: event.type === "keyUp" ? "keyUp" : "rawKeyDown",
      key,
      windowsVirtualKeyCode: vk,
      modifiers,
    });
    if (event.type === "keyDown" && key === "Enter" && modifiers === 8)
      await command("Input.insertText", { text: "\n" });
  }
}
async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    for (let msg; (msg = queue.shift()); ) {
      metrics.inputProcessed++;
      if (msg.kind === "init") await start(msg);
      else if (msg.kind === "quit") app.quit();
      else if (msg.kind === "inspect" && config.diagnostics) {
        diagnostic();
        if (msg.path && ready) await diagnosticCapture(msg.path);
      } else if (win && msg.kind === "resize") await resize(msg);
      else if (ready && msg.kind === "key-text") {
        for (const key of msg.text) {
          await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            text: key,
          });
          await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
          });
        }
      } else if (ready && msg.kind === "text")
        await win.webContents.debugger.sendCommand("Input.insertText", {
          text: msg.text,
        });
      else if (ready && msg.kind === "input") await input(msg.event);
      else if (ready && msg.kind === "copy") win.webContents.copy();
      diagnostic();
    }
  } catch (error) {
    send({ kind: "error", message: String(error) });
  } finally {
    processing = false;
  }
}
createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.kind === "response") {
      const request = pendingRequests.get(msg.id);
      if (request) {
        clearTimeout(request.timer);
        pendingRequests.delete(msg.id);
        msg.ok
          ? request.resolve(msg.value)
          : request.reject(new Error(msg.error));
      }
      return;
    }
    if (msg.kind === "ui-command") {
      win?.webContents.send("demesne:command", msg.command);
      return;
    }
    if (msg.kind === "app-state") {
      appState(msg.state);
      return;
    }
    if (msg.kind === "ack") {
      if (msg.serial === inFlight) {
        inFlight = 0;
        schedule();
      }
      return;
    }
    metrics.inputReceived++;
    queue.push(msg);
    setImmediate(processQueue);
  } catch (error) {
    send({ kind: "error", message: String(error) });
  }
});
process.stdin.on("end", () => app.quit());
process.on("SIGTERM", () => app.quit());
app.on("window-all-closed", () => app.quit());
