import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghCandidates, githubToken, installFor, newerVersion, parseChecksum, pickRelease, swapScript, Updater, UPDATE_REPO, type UpdateStatus } from "../electron/updater.ts";
import { releaseLine } from "../workspace/release-line.ts";

const temp = () => mkdtempSync(join(tmpdir(), "demesne-update-"));

test("each computer maps to the release file it can swap in", () => {
  expect(installFor("darwin", "arm64", "/Users/m/Applications/Demesne.app/Contents/MacOS/Demesne")).toEqual({ kind: "mac", root: "/Users/m/Applications/Demesne.app" });
  expect(installFor("darwin", "x64", "/Applications/Demesne.app/Contents/MacOS/Demesne")).toBeNull();
  expect(installFor("linux", "x64", "/opt/Demesne/demesne")).toEqual({ kind: "linux-deb", root: "/opt/Demesne" });
  expect(installFor("linux", "x64", "/home/m/.local/share/demesne/demesne")).toEqual({ kind: "linux-portable", root: "/home/m/.local/share/demesne" });
  expect(installFor("win32", "x64", "C:\\Users\\m\\AppData\\Local\\Programs\\Demesne\\demesne.exe")?.kind).toBe("windows");
  expect(installFor("linux", "arm64", "/opt/Demesne/demesne")).toBeNull();
});

test("only a strictly newer plain version counts", () => {
  expect(newerVersion("0.4.52", "0.4.51")).toBe(true);
  expect(newerVersion("v0.5.0", "0.4.99")).toBe(true);
  expect(newerVersion("0.4.10", "0.4.9")).toBe(true);
  expect(newerVersion("0.4.51", "0.4.51")).toBe(false);
  expect(newerVersion("0.4.50", "0.4.51")).toBe(false);
  expect(newerVersion("0.5.0-rc1", "0.4.0")).toBe(false);
  expect(parseChecksum(`${"ab".repeat(32)}  demesne-darwin-arm64.zip\n`)).toBe("ab".repeat(32));
  expect(parseChecksum("not a hash")).toBeNull();
});

const release = (tag: string, names: string[], host = `https://github.com/${UPDATE_REPO}/releases/download/${tag}/`) =>
  ({ tag_name: tag, draft: false, prerelease: false, assets: names.map((name) => ({ name, browser_download_url: host + name, size: 10 })) });

test("a release is taken only from the repository's own downloads, with its checksum", () => {
  const files = ["demesne-darwin-arm64.zip", "demesne-darwin-arm64.zip.sha256"];
  expect(pickRelease(release("v0.4.52", files), "mac", "0.4.51")?.version).toBe("0.4.52");
  expect(pickRelease(release("v0.4.51", files), "mac", "0.4.51")).toBeNull();
  expect(pickRelease(release("v0.4.52", files.slice(0, 1)), "mac", "0.4.51")).toBeNull();
  expect(pickRelease(release("v0.4.52", files, "https://evil.example/"), "mac", "0.4.51")).toBeNull();
  expect(pickRelease({ ...release("v0.4.52", files), prerelease: true }, "mac", "0.4.51")).toBeNull();
  expect(pickRelease(release("v0.4.52", files), "linux-portable", "0.4.51")).toBeNull();
});

/// A Linux portable release: a tarball holding demesne/ with its backend.
async function portableTarball(dir: string, marker: string) {
  const app = join(dir, "build", "demesne"), backend = join(app, "resources", "backend");
  mkdirSync(backend, { recursive: true });
  for (const file of [join(app, "demesne"), join(backend, "demesned"), join(backend, "demesne-host"), join(backend, "demesne-desktop-host")]) { writeFileSync(file, `#!/bin/sh\n# ${marker}\n`); chmodSync(file, 0o755); }
  const tarball = join(dir, "demesne-linux-x64.tar.gz");
  const done = Bun.spawnSync(["tar", "-czf", tarball, "-C", join(dir, "build"), "demesne"]);
  expect(done.exitCode).toBe(0);
  return new Uint8Array(readFileSync(tarball));
}

function fakeGitHub(bytes: Uint8Array, sum = createHash("sha256").update(bytes).digest("hex")) {
  const tag = "v0.4.52", base = `https://github.com/${UPDATE_REPO}/releases/download/${tag}/`;
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    if (url.endsWith("/releases/latest")) return Response.json(release(tag, ["demesne-linux-x64.tar.gz", "demesne-linux-x64.tar.gz.sha256"]));
    if (url === `${base}demesne-linux-x64.tar.gz.sha256`) return new Response(`${sum}  demesne-linux-x64.tar.gz\n`);
    if (url === `${base}demesne-linux-x64.tar.gz`) return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { headers: { "content-length": String(bytes.length) } });
    return new Response("nope", { status: 404 });
  };
  return { fetch, calls };
}

function updater(dir: string, fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>, extra: Partial<ConstructorParameters<typeof Updater>[0]> = {}) {
  const seen: UpdateStatus[] = [], spawned: string[][] = [];
  let quits = 0;
  const root = join(dir, "install", "demesne");
  mkdirSync(root, { recursive: true });
  const it = new Updater({
    install: { kind: "linux-portable", root }, current: "0.4.51", release: true, dir: join(dir, "updates"), pid: 999999,
    relaunch: [join(root, "demesne")], fetch, emit: (status) => seen.push(status), log: () => {}, quit: () => { quits++; },
    spawnDetached: (command, args) => spawned.push([command, ...args]), ...extra,
  });
  return { it, seen, spawned, quits: () => quits, root };
}

test("it downloads the newer release, checks it and waits with Restart", async () => {
  const dir = temp(), github = fakeGitHub(await portableTarball(dir, "new"));
  const { it, seen, spawned, quits } = updater(dir, github.fetch);
  const status = await it.check();
  expect(status).toMatchObject({ state: "ready", to: "0.4.52" });
  expect(seen.some((item) => item.state === "downloading")).toBe(true);
  expect(existsSync(join(dir, "updates", "0.4.52", "demesne", "resources", "backend", "demesned"))).toBe(true);
  // Never mid-work: Restart waits for the chat to finish.
  it.setBusy(true);
  expect(it.restart()).toMatchObject({ state: "ready", waiting: true });
  expect(spawned).toEqual([]);
  it.setBusy(false);
  expect(spawned[0]?.[0]).toBe("/bin/sh");
  expect(quits()).toBe(1);
  expect(readFileSync(join(dir, "updates", "swap.sh"), "utf8")).toContain("0.4.52");
});

test("a download that doesn't match its checksum is thrown away", async () => {
  const dir = temp(), github = fakeGitHub(await portableTarball(dir, "new"), "00".repeat(32));
  const { it } = updater(dir, github.fetch);
  expect(await it.check()).toMatchObject({ state: "idle" });
  expect(existsSync(join(dir, "updates", "0.4.52"))).toBe(false);
});

test("a source build, or updates switched off, never looks", async () => {
  const dir = temp(), github = fakeGitHub(new Uint8Array([1]));
  expect(updater(dir, github.fetch, { release: false }).it.status).toEqual({ state: "off", why: "built from source" });
  const { it } = updater(dir, github.fetch);
  it.setEnabled(false);
  expect(await it.check()).toMatchObject({ state: "idle", enabled: false });
  expect(github.calls.filter((url) => url.endsWith("/latest"))).toEqual([]);
});

test("a finished download goes in the next time it opens, unless that version failed", async () => {
  const dir = temp(), github = fakeGitHub(await portableTarball(dir, "new"));
  await updater(dir, github.fetch).it.check();
  const again = updater(dir, github.fetch);
  expect(again.it.applyPending()).toBe(true);
  expect(again.quits()).toBe(1);
  writeFileSync(join(dir, "updates", "failed"), "0.4.52\n");
  const third = updater(dir, github.fetch);
  expect(third.it.applyPending()).toBe(false);
  third.it.started();
  expect(third.it.status).toMatchObject({ state: "failed", to: "0.4.52" });
});

test("the swap script moves the new app in, deletes the old one once it starts, and puts it back if it never does", async () => {
  for (const starts of [true, false]) {
    const dir = temp(), root = join(dir, "demesne"), staged = join(dir, "staged");
    mkdirSync(root); writeFileSync(join(root, "which"), "old");
    mkdirSync(staged); writeFileSync(join(staged, "which"), "new");
    const started = join(dir, "started"), failed = join(dir, "failed");
    // The "app" it opens says it started, or doesn't.
    const launcher = join(dir, "launch.sh");
    writeFileSync(launcher, starts ? `#!/bin/sh\ngrep -q new ${root}/which && echo 0.4.52 > ${started}\n` : "#!/bin/sh\n", { mode: 0o755 });
    const script = swapScript({ kind: "linux-portable", pid: 999999, root, staged, version: "0.4.52", started, failed, relaunch: [launcher] })
      .replace(/-lt \d+/, "-lt 4");
    writeFileSync(join(dir, "swap.sh"), script);
    const run = Bun.spawnSync(["sh", join(dir, "swap.sh")]);
    expect(run.exitCode).toBe(0);
    expect(readFileSync(join(root, "which"), "utf8")).toBe(starts ? "new" : "old");
    expect(existsSync(failed)).toBe(!starts);
    expect(existsSync(`${root}.prev`)).toBe(false);
  }
});

test("the release line shows the name, the download, then Restart", () => {
  expect(releaseLine(null).html).toBe("Demesne · Cherry Blossom");
  expect(releaseLine({ state: "downloading", version: "0.4.51", to: "0.4.52", progress: 0.45 }).html).toContain('width:45%');
  expect(releaseLine({ state: "ready", version: "0.4.51", to: "0.4.52" }).html).toContain("data-update-restart");
  expect(releaseLine({ state: "ready", version: "0.4.51", to: "0.4.52", waiting: true }).html).toContain("restarts when this finishes");
});

/// A private repository: the API answers only with a token, and files come
/// through their API links, never the public download links.
function privateGitHub(bytes: Uint8Array) {
  const tag = "v0.4.52", api = `https://api.github.com/repos/${UPDATE_REPO}/releases/assets/`;
  const names = ["demesne-linux-x64.tar.gz", "demesne-linux-x64.tar.gz.sha256"];
  const body = { ...release(tag, names), assets: release(tag, names).assets.map((asset, i) => ({ ...asset, url: `${api}${100 + i}` })) };
  const calls: { url: string; auth?: string; accept?: string }[] = [];
  const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    const auth = init?.headers?.Authorization, accept = init?.headers?.Accept;
    calls.push({ url, auth, accept });
    if (auth !== "Bearer secret") return new Response("Not Found", { status: 404 });
    if (url.endsWith("/releases/latest")) return Response.json(body);
    if (url === `${api}101` && accept === "application/octet-stream") return new Response(`${createHash("sha256").update(bytes).digest("hex")}  demesne-linux-x64.tar.gz\n`);
    if (url === `${api}100` && accept === "application/octet-stream") return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]));
    return new Response("Not Found", { status: 404 });
  };
  return { fetch, calls };
}

test("a private repository updates with the computer's GitHub login", async () => {
  const dir = temp(), github = privateGitHub(await portableTarball(dir, "new"));
  const logs: string[] = [];
  const without = updater(dir, github.fetch, { log: (line) => logs.push(line), token: async () => null });
  expect(await without.it.check()).toMatchObject({ state: "idle" });
  expect(logs.join("\n")).toContain("gh auth login");
  const { it } = updater(dir, github.fetch, { token: async () => " secret\n" });
  expect(await it.check()).toMatchObject({ state: "ready", to: "0.4.52" });
  expect(github.calls.filter((call) => call.auth).every((call) => call.url.startsWith("https://api.github.com/"))).toBe(true);
});

test("the token comes from the environment, else from gh", async () => {
  expect(await githubToken({ GH_TOKEN: " a " }, () => false)).toBe("a");
  expect(await githubToken({ GITHUB_TOKEN: "b" }, () => false)).toBe("b");
  expect(await githubToken({ PATH: "/nowhere" }, () => false)).toBeNull();
  const dir = temp(), gh = join(dir, "gh");
  writeFileSync(gh, `#!/bin/sh\n[ "$1 $2" = "auth token" ] && echo from-gh\n`, { mode: 0o755 });
  expect(await githubToken({ PATH: dir }, (path) => path === gh)).toBe("from-gh");
  expect(ghCandidates({ PATH: "" }, "darwin")).toContain("/opt/homebrew/bin/gh");
});
