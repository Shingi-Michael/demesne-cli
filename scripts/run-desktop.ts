import { resolve } from "node:path";
const args = process.argv.slice(2).filter(arg => arg !== "--");
const child = Bun.spawn([process.execPath, "x", "--no-install", "tauri", "dev", ...(args.length ? ["--", ...args] : [])], {
  cwd: resolve(import.meta.dir, "../apps/desktop"), stdin: "inherit", stdout: "inherit", stderr: "inherit",
  env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2" },
});
process.exitCode = await child.exited;
