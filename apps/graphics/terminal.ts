import { spawn } from "node:child_process";
import { emitKeypressEvents, createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { GraphicsHost } from "./host.ts";
import { StateEncoder, type GraphicsSnapshot } from "./state-wire.ts";
import { palette } from "../../packages/brand/src/theme.ts";
import { graphicsProbe } from "../../apps/cli/src/terminal-graphics.ts";
import {
  TerminalInputDecoder,
  PASTE_ENABLE,
  PASTE_DISABLE,
} from "../../apps/cli/src/workbench/terminal-input.ts";
import { TileTransport, viewport, type TileBatch } from "./transport.ts";
import { PipeWriter, isDisconnect } from "./pipe-writer.cjs";
import { InputQueue } from "./input-queue.cjs";
import { displayScale, parseDisplayScale } from "./display-scale.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
};
const root = process.env.DEMESNE_GRAPHICS_ROOT ?? import.meta.dir;
const snapshot = option("snapshot");
const live = args.includes("--live");
if (live && (await Bun.file(join(root, "live.ts")).exists())) {
  const bundle = await Bun.build({
    entrypoints: [join(root, "live.ts")],
    outdir: join(root, "dist"),
    target: "browser",
    minify: false,
  });
  if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"));
}
let host: GraphicsHost | undefined;
if (option("capture-dir"))
  mkdirSync(option("capture-dir")!, { recursive: true });
const explicitScale = parseDisplayScale(option("scale"));
let scale = explicitScale ?? 1;
if (!snapshot && (!process.stdin.isTTY || !process.stdout.isTTY))
  throw new Error(
    "Run the graphics UI in Ghostty, or use --snapshot=/absolute/path.png",
  );
const cache = mkdtempSync(join(tmpdir(), "demesne-pixel-"));
const packagedRuntime = join(root, "runtime");
const electronRoot = (await Bun.file(join(root, "live.ts")).exists())
  ? dirname(Bun.resolveSync("electron", root))
  : root;
const runtimeSuffix =
  process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : "electron";
let electronPath = (await Bun.file(
  join(packagedRuntime, runtimeSuffix),
).exists())
  ? join(packagedRuntime, runtimeSuffix)
  : join(electronRoot, "dist", runtimeSuffix);
// Reuse the already-installed proof-of-concept runtime in a development checkout.
if (!(await Bun.file(electronPath).exists()))
  electronPath = join(
    import.meta.dir,
    "../../experiments/ghostty-ui/node_modules/electron/dist",
    runtimeSuffix,
  );
const rendererEnv = Object.fromEntries(
  [
    "HOME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DEMESNE_GRAPHICS_TRACE",
    "DEMESNE_GRAPHICS_GPU",
  ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
);
const child = spawn(electronPath, [join(root, "renderer.cjs")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...rendererEnv,
    ELECTRON_RUN_AS_NODE: undefined,
    DEMESNE_PIXEL_CACHE: cache,
  },
});
let errorLog = "",
  started = false,
  ready = false,
  attached = false,
  closing = false,
  supported = false;
let cell: { width: number; height: number } | undefined;
let pixelMouse = false,
  epoch = 0,
  wheelAt = 0;
const transport = new TileTransport();
const stateEncoder = new StateEncoder();
const inputQueue = new InputQueue();
let inputScheduled = false,
  sending = false;
const metrics = {
  batches: 0,
  tiles: 0,
  terminalBytes: 0,
  imageBytes: 0,
  // Wheel input to the frame showing it written for the terminal: everything
  // Demesne does (host, Chromium, encoding); excludes the terminal's decode.
  scrollFrames: 0,
  scrollToOutputMs: 0,
  renderer: {} as Record<string, number>,
};
let requested = { width: 1200, height: 720 };
const probeId = 140000;
// Asks whether the terminal can read image files from a private directory
// (it can when it runs on this machine); if so, tiles go by path, not base64.
const fileProbeId = 139999;
let imageDirectory: string | undefined;
function fileProbe(): string {
  if (process.env.DEMESNE_GRAPHICS_FILES === "0") return "";
  imageDirectory = mkdtempSync(join(tmpdir(), "demesne-graphics-"));
  const path = join(imageDirectory, "tty-graphics-protocol-probe");
  writeFileSync(path, deflateSync(Buffer.from([0, 0, 0])), { mode: 0o600 });
  return `\x1b_Ga=q,t=t,f=24,o=z,s=1,v=1,i=${fileProbeId};${Buffer.from(path).toString("base64")}\x1b\\`;
}
const rendererInput = new PipeWriter(child.stdin, error => {
  if (!closing) finish(`Renderer connection closed${error ? `: ${error.message}` : "."}`, 1);
});
const terminalOutput = new PipeWriter(process.stdout, error => finish("", isDisconnect(error) ? 0 : 1));
const diagnosticOutput = new PipeWriter(process.stderr, () => {});
const send = (value: any) => {
  if (closing || rendererInput.closed) return;
  // Drain acknowledgements bypass input coalescing and never wait for a hover burst.
  if (
    value.kind === "ack" ||
    value.kind === "response" ||
    value.kind === "app-state" ||
    value.kind === "ui-command"
  ) {
    rendererInput.write(JSON.stringify(value) + "\n");
    return;
  }
  inputQueue.push(value);
  if (!inputScheduled) {
    inputScheduled = true;
    setImmediate(flushInputs);
  }
};
function flushInputs() {
  inputScheduled = false;
  if (closing || sending || rendererInput.closed) return;
  const items = [];
  for (let value; (value = inputQueue.shift()); ) items.push(value);
  if (!items.length) return;
  sending = true;
  rendererInput.write(
    items.map((value) => JSON.stringify(value)).join("\n") + "\n",
    () => {
      sending = false;
      flushInputs();
    },
  );
}
const dimensions = () =>
  viewport(process.stdout.columns, process.stdout.rows, cell!);
function startHost() {
  if (!live || host) return;
  host = new GraphicsHost({
    server: option("server"),
    workspace: option("workspace"),
    sessionId: option("session"),
    startup: { model: option("model"), prompt: option("prompt") },
    changed: (state) =>
      send({ kind: "app-state", state: stateEncoder.encode(state) }),
    command: (command) => send({ kind: "ui-command", command }),
  });
  if (args.includes("--setup")) void host.handle("setup", {});
  else void host.connect();
}
function begin() {
  if (started || !supported || !cell) return;
  started = true;
  scale = displayScale(cell, explicitScale);
  requested = dimensions();
  startHost();
  send({
    kind: "init",
    ...requested,
    epoch,
    cell,
    scale,
    theme: palette,
    live,
    diagnostics: Boolean(option("capture-dir")),
    metrics: Boolean(option("metrics")),
    layout: Boolean(option("layout")),
  });
}
function resize() {
  if (!started || !cell) return;
  const next = dimensions(),
    signature = `${next.width}:${next.height}:${cell.width}:${cell.height}`;
  if (signature === geometry) return;
  geometry = signature;
  requested = next;
  scale = displayScale(cell, explicitScale);
  epoch++;
  send({ kind: "resize", ...requested, epoch, cell, scale });
}
let geometry = "";
function draw(batch: TileBatch) {
  if (closing) return;
  if (
    batch.epoch !== epoch ||
    batch.width !== requested.width ||
    batch.height !== requested.height
  ) {
    // A stale batch is never shown: remove any files its tiles were written to.
    for (const tile of batch.tiles) if (tile.file) rmSync(tile.file, { force: true });
    send({ kind: "ack", serial: batch.serial });
    return;
  }
  const output = transport.apply(batch, cell!);
  metrics.batches++;
  metrics.tiles += batch.tiles.length;
  metrics.terminalBytes += Buffer.byteLength(output);
  metrics.imageBytes += batch.tiles.reduce((total, tile) => total + (tile.bytes ?? 0), 0);
  if (batch.metrics) metrics.renderer = batch.metrics;
  const scrolled = wheelAt;
  wheelAt = 0;
  const traceDraw = process.env.DEMESNE_GRAPHICS_TRACE, drawStart = performance.timeOrigin + performance.now();
  terminalOutput.write(output, () => {
    if (scrolled) { metrics.scrollFrames++; metrics.scrollToOutputMs += performance.now() - scrolled; }
    if (traceDraw) appendFileSync(traceDraw, JSON.stringify({ at: "terminal", stage: "draw", serial: batch.serial, start: drawStart, end: performance.timeOrigin + performance.now(), bytes: Buffer.byteLength(output) }) + "\n");
    send({ kind: "ack", serial: batch.serial });
    const capture = option("capture-dir");
    if (capture)
      send({ kind: "inspect", path: resolve(capture, "latest.png") });
  });
}
function finish(message = "", code = 0) {
  if (closing) return;
  closing = true;
  rendererInput.close();
  inputQueue.items.length = 0;
  host?.dispose();
  clearTimeout(probeTimer);
  clearTimeout(escapeTimer);
  if (imageDirectory) rmSync(imageDirectory, { recursive: true, force: true });
  if (attached) {
    try { process.stdin.setRawMode(wasRaw); } catch { /* The terminal may already be gone. */ }
    process.stdin.pause();
    terminalOutput.write(
      transport.clear() +
        "\x1b[?1016;1000;1002;1003;1006l" +
        PASTE_DISABLE +
        "\x1b[?25h\x1b[?2026l\x1b[?1049l",
    );
  }
  const metricsPath = option("metrics");
  if (metricsPath)
    writeFileSync(
      metricsPath,
      JSON.stringify(
        {
          ...metrics,
          imageTransfer: transport.filesEnabled ? "files" : "inline",
          coalescedInputs: inputQueue.coalesced,
          maxPendingInputs: inputQueue.maximum,
        },
        null,
        2,
      ) + "\n",
    );
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), 1500);
  forced.unref();
  process.exitCode = code;
  if (message) diagnosticOutput.write(message + "\n");
}
child.stderr.on("data", (chunk) => {
  errorLog = (errorLog + chunk.toString()).slice(-4000);
});
child.on("error", (error) =>
  finish(
    `Chromium renderer could not start: ${error.message}. Run bun run graphics:setup from the repository root.`,
    1,
  ),
);
child.on("exit", (code, signal) => {
  if (!closing)
    finish(
      code || signal ? `Renderer exited (${signal ?? code}). ${errorLog}` : "",
      code ?? 1,
    );
});
child.on("close", () => rmSync(cache, { recursive: true, force: true }));
createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    const event = JSON.parse(line);
    if (event.kind === "request") {
      const task =
        event.method === "quit"
          ? Promise.resolve().then(() => {
              finish();
            })
          : host
            ? host.handle(event.method, event.args)
            : Promise.reject(new Error("The live host is unavailable"));
      void task.then(
        (value) => {
          if (event.method === "bootstrap")
            stateEncoder.reset(value as GraphicsSnapshot);
          send({ kind: "response", id: event.id, ok: true, value });
        },
        (error) =>
          send({
            kind: "response",
            id: event.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    }
    if (event.kind === "error") finish(event.message, 1);
    if (event.kind === "state" && option("capture-dir")) {
      mkdirSync(option("capture-dir")!, { recursive: true });
      writeFileSync(
        join(option("capture-dir")!, "state.json"),
        JSON.stringify(event.state),
      );
    }
    if (event.kind === "snapshot") {
      console.log(event.path);
      finish();
    }
    if (event.kind === "ready") {
      ready = true;
      if (option("layout") && event.layout)
        writeFileSync(option("layout")!, JSON.stringify(event.layout));
    }
    if (event.kind === "tiles" && !snapshot) draw(event);
  } catch (error) {
    finish(`Rendering bridge failed: ${String(error)}`, 1);
  }
});
const keys = new PassThrough();
emitKeypressEvents(keys);
keys.on(
  "keypress",
  (
    text: string,
    key: {
      name?: string;
      ctrl?: boolean;
      meta?: boolean;
      shift?: boolean;
    } = {},
  ) => {
    if (key.ctrl && key.name === "q") {
      finish();
      return;
    }
    if (key.ctrl && key.name === "c") {
      if (host?.active || host?.checking) {
        host.drive?.agent.intervene();
        void host.interrupt();
      } else finish();
      return;
    }
    if (!ready) return;
    if (key.ctrl && key.name === "y") {
      send({ kind: "copy" });
      return;
    }
    const codes: Record<string, string> = {
      return: "Return",
      enter: "Return",
      tab: "Tab",
      backspace: "Backspace",
      delete: "Delete",
      escape: "Escape",
      left: "Left",
      right: "Right",
      up: "Up",
      down: "Down",
      home: "Home",
      end: "End",
      pageup: "PageUp",
      pagedown: "PageDown",
    };
    const code =
      codes[key.name ?? ""] ??
      (key.ctrl || key.meta ? key.name?.toUpperCase() : undefined);
    if (code) {
      const modifiers = [
        key.ctrl ? "control" : "",
        key.meta ? "alt" : "",
        key.shift ? "shift" : "",
      ].filter(Boolean);
      send({
        kind: "input",
        event: { type: "keyDown", keyCode: code, modifiers },
      });
      send({
        kind: "input",
        event: { type: "keyUp", keyCode: code, modifiers },
      });
    } else if (text) send({ kind: "key-text", text });
  },
);
function standaloneEscape(sequence: string) {
  if (!/^\x1b+$/.test(sequence)) {
    keys.write(sequence);
    return;
  }
  // The decoder already resolved the ambiguity. Readline's additional 500ms
  // Escape timeout would merge Esc Esc into one Alt+Escape and delay dismissal.
  for (const _ of sequence) {
    send({
      kind: "input",
      event: { type: "keyDown", keyCode: "Escape", modifiers: [] },
    });
    send({
      kind: "input",
      event: { type: "keyUp", keyCode: "Escape", modifiers: [] },
    });
  }
}
const decoder = new TerminalInputDecoder();
let escapeTimer: ReturnType<typeof setTimeout> | undefined;
const wasRaw = process.stdin.isRaw;
const probeTimer = setTimeout(() => {
  if (!snapshot && !started)
    finish(
      "The graphics UI requires Kitty graphics and a terminal cell-size reply. Run it directly in Ghostty (outside tmux).",
      1,
    );
}, 2500);
probeTimer.unref();
if (snapshot) {
  startHost();
  const [width, height] = (option("size") ?? "1200x720").split("x").map(Number);
  if (!width || !height) throw new Error("Use --size=1200x720");
  send({
    kind: "init",
    width,
    height,
    scale,
    theme: palette,
    live,
    snapshot: resolve(snapshot),
  });
} else {
  attached = true;
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  terminalOutput.write(
    "\x1b[?1049h\x1b[2J\x1b[?25l\x1b[?1003;1006h" +
      PASTE_ENABLE +
      graphicsProbe(probeId) +
      fileProbe() +
      "\x1b[?1016$p",
  );
  process.stdin.on("data", (chunk: string) => {
    for (const input of decoder.push(chunk)) {
      if (
        input.kind === "graphics-reply" &&
        input.header.split(",").includes(`i=${fileProbeId}`)
      ) {
        if (input.message === "OK" && imageDirectory) {
          transport.useFiles(imageDirectory);
          send({ kind: "image-files", directory: imageDirectory });
        }
      } else if (
        input.kind === "graphics-reply" &&
        input.header.split(",").includes(`i=${probeId}`)
      ) {
        supported = input.message === "OK";
        begin();
      } else if (input.kind === "cell-size") {
        const nextCell = { width: input.width, height: input.height };
        try {
          displayScale(nextCell, explicitScale);
        } catch (error) {
          finish(String(error), 1);
          return;
        }
        cell = nextCell;
        if (started) resize();
        else {
          geometry = `${dimensions().width}:${dimensions().height}:${cell.width}:${cell.height}`;
          begin();
        }
      } else if (
        (input.kind === "escape" || input.kind === "text") &&
        /^\x1b\[\?1016;\d\$y$/.test(
          input.kind === "text" ? input.text : input.sequence,
        )
      ) {
        pixelMouse = /;[1234]\$y$/.test(
          input.kind === "text" ? input.text : input.sequence,
        );
        if (pixelMouse) terminalOutput.write("\x1b[?1016h");
      } else if (input.kind === "text") keys.write(input.text);
      else if (input.kind === "escape") standaloneEscape(input.sequence);
      else if (input.kind === "paste") send({ kind: "text", text: input.text });
      else if (input.kind === "mouse" && ready && cell) {
        const event = input.event;
        const x = Math.round(
          (pixelMouse ? event.col : (event.col + 0.5) * cell.width) / scale,
        );
        const y = Math.round(
          (pixelMouse ? event.row : (event.row + 0.5) * cell.height) / scale,
        );
        const button =
          (["left", "middle", "right"] as const)[event.button] ?? "left";
        if (event.kind === "wheel") {
          wheelAt ||= performance.now();
          if (process.env.DEMESNE_GRAPHICS_TRACE) appendFileSync(process.env.DEMESNE_GRAPHICS_TRACE, JSON.stringify({ at: "terminal", stage: "wheel", start: performance.timeOrigin + performance.now() }) + "\n");
          send({
            kind: "input",
            event: {
              type: "mouseWheel",
              x,
              y,
              deltaX:
                event.direction === "left"
                  ? -60
                  : event.direction === "right"
                    ? 60
                    : 0,
              deltaY:
                event.direction === "up"
                  ? -60
                  : event.direction === "down"
                    ? 60
                    : 0,
              canScroll: true,
            },
          });
        } else
          send({
            kind: "input",
            event: {
              type:
                event.kind === "press"
                  ? "mouseDown"
                  : event.kind === "release"
                    ? "mouseUp"
                    : "mouseMove",
              x,
              y,
              button,
              clickCount: 1,
              ...(event.kind === "drag"
                ? { modifiers: [`${button}ButtonDown`] }
                : {}),
            },
          });
      }
    }
    clearTimeout(escapeTimer);
    if (decoder.waitingForEscape)
      escapeTimer = setTimeout(() => {
        for (const event of decoder.flushEscape())
          if (event.kind === "escape") standaloneEscape(event.sequence);
      }, 30);
  });
  process.stdout.on("resize", () => {
    resize();
    terminalOutput.write("\x1b[16t");
  });
}
process.stdin.on("end", () => finish());
process.stdin.on("close", () => finish());
process.stdin.on("error", error => finish(error.message, isDisconnect(error) ? 0 : 1));
process.on("SIGHUP", () => finish());
process.on("SIGTERM", () => finish());
process.on("SIGINT", () => finish());
