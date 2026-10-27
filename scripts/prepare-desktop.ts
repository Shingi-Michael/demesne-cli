import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { prepareUi } from "./prepare-ui.ts";
import { buildVersionArgs, resolveBuildVersion } from "./build-version.ts";
const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const build = join(desktop, "build"), application = join(build, "app"), out = join(application, "ui"), backend = join(build, "backend");
async function run(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Desktop preparation failed: ${args.slice(1, 3).join(" ")}`);
}
rmSync(build, { recursive: true, force: true }); mkdirSync(application, { recursive: true }); mkdirSync(backend, { recursive: true });
// The window's page.
await prepareUi(out);
for (const entry of ["electron/main.ts", "electron/preload.ts"]) {
  const bundle = await Bun.build({ entrypoints: [join(desktop, entry)], outdir: application, target: "node", format: "cjs", external: ["electron"], minify: true, naming: "[name].cjs" });
  if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"));
}
const version = resolveBuildVersion();
writeFileSync(join(application, "package.json"), JSON.stringify({ name: "demesne-desktop", productName: "Demesne", version, description: "A coding workspace with durable sessions and Agent Drive", author: "Demesne contributors", main: "main.cjs" }, null, 2));
const suffix = process.platform === "win32" ? ".exe" : "";
await run([process.execPath, "build", join(desktop, "host.ts"), "--compile", ...buildVersionArgs(version), "--outfile", join(backend, `demesne-desktop-host${suffix}`)]);
await run([process.execPath, "run", "scripts/build-daemon.ts"]);
cpSync(join(root, `dist/demesned${suffix}`), join(backend, `demesned${suffix}`));
cpSync(join(root, "dist/node_modules"), join(backend, "node_modules"), { recursive: true, dereference: true });
await sharp(join(desktop, "icon.svg")).resize(512, 512).png().toFile(join(build, "icon.png"));
console.log(`Prepared Electron desktop and Bun backends for ${process.platform}-${process.arch}.`);
