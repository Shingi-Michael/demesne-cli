import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { codesign, signBackends } from "./sign-backends.ts";
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

// Packaging copies the backends into the app again, so they are signed there
// too (scripts/sign-backends.ts), then the app itself so its seal covers the
// re-signed files, and every signature is checked before the build is done.
if (process.exitCode === 0 && process.platform === "darwin") {
  const app = resolve(import.meta.dir, "../apps/desktop/release/mac-arm64/Demesne.app");
  if (existsSync(app)) {
    await signBackends(join(app, "Contents/Resources/backend"));
    await codesign(["--force", "--sign", "-", app]);
    await codesign(["--verify", app]);
    console.log("Signed the Bun backends and Demesne.app ad hoc for this Mac.");
  }
}
