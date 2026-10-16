import { createRequire } from "node:module";
import { resolve } from "node:path";
await import("./prepare-desktop.ts");
const electron = createRequire(import.meta.url)("electron") as string;
const args = process.argv.slice(2).filter(arg => arg !== "--");
const child = Bun.spawn([electron, resolve(import.meta.dir, "../apps/desktop/build/app"), ...args], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
});
process.exitCode = await child.exited;
