/// Sign-ins from your other browsers (pass 261 A). Demesne lists the sites you
/// are signed in to in Chrome, Arc, Brave, Edge, Safari or Firefox, and brings
/// the ones you tick into a project's own browser profile, so its chats can
/// use them without signing in again. Only what you pick comes in, and email
/// and money sites never do: the model can use whatever is brought in.
///
/// Listing reads only site names and dates, which no browser locks. Bringing
/// sites in reads the cookies themselves: Chromium browsers lock them with a
/// key in the Mac's Keychain (the Mac asks once), Safari's sit in a folder that
/// needs Full Disk Access, and Firefox's are plain.
import { Database } from "bun:sqlite";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

export type SigninSourceId = "chrome" | "arc" | "brave" | "edge" | "safari" | "firefox";
/// A browser profile on this computer: whether its sign-ins can be read, and if not, why.
/// `id` is the browser ("chrome") for its first profile, and the browser and profile folder ("chrome:Profile 1") for the others.
export interface SigninSource { id: string; browser: SigninSourceId; label: string; state: "ready" | "missing" | "disk" | "locked" }
export interface SigninSite { site: string; lastUsed: number; cookies: number; never?: true }
/// One cookie, ready for Electron's `session.cookies.set`.
export interface SigninCookie { url: string; name: string; value: string; domain?: string; path: string; secure: boolean; httpOnly: boolean; expirationDate?: number; sameSite?: "no_restriction" | "lax" | "strict" }

const LABELS: Record<SigninSourceId, string> = { chrome: "Chrome", arc: "Arc", brave: "Brave", edge: "Edge", safari: "Safari", firefox: "Firefox" };
/// The Keychain item each Chromium browser keeps its cookie key in (macOS), and its libsecret name (Linux).
const KEYCHAIN: Partial<Record<SigninSourceId, { mac: string; linux: string }>> = {
  chrome: { mac: "Chrome Safe Storage", linux: "chrome" }, arc: { mac: "Arc Safe Storage", linux: "arc" },
  brave: { mac: "Brave Safe Storage", linux: "brave" }, edge: { mac: "Microsoft Edge Safe Storage", linux: "microsoft-edge" },
};

/// Email and money: never listed as something to bring in.
const NEVER = /(^|\.)(google|gmail|googlemail|youtube|outlook|live|hotmail|msn|microsoftonline|office|office365|icloud|apple|me|yahoo|aol|proton|protonmail|fastmail|zoho|hey|tutanota|paypal|venmo|cash|chase|wellsfargo|bankofamerica|citi|citibank|capitalone|americanexpress|amex|discover|usbank|pnc|schwab|fidelity|vanguard|robinhood|etrade|ally|sofi|wise|revolut|monzo|n26|coinbase|binance|kraken|klarna|affirm|mint|creditkarma|irs|ssa)\.[a-z.]+$|bank|credit|wallet|pay\./i;
export const neverBrought = (site: string) => NEVER.test(site);

/// Two-part endings, so `shop.co.uk` stays whole.
const SECOND = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "com.br", "com.mx", "co.in", "co.za", "com.sg", "com.hk", "com.tr", "com.cn", "co.kr"]);
/// The site a cookie's host belongs to: the name you'd type, without `www.` or a leading dot.
export function siteOf(host: string): string {
  const clean = host.replace(/^\./, "").toLowerCase();
  if (/^[\d.]+$/.test(clean) || clean === "localhost" || !clean.includes(".")) return clean;
  const parts = clean.split(".");
  const tail = parts.slice(-2).join(".");
  return parts.slice(SECOND.has(tail) && parts.length > 2 ? -3 : -2).join(".");
}
const under = (host: string, site: string) => { const clean = host.replace(/^\./, "").toLowerCase(); return clean === site || clean.endsWith(`.${site}`); };

interface RawCookie { host: string; name: string; value: string; encrypted?: Uint8Array; path: string; expires: number; secure: boolean; httpOnly: boolean; lastUsed: number; sameSite?: SigninCookie["sameSite"] }

export interface SigninWhere { home: string; os: NodeJS.Platform; env: NodeJS.ProcessEnv }
const here = (): SigninWhere => ({ home: homedir(), os: platform(), env: process.env });

/// A source as its browser and profile folder ("" for the browser's first profile).
export function signinFrom(from: string): { browser: SigninSourceId; profile: string } | null {
  const at = from.indexOf(":"), browser = (at < 0 ? from : from.slice(0, at)) as SigninSourceId, profile = at < 0 ? "" : from.slice(at + 1);
  if (!(browser in LABELS)) return null;
  // A profile is a folder name inside the browser's own folder, nothing more.
  if (profile && (browser === "safari" || !/^[\w .()@+-]{1,80}$/.test(profile) || profile.includes("..") || profile.startsWith("."))) return null;
  return { browser, profile };
}
const CHROMIUM_COOKIES = (dir: string) => [join(dir, "Network", "Cookies"), join(dir, "Cookies")].find((path) => existsSync(path)) ?? null;
/// Where a Chromium browser keeps its profiles on this computer.
function chromiumBase(id: SigninSourceId, { home, os, env }: SigninWhere): string | null {
  const bases: Partial<Record<SigninSourceId, Partial<Record<NodeJS.Platform, string>>>> = {
    chrome: { darwin: join(home, "Library", "Application Support", "Google", "Chrome"), linux: join(home, ".config", "google-chrome"), win32: join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Google", "Chrome", "User Data") },
    arc: { darwin: join(home, "Library", "Application Support", "Arc", "User Data") },
    brave: { darwin: join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"), linux: join(home, ".config", "BraveSoftware", "Brave-Browser"), win32: join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "BraveSoftware", "Brave-Browser", "User Data") },
    edge: { darwin: join(home, "Library", "Application Support", "Microsoft Edge"), linux: join(home, ".config", "microsoft-edge"), win32: join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Microsoft", "Edge", "User Data") },
  };
  return bases[id]?.[os] ?? null;
}
/// A Chromium browser's profiles that have sign-ins, Default first, each with the name you gave it in the browser.
function chromiumProfiles(base: string): { dir: string; name: string }[] {
  let names: Record<string, { name?: string }> = {};
  try { names = (JSON.parse(readFileSync(join(base, "Local State"), "utf8")) as { profile?: { info_cache?: Record<string, { name?: string }> } }).profile?.info_cache ?? {}; } catch { /* no names: folder names */ }
  let dirs: string[] = [];
  try { dirs = readdirSync(base).filter((dir) => dir === "Default" || /^Profile \d+$/.test(dir) || dir in names); } catch { return []; }
  return dirs.filter((dir) => CHROMIUM_COOKIES(join(base, dir)))
    .sort((a, b) => a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b, undefined, { numeric: true }))
    .map((dir) => ({ dir, name: names[dir]?.name?.trim() || dir }));
}
/// Firefox's profiles that have sign-ins, the one used last first, named as in its profiles.ini.
function firefoxProfiles({ home, os, env }: SigninWhere): { dir: string; path: string; name: string }[] {
  const roots = os === "darwin" ? [join(home, "Library", "Application Support", "Firefox", "Profiles")] : os === "win32" ? [join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Mozilla", "Firefox", "Profiles")] : [join(home, ".mozilla", "firefox"), join(home, "snap", "firefox", "common", ".mozilla", "firefox")];
  const named = new Map<string, string>();
  for (const root of roots) {
    let ini = "";
    for (const at of [join(root, "profiles.ini"), join(root, "..", "profiles.ini")]) { try { ini = readFileSync(at, "utf8"); break; } catch { /* not here */ } }
    for (const block of ini.split(/^\[/m)) { const name = /^Name=(.+)$/m.exec(block)?.[1]?.trim(), path = /^Path=(.+)$/m.exec(block)?.[1]?.trim(); if (name && path) named.set(path.split(/[\\/]/).pop()!, name); }
  }
  return roots.filter(existsSync).flatMap((root) => readdirSync(root).map((dir) => ({ dir, path: join(root, dir, "cookies.sqlite") })))
    .filter((one) => existsSync(one.path))
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)
    .map((one) => ({ ...one, name: named.get(one.dir) ?? one.dir.replace(/^[^.]*\./, "") }));
}

/// Where a browser profile keeps its cookies on this computer (the first profile when none is named).
export function cookieFile(from: string, where: SigninWhere = here()): string | null {
  const source = signinFrom(from);
  if (!source) return null;
  const { browser: id, profile } = source, { home, os } = where;
  const first = (...paths: string[]) => paths.find((path) => existsSync(path)) ?? null;
  if (id === "firefox") {
    const found = firefoxProfiles(where);
    return (profile ? found.find((one) => one.dir === profile) : found[0])?.path ?? null;
  }
  if (id === "safari") return os === "darwin" ? first(join(home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies", "Cookies.binarycookies"), join(home, "Library", "Cookies", "Cookies.binarycookies")) ?? join(home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies", "Cookies.binarycookies") : null;
  const base = chromiumBase(id, where);
  if (!base) return null;
  if (profile) return CHROMIUM_COOKIES(join(base, profile));
  return CHROMIUM_COOKIES(join(base, "Default")) ?? (chromiumProfiles(base)[0] ? CHROMIUM_COOKIES(join(base, chromiumProfiles(base)[0]!.dir)) : null);
}

/// The browsers on this computer, one row per profile with sign-ins, in a fixed order; Safari shows even when Demesne can't read it yet.
/// A browser with several profiles names each ("Chrome · Work"); its first keeps the browser's own id.
export function signinSources(where: SigninWhere = here()): SigninSource[] {
  return (Object.keys(LABELS) as SigninSourceId[]).flatMap((id): SigninSource[] => {
    const label = LABELS[id];
    if (id === "safari") {
      const file = cookieFile(id, where);
      if (where.os !== "darwin" || !file) return [];
      try { readFileSync(file).subarray(0, 4); return [{ id, browser: id, label, state: "ready" }]; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : [{ id, browser: id, label, state: "disk" }]; }
    }
    const profiles = id === "firefox" ? firefoxProfiles(where) : (() => { const base = chromiumBase(id, where); return base ? chromiumProfiles(base) : []; })();
    if (!profiles.length) return [];
    // Chromium browsers on Windows lock cookies to the browser itself since 2024 (app-bound encryption).
    if (where.os === "win32" && id !== "firefox") return [{ id, browser: id, label, state: "locked" }];
    return profiles.map((profile, at) => ({ id: at === 0 ? id : `${id}:${profile.dir}`, browser: id, label: profiles.length > 1 ? `${label} · ${profile.name}` : label, state: "ready" as const }));
  });
}

/// A copy of a browser's cookie database to read while the browser keeps running (it holds the file open).
function withCopy<T>(file: string, read: (db: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "demesne-signins-"));
  try {
    const copy = join(dir, "cookies.sqlite");
    copyFileSync(file, copy);
    for (const end of ["-wal", "-shm"]) if (existsSync(file + end)) copyFileSync(file + end, copy + end);
    // Opened read-write (the default) so SQLite can replay the copied -wal; { readonly: false } alone is "API misuse" on Bun 1.4.0, which CI runs.
    const db = new Database(copy);
    try { return read(db); } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/// Chromium's clock counts microseconds from 1601.
const fromChromium = (micros: number) => micros > 0 ? micros / 1e6 - 11_644_473_600 : 0;
const SAME_SITE: Record<number, SigninCookie["sameSite"]> = { 0: "no_restriction", 1: "lax", 2: "strict" };

function chromiumCookies(file: string, sites?: string[]): { cookies: RawCookie[]; version: number } {
  return withCopy(file, (db) => {
    const version = Number((db.query("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | null)?.value ?? 0);
    const rows = db.query("SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, samesite FROM cookies").all() as Record<string, unknown>[];
    const cookies = rows.filter((row) => !sites || sites.some((site) => under(String(row.host_key), site))).map((row): RawCookie => ({
      host: String(row.host_key), name: String(row.name), value: String(row.value ?? ""), encrypted: sites ? row.encrypted_value as Uint8Array : undefined, path: String(row.path || "/"),
      expires: fromChromium(Number(row.expires_utc)), secure: Boolean(row.is_secure), httpOnly: Boolean(row.is_httponly), lastUsed: fromChromium(Number(row.last_access_utc)), sameSite: SAME_SITE[Number(row.samesite)],
    }));
    return { cookies, version };
  });
}

/// Firefox kept expiry in seconds, and newer versions in milliseconds.
const firefoxTime = (value: number) => !value ? 0 : value > 1e11 ? value / 1000 : value;
function firefoxCookies(file: string, sites?: string[]): RawCookie[] {
  return withCopy(file, (db) => (db.query("SELECT host, name, value, path, expiry, isSecure, isHttpOnly, lastAccessed, sameSite FROM moz_cookies").all() as Record<string, unknown>[])
    .filter((row) => !sites || sites.some((site) => under(String(row.host), site)))
    .map((row) => ({ host: String(row.host), name: String(row.name), value: String(row.value ?? ""), path: String(row.path || "/"), expires: firefoxTime(Number(row.expiry)), secure: Boolean(row.isSecure), httpOnly: Boolean(row.isHttpOnly), lastUsed: Number(row.lastAccessed) / 1e6 || 0, sameSite: SAME_SITE[Number(row.sameSite)] })));
}

/// Safari's Cookies.binarycookies: pages of cookies, each a little-endian record of offsets to its strings.
export function safariCookies(data: Uint8Array, sites?: string[]): RawCookie[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 8 || String.fromCharCode(...data.subarray(0, 4)) !== "cook") return [];
  const pages = view.getUint32(4), sizes: number[] = [];
  for (let i = 0; i < pages; i++) sizes.push(view.getUint32(8 + i * 4));
  const out: RawCookie[] = [];
  const text = (at: number) => { let end = at; while (end < data.byteLength && data[end] !== 0) end++; return new TextDecoder().decode(data.subarray(at, end)); };
  let page = 8 + pages * 4;
  for (const size of sizes) {
    const count = view.getUint32(page + 4, true);
    for (let i = 0; i < count; i++) {
      const at = page + view.getUint32(page + 8 + i * 4, true);
      const flags = view.getUint32(at + 8, true);
      const host = text(at + view.getUint32(at + 16, true)), name = text(at + view.getUint32(at + 20, true)), path = text(at + view.getUint32(at + 24, true)), value = text(at + view.getUint32(at + 28, true));
      // Mac time counts seconds from 2001.
      const expires = view.getFloat64(at + 40, true) + 978_307_200, made = view.getFloat64(at + 48, true) + 978_307_200;
      if (!sites || sites.some((site) => under(host, site))) out.push({ host, name, value, path: path || "/", expires, secure: Boolean(flags & 1), httpOnly: Boolean(flags & 4), lastUsed: made });
    }
    page += size;
  }
  return out;
}

function rawCookies(from: string, sites?: string[], where: SigninWhere = here()): { cookies: RawCookie[]; version: number } {
  const id = signinFrom(from)?.browser;
  if (!id) throw new Error("That browser isn't one Demesne reads");
  const file = cookieFile(from, where);
  if (!file) throw new Error(`${LABELS[id]} isn't on this computer`);
  if (id === "firefox") return { cookies: firefoxCookies(file, sites), version: 0 };
  if (id === "safari") {
    try { return { cookies: safariCookies(new Uint8Array(readFileSync(file)), sites), version: 0 }; }
    catch { throw new Error("Safari keeps its sign-ins in a protected folder: turn on Full Disk Access for Demesne in System Settings › Privacy & Security, then try again"); }
  }
  return chromiumCookies(file, sites);
}

/// The sites you're signed in to in one browser, used last first. Nothing secret is read.
export function signinSites(id: string, where: SigninWhere = here(), now = Date.now() / 1000): SigninSite[] {
  const { cookies } = rawCookies(id, undefined, where);
  const sites = new Map<string, SigninSite>();
  for (const cookie of cookies) {
    // A cookie that has run out, or only lives for one visit, is not a sign-in to bring.
    if (cookie.expires && cookie.expires < now) continue;
    const site = siteOf(cookie.host);
    if (!site) continue;
    const have = sites.get(site) ?? { site, lastUsed: 0, cookies: 0, ...(neverBrought(site) ? { never: true as const } : {}) };
    have.cookies++;
    have.lastUsed = Math.max(have.lastUsed, Math.round(cookie.lastUsed * 1000));
    sites.set(site, have);
  }
  return [...sites.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 80);
}

/// The key a Chromium browser locks its cookies with. On a Mac the Keychain asks you once.
export type KeyReader = (id: SigninSourceId) => Promise<{ v10: Buffer; v11?: Buffer }>;
export const readChromiumKey: KeyReader = async (id) => {
  const names = KEYCHAIN[id];
  if (!names) throw new Error(`${LABELS[id]} has no key to read`);
  if (platform() === "darwin") {
    const run = Bun.spawn(["security", "find-generic-password", "-w", "-s", names.mac], { stdout: "pipe", stderr: "pipe" });
    const [password, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    if (code !== 0 || !password.trim()) throw new Error(`The Mac didn't share ${LABELS[id]}'s key. Click Always Allow when it asks about “${names.mac}”`);
    return { v10: pbkdf2Sync(password.trim(), "saltysalt", 1003, 16, "sha1") };
  }
  // Linux: v10 cookies use a fixed word; v11 ones the desktop's keyring, when it has one.
  const v10 = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  try {
    const run = Bun.spawn(["secret-tool", "lookup", "application", names.linux], { stdout: "pipe", stderr: "ignore" });
    const [password, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    return code === 0 && password.trim() ? { v10, v11: pbkdf2Sync(password.trim(), "saltysalt", 1, 16, "sha1") } : { v10 };
  } catch { return { v10 }; }
};

/// One Chromium cookie's value. Version 24 databases put a hash of the host before it.
export function chromiumValue(encrypted: Uint8Array, key: { v10: Buffer; v11?: Buffer }, version: number): string | null {
  const bytes = Buffer.from(encrypted);
  const tag = bytes.subarray(0, 3).toString();
  const use = tag === "v10" ? key.v10 : tag === "v11" ? key.v11 : undefined;
  if (!use) return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", use, Buffer.alloc(16, " "));
    let plain = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
    if (version >= 24) plain = plain.subarray(32);
    return plain.toString("utf8");
  } catch { return null; }
}

/// The cookies of the sites you picked, ready for the project's browser. Email and money sites are left out whatever is asked.
export async function signinCookies(id: string, sites: string[], options: { where?: SigninWhere; key?: KeyReader; now?: number } = {}): Promise<SigninCookie[]> {
  const picked = [...new Set(sites.map((site) => site.toLowerCase().trim()))].filter((site) => site && !neverBrought(site));
  if (!picked.length) return [];
  const where = options.where ?? here(), now = options.now ?? Date.now() / 1000;
  const { cookies, version } = rawCookies(id, picked, where);
  // Every profile of a browser shares its one key.
  const browser = signinFrom(id)?.browser;
  const chromium = Boolean(browser && KEYCHAIN[browser]);
  const key = chromium && cookies.some((cookie) => !cookie.value && cookie.encrypted?.length) ? await (options.key ?? readChromiumKey)(browser!) : null;
  return cookies.flatMap((cookie): SigninCookie[] => {
    if (cookie.expires && cookie.expires < now) return [];
    const value = cookie.value || (key && cookie.encrypted?.length ? chromiumValue(cookie.encrypted, key, version) : "") || "";
    if (!value) return [];
    const host = cookie.host.replace(/^\./, "");
    return [{ url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`, name: cookie.name, value, ...(cookie.host.startsWith(".") ? { domain: cookie.host } : {}), path: cookie.path || "/", secure: cookie.secure, httpOnly: cookie.httpOnly, ...(cookie.expires ? { expirationDate: cookie.expires } : {}), ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}) }];
  });
}

export const isSigninSource = (value: unknown): value is string => typeof value === "string" && signinFrom(value) !== null;
export const signinLabel = (from: string) => { const source = signinFrom(from); return source ? LABELS[source.browser] : from; };

/// What each project has brought in, so Settings can list it and take it out again.
export interface KeptSignin { site: string; from: string; at: number }
export class SigninRecord {
  constructor(private readonly file: string) {}
  private read(): Record<string, KeptSignin[]> { try { return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, KeptSignin[]>; } catch { return {}; } }
  list(profile: string): KeptSignin[] { return (this.read()[profile] ?? []).sort((a, b) => a.site.localeCompare(b.site)); }
  add(profile: string, from: string, sites: string[], at = Date.now()) {
    const all = this.read(), kept = (all[profile] ?? []).filter((one) => !sites.includes(one.site));
    all[profile] = [...kept, ...sites.map((site) => ({ site, from, at }))];
    writeFileSync(this.file, JSON.stringify(all, null, 2));
  }
  remove(profile: string, site: string) {
    const all = this.read();
    all[profile] = (all[profile] ?? []).filter((one) => one.site !== site);
    writeFileSync(this.file, JSON.stringify(all, null, 2));
  }
}
