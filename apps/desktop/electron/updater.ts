/// Updates without a rebuild (pass 153 A). Every merge to main publishes a
/// GitHub release with each computer's app. A release build looks for the
/// newest one every few hours, downloads it in the background, checks it
/// against its published checksum and unpacks it beside the app. It swaps in
/// when you press Restart, or the next time the app opens: a small script
/// waits for this app to exit, moves it aside as the backup, moves the new one
/// in and opens it, and if the new one never says it started, puts the old
/// one back. Builds made from source are left alone.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const UPDATE_REPO = "Shingi-Michael/demesne-cli";
/// The first look a little after starting, then every few hours.
export const FIRST_CHECK_MS = 60_000;
export const CHECK_EVERY_MS = 4 * 60 * 60_000;
/// How long the new app has to say it started before the old one comes back.
export const START_WAIT_S = 90;

export type InstallKind = "mac" | "linux-portable" | "linux-deb" | "windows";
export interface Install { kind: InstallKind; root: string }
export type UpdateStatus =
  | { state: "off"; why: string }
  | { state: "idle"; version: string; enabled: boolean; checked?: number }
  | { state: "downloading"; version: string; to: string; progress: number; enabled: true }
  | { state: "ready"; version: string; to: string; enabled: true; waiting?: boolean }
  | { state: "failed"; version: string; to?: string; error: string; enabled: boolean };

/// Where this copy of the app is installed, and how it is swapped, or null
/// for a computer no release is built for.
export function installFor(platform: string, arch: string, execPath: string): Install | null {
  if (platform === "darwin" && arch === "arm64") {
    const app = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1];
    return app ? { kind: "mac", root: app } : null;
  }
  if (platform === "linux" && arch === "x64") {
    if (execPath.startsWith("/opt/Demesne/")) return { kind: "linux-deb", root: "/opt/Demesne" };
    return { kind: "linux-portable", root: dirname(execPath) };
  }
  if (platform === "win32" && arch === "x64") return { kind: "windows", root: dirname(execPath) };
  return null;
}

export const ASSETS: Record<InstallKind, string> = {
  "mac": "demesne-darwin-arm64.zip",
  "linux-portable": "demesne-linux-x64.tar.gz",
  "linux-deb": "demesne-linux-amd64.deb",
  "windows": "demesne-windows-x64.exe",
};

/// a > b for plain x.y.z versions (a leading v allowed); anything else is not newer.
export function newerVersion(a: string, b: string): boolean {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())?.slice(1).map(Number);
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

export interface ReleaseAsset { version: string; url: string; checksumUrl: string; size: number }
/// The newest release's file for this computer, when it is newer than ours.
/// Only the repository's own download links count.
export function pickRelease(release: unknown, kind: InstallKind, current: string): ReleaseAsset | null {
  if (!release || typeof release !== "object") return null;
  const { tag_name, draft, prerelease, assets } = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (typeof tag_name !== "string" || draft === true || prerelease === true || !Array.isArray(assets)) return null;
  const version = tag_name.replace(/^v/, "");
  if (!newerVersion(version, current)) return null;
  const prefix = `https://github.com/${UPDATE_REPO}/releases/download/${tag_name}/`;
  const find = (name: string) => assets.find((item): item is { name: string; browser_download_url: string; size?: number } =>
    Boolean(item) && typeof item === "object" && (item as { name?: unknown }).name === name
    && typeof (item as { browser_download_url?: unknown }).browser_download_url === "string"
    && (item as { browser_download_url: string }).browser_download_url.toLowerCase() === (prefix + name).toLowerCase());
  const file = find(ASSETS[kind]), sum = find(`${ASSETS[kind]}.sha256`);
  if (!file || !sum) return null;
  return { version, url: file.browser_download_url, checksumUrl: sum.browser_download_url, size: typeof file.size === "number" ? file.size : 0 };
}

/// The hash from a `sha256sum`-style line.
export function parseChecksum(text: string): string | null {
  return /^([0-9a-f]{64})\b/i.exec(text.trim())?.[1]?.toLowerCase() ?? null;
}

/// What a staged download must hold before it may replace the app.
export function stagedEntry(kind: InstallKind, dir: string): { path: string; needs: string[] } {
  if (kind === "mac") {
    const app = join(dir, "Demesne.app"), backend = join(app, "Contents", "Resources", "backend");
    return { path: app, needs: [join(app, "Contents", "MacOS", "Demesne"), join(backend, "demesned"), join(backend, "demesne-host"), join(backend, "demesne-desktop-host")] };
  }
  if (kind === "linux-portable") {
    const app = join(dir, "demesne"), backend = join(app, "resources", "backend");
    return { path: app, needs: [join(app, "demesne"), join(backend, "demesned"), join(backend, "demesne-host"), join(backend, "demesne-desktop-host")] };
  }
  return { path: join(dir, ASSETS[kind]), needs: [join(dir, ASSETS[kind])] };
}

const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/// The script that swaps the app once this one has exited (Mac and Linux).
/// It waits for `pid`, keeps the old app as `<root>.prev` (only the newest
/// backup), moves the new one in, opens it, and waits for `started` to name
/// the new version; if it never does, the old app comes back and opens.
export function swapScript(options: { kind: InstallKind; pid: number; root: string; staged: string; version: string; started: string; failed: string; relaunch: string[] }): string {
  const { kind, pid, root, staged, version, started, failed } = options;
  const prev = `${root}.prev`, launch = options.relaunch.map(q).join(" ");
  const open = kind === "mac" ? `open ${q(root)}` : `(${launch} >/dev/null 2>&1 &)`;
  const install = kind === "linux-deb"
    ? `pkexec dpkg -i ${q(staged)} || { echo ${q(version)} > ${q(failed)}; ${open}; exit 1; }`
    : [`rm -rf ${q(prev)}`, `mv ${q(root)} ${q(prev)} || { ${open}; exit 1; }`,
      `if ! mv ${q(staged)} ${q(root)}; then mv ${q(prev)} ${q(root)}; echo ${q(version)} > ${q(failed)}; ${open}; exit 1; fi`,
      ...(kind === "mac" ? [`xattr -dr com.apple.quarantine ${q(root)} 2>/dev/null`] : [])].join("\n");
  const rollback = kind === "linux-deb" ? "" : [
    `pkill -f ${q(kind === "mac" ? `${root}/Contents/MacOS/` : `${root}/demesne`)} 2>/dev/null; sleep 1`,
    `rm -rf ${q(root)}; mv ${q(prev)} ${q(root)}`,
  ].join("\n");
  return [
    "#!/bin/sh",
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done`,
    `rm -f ${q(started)}`,
    install,
    open,
    `i=0; while [ $i -lt ${START_WAIT_S * 2} ]; do grep -qx ${q(version)} ${q(started)} 2>/dev/null && exit 0; sleep 0.5; i=$((i+1)); done`,
    `echo ${q(version)} > ${q(failed)}`,
    rollback,
    rollback ? open : "",
  ].filter(Boolean).join("\n") + "\n";
}

export interface UpdaterOptions {
  install: Install | null;
  current: string;
  /// Only release builds update themselves.
  release: boolean;
  dir: string;
  pid: number;
  relaunch: string[];
  fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
  emit: (status: UpdateStatus) => void;
  log: (message: string) => void;
  quit: () => void;
  run?: (command: string, args: string[]) => Promise<void>;
  spawnDetached?: (command: string, args: string[]) => void;
  now?: () => number;
}

function defaultRun(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
function defaultSpawnDetached(command: string, args: string[]): void {
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

export class Updater {
  status: UpdateStatus;
  private busy = false;
  private restartWhenIdle = false;
  private checking = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private options: UpdaterOptions) {
    this.status = this.initial();
  }
  private get settingsFile() { return join(this.options.dir, "settings.json"); }
  private get readyFile() { return join(this.options.dir, "ready.json"); }
  get startedFile() { return join(this.options.dir, "started"); }
  get failedFile() { return join(this.options.dir, "failed"); }
  get enabled(): boolean {
    try { return JSON.parse(readFileSync(this.settingsFile, "utf8")).off !== true; } catch { return true; }
  }
  private initial(): UpdateStatus {
    const { install, release, current } = this.options;
    if (!release) return { state: "off", why: "built from source" };
    if (!install) return { state: "off", why: "no release for this computer" };
    if (install.kind !== "linux-deb" && install.kind !== "windows") {
      try { accessSync(dirname(install.root), constants.W_OK); } catch { return { state: "off", why: `can't write beside ${install.root}` }; }
    }
    return { state: "idle", version: current, enabled: this.enabled };
  }
  private set(status: UpdateStatus) { this.status = status; this.options.emit(status); }

  /// Before the window opens: a download that finished last time goes in
  /// now, the next time the app opens. True when it is being put in place.
  applyPending(): boolean {
    const { current } = this.options;
    if (this.status.state === "off" || !this.enabled) return false;
    const ready = this.readReady();
    if (!ready || !newerVersion(ready.version, current) || this.failedVersion() === ready.version || !existsSync(stagedEntry(ready.kind, ready.dir).path)) return false;
    this.status = { state: "ready", version: current, to: ready.version, enabled: true };
    this.options.log(`Update: ${ready.version} was waiting, putting it in place now.`);
    return this.apply();
  }
  /// Once the window has loaded: tells a waiting swap script that this
  /// version started, and says so if the last update had to be undone.
  started() {
    const { current, dir } = this.options;
    try { mkdirSync(dir, { recursive: true }); writeFileSync(this.startedFile, `${current}\n`); } catch {}
    if (this.status.state === "off") return;
    const ready = this.readReady(), failed = this.failedVersion();
    if (failed && ready?.version === failed) {
      this.set({ state: "failed", version: current, to: failed, error: `${failed} didn't start, so ${current} came back`, enabled: this.enabled });
      this.options.log(`Update: ${failed} didn't start; staying on ${current}.`);
    } else if (ready && newerVersion(ready.version, current) && existsSync(stagedEntry(ready.kind, ready.dir).path)) {
      this.set({ state: "ready", version: current, to: ready.version, enabled: true });
    } else if (ready) this.clean();
  }
  private failedVersion(): string | null {
    try { return readFileSync(this.failedFile, "utf8").trim() || null; } catch { return null; }
  }
  schedule() {
    if (this.status.state === "off") return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.check().finally(() => this.schedule()); }, this.status.state === "idle" && !this.status.checked ? FIRST_CHECK_MS : CHECK_EVERY_MS);
    this.timer.unref?.();
  }
  stop() { clearTimeout(this.timer); }

  setEnabled(on: boolean) {
    if (this.status.state === "off") return this.status;
    try { mkdirSync(this.options.dir, { recursive: true }); writeFileSync(this.settingsFile, JSON.stringify({ off: !on }) + "\n"); } catch {}
    if (!on) { this.clean(); this.set({ state: "idle", version: this.options.current, enabled: false }); this.stop(); }
    else { this.set({ state: "idle", version: this.options.current, enabled: true }); void this.check(); this.schedule(); }
    return this.status;
  }

  /// Something works (a chat, Drive): a restart waits for it to finish.
  setBusy(on: boolean) {
    this.busy = on;
    if (!on && this.restartWhenIdle) { this.restartWhenIdle = false; this.restart(); }
  }
  restart(): UpdateStatus {
    if (this.status.state !== "ready") return this.status;
    if (this.busy) {
      this.restartWhenIdle = true;
      this.set({ ...this.status, waiting: true });
      return this.status;
    }
    this.apply();
    return this.status;
  }

  async check(): Promise<UpdateStatus> {
    const { install, current } = this.options;
    if (this.status.state === "off" || !install || this.checking || !this.enabled) return this.status;
    if (this.status.state === "ready" || this.status.state === "downloading") return this.status;
    this.checking = true;
    try {
      const response = await this.options.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Demesne" } });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const found = pickRelease(await response.json(), install.kind, current);
      if (!found || found.version === this.failedVersion()) { this.set({ state: "idle", version: current, enabled: true, checked: this.options.now?.() ?? Date.now() }); return this.status; }
      await this.download(found);
    } catch (error) {
      this.options.log(`Update check failed: ${String(error)}`);
      // A failed look is quiet: the next one tries again.
      this.set({ state: "idle", version: current, enabled: true, checked: this.options.now?.() ?? Date.now() });
    } finally { this.checking = false; }
    return this.status;
  }

  private async download(found: ReleaseAsset) {
    const { install, current, dir } = this.options;
    const kind = install!.kind, stage = join(dir, found.version);
    this.clean();
    mkdirSync(stage, { recursive: true });
    this.set({ state: "downloading", version: current, to: found.version, progress: 0, enabled: true });
    this.options.log(`Update: downloading ${found.version} (${ASSETS[kind]}).`);
    const sumResponse = await this.options.fetch(found.checksumUrl, { headers: { "User-Agent": "Demesne" } });
    const want = sumResponse.ok ? parseChecksum(await sumResponse.text()) : null;
    if (!want) throw new Error("the release has no checksum");
    const file = join(stage, ASSETS[kind]);
    const response = await this.options.fetch(found.url, { headers: { "User-Agent": "Demesne" } });
    if (!response.ok || !response.body) throw new Error(`the download answered ${response.status}`);
    const total = Number(response.headers.get("content-length")) || found.size || 0;
    const hash = createHash("sha256"), out = createWriteStream(file);
    const reader = response.body.getReader();
    let got = 0, shown = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(value)) await new Promise(resolve => out.once("drain", resolve));
        const progress = total ? Math.min(0.99, got / total) : 0;
        if (progress - shown >= 0.02) { shown = progress; this.set({ state: "downloading", version: current, to: found.version, progress, enabled: true }); }
      }
    } finally { await new Promise<void>(resolve => out.end(resolve)); }
    if (hash.digest("hex") !== want) { rmSync(stage, { recursive: true, force: true }); throw new Error("the download didn't match its checksum"); }
    const run = this.options.run ?? defaultRun;
    if (kind === "mac") await run("ditto", ["-x", "-k", file, stage]);
    if (kind === "linux-portable") await run("tar", ["-xzf", file, "-C", stage]);
    const entry = stagedEntry(kind, stage);
    for (const need of entry.needs) if (!existsSync(need)) throw new Error(`the download is missing ${need.slice(stage.length + 1)}`);
    if (kind === "mac" || kind === "linux-portable") rmSync(file, { force: true });
    writeFileSync(this.readyFile, JSON.stringify({ version: found.version, kind, dir: stage }) + "\n");
    this.options.log(`Update: ${found.version} downloaded and checked.`);
    this.set({ state: "ready", version: current, to: found.version, enabled: true });
  }

  private readReady(): { version: string; kind: InstallKind; dir: string } | null {
    try {
      const ready = JSON.parse(readFileSync(this.readyFile, "utf8"));
      if (typeof ready.version === "string" && ready.kind === this.options.install?.kind && typeof ready.dir === "string") return ready;
    } catch {}
    return null;
  }
  /// Old downloads go; the backup of the app itself is kept by the swap.
  private clean() {
    const ready = this.readReady();
    try { rmSync(this.readyFile, { force: true }); } catch {}
    if (ready) try { rmSync(ready.dir, { recursive: true, force: true }); } catch {}
  }

  /// Hands the swap to a script that outlives this app, then quits.
  private apply(): boolean {
    const { install, pid, dir, relaunch } = this.options;
    const ready = this.readReady();
    if (!install || !ready || this.status.state !== "ready") return false;
    const entry = stagedEntry(install.kind, ready.dir), spawnDetached = this.options.spawnDetached ?? defaultSpawnDetached;
    try { rmSync(this.failedFile, { force: true }); } catch {}
    if (install.kind === "windows") {
      // The installer replaces the app by itself and opens it again.
      try { writeFileSync(this.readyFile, ""); } catch {}
      spawnDetached(entry.path, ["/S", "--force-run"]);
    } else {
      const script = join(dir, "swap.sh");
      writeFileSync(script, swapScript({ kind: install.kind, pid, root: install.root, staged: entry.path, version: ready.version, started: this.startedFile, failed: this.failedFile, relaunch }), { mode: 0o755 });
      spawnDetached("/bin/sh", [script]);
    }
    this.options.log(`Update: restarting into ${ready.version}.`);
    this.options.quit();
    return true;
  }
}
