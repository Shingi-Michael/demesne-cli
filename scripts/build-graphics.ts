import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const root = resolve(import.meta.dir, "../apps/graphics"),
  out = resolve(import.meta.dir, "../dist/graphics");
const setup = Bun.spawn(
  [process.execPath, join(import.meta.dir, "setup-graphics.ts")],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await setup.exited) !== 0) throw new Error("Runtime setup failed");
mkdirSync(join(out, "dist"), { recursive: true });
const bundle = await Bun.build({
  entrypoints: [join(root, "live.ts")],
  outdir: join(out, "dist"),
  target: "browser",
  minify: true,
});
if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"));
for (const file of [
  "renderer.cjs",
  "bridge.cjs",
  "tiles.cjs",
  "tile-encoder.cjs",
  "input-queue.cjs",
  "live.html",
  "live.css",
  "ui.css",
])
  cpSync(join(root, file), join(out, file));
cpSync(join(root, "assets"), join(out, "assets"), { recursive: true });
const fontRoot = join(root, "node_modules/@fontsource/jetbrains-mono/files"),
  fontOut = join(out, "node_modules/@fontsource/jetbrains-mono/files");
mkdirSync(fontOut, { recursive: true });
for (const weight of [400, 500])
  cpSync(
    join(fontRoot, `jetbrains-mono-latin-${weight}-normal.woff2`),
    join(fontOut, `jetbrains-mono-latin-${weight}-normal.woff2`),
  );
const electronRoot = dirname(Bun.resolveSync("electron", root));
rmSync(join(out, "runtime"), { recursive: true, force: true });
cpSync(join(electronRoot, "dist"), join(out, "runtime"), {
  recursive: true,
  dereference: false,
  verbatimSymlinks: true,
});
const host = Bun.spawn(
  [
    process.execPath,
    "build",
    join(root, "terminal.ts"),
    "--compile",
    "--outfile",
    join(out, "host"),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await host.exited) !== 0) throw new Error("Graphics host build failed");
console.log("Built dist/graphics. Keep this directory beside dist/demesne.");
