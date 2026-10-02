// Chromium renders offscreen; only changed tiles cross the terminal bridge.
const { app, BrowserWindow, ipcMain } = require("electron");
const { createInterface } = require("node:readline");
const { join } = require("node:path");
const { writeFileSync, appendFileSync } = require("node:fs");
// DEMESNE_GRAPHICS_TRACE=<file>: one JSON line per frame with its stage
// timestamps (performance.timeOrigin-based ms), for diagnosing frame cost.
const tracePath = process.env.DEMESNE_GRAPHICS_TRACE;
const trace = (record) => { if (tracePath) appendFileSync(tracePath, JSON.stringify({ at: "renderer", ...record }) + "\n"); };
const now = () => performance.timeOrigin + performance.now();
const { TileFrame } = require("./tiles.cjs");
const { InputQueue } = require("./input-queue.cjs");
const { TileEncoder } = require("./tile-encoder.cjs");
const encoder = new TileEncoder();
// Set when the terminal reads image files: workers write tiles here directly.
let imageDirectory = null,
  imageFiles = 0;
// GPU rasterization is enabled: at Retina sizes, software raster made a
// scrolled frame's paint ~24 ms on Apple Silicon versus 10-16 ms on the GPU,
// readback included (benchmark-scroll.ts). DEMESNE_GRAPHICS_GPU=0 forces
// software rendering; Chromium also falls back to it where no GPU is usable.
if (process.env.DEMESNE_GRAPHICS_GPU === "0") app.disableHardwareAcceleration();
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
  // Where a frame's time goes: input dispatched → Chromium paints it, and
  // paint → tiles leave (bitmap copy, diff, encode).
  inputToPaintMs: 0,
  paintToSendMs: 0,
  timedFrames: 0,
  diffMs: 0,
  drainMs: 0,
};
let inputAt = 0,
  paintAt = 0;
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
async function flush() {
  scheduled = false;
  if (!ready || inFlight || !frame.dirty?.size) return;
  const start = performance.now();
  const drainStart = performance.now(), traceStart = now();
  const drained = frame.drain();
  metrics.drainMs += performance.now() - drainStart;
  const drainedAt = now();
  if (!drained.tiles.length) return;
  // Reserve the in-flight slot before encoding: paints during the encode
  // merge into the retained bitmap and leave with the next batch.
  inFlight = ++serial;
  // Worker threads convert and compress tiles in parallel, so a full-screen
  // scroll never encodes its tiles one after another on this thread.
  let tiles;
  try {
    tiles = await Promise.all(drained.tiles.map(async ({ data, ...tile }) => ({
      ...tile, format: "rgba-zlib",
      ...(await encoder.encode(data, imageDirectory && join(imageDirectory, `tty-graphics-protocol-${++imageFiles}`))) })));
  } catch (error) {
    // Never leave a tile marked as shown when it wasn't: resend it next time.
    for (const tile of drained.tiles) { frame.previous.delete(tile.id); frame.dirty.add(tile.id); }
    inFlight = 0;
    throw error;
  }
  const batch = { ...drained, tiles };
  if (tracePath) trace({ stage: "flush", serial: inFlight, start: traceStart, drained: drainedAt, end: now(), tiles: tiles.length });
  metrics.encodeMs += performance.now() - start;
  if (paintAt) { metrics.paintToSendMs += performance.now() - paintAt; metrics.timedFrames++; paintAt = 0; }
  metrics.encodedTiles += batch.tiles.length;
  metrics.encodedPixels += batch.tiles.reduce(
    (sum, tile) => sum + tile.width * tile.height,
    0,
  );
  // One batch is allowed in flight. Later paints merge into the retained bitmap
  // until stdout has drained; no dropped delta can leave a stale tile behind.
  send({
    kind: "tiles",
    serial: inFlight,
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
    setImmediate(() => void flush().catch((error) => send({ kind: "error", message: String(error) })));
  }
}
function paint(_event, dirty, image) {
  metrics.paintEvents++;
  if (!paintAt) paintAt = performance.now();
  if (inputAt) { metrics.inputToPaintMs += performance.now() - inputAt; inputAt = 0; }
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
  const diffStart = performance.now();
  const changed = frame.update(image.toBitmap(), size.width, size.height, dirty);
  metrics.diffMs += performance.now() - diffStart;
  if (tracePath) trace({ stage: "paint", start: now() - (performance.now() - diffStart), end: now(), changed, dirty });
  if (changed) schedule();
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
      else if (ready && msg.kind === "input") {
        inputAt = performance.now();
        if (tracePath) trace({ stage: "input", type: msg.event.type, start: now() });
        await input(msg.event);
        if (tracePath) trace({ stage: "dispatched", type: msg.event.type, end: now() });
      }
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
    if (msg.kind === "image-files") {
      imageDirectory = typeof msg.directory === "string" ? msg.directory : null;
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
