import { resolve } from "node:path";
import { ensureGraphicsRuntime, installSandboxHelper, verifyGraphicsRuntime } from "../apps/graphics/runtime.ts";
const root = resolve(import.meta.dir, "../apps/graphics");
try {
  const electron = await ensureGraphicsRuntime(root);
  if (process.argv.includes("--install-sandbox")) await installSandboxHelper(root, electron);
  if (process.argv.includes("--download-only")) {
    console.log("Graphics runtime downloaded. Desktop and sandbox startup have not been checked.");
  } else {
    await verifyGraphicsRuntime(root, electron);
    console.log("Graphics runtime verified: sandboxed renderer produced pixels. Run bun run graphics in Ghostty.");
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
