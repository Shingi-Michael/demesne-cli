import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop"), workspace = join(desktop, "workspace");
const build = join(desktop, "build"), application = join(build, "app"), out = join(application, "ui"), backend = join(build, "backend");
async function run(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Desktop preparation failed: ${args.slice(1, 3).join(" ")}`);
}
rmSync(build, { recursive: true, force: true }); mkdirSync(out, { recursive: true }); mkdirSync(backend, { recursive: true });
for (const [entry, destination, target, format] of [
  ["frontend.ts", out, "browser", "esm"],
  ["electron/main.ts", application, "node", "cjs"],
  ["electron/preload.ts", application, "node", "cjs"],
] as const) {
  const bundle = await Bun.build({ entrypoints: [join(desktop, entry)], outdir: destination, target, format, external: ["electron"], minify: true, splitting: target === "browser", naming: target === "node" ? "[name].cjs" : "[name].[ext]" });
  if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"));
}
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(join(application, "package.json"), JSON.stringify({ name: "demesne-desktop", productName: "Demesne", version: process.env.DEMESNE_BUILD_VERSION ?? metadata.version, description: "A coding workspace with durable sessions and Agent Drive", author: "Demesne contributors", main: "main.cjs" }, null, 2));
writeFileSync(join(out, "ui.css"), readFileSync(join(workspace, "ui.css"), "utf8").replaceAll("node_modules/@fontsource/jetbrains-mono/files/", "vendor/fonts/"));
cpSync(join(workspace, "live.css"), join(out, "live.css"));
writeFileSync(join(out, "index.html"), readFileSync(join(desktop, "index.html"), "utf8").replaceAll("node_modules/katex/dist/katex.min.css", "vendor/katex/katex.min.css"));
cpSync(join(desktop, "desktop.css"), join(out, "desktop.css"));
cpSync(join(desktop, "workspace.css"), join(out, "workspace.css"));
cpSync(join(workspace, "assets"), join(out, "assets"), { recursive: true });
mkdirSync(join(out, "vendor/fonts"), { recursive: true });
for (const weight of [400, 500]) cpSync(join(desktop, "node_modules/@fontsource/jetbrains-mono/files", `jetbrains-mono-latin-${weight}-normal.woff2`), join(out, "vendor/fonts", `jetbrains-mono-latin-${weight}-normal.woff2`));
mkdirSync(join(out, "vendor/katex"), { recursive: true });
cpSync(join(desktop, "node_modules/katex/dist/katex.min.css"), join(out, "vendor/katex/katex.min.css"));
cpSync(join(desktop, "node_modules/katex/dist/fonts"), join(out, "vendor/katex/fonts"), { recursive: true });
const suffix = process.platform === "win32" ? ".exe" : "";
await run([process.execPath, "build", join(desktop, "host.ts"), "--compile", "--outfile", join(backend, `demesne-desktop-host${suffix}`)]);
await run([process.execPath, "run", "scripts/build-daemon.ts"]);
cpSync(join(root, `dist/demesned${suffix}`), join(backend, `demesned${suffix}`));
cpSync(join(root, "dist/node_modules"), join(backend, "node_modules"), { recursive: true, dereference: true });
await sharp(join(desktop, "icon.svg")).resize(512, 512).png().toFile(join(build, "icon.png"));
console.log(`Prepared Electron desktop and Bun backends for ${process.platform}-${process.arch}.`);
