/// "Changed, not running yet" (pass 115): when a chat changes Demesne's own
/// source, the turn says whether the app you're in runs that change, and on
/// a Mac builds it and reopens in one click. Only ever on that click, only
/// once nothing works, and only from a folder that has everything the app
/// you're running has (never an older checkout over a newer app).
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

/// The app's build id is "<commit>.<build time in base 36>".
export function buildParts(id: string): { commit: string; at: number } | null {
  const match = /^([0-9a-f]{7,40})\.([0-9a-z]+)$/.exec(id);
  if (!match) return null;
  const at = parseInt(match[2]!, 36);
  return Number.isFinite(at) ? { commit: match[1]!, at } : null;
}

/// Demesne's own source: the root package is "demesne" and it has the app.
export function isDemesneSource(root: string): boolean {
  try { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name === "demesne" && existsSync(join(root, "apps/desktop/electron/main.ts")); }
  catch { return false; }
}

/// The installed Mac app this host runs from (…/Demesne.app/Contents/Resources/backend/demesne-host).
export function appBundle(execPath: string): string | null {
  const match = /^(.*\.app)\/Contents\/Resources\/backend\/[^/]+$/.exec(execPath);
  return match ? match[1]! : null;
}

/// Bun, which a Mac app started from the Dock doesn't find on its PATH.
export function findBun(home: string, path = process.env.PATH ?? ""): string | null {
  const places = [...path.split(":").filter(Boolean).map((dir) => join(dir, "bun")), join(home, ".bun/bin/bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"];
  return places.find((place) => existsSync(place)) ?? null;
}

/// Whether the folder holds the commit the app was built from: a folder
/// behind the app would build something older than what you're running.
export function holdsCommit(root: string, commit: string): boolean {
  return spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: root, stdio: "ignore" }).status === 0;
}

/// The app electron-builder made, newest first (release/mac-arm64, release/mac…).
export function builtApp(root: string): string | null {
  const release = join(root, "apps/desktop/release");
  try {
    const found = readdirSync(release).filter((dir) => dir.startsWith("mac")).map((dir) => join(release, dir, "Demesne.app")).filter((app) => existsSync(app));
    return found[0] ?? null;
  } catch { return null; }
}

/// Waits for the app to quit, keeps the old one beside it, puts the new one
/// in its place and opens it.
export function swapScript(pid: number, installed: string, built: string, keep: string): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`,
    `rm -rf ${q(keep)}`,
    // The old app is only ever moved aside; a failed copy puts it back.
    `mv ${q(installed)} ${q(keep)} || { open ${q(installed)}; exit 1; }`,
    `cp -R ${q(built)} ${q(installed)} || { rm -rf ${q(installed)}; mv ${q(keep)} ${q(installed)}; }`,
    `open ${q(installed)}`,
  ].join("\n") + "\n";
}

export interface SelfBuild { app: string; builtAt: number | null; source: boolean; behind: boolean; can: boolean; state: "idle" | "building" | "ready" | "failed"; error: string | null }

/// One rebuild at a time, from the chat's folder.
export class SelfBuilder {
  state: SelfBuild["state"] = "idle";
  error: string | null = null;
  private sources = new Map<string, { source: boolean; behind: boolean; at: number }>();
  constructor(private readonly options: { app: string; execPath: string; home: string; logDir: () => string; platform: string; changed: () => void }) {}

  view(root: string | null): SelfBuild {
    const app = this.options.app, parts = buildParts(app);
    let known = root ? this.sources.get(root) : undefined;
    // Asked again after a minute: a pull can bring the folder level with the app.
    if (root && (!known || Date.now() - known.at > 60_000)) {
      const source = isDemesneSource(root);
      known = { source, behind: source && parts ? !holdsCommit(root, parts.commit) : false, at: Date.now() };
      this.sources.set(root, known);
    }
    const can = Boolean(known?.source && !known.behind && parts && this.options.platform === "darwin" && appBundle(this.options.execPath));
    return { app, builtAt: parts?.at ?? null, source: Boolean(known?.source && parts), behind: Boolean(known?.behind), can, state: this.state, error: this.error };
  }

  /// Builds the app in the folder; resolves once the new app is ready to swap in.
  async build(root: string): Promise<void> {
    const view = this.view(root);
    if (!view.can) throw new Error(view.behind ? "This folder is behind the app you're running" : "Rebuilding is only for Demesne's own source on a Mac");
    if (this.state === "building") return;
    const bun = findBun(this.options.home);
    if (!bun) throw new Error("Bun isn't installed, so Demesne can't build itself");
    this.state = "building"; this.error = null; this.options.changed();
    const logDir = this.options.logDir();
    mkdirSync(logDir, { recursive: true });
    const log = openSync(join(logDir, "rebuild.log"), "w");
    const run = async (args: string[]) => {
      const child = Bun.spawn([bun, ...args], { cwd: root, stdin: "ignore", stdout: log, stderr: log, env: { ...process.env, PATH: `${dirname(bun)}:${process.env.PATH ?? ""}` } });
      const code = await child.exited;
      if (code !== 0) throw new Error(`bun ${args.join(" ")} failed (${code}); see rebuild.log`);
    };
    try {
      if (!existsSync(join(root, "node_modules"))) await run(["install"]);
      await run(["run", "build:desktop"]);
      if (!builtApp(root)) throw new Error("The build made no Demesne.app");
      this.state = "ready";
    } catch (error) {
      this.state = "failed"; this.error = error instanceof Error ? error.message : String(error);
    }
    this.options.changed();
  }

  /// Hands the swap to a script that runs once the app has quit; the caller quits.
  swap(root: string, pid: number): void {
    const installed = appBundle(this.options.execPath), built = builtApp(root);
    if (this.state !== "ready" || !installed || !built) throw new Error("There's no new build to open");
    const script = join(this.options.logDir(), "rebuild-swap.sh");
    writeFileSync(script, swapScript(pid, installed, built, `${installed.replace(/\.app$/, "")}.app.prev`), { mode: 0o755 });
    spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
  }
}
