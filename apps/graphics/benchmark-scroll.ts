// Scrolling is the graphics UI's worst case: every visible tile changes, so
// each wheel step re-encodes and transfers the whole conversation area. This
// measures wheel input to decoded terminal pixels while scrolling a long,
// Markdown-heavy conversation, at standard and Retina density.
//   bun apps/graphics/benchmark-scroll.ts [scale 1|2] [files|inline] [columns] [rows]
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { TerminalHarness } from "./test/terminal-harness.ts";
import { fixture, eventually } from "./test/fixture.ts";

const scale = Number(process.argv[2] ?? 1);
const answer = ["## Findings", ...Array.from({ length: 40 }, (_, i) => `- Point ${i}: **bold**, \`code\`, and a longer sentence that wraps across the panel width to fill it.`),
  "", "```ts", ...Array.from({ length: 30 }, (_, i) => `const value${i} = compute(${i});`), "```"].join("\n");
const f = await fixture({ providerId: "test", modelId: "qwen3.8-27b", contextCapacity: 262144,
  async listModels() { return [{ id: "qwen3.8-27b", provider: "test", contextWindow: 262144 }]; },
  async *stream() { yield { type: "text_delta", delta: answer }; yield { type: "finish", reason: "stop" }; } });
const directory = mkdtempSync(join(tmpdir(), "graphics-scroll-")), layout = join(directory, "layout.json"), metricsPath = join(directory, "metrics.json");
const cell = { width: 8 * scale, height: 18 * scale }, columns = Number(process.argv[4] ?? 150), rows = Number(process.argv[5] ?? 40);
const inline = process.argv[3] === "inline";  // "files" (default) or "inline"
const app = new TerminalHarness({ columns, rows, cell, entry: resolve(import.meta.dir, "terminal.ts"), env: { ...f.env, ...(inline ? { DEMESNE_GRAPHICS_FILES: "0" } : {}), ...(process.env.DEMESNE_GRAPHICS_TRACE ? { DEMESNE_GRAPHICS_TRACE: process.env.DEMESNE_GRAPHICS_TRACE } : {}) },
  args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--layout=${layout}`, `--metrics=${metricsPath}`] });
const deadline = setTimeout(() => { console.error("benchmark timed out"); app.kill(); process.exit(1); }, 180_000);
try {
  await app.after(0);
  await eventually(() => Bun.file(layout).exists());
  await Bun.sleep(300);
  const box = JSON.parse(readFileSync(layout, "utf8"));
  for (let turn = 0; turn < 3; turn++) {
    app.click(Math.round((box.x + 8) * scale), Math.round((box.y + 10) * scale));
    await Bun.sleep(80);
    app.write(`question ${turn}\r`);
    await Bun.sleep(1500);
  }
  await Bun.sleep(800);
  const x = Math.round(columns * cell.width / 3), y = Math.round(rows * cell.height / 3);
  const times: number[] = [], sizes: number[] = [];
  let missed = 0;
  const scrollStart = app.batches;
  for (let i = 0; i < 30; i++) {
    const bytes = app.bytes, batch = app.batches, start = performance.now();
    app.write(`\x1b[<${i < 15 ? 64 : 65};${x};${y}M`);
    const framed = await Promise.race([app.after(batch).then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!framed) { missed++; continue; }
    times.push(performance.now() - start);
    await Bun.sleep(60);
    sizes.push(app.bytes - bytes);
  }
  const framesPerStep = (app.batches - scrollStart) / 30;
  if (times.length < 10) throw new Error(`Only ${times.length} scroll steps produced a frame`);
  app.write("\x11");
  await Promise.race([app.child.exited, Bun.sleep(5000)]);
  const sorted = [...times].sort((a, b) => a - b), kb = sizes.map((value) => value / 1024).sort((a, b) => a - b);
  const pick = (values: number[], q: number) => values[Math.min(values.length - 1, Math.floor(values.length * q))]!;
  const recorded = await Bun.file(metricsPath).exists() ? JSON.parse(readFileSync(metricsPath, "utf8")) : {};
  if (process.env.SCROLL_BENCH_RAW) console.error(JSON.stringify(recorded.renderer));
  console.log(JSON.stringify({
    viewport: `${columns * cell.width}x${rows * cell.height}`, scale, transfer: recorded.imageTransfer ?? "inline",
    wheelToPixelsMs: { median: +pick(sorted, 0.5).toFixed(1), p90: +pick(sorted, 0.9).toFixed(1) },
    kbPerScrollStep: { median: Math.round(pick(kb, 0.5)), max: Math.round(kb.at(-1)!) }, framesPerStep: +framesPerStep.toFixed(1), missedFrames: missed,
    demesneScrollToOutputMs: recorded.scrollFrames ? +(recorded.scrollToOutputMs / recorded.scrollFrames).toFixed(1) : null,
    rendererEncodeMsPerTile: recorded.renderer?.encodedTiles ? +(recorded.renderer.encodeMs / recorded.renderer.encodedTiles).toFixed(2) : null,
    rendererPaintToSendMs: recorded.renderer?.timedFrames ? +(recorded.renderer.paintToSendMs / recorded.renderer.timedFrames).toFixed(1) : null,
    rendererInputToPaintMs: recorded.renderer?.inputProcessed ? +(recorded.renderer.inputToPaintMs / recorded.renderer.inputProcessed).toFixed(1) : null,
    scope: "Synthetic PTY wheel input to decoded terminal pixels. Excludes Ghostty decoding and display; includes harness image decoding.",
  }));
} finally { clearTimeout(deadline); app.kill(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
