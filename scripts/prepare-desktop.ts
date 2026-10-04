import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop"), graphics = join(root, "apps/graphics"), native = join(desktop, "src-tauri");
const out = join(desktop, "dist");
async function run(args: string[], cwd = root) {
  const child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Desktop preparation failed: ${args.slice(1, 3).join(" ")}`);
}
const target = Bun.spawnSync(["rustc", "--print", "host-tuple"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
if (!target) throw new Error("Rust is required. Install Rust and the platform prerequisites in docs/desktop.md.");
if (process.env.TAURI_ENV_TARGET_TRIPLE && process.env.TAURI_ENV_TARGET_TRIPLE !== target) {
  throw new Error("Build the desktop app on its target platform so the Bun sidecars and native image codecs match its architecture.");
}
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const bundle = await Bun.build({ entrypoints: [join(desktop, "frontend.ts")], outdir: out, target: "browser", splitting: true, minify: true });
if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"));
writeFileSync(join(out, "ui.css"), readFileSync(join(graphics, "ui.css"), "utf8").replaceAll("node_modules/@fontsource/jetbrains-mono/files/", "vendor/fonts/"));
cpSync(join(graphics, "live.css"), join(out, "live.css"));
writeFileSync(join(out, "index.html"), readFileSync(join(desktop, "index.html"), "utf8").replaceAll("node_modules/katex/dist/katex.min.css", "vendor/katex/katex.min.css"));
cpSync(join(desktop, "desktop.css"), join(out, "desktop.css"));
cpSync(join(graphics, "assets"), join(out, "assets"), { recursive: true });
const fonts = "node_modules/@fontsource/jetbrains-mono/files";
mkdirSync(join(out, "vendor/fonts"), { recursive: true });
for (const weight of [400, 500]) cpSync(join(graphics, fonts, `jetbrains-mono-latin-${weight}-normal.woff2`), join(out, "vendor/fonts", `jetbrains-mono-latin-${weight}-normal.woff2`));
const katex = "node_modules/katex/dist";
mkdirSync(join(out, "vendor/katex"), { recursive: true });
cpSync(join(graphics, katex, "katex.min.css"), join(out, "vendor/katex/katex.min.css"));
cpSync(join(graphics, katex, "fonts"), join(out, "vendor/katex/fonts"), { recursive: true });
const binaries = join(native, "binaries"); mkdirSync(binaries, { recursive: true });
const suffix = process.platform === "win32" ? ".exe" : "";
await run([process.execPath, "build", join(desktop, "host.ts"), "--compile", "--outfile", join(binaries, `demesne-desktop-host-${target}${suffix}`)]);
await run([process.execPath, "run", "scripts/build-daemon.ts"]);
cpSync(join(root, "dist/demesned"), join(binaries, `demesned-${target}${suffix}`));
const runtime = join(native, "resources/runtime");
rmSync(runtime, { recursive: true, force: true }); mkdirSync(runtime, { recursive: true });
cpSync(join(root, "dist/node_modules"), join(runtime, "node_modules"), { recursive: true, dereference: true });
// Keep the directly launched debug/release test binaries self-contained too.
for (const profile of ["debug", "release"]) {
  const directory = join(native, "target", profile); mkdirSync(directory, { recursive: true });
  cpSync(join(binaries, `demesne-desktop-host-${target}${suffix}`), join(directory, `demesne-desktop-host${suffix}`));
  cpSync(join(binaries, `demesned-${target}${suffix}`), join(directory, `demesned${suffix}`));
  cpSync(runtime, join(directory, "runtime"), { recursive: true, dereference: true });
}
if (!existsSync(join(native, "icons/icon.png")) || statSync(join(native, "icons/icon.png")).mtimeMs < statSync(join(desktop, "icon.svg")).mtimeMs) await run([process.execPath, "x", "--no-install", "tauri", "icon", join(desktop, "icon.svg"), "--output", join(native, "icons")]);
console.log(`Prepared Demesne desktop assets and sidecars for ${target}.`);
