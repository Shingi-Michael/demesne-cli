import { existsSync } from "node:fs";
import { join } from "node:path";

/// Apple silicon kills a program whose signature doesn't match its contents:
/// the backend exits with SIGKILL the moment the app starts it, and the window
/// says "Desktop backend exited (SIGKILL)". Bun's compiled backends can come
/// out with a stale linker signature, so every place that makes them signs
/// them and checks the signature before the build counts as done.
export const BACKENDS = ["demesne-host", "demesne-desktop-host", "demesned"] as const;

/// Who signs. Releases set DEMESNE_SIGN_IDENTITY to the project's own
/// self-signed certificate (its SHA-1, see docs/macos-release-signing.md),
/// and DEMESNE_SIGN_KEYCHAIN to the keychain holding it. macOS then knows
/// every release as the same app, so permissions such as Screen Recording
/// survive updates. Without it, "-" signs ad hoc: fine for this Mac, but
/// each build is a new app to macOS and its permissions start over.
export function signWith(): string[] {
  const identity = process.env.DEMESNE_SIGN_IDENTITY?.trim();
  if (!identity) return ["--sign", "-"];
  const keychain = process.env.DEMESNE_SIGN_KEYCHAIN?.trim();
  return ["--sign", identity, ...(keychain ? ["--keychain", keychain] : [])];
}

export async function codesign(args: string[]) {
  const run = Bun.spawn(["codesign", ...args], { stdout: "ignore", stderr: "pipe" });
  if (await run.exited !== 0) throw new Error(`codesign ${args.join(" ")} failed: ${(await new Response(run.stderr).text()).trim()}`);
}

/// Signs the named programs in a folder (signWith) and verifies each; does nothing off macOS.
export async function signBackends(folder: string, names: readonly string[] = BACKENDS) {
  if (process.platform !== "darwin") return;
  for (const name of names) {
    const file = join(folder, name);
    if (!existsSync(file)) throw new Error(`${folder} is missing ${name}`);
    await codesign(["--force", ...signWith(), file]);
    await codesign(["--verify", "--strict", file]);
  }
}
