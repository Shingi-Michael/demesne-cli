import { existsSync } from "node:fs";
import { join } from "node:path";

/// Apple silicon kills a program whose signature doesn't match its contents:
/// the backend exits with SIGKILL the moment the app starts it, and the window
/// says "Desktop backend exited (SIGKILL)". Bun's compiled backends can come
/// out with a stale linker signature, so every place that makes them signs
/// them ad hoc and checks the signature before the build counts as done.
export const BACKENDS = ["demesne-host", "demesne-desktop-host", "demesned"] as const;

export async function codesign(args: string[]) {
  const run = Bun.spawn(["codesign", ...args], { stdout: "ignore", stderr: "pipe" });
  if (await run.exited !== 0) throw new Error(`codesign ${args.join(" ")} failed: ${(await new Response(run.stderr).text()).trim()}`);
}

/// Signs the named programs in a folder ad hoc and verifies each; does nothing off macOS.
export async function signBackends(folder: string, names: readonly string[] = BACKENDS) {
  if (process.platform !== "darwin") return;
  for (const name of names) {
    const file = join(folder, name);
    if (!existsSync(file)) throw new Error(`${folder} is missing ${name}`);
    await codesign(["--force", "--sign", "-", file]);
    await codesign(["--verify", "--strict", file]);
  }
}
