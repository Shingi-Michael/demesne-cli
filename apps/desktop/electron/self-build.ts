import { spawn, type ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join, sep } from "node:path";
import type { LookState } from "../workspace/self-build.ts";

/// Demesne rebuilds its own look (pass 80), the main process's part: it runs
/// the project's own scripts to rebuild the window's page into a trial
/// folder and serves the page from there, or builds the whole app and swaps
/// it in once Demesne quits.

/** Whether the open project is Demesne itself: `yes` when its package says
 *  so and it carries the script that builds the window's page, `behind`
 *  when the package says so but a checkout older than that script is open
 *  (Try it here has nothing to run), else `no`. */
export type DemesneProject = "yes" | "behind" | "no";
export function demesneProject(root: string): DemesneProject {
  let named = false;
  try { named = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.name === "demesne-cli"; } catch { return "no"; }
  if (!named) return "no";
  try { return statSync(join(root, "scripts/prepare-ui.ts")).isFile() ? "yes" : "behind"; } catch { return "behind"; }
}
export const isDemesneProject = (root: string) => demesneProject(root) === "yes";

/** Bun, which the project's scripts run under: DEMESNE_BUN, then the PATH,
 *  then where its installer and Homebrew put it (a Mac app started from the
 *  Dock has a short PATH). */
export function findBun(env: Record<string, string | undefined>, exists: (path: string) => boolean = existsSync, platform: string = process.platform): string | null {
  if (env.DEMESNE_BUN) return env.DEMESNE_BUN;
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const dirs = [...(env.PATH ?? "").split(delimiter), join(home, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean);
  for (const dir of dirs) { const candidate = join(dir, platform === "win32" ? "bun.exe" : "bun"); if (exists(candidate)) return candidate; }
  return null;
}

/** Where build-desktop.ts leaves the app: the Mac app bundle, or null on
 *  platforms Keep doesn't install for yet. */
export function builtApp(project: string, platform: string, arch: string): string | null {
  if (platform !== "darwin") return null;
  return join(project, "apps/desktop/release", arch === "arm64" ? "mac-arm64" : "mac", "Demesne.app");
}

/** The installed app bundle this process runs from, or null when it runs
 *  from source. */
export function installedBundle(exePath: string, platform: string = process.platform): string | null {
  if (platform !== "darwin") return null;
  const parts = exePath.split(sep), at = parts.findLastIndex((part) => part.endsWith(".app"));
  return at > 0 ? parts.slice(0, at + 1).join(sep) : null;
}

/** The shell lines that swap a kept build in once this process has gone:
 *  the old app to the Trash, the staged one in its place, and its daemon
 *  stopped so the new app starts its own. `open` starts the new app. */
export function swapScript(pid: number, staged: string, bundle: string, open: boolean): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`,
    `pkill -f ${q(`${bundle}/Contents/Resources/backend/demesned`)} 2>/dev/null`,
    `mv ${q(bundle)} "$HOME/.Trash/Demesne-$(date +%Y%m%d-%H%M%S).app" || exit 1`,
    `ditto ${q(staged)} ${q(bundle)} || exit 1`,
    `rm -rf ${q(staged)}`,
    ...(open ? [`open ${q(bundle)}`] : []),
    "",
  ].join("\n");
}

const UI_TIMEOUT = 120_000, APP_TIMEOUT = 15 * 60_000, LOAD_TIMEOUT = 20_000, TAIL = 4_000;

export class SelfBuild {
  state: LookState = { kind: "installed" };
  /// Where the page is served from while a trial look is on, else null.
  uiRoot: string | null = null;
  private staged: string | null = null;
  private loading: ReturnType<typeof setTimeout> | null = null;
  private firstError = "";
  private running: { kind: "ui" | "app"; kill: () => void } | null = null;
  private readonly looks: string;
  constructor(private readonly options: {
    userData: string; env: Record<string, string | undefined>; platform: string; arch: string; exePath: string; packaged: boolean;
    reload: () => void; emit: (state: LookState) => void; log: (message: string) => void;
  }) { this.looks = join(options.userData, "look"); }

  private set(state: LookState) { this.state = state; this.options.emit(state); }

  /** Runs one of the project's scripts under Bun and resolves with its last
   *  lines, or rejects with them. */
  private script(kind: "ui" | "app", project: string, args: string[], timeout: number): Promise<string> {
    const bun = findBun(this.options.env, existsSync, this.options.platform);
    if (!bun) return Promise.reject(new Error("Bun isn't installed where Demesne can find it. Install it from bun.sh, or set DEMESNE_BUN to its path."));
    return new Promise((resolve, reject) => {
      const path = [join(bun, ".."), this.options.env.PATH ?? ""].join(delimiter);
      const child = spawn(bun, args, { cwd: project, env: { ...this.options.env, PATH: path, ELECTRON_RUN_AS_NODE: undefined }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) as ChildProcess & EventEmitter;
      let out = "";
      const take = (bytes: Buffer) => { out = (out + String(bytes)).slice(-TAIL); };
      child.stdout!.on("data", take); child.stderr!.on("data", take);
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${args[0]} took longer than ${Math.round(timeout / 60_000)} minutes\n${out}`)); }, timeout);
      this.running = { kind, kill: () => child.kill() };
      child.on("error", (error: Error) => { clearTimeout(timer); this.running = null; reject(error); });
      child.on("exit", (code: number | null) => {
        clearTimeout(timer); this.running = null;
        if (code === 0) resolve(out.trim()); else reject(new Error(out.trim() || `${args[0]} exited with ${code}`));
      });
    });
  }

  /** Try it here: the window's page from the project, in this window. */
  async try(project: string) {
    if (!isDemesneProject(project)) throw new Error("This project isn't Demesne");
    if (this.running) return this.state;
    this.set({ kind: "building", project });
    this.options.log(`Try it here: building the page from ${project}`);
    const dir = join(this.looks, String(Date.now()));
    try {
      mkdirSync(dir, { recursive: true });
      await this.script("ui", project, ["scripts/prepare-ui.ts", "--out", join(dir, "ui")], UI_TIMEOUT);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      this.options.log(`The page didn't build: ${(error as Error).message}`);
      this.set({ kind: "broken", project, why: (error as Error).message });
      return this.state;
    }
    const previous = this.uiRoot;
    this.uiRoot = join(dir, "ui");
    this.firstError = "";
    this.watch(() => { this.revert(project, this.firstError ? `The page stopped with an error:\n${this.firstError}` : "The page didn't start within 20 seconds"); });
    this.options.reload();
    if (previous) rmSync(join(previous, ".."), { recursive: true, force: true });
    return this.state;
  }

  /// The page says it started: the trial look is on.
  loaded() {
    if (!this.loading) return;
    clearTimeout(this.loading); this.loading = null;
    const project = "project" in this.state ? this.state.project : "";
    if (this.state.kind === "building") { this.options.log("The trial look is on"); this.set({ kind: "trial", project, keep: this.canKeep() }); }
  }
  /// The page failed to load, or reported an error while starting.
  failed(message: string) {
    if (!this.loading) return;
    this.firstError ||= message;
    if (/fail/i.test(message)) this.revert("project" in this.state ? this.state.project : "", message);
  }
  private watch(onTimeout: () => void) {
    if (this.loading) clearTimeout(this.loading);
    this.loading = setTimeout(() => { this.loading = null; onTimeout(); }, LOAD_TIMEOUT);
  }
  private revert(project: string, why: string) {
    if (this.loading) { clearTimeout(this.loading); this.loading = null; }
    const trial = this.uiRoot;
    this.uiRoot = null;
    if (trial) rmSync(join(trial, ".."), { recursive: true, force: true });
    this.options.log(`The trial look went back: ${why}`);
    this.set({ kind: "broken", project, why });
    this.options.reload();
  }

  /** Go back: the installed look, now. */
  back() {
    const trial = this.uiRoot;
    this.options.log(trial ? "Go back: the installed look" : "Go back: nothing to go back from");
    this.uiRoot = null;
    if (this.loading) { clearTimeout(this.loading); this.loading = null; }
    if (trial) rmSync(join(trial, ".."), { recursive: true, force: true });
    if (this.state.kind !== "kept" && this.state.kind !== "keeping") this.set({ kind: "installed" });
    this.options.reload();
    return this.state;
  }

  /// Keep can install only over an installed Mac app.
  canKeep() { return this.options.packaged && builtApp("", this.options.platform, this.options.arch) !== null && installedBundle(this.options.exePath, this.options.platform) !== null; }

  /** Keep: build the app from the project and stage it; it replaces the
   *  installed app when Demesne quits. */
  async keep(project: string) {
    if (!isDemesneProject(project)) throw new Error("This project isn't Demesne");
    if (this.running) return this.state;
    if (!this.canKeep()) { this.set({ kind: "failed", project, why: "Keep installs over the Mac app. You're running Demesne from source, so build and open it from there." }); return this.state; }
    this.set({ kind: "keeping", project });
    this.options.log(`Keep: building the app from ${project}`);
    try {
      await this.script("app", project, ["scripts/build-desktop.ts"], APP_TIMEOUT);
      const built = builtApp(project, this.options.platform, this.options.arch)!;
      if (!existsSync(built)) throw new Error(`The build finished but left no app at ${built}`);
      const staged = join(this.looks, "keep", "Demesne.app");
      rmSync(join(this.looks, "keep"), { recursive: true, force: true }); mkdirSync(join(this.looks, "keep"), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const copy = spawn("ditto", [built, staged], { stdio: "ignore" }) as ChildProcess & EventEmitter;
        copy.once("error", reject);
        copy.once("exit", (code: number | null) => { if (code === 0) resolve(); else reject(new Error(`Staging the app failed (${code})`)); });
      });
      this.staged = staged;
      this.options.log(`Kept: the app is staged at ${staged}`);
      this.set({ kind: "kept", project });
    } catch (error) {
      this.options.log(`The app didn't build: ${(error as Error).message}`);
      this.set({ kind: "failed", project, why: (error as Error).message });
    }
    return this.state;
  }

  /** At quit: the staged app, if any, takes the installed one's place once
   *  this process is gone. `open` starts it again (Restart). */
  swapOnExit(open: boolean) {
    const bundle = installedBundle(this.options.exePath, this.options.platform);
    if (!this.staged || !bundle) { this.cleanup(); return false; }
    const script = join(this.looks, "swap.sh");
    writeFileSync(script, swapScript(process.pid, this.staged, bundle, open), { mode: 0o755 });
    spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
    if (this.uiRoot) rmSync(join(this.uiRoot, ".."), { recursive: true, force: true });
    return true;
  }
  /// Trial folders go when the app does.
  cleanup() { this.running?.kill(); rmSync(this.looks, { recursive: true, force: true }); }
}
