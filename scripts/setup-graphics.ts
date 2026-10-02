import { dirname, join, resolve } from "node:path";
const root = resolve(import.meta.dir, "../apps/graphics"),
  electronRoot = dirname(Bun.resolveSync("electron", root));
const runtime = join(
  electronRoot,
  "dist",
  process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : process.platform === "win32"
      ? "electron.exe"
      : "electron",
);
if (!(await Bun.file(runtime).exists())) {
  const child = Bun.spawn(
    [process.execPath, join(electronRoot, "install.js")],
    { cwd: electronRoot, stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0)
    throw new Error("Electron installation failed");
}
if (!(await Bun.file(runtime).exists()))
  throw new Error("Electron runtime missing after installation");
console.log("Graphics runtime ready. Run bun run graphics in Ghostty.");
