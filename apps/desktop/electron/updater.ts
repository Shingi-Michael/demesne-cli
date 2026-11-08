/// Updates without a rebuild (pass 153 A). Every merge to main publishes a
/// GitHub release with each computer's app. A release build looks for the
/// newest one every few hours, downloads it in the background, checks it
/// against its published checksum and unpacks it beside the app. It swaps in
/// when you press Restart, or the next time the app opens: a small script
/// waits for this app to exit, moves it aside as the backup, moves the new one
/// in and opens it, and if the new one never says it started, puts the old
/// one back. Builds made from source are left alone. The repository is
/// private, so the look and the downloads go with a GitHub token (the
/// computer's `gh` login) when there is one; GitHub answers 404 without it.
import { execFile, spawn } from "node:child_process";
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
  | { state: "idle"; version: string; enabled: boolean; checked?: number; checking?: boolean; problem?: string }
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

/// `api` holds the files' API links, which a token can read in a private repository.
export interface ReleaseAsset { version: string; url: string; checksumUrl: string; size: number; api?: { url: string; checksumUrl: string } }
/// The newest release's file for this computer, when it is newer than ours.
/// Only the repository's own download links count.
export function pickRelease(release: unknown, kind: InstallKind, current: string): ReleaseAsset | null {
  if (!release || typeof release !== "object") return null;
  const { tag_name, draft, prerelease, assets } = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (typeof tag_name !== "string" || draft === true || prerelease === true || !Array.isArray(assets)) return null;
  const version = tag_name.replace(/^v/, "");
  if (!newerVersion(version, current)) return null;
  const prefix = `https://github.com/${UPDATE_REPO}/releases/download/${tag_name}/`;
  const apiPrefix = `https://api.github.com/repos/${UPDATE_REPO}/releases/assets/`;
  const find = (name: string) => assets.find((item): item is { name: string; browser_download_url: string; url?: unknown; size?: number } =>
    Boolean(item) && typeof item === "object" && (item as { name?: unknown }).name === name
    && typeof (item as { browser_download_url?: unknown }).browser_download_url === "string"
    && (item as { browser_download_url: string }).browser_download_url.toLowerCase() === (prefix + name).toLowerCase());
  const file = find(ASSETS[kind]), sum = find(`${ASSETS[kind]}.sha256`);
  if (!file || !sum) return null;
  const apiOf = (item: { url?: unknown }) => typeof item.url === "string" && item.url.startsWith(apiPrefix) && /^\d+$/.test(item.url.slice(apiPrefix.length)) ? item.url : null;
  const fileApi = apiOf(file), sumApi = apiOf(sum);
  return {
    version, url: file.browser_download_url, checksumUrl: sum.browser_download_url, size: typeof file.size === "number" ? file.size : 0,
    ...(fileApi && sumApi ? { api: { url: fileApi, checksumUrl: sumApi } } : {}),
  };
}

/// Where `gh` may live: an app opened from the Dock or Finder gets a short PATH,
/// so Homebrew's folders are tried as well.
export function ghCandidates(env: Record<string, string | undefined>, platform = process.platform): string[] {
  const name = platform === "win32" ? "gh.exe" : "gh";
  const dirs = (env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  if (platform !== "win32") dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/home/linuxbrew/.linuxbrew/bin");
  return [...new Set(dirs.map(dir => join(dir, name)))];
}

/// The computer's GitHub token: GH_TOKEN or GITHUB_TOKEN, else `gh auth token`.
export async function githubToken(env: Record<string, string | undefined> = process.env, exists: (path: string) => boolean = existsSync): Promise<string | null> {
  const fromEnv = (env.GH_TOKEN || env.GITHUB_TOKEN)?.trim();
  if (fromEnv) return fromEnv;
  for (const gh of ghCandidates(env)) {
    if (!exists(gh)) continue;
    const token = await new Promise<string | null>(resolve => {
      execFile(gh, ["auth", "token", "--hostname", "github.com"], { timeout: 5_000, env: { ...env, GH_PROMPT_DISABLED: "1" } }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null));
    });
    if (token) return token;
  }
  return null;
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
/// It waits for `pid`, moves the old app aside as `<root>.prev`, moves the
/// new one in, opens it, and waits for `started` to name the new version;
/// once it does the old app is deleted, and if it never does the old app
/// comes back and opens.
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
    `i=0; while [ $i -lt ${START_WAIT_S * 2} ]; do grep -qx ${q(version)} ${q(started)} 2>/dev/null && { ${kind === "linux-deb" ? "" : `rm -rf ${q(prev)}; `}exit 0; }; sleep 0.5; i=$((i+1)); done`,
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
  /// A GitHub token for a private repository, or null to go without one.
  token?: () => Promise<string | null>;
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

/// Why a check failed, in a few words for the release line and Settings.
export function checkProblem(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/no GitHub login|gh auth login/.test(text)) return "GitHub needs a login: run gh auth login";
  const answered = /GitHub answered (\d+)/.exec(text);
  if (answered) return `GitHub answered ${answered[1]}`;
  const download = /download answered (\d+)/.exec(text);
  if (download) return `The download answered ${download[1]}`;
  if (/no checksum/.test(text)) return "The release has no checksum";
  if (/didn't match its checksum/.test(text)) return "The download didn't match its checksum";
  if (/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|network|getaddrinfo|ERR_/i.test(text)) return "Couldn't reach GitHub";
  return "The check didn't finish";
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

  /// Looks for a newer release. `asked` is a check you asked for (the release
  /// line, Settings): it runs even with updates off and says it is looking.
  async check(asked = false): Promise<UpdateStatus> {
    const { install, current } = this.options;
    if (this.status.state === "idle" && this.checking && asked) { this.set({ ...this.status, checking: true }); return this.status; }
    if (this.status.state === "off" || !install || this.checking || (!asked && !this.enabled)) return this.status;
    if (this.status.state === "ready" || this.status.state === "downloading") return this.status;
    this.checking = true;
    const enabled = this.enabled, checked = this.status.state === "idle" ? this.status.checked : undefined;
    if (asked) this.set({ state: "idle", version: current, enabled, ...(checked ? { checked } : {}), checking: true });
    try {
      const token = await this.token();
      const response = await this.options.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: this.headers(token, "application/vnd.github+json") });
      if (!response.ok) throw new Error(response.status === 404 && !token ? "GitHub answered 404 (the repository is private and there is no GitHub login; run `gh auth login`)" : `GitHub answered ${response.status}`);
      const found = pickRelease(await response.json(), install.kind, current);
      if (!found || found.version === this.failedVersion()) { this.set({ state: "idle", version: current, enabled, checked: this.options.now?.() ?? Date.now() }); return this.status; }
      await this.download(found, token);
    } catch (error) {
      this.options.log(`Update check failed: ${String(error)}`);
      // A failed look keeps its reason for whoever asked; the next one tries again.
      this.set({ state: "idle", version: current, enabled, checked: this.options.now?.() ?? Date.now(), problem: checkProblem(error) });
    } finally { this.checking = false; }
    return this.status;
  }

  private async token(): Promise<string | null> {
    try { return (await this.options.token?.())?.trim() || null; } catch { return null; }
  }
  private headers(token: string | null, accept?: string): Record<string, string> {
    return { "User-Agent": "Demesne", ...(accept ? { Accept: accept } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }
  /// With a token, a file comes through the API (which redirects to a signed
  /// link); without one, from the public download link.
  private fetchFile(found: ReleaseAsset, which: "url" | "checksumUrl", token: string | null) {
    if (token && found.api) return this.options.fetch(found.api[which], { headers: this.headers(token, "application/octet-stream") });
    return this.options.fetch(found[which], { headers: this.headers(null) });
  }

  private async download(found: ReleaseAsset, token: string | null = null) {
    const { install, current, dir } = this.options;
    const kind = install!.kind, stage = join(dir, found.version);
    this.clean();
    mkdirSync(stage, { recursive: true });
    this.set({ state: "downloading", version: current, to: found.version, progress: 0, enabled: true });
    this.options.log(`Update: downloading ${found.version} (${ASSETS[kind]}).`);
    const sumResponse = await this.fetchFile(found, "checksumUrl", token);
    const want = sumResponse.ok ? parseChecksum(await sumResponse.text()) : null;
    if (!want) throw new Error("the release has no checksum");
    const file = join(stage, ASSETS[kind]);
    const response = await this.fetchFile(found, "url", token);
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
