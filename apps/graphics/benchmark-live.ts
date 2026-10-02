import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { TerminalHarness } from "../../experiments/ghostty-ui/test/terminal-harness.ts";
import { fixture, eventually } from "./test/fixture.ts";
const f = await fixture(),
  directory = mkdtempSync(join(tmpdir(), "graphics-benchmark-")),
  layout = join(directory, "layout.json");
const columns = Number(process.argv[2] ?? 150),
  rows = Number(process.argv[3] ?? 40);
const app = new TerminalHarness({
  columns,
  rows,
  entry: resolve(import.meta.dir, "terminal.ts"),
  env: f.env,
  args: [
    "--live",
    `--server=${f.server.url}`,
    `--workspace=${f.workspace}`,
    `--layout=${layout}`,
  ],
});
const times: number[] = [];
try {
  await app.after(0);
  await eventually(() => Bun.file(layout).exists());
  await Bun.sleep(200);
  const rect = JSON.parse(readFileSync(layout, "utf8"));
  app.click(Math.round(rect.x + 8), Math.round(rect.y + 10));
  await Bun.sleep(100);
  const bytes = app.bytes;
  for (let i = 0; i < 24; i++) {
    const x = Math.round(rect.x + i * 8.4) + 2,
      start = performance.now();
    let batch = app.batches;
    app.write("W");
    while (true) {
      await app.after(batch);
      batch = app.batches;
      if ((await app.brightPixels(x, Math.round(rect.y) + 3, 4, 16)) > 8) break;
      if (performance.now() - start > 3000)
        throw new Error("Typed glyph did not render");
    }
    times.push(performance.now() - start);
    await Bun.sleep([23, 47, 81, 109, 37][i % 5]!);
  }
  const typingBytes = app.bytes - bytes;
  app.click(30, 25);
  await Bun.sleep(300);
  const idleFrames = app.batches,
    idleBytes = app.bytes;
  await Bun.sleep(1000);
  const sorted = [...times].sort((a, b) => a - b);
  const result = {
    viewport: `${columns * 8}x${rows * 18}`,
    samples: times.length,
    inputToTextPixelsMs: {
      median: +sorted[12]!.toFixed(1),
      p95: +sorted[22]!.toFixed(1),
    },
    bytesPerKey: Math.round(typingBytes / 24),
    idleFrames: app.batches - idleFrames,
    idleBytes: app.bytes - idleBytes,
    scope:
      "Connected UI, synthetic PTY input to decoded terminal pixels. Excludes Ghostty decoding and display. Includes harness PNG decoding.",
  };
  console.log(JSON.stringify(result));
  await Bun.write(
    join(import.meta.dir, `benchmark-${columns * 8}.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
  app.write("\x11");
  await app.child.exited;
} finally {
  app.kill();
  await f.close();
  rmSync(directory, { recursive: true, force: true });
}
