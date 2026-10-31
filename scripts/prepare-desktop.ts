import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { prepareUi } from "./prepare-ui.ts";
import { buildVersionArgs, resolveBuildId, resolveBuildVersion } from "./build-version.ts";
const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const build = join(desktop, "build"), application = join(build, "app"), out = join(application, "ui"), backend = join(build, "backend");
async function run(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, env: process.env, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Desktop preparation failed: ${args.slice(1, 3).join(" ")}`);
}
rmSync(build, { recursive: true, force: true }); mkdirSync(application, { recursive: true }); mkdirSync(backend, { recursive: true });
// The window's page.
await prepareUi(out);
for (const entry of ["electron/main.ts", "electron/preload.ts"]) {
  const bundle = await Bun.build({ entrypoints: [join(desktop, entry)], outdir: application, target: "node", format: "cjs", external: ["electron"], minify: true, naming: "[name].cjs" });
  if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"));
}
// The Mac's liquid glass: electron-liquid-glass's prebuilt addon for this
// Mac, loaded by the main process on macOS 26 and later.
if (process.platform === "darwin") {
  const prebuilds = join(desktop, "node_modules/electron-liquid-glass/prebuilds");
  const addon = process.arch === "arm64" ? join(prebuilds, "darwin-arm64/node.napi.armv8.node") : join(prebuilds, "darwin-x64/node.napi.node");
  if (existsSync(addon)) cpSync(addon, join(application, "liquid-glass.node"));
  else console.warn("No liquid glass addon for this Mac; the window keeps frosted glass.");
}
const version = resolveBuildVersion();
// One build id for the host and the daemon built below (build-daemon reads it from the environment).
process.env.DEMESNE_BUILD_ID = resolveBuildId();
writeFileSync(join(application, "package.json"), JSON.stringify({ name: "demesne", productName: "Demesne", version, description: "A coding workspace with durable sessions and Agent Drive", author: "Demesne contributors", main: "main.cjs" }, null, 2));
const suffix = process.platform === "win32" ? ".exe" : "";
await run([process.execPath, "build", join(desktop, "host.ts"), "--compile", ...buildVersionArgs(version), "--outfile", join(backend, `demesne-host${suffix}`)]);
// Compatibility for an already-running Electron main process upgraded in place:
// it still knows the old private helper path until the app is relaunched.
cpSync(join(backend, `demesne-host${suffix}`), join(backend, `demesne-desktop-host${suffix}`));
await run([process.execPath, "run", "scripts/build-daemon.ts"]);
cpSync(join(root, `dist/demesned${suffix}`), join(backend, `demesned${suffix}`));
cpSync(join(root, "dist/node_modules"), join(backend, "node_modules"), { recursive: true, dereference: true });
await sharp(join(desktop, "icon.svg")).resize(512, 512).png().toFile(join(build, "icon.png"));
console.log(`Prepared Electron desktop and Bun backends for ${process.platform}-${process.arch}.`);
