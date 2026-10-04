import { resolve } from "node:path";
const args = process.argv.slice(2).filter(arg => arg !== "--");
const cwd = resolve(import.meta.dir, "../apps/desktop");
const targets = process.platform === "darwin" ? "app" : process.platform === "linux" ? "deb" : "nsis";
const child = Bun.spawn([process.execPath, "x", "--no-install", "tauri", "build", ...(args.includes("--no-bundle") || args.some(arg => arg === "--bundles" || arg.startsWith("--bundles=")) ? [] : ["--bundles", targets]), ...args], {
  cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2" },
});
process.exitCode = await child.exited;
