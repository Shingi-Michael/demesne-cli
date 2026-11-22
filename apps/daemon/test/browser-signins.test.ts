import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromiumValue, cookieFile, neverBrought, safariCookies, signinCookies, SigninRecord, signinSites, signinSources, siteOf } from "../src/browser-signins.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const home = () => { const dir = mkdtempSync(join(tmpdir(), "demesne-signins-home-")); dirs.push(dir); return dir; };
const NOW = 1_800_000_000;
/// Chromium counts microseconds from 1601.
const chromiumTime = (seconds: number) => (seconds + 11_644_473_600) * 1e6;
const KEY = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
/// A v10 value the way Chrome on Linux writes it; version 24 databases put the host's hash first.
function lock(value: string, host: string, version: number) {
  const plain = Buffer.concat([version >= 24 ? createHash("sha256").update(host).digest() : Buffer.alloc(0), Buffer.from(value)]);
  const cipher = createCipheriv("aes-128-cbc", KEY, Buffer.alloc(16, " "));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}
function chrome(root: string, version = 24) {
  const dir = join(root, ".config", "google-chrome", "Default");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "Cookies"));
  db.run("CREATE TABLE meta (key TEXT, value TEXT)");
  db.run("INSERT INTO meta VALUES ('version', ?)", [String(version)]);
  db.run("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER, samesite INTEGER)");
  const add = (host: string, name: string, value: string, lastUsed: number, expires = NOW + 86_400) => db.run("INSERT INTO cookies VALUES (?, ?, '', ?, '/', ?, 1, 1, ?, 1)", [host, name, lock(value, host, version), chromiumTime(expires), chromiumTime(lastUsed)]);
  add(".github.com", "user_session", "gh-secret", NOW - 3600);
  add("github.com", "_gh_sess", "gh-two", NOW - 7200);
  add(".vercel.com", "authorization", "vc-secret", NOW - 60);
  add(".chase.com", "session", "bank-secret", NOW - 30);
  add(".old.example", "gone", "x", NOW - 99, NOW - 10);
  db.close();
}
const linux = (root: string) => ({ home: root, os: "linux" as const, env: {} });

test("a cookie's site is the name you'd type", () => {
  expect(siteOf(".www.github.com")).toBe("github.com");
  expect(siteOf("api.shop.co.uk")).toBe("shop.co.uk");
  expect(siteOf("localhost")).toBe("localhost");
  expect(siteOf("127.0.0.1")).toBe("127.0.0.1");
});

test("email and money sites never come in", () => {
  for (const site of ["google.com", "chase.com", "paypal.com", "icloud.com", "mybank.com", "outlook.com"]) expect(neverBrought(site)).toBe(true);
  for (const site of ["github.com", "vercel.com", "figma.com", "slowpour.test", "linear.app"]) expect(neverBrought(site)).toBe(false);
});

test("Chrome's sites are listed newest first, without reading a secret, and lapsed cookies don't count", () => {
  const root = home(); chrome(root);
  expect(cookieFile("chrome", linux(root))).toBe(join(root, ".config", "google-chrome", "Default", "Cookies"));
  expect(signinSources(linux(root))).toEqual([{ id: "chrome", label: "Chrome", state: "ready" }]);
  const sites = signinSites("chrome", linux(root), NOW);
  expect(sites.map((one) => one.site)).toEqual(["chase.com", "vercel.com", "github.com"]);
  expect(sites.find((one) => one.site === "github.com")!.cookies).toBe(2);
  expect(sites.find((one) => one.site === "chase.com")!.never).toBe(true);
});

test("the picked sites' cookies come out unlocked, ready for the project's browser; money sites never do", async () => {
  for (const version of [24, 18]) {
    const root = home(); chrome(root, version);
    const cookies = await signinCookies("chrome", ["github.com", "chase.com"], { where: linux(root), now: NOW, key: async () => ({ v10: KEY }) });
    expect(cookies.map((one) => [one.name, one.value]).sort()).toEqual([["_gh_sess", "gh-two"], ["user_session", "gh-secret"]]);
    const session = cookies.find((one) => one.name === "user_session")!;
    expect(session).toMatchObject({ url: "https://github.com/", domain: ".github.com", secure: true, httpOnly: true, sameSite: "lax", expirationDate: NOW + 86_400 });
    expect(cookies.find((one) => one.name === "_gh_sess")!.domain).toBeUndefined();
  }
});

test("a value locked with another key is left out, not garbled", () => {
  expect(chromiumValue(lock("x", "a.com", 24), { v10: pbkdf2Sync("other", "saltysalt", 1, 16, "sha1") }, 24)).toBeNull();
  expect(chromiumValue(Buffer.from("plain"), { v10: KEY }, 24)).toBeNull();
});

test("Firefox's sites and cookies are read as they are", async () => {
  const root = home(), dir = join(root, ".mozilla", "firefox", "abc.default-release");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "cookies.sqlite"));
  db.run("CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, lastAccessed INTEGER, sameSite INTEGER)");
  db.run("INSERT INTO moz_cookies VALUES ('.figma.com', 'figma.session', 'fg', '/', ?, 1, 1, ?, 0)", [(NOW + 3600) * 1000, (NOW - 5) * 1e6]);
  db.close();
  expect(signinSources(linux(root)).map((one) => one.id)).toEqual(["firefox"]);
  expect(signinSites("firefox", linux(root), NOW)).toEqual([{ site: "figma.com", lastUsed: (NOW - 5) * 1000, cookies: 1 }]);
  const [cookie] = await signinCookies("firefox", ["figma.com"], { where: linux(root), now: NOW });
  expect(cookie).toMatchObject({ name: "figma.session", value: "fg", expirationDate: NOW + 3600, sameSite: "no_restriction" });
});

/// One page of Safari's binarycookies with the given cookies.
function binarycookies(cookies: { host: string; name: string; path: string; value: string; flags: number; expires: number }[]) {
  const records = cookies.map((one) => {
    const strings = [one.host, one.name, one.path, one.value].map((text) => Buffer.from(`${text}\0`));
    const head = 56, record = Buffer.alloc(head + strings.reduce((sum, item) => sum + item.length, 0));
    record.writeUInt32LE(record.length, 0); record.writeUInt32LE(one.flags, 8);
    let at = head;
    strings.forEach((item, i) => { record.writeUInt32LE(at, 16 + i * 4); item.copy(record, at); at += item.length; });
    record.writeDoubleLE(one.expires - 978_307_200, 40); record.writeDoubleLE(NOW - 978_307_200, 48);
    return record;
  });
  const pageHead = Buffer.alloc(8 + records.length * 4 + 4);
  pageHead.writeUInt32BE(0x100, 0); pageHead.writeUInt32LE(records.length, 4);
  let offset = pageHead.length;
  records.forEach((record, i) => { pageHead.writeUInt32LE(offset, 8 + i * 4); offset += record.length; });
  const page = Buffer.concat([pageHead, ...records]);
  const head = Buffer.alloc(12); head.write("cook", 0); head.writeUInt32BE(1, 4); head.writeUInt32BE(page.length, 8);
  return new Uint8Array(Buffer.concat([head, page]));
}

test("Safari's binarycookies are read: host, name, value, secure and httpOnly", () => {
  const data = binarycookies([{ host: ".linear.app", name: "session", path: "/", value: "ln", flags: 5, expires: NOW + 60 }, { host: "example.org", name: "a", path: "/x", value: "b", flags: 0, expires: NOW + 60 }]);
  const all = safariCookies(data);
  expect(all).toHaveLength(2);
  expect(all[0]).toMatchObject({ host: ".linear.app", name: "session", value: "ln", path: "/", secure: true, httpOnly: true });
  expect(all[0]!.expires).toBeCloseTo(NOW + 60, 0);
  expect(safariCookies(data, ["example.org"]).map((one) => one.name)).toEqual(["a"]);
  expect(safariCookies(new Uint8Array([1, 2, 3]))).toEqual([]);
});

test("what a project brought in is kept per project, and comes out again", () => {
  const record = new SigninRecord(join(home(), "browser-signins.json"));
  record.add("p1", "chrome", ["vercel.com", "github.com"], 5);
  record.add("p2", "firefox", ["figma.com"], 6);
  record.add("p1", "arc", ["github.com"], 7);
  expect(record.list("p1")).toEqual([{ site: "github.com", from: "arc", at: 7 }, { site: "vercel.com", from: "chrome", at: 5 }]);
  record.remove("p1", "github.com");
  expect(record.list("p1").map((one) => one.site)).toEqual(["vercel.com"]);
  expect(record.list("p2").map((one) => one.site)).toEqual(["figma.com"]);
});
