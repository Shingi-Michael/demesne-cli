import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonApp, type DaemonApp } from "../src/app.ts";
import { browserProfile, type BrowserDriver } from "../src/browser.ts";

// Pass 261 A from the desktop's side: Settings › Browser lists a browser's sites, brings the
// picked ones into the project's profile through the browser, and takes one out again.

const directories: string[] = [];
const apps: DaemonApp[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.close?.();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("Settings › Browser lists sites, brings the picked ones into the project's browser, and removes one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "demesne-signins-app-"));
  directories.push(directory);
  // A Firefox on this computer (its cookies need no key), under a home of its own.
  const profile = join(directory, "home", ".mozilla", "firefox", "x.default");
  mkdirSync(profile, { recursive: true });
  const db = new Database(join(profile, "cookies.sqlite"));
  db.run("CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, lastAccessed INTEGER, sameSite INTEGER)");
  const later = Math.floor(Date.now() / 1000) + 86_400;
  db.run("INSERT INTO moz_cookies VALUES ('.figma.com', 'session', 'fg', '/', ?, 1, 1, ?, 1)", [later, Date.now() * 1000]);
  db.run("INSERT INTO moz_cookies VALUES ('.paypal.com', 'session', 'pp', '/', ?, 1, 1, ?, 1)", [later, Date.now() * 1000]);
  db.close();

  const sent: Record<string, unknown>[] = [];
  const browser = (async (_chat, command) => { sent.push(command); return command.action === "cookies_set" ? { set: (command.cookies as unknown[]).length } : { removed: 1 }; }) as BrowserDriver;
  const app = createDaemonApp({ databasePath: join(directory, "data", "demesne.sqlite"), browser, signinWhere: { home: join(directory, "home"), os: "linux", env: {} } });
  apps.push(app);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, body?: unknown) => fetch(new URL(path, server.url), body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const root = join(directory, "slowpour");
  try {
    const listed = await (await call(`/v1/browser/signins?root=${encodeURIComponent(root)}`)).json() as { from: string; sites: { site: string; never?: boolean }[]; kept: unknown[] };
    expect(listed.from).toBe("firefox");
    expect(listed.sites.map((one) => [one.site, one.never ?? false]).sort()).toEqual([["figma.com", false], ["paypal.com", true]]);
    expect(listed.kept).toEqual([]);
    // No project: nothing to bring into.
    expect((await call("/v1/browser/signins?root=relative")).status).toBe(400);

    // Money sites are dropped even when asked for.
    const brought = await (await call("/v1/browser/signins", { root, from: "firefox", sites: ["figma.com", "paypal.com"] })).json() as { set: number; sites: string[]; kept: { site: string }[] };
    expect(brought).toMatchObject({ set: 1, sites: ["figma.com"] });
    expect(brought.kept.map((one) => one.site)).toEqual(["figma.com"]);
    expect(sent[0]).toMatchObject({ action: "cookies_set", profile: browserProfile(root), cookies: [{ name: "session", value: "fg", domain: ".figma.com", url: "https://figma.com/" }] });
    expect((await call("/v1/browser/signins", { root, from: "firefox", sites: ["paypal.com"] })).status).toBe(409);
    expect((await call("/v1/browser/signins", { root, from: "chrome", sites: ["figma.com"] })).status).toBe(400);

    const removed = await (await call("/v1/browser/signins/remove", { root, site: "figma.com" })).json() as { kept: unknown[] };
    expect(removed.kept).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ action: "cookies_remove", profile: browserProfile(root), sites: ["figma.com"] });
  } finally { server.stop(true); }
});
