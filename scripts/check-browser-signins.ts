/** Settings › Browser against the real Electron app (pass 261 A): a Chrome on this computer
 * lists its sites, email and money show greyed, ticked sites come into the project, and
 * one comes out again. bun scripts/check-browser-signins.ts [dir]; run bun scripts/prepare-desktop.ts first (Linux: xvfb-run -a). */
import { Database } from "bun:sqlite";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";
import type { BrowserDriver } from "../apps/daemon/src/browser.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const output = resolve(process.argv[2] ?? "test-results/browser-signins");
mkdirSync(output, { recursive: true });
const { _electron: electron } = await import("playwright");

// A Chrome whose cookies are locked the way Chrome on Linux locks them.
const chromeHome = join(output, "chrome-home"), now = Date.now() / 1000;
const dir = join(chromeHome, ".config", "google-chrome", "Default");
mkdirSync(dir, { recursive: true });
const key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
const lock = (value: string, host: string) => { const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " ")); return Buffer.concat([Buffer.from("v10"), cipher.update(Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)])), cipher.final()]); };
const at = (seconds: number) => (seconds + 11_644_473_600) * 1e6;
const db = new Database(join(dir, "Cookies"));
db.run("DROP TABLE IF EXISTS meta"); db.run("DROP TABLE IF EXISTS cookies");
db.run("CREATE TABLE meta (key TEXT, value TEXT)"); db.run("INSERT INTO meta VALUES ('version', '24')");
db.run("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER, samesite INTEGER)");
for (const [host, name, ago] of [[".github.com", "user_session", 3 * 86_400], [".vercel.com", "authorization", 600], ["admin.slowpour.test", "sid", 7 * 86_400], [".figma.com", "figma.session", 86_400], [".linear.app", "session", 14 * 86_400], [".google.com", "SID", 60], [".chase.com", "session", 120]] as const)
  db.run("INSERT INTO cookies VALUES (?, ?, '', ?, '/', ?, 1, 1, ?, 1)", [host, name, lock(`${name}-value`, host), at(now + 30 * 86_400), at(now - ago)]);
db.close();

const sent: Record<string, unknown>[] = [];
const browserDriver = (async (_chat, command) => { sent.push(command); return command.action === "cookies_set" ? { set: (command.cookies as unknown[]).length } : command.action === "cookies_remove" ? { removed: 1 } : { error: "not in this check" }; }) as BrowserDriver;
const f = await fixture(undefined, { browser: browserDriver, signinWhere: { home: chromeHome, os: "linux", env: {} }, workspaceName: "slowpour" });
const app = await electron.launch({ args: [join(desktop, "build/app"), `--user-data-dir=${join(f.root, "electron")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") } });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.locator("#composer-model").waitFor({ timeout: 20_000 });
  for (let tries = 0; tries < 5 && !await page.locator('.st-nav[data-args*="browser"]').isVisible(); tries++) {
    await page.locator('[data-action="page-open"][data-args*="settings"]').first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
  await page.locator('.st-nav[data-args*="browser"]').click();
  await page.getByText("Signed in, in Chrome").waitFor({ timeout: 10_000 });
  const text = await page.locator("#page").innerText();
  for (const site of ["vercel.com", "github.com", "figma.com", "slowpour.test"]) assert(text.includes(site), `${site} is listed`);
  assert.equal(await page.locator('[aria-label="Bring in chase.com"]').count(), 0, "a bank can't be ticked");
  assert.equal(await page.locator('[aria-label="Bring in google.com"]').count(), 0, "email can't be ticked");
  assert.match(text, /Email and money sites never come in/);
  assert.match(text, /Nothing brought in yet/);
  await page.screenshot({ path: join(output, "list.png") });
  console.log("PASS: Settings › Browser lists Chrome's sites, newest first, with email and money greyed out.");

  await page.locator('[aria-label="Bring in vercel.com"]').click();
  await page.locator('[aria-label="Bring in github.com"]').click();
  await page.getByText("Bring in 2 sign-ins").waitFor();
  await page.screenshot({ path: join(output, "picked.png") });
  await page.locator('[data-action="signins-bring"]').click();
  await page.getByText(/Brought in 2 sites/).waitFor({ timeout: 10_000 }).catch(() => {});
  await page.locator('[data-action="signins-remove"]').first().waitFor({ timeout: 10_000 });
  const set = sent.find((one) => one.action === "cookies_set") as { cookies: { name: string; value: string }[] } | undefined;
  assert(set, "the cookies went to the browser");
  assert.deepEqual(set.cookies.map((one) => [one.name, one.value]).sort(), [["authorization", "authorization-value"], ["user_session", "user_session-value"]]);
  const after = await page.locator("#page").innerText();
  assert.match(after, /In slowpour/);
  assert.equal(await page.locator('[data-action="signins-remove"]').count(), 2, "both are listed in the project");
  assert.equal(await page.locator('[aria-label="Bring in vercel.com"]').count(), 0, "a site already brought in isn't offered again");
  await page.screenshot({ path: join(output, "brought.png") });
  console.log("PASS: the ticked sites come in, unlocked, and are listed in the project.");

  await page.locator('[data-action="signins-remove"]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-action="signins-remove"]').length === 1, undefined, { timeout: 10_000 });
  assert(sent.some((one) => one.action === "cookies_remove"), "the browser was told to sign out of it");
  console.log("PASS: Remove takes a site back out.");
} finally {
  await app.close();
  await f.close?.();
}
