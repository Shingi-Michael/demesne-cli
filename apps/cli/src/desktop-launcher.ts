import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/// `demesne` in a terminal opens the desktop window on this project. The app
/// is found where it was installed or built; from a checkout without a build,
/// `bun run desktop` builds and runs it (that needs Rust).

export interface DesktopLaunch { argv: string[]; detached: boolean; cwd?: string }
export interface DesktopProbe {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  which: (command: string) => string | null;
  home: string;
  source: string;
  bun: string;
}

const realProbe = (): DesktopProbe => ({
  platform: process.platform, env: process.env, exists: existsSync, which: (command) => Bun.which(command), home: homedir(),
  source: resolve(import.meta.dir, "../../.."), bun: process.execPath,
});

/// `demesne [message] [--model id] [--session id] [--workspace path] [--setup]`
/// as the desktop's `--key=value` launch options. Words become the opening message.
export function desktopArgs(command: string[], options: { cwd: string; server?: string }): string[] {
  const out: string[] = [], words: string[] = [];
  let workspace: string | undefined;
  for (let index = 0; index < command.length; index++) {
    const arg = command[index]!;
    if (arg === "--setup") { out.push(arg); continue; }
    const inline = /^--(session|workspace|model)=(.*)$/.exec(arg);
    const key = inline?.[1] ?? (["--session", "--workspace", "--model"].includes(arg) ? arg.slice(2) : null);
    if (key) {
      const value = inline ? inline[2] : command[++index];
      if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
      if (key === "workspace") workspace = value;
      else out.push(`--${key}=${value}`);
    } else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}. Run demesne --help.`);
    else words.push(arg);
  }
  const prompt = words.join(" ").trim();
  return [`--workspace=${resolve(options.cwd, workspace ?? ".")}`, ...(options.server ? [`--server=${options.server}`] : []), ...out, ...(prompt ? [`--prompt=${prompt}`] : [])];
}

/// How to open the desktop app with these options, or null when it isn't installed or built.
export function desktopLaunch(args: string[], probe: DesktopProbe = realProbe()): DesktopLaunch | null {
  const explicit = probe.env.DEMESNE_DESKTOP_BIN;
  if (explicit) return { argv: [explicit, ...args], detached: true };
  if (probe.platform === "darwin") {
    const app = [join("/Applications", "Demesne.app"), join(probe.home, "Applications", "Demesne.app")].find(probe.exists);
    if (app) return { argv: ["open", "-n", "-a", app, "--args", ...args], detached: false };
  }
  const installed = probe.which("demesne-desktop");
  if (installed) return { argv: [installed, ...args], detached: true };
  const target = join(probe.source, "apps", "desktop", "src-tauri", "target");
  const built = ["release", "debug"].map((profile) => join(target, profile, "demesne-desktop")).find(probe.exists);
  if (built) return { argv: [built, ...args], detached: true };
  // A checkout with Rust: build and run it (the first build takes a while).
  if (probe.exists(join(probe.source, "scripts", "run-desktop.ts")) && probe.which("cargo"))
    return { argv: [probe.bun, join(probe.source, "scripts", "run-desktop.ts"), "--", ...args], detached: false, cwd: probe.source };
  return null;
}

export async function runDesktop(args: string[]): Promise<number> {
  const launch = desktopLaunch(args);
  if (!launch) throw new Error("The demesne desktop app isn't installed. Build it with `bun run build:desktop` (needs Rust; see docs/desktop.md), or use `demesne prompt` in the terminal.");
  if (launch.detached) {
    // The window outlives this command; its daemon work outlives both.
    const child = Bun.spawn(launch.argv, { cwd: launch.cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env });
    child.unref();
    return 0;
  }
  const child = Bun.spawn(launch.argv, { cwd: launch.cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
  return await child.exited;
}
