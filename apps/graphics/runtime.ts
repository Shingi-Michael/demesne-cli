import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export const RUNTIME_READY = "DEMESNE_GRAPHICS_READY";
export function runtimeSuffix(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : platform === "win32" ? "electron.exe" : "electron";
}

/** Preserve desktop authentication without forwarding provider credentials to Electron. */
export function graphicsEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries([
    "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
    "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE", "DEMESNE_GRAPHICS_TRACE", "DEMESNE_GRAPHICS_GPU",
  ].flatMap(key => env[key] ? [[key, env[key]!]] : []));
}

export function linuxSessionProblem(env: NodeJS.ProcessEnv, uid: number | undefined): string | undefined {
  if (uid === 0) return "Run Demesne as your normal user, not with sudo. Only the optional sandbox-helper installation needs administrator access.";
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return "No Linux graphical session is available. Run inside Ghostty on a desktop with DISPLAY or WAYLAND_DISPLAY set. For an SSH/headless session, use demesne prompt instead.";
}

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function graphicsStartupProblem(log: string, electron: string, root: string): string {
  const helper = join(dirname(electron), "chrome-sandbox");
  if (/SUID sandbox|No usable sandbox|setuid sandbox|Failed to move to new namespace|namespace.*[Pp]ermission|Operation not permitted.*namespace/i.test(log)) {
    return `Electron's Linux sandbox could not start.\nSandbox helper: ${helper}\n` +
      `From this source checkout, run: bun run graphics:setup --install-sandbox\n` +
      `For a packaged installation, run: ${shellQuote(join(root, "host"))} --install-sandbox\n` +
      "This asks for administrator access to install a verified copy of this helper in /usr/local/lib/demesne/sandbox, then links this runtime to it. It does not run Demesne as root.\n" +
      "If a container or host policy forbids sandbox namespaces, its administrator must allow them; changing file permissions alone cannot override that policy.\n" +
      `This is separate from workspace directory permissions. Chromium reported:\n${log.slice(-2500)}`;
  }
  const library = /error while loading shared libraries:\s*([^:\s]+)/.exec(log)?.[1];
  if (library) return `Electron is missing a Linux system library: ${library}.\nInstall the desktop runtime dependencies listed in docs/linux.md, then run bun run graphics again.\n${log.slice(-1500)}`;
  if (/Missing X server|cannot open display|Failed to connect to.*display|Authorization required|ozone_platform.*failed/i.test(log)) {
    return `Electron cannot connect to the Linux desktop. Start Demesne from Ghostty in your logged-in desktop session; verify DISPLAY/WAYLAND_DISPLAY and XAUTHORITY.\n${log.slice(-1500)}`;
  }
  return `Electron could not render its startup check.\nRuntime: ${electron}\n${log.slice(-3000) || "No diagnostic output was returned."}`;
}

/** Downloads only a missing source runtime; packaged installations remain self-contained. */
export async function ensureGraphicsRuntime(root: string): Promise<string> {
  const suffix = runtimeSuffix();
  const packaged = join(root, "runtime", suffix);
  if (existsSync(packaged)) return packaged;
  if (!existsSync(join(root, "live.ts"))) {
    throw new Error(`The packaged graphics runtime is missing: ${packaged}. Reinstall the complete graphics bundle.`);
  }
  let electronRoot: string;
  try { electronRoot = dirname(Bun.resolveSync("electron", root)); }
  catch { throw new Error("Graphics dependencies are missing. Run bun install --frozen-lockfile from the repository root, then bun run graphics."); }
  const electron = join(electronRoot, "dist", suffix);
  if (!existsSync(electron)) {
    console.error("Installing Demesne's Electron runtime…");
    const child = Bun.spawn([process.execPath, join(electronRoot, "install.js")], {
      cwd: electronRoot, stdout: "inherit", stderr: "inherit",
    });
    const timer = setTimeout(() => child.kill(), 180000);
    try {
      if (await child.exited !== 0 || !existsSync(electron)) throw new Error("Electron installation failed. Check network access and retry bun run graphics:setup.");
    } finally { clearTimeout(timer); }
  }
  return electron;
}

/** Run before entering raw terminal mode. A binary on disk is not a working runtime. */
export async function verifyGraphicsRuntime(root: string, electron: string, env = graphicsEnvironment()): Promise<void> {
  if (process.platform === "linux") {
    const problem = linuxSessionProblem(env, process.getuid?.());
    if (problem) throw new Error(problem);
  }
  const cache = mkdtempSync(join(tmpdir(), "demesne-runtime-check-"));
  try {
    const child = Bun.spawn([electron, join(root, "runtime-probe.cjs")], {
      env: { ...env, DEMESNE_PIXEL_CACHE: cache }, stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0 || !stdout.split(/\r?\n/).includes(RUNTIME_READY)) {
        throw new Error(graphicsStartupProblem(stderr || stdout, electron, root));
      }
    } finally { clearTimeout(timer); }
  } finally { rmSync(cache, { recursive: true, force: true }); }
}

/** Explicit opt-in. Never elevates Bun or the app, and never chmods the workspace. */
export async function installSandboxHelper(root: string, electron: string): Promise<void> {
  if (process.platform !== "linux") throw new Error("Sandbox-helper installation applies only to Linux.");
  if (process.getuid?.() === 0) throw new Error("Run graphics:setup --install-sandbox as your normal user; it requests sudo only for the helper copy.");
  const helper = join(dirname(electron), "chrome-sandbox");
  if (!existsSync(helper) || !statSync(helper).isFile()) throw new Error(`Missing sandbox helper: ${helper}. Reinstall the Electron runtime.`);
  const hash = createHash("sha256").update(readFileSync(helper)).digest("hex");
  const destination = `/usr/local/lib/demesne/sandbox/${hash}/chrome-sandbox`;
  const script = readFileSync(join(root, "install-sandbox.sh"), "utf8");
  console.error(`Install Electron's sandbox helper at ${destination}.\nAdministrator access is used only for this verified helper copy; the app stays unprivileged.`);
  const child = Bun.spawn(["sudo", "--", "/bin/sh", "-c", script, "demesne-sandbox-install", resolve(helper), hash], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  if (await child.exited !== 0) throw new Error("Sandbox installation failed or was cancelled. No sandbox bypass was enabled.");
  // Verify the elevated operation before connecting our user-owned runtime to it.
  const installed = lstatSync(destination);
  if (!installed.isFile() || installed.uid !== 0 || (installed.mode & 0o7777) !== 0o4755 ||
      createHash("sha256").update(readFileSync(destination)).digest("hex") !== hash) {
    throw new Error("Installed sandbox helper failed verification.");
  }
  if (realpathSync(helper) !== destination) {
    const temporary = `${helper}.${randomUUID()}.link`;
    try { symlinkSync(destination, temporary); renameSync(temporary, helper); }
    catch (error) { throw new Error(`The helper was installed, but this runtime is not writable: ${helper}. Ask the package administrator to link it to ${destination}.`, { cause: error }); }
    finally { rmSync(temporary, { force: true }); }
  }
}
