import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
const args = process.argv.slice(2).filter(arg => arg !== "--");
const platformFlags = { "--mac": "darwin", "-m": "darwin", "--linux": "linux", "-l": "linux", "--win": "win32", "-w": "win32" };
for (const arg of args) {
  const platform = platformFlags[arg as keyof typeof platformFlags];
  if (platform && platform !== process.platform || arg === "--universal" || ["--x64", "--arm64", "--ia32", "--armv7l"].includes(arg) && arg.slice(2) !== process.arch)
    throw new Error("Build on the target platform and architecture so the Bun backends and image codecs match Electron.");
}
await import("./prepare-desktop.ts");
const child = Bun.spawn([process.execPath, "x", "--no-install", "electron-builder", "--config", "apps/desktop/electron-builder.json", "--publish", "never", ...args], {
  cwd: resolve(import.meta.dir, ".."), stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exitCode = await child.exited;

// Apple silicon kills a program whose signature doesn't match its contents
// (the backend exits with SIGKILL the moment the app starts it). The Bun
// backends reach the packaged app with a stale linker signature, so sign them
// ad hoc here, then the app itself so its seal covers the re-signed files, and
// check every signature before the build counts as done.
if (process.exitCode === 0 && process.platform === "darwin") {
  const app = resolve(import.meta.dir, "../apps/desktop/release/mac-arm64/Demesne.app");
  const backend = join(app, "Contents/Resources/backend");
  const codesign = async (args: string[]) => {
    const run = Bun.spawn(["codesign", ...args], { stdout: "inherit", stderr: "inherit" });
    if (await run.exited !== 0) throw new Error(`codesign ${args.join(" ")} failed`);
  };
  if (existsSync(app)) {
    for (const name of ["demesne-host", "demesne-desktop-host", "demesned"]) {
      const file = join(backend, name);
      if (!existsSync(file)) throw new Error(`The packaged app is missing ${name}`);
      await codesign(["--force", "--sign", "-", file]);
      await codesign(["--verify", "--strict", file]);
    }
    await codesign(["--force", "--sign", "-", app]);
    await codesign(["--verify", app]);
    console.log("Signed the Bun backends and Demesne.app ad hoc for this Mac.");
  }
}
