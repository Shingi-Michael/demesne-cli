/// Real data in the page (Foundry step 5): what a mockup may read through
/// demesne.read / list / fetch (foundry-kit/remember.js). Files come only
/// from the mockup's own project, never its secrets; the web only over
/// https, from public hosts you allowed for that mockup, a little at a time.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const READ_MAX_BYTES = 2 * 1024 * 1024, FETCH_MAX_BYTES = 2 * 1024 * 1024, FETCH_TIMEOUT_MS = 15_000, LIST_MAX = 500;

/// Files a page never reads, wherever they are: keys, tokens, environment files, git's insides.
const SECRET = [/(^|\/)\.env(\.|$)/i, /(^|\/)\.git(\/|$)/, /(^|\/)\.(npmrc|pypirc|netrc|aws|ssh|gnupg|docker)(\/|$)/i, /\.(pem|key|p12|pfx|keystore|jks)$/i, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)/i, /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i, /(^|\/)\.demesne\/(?!design\.md$)/];
export const secretPath = (path: string) => SECRET.some((rule) => rule.test(path.replace(/\\/g, "/")));

/// The file a page asks for, inside its project (symlinks followed), or why not.
export function projectPath(root: string | null, asked: string): { path: string } | { error: string } {
  if (!root) return { error: "This mockup isn't in a project, so it has no files to read" };
  const clean = asked.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (clean.includes("\0") || isAbsolute(clean) || /^[a-z]:/i.test(clean)) return { error: "demesne.read takes a path inside the project, like \"data/sales.csv\"" };
  if (secretPath(clean)) return { error: `${clean} is kept from pages (keys, tokens and environment files are)` };
  let base: string, path: string;
  try { base = realpathSync(root); } catch { return { error: "This mockup's project isn't on this computer" }; }
  try { path = realpathSync(resolve(base, clean || ".")); } catch { return { error: `There's no ${clean || "folder"} in the project` }; }
  const inside = relative(base, path);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { error: "demesne.read reads files inside the project only" };
  if (secretPath(inside)) return { error: `${clean} is kept from pages (keys, tokens and environment files are)` };
  return { path };
}

/// A web address a page may fetch: https, no password in it, a public host
/// (not this computer, the local network or an address by number in a private range).
export function publicAddress(value: string): URL | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".") || /^(localhost|.*\.(localhost|local|internal|lan|home|corp|intranet))$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return null;
  }
  if (host.includes(":")) return null; // IPv6 by number: none needed for public data
  return url;
}

/// The sites each mockup may read, as kept on disk: { [artifact id]: [host, …] }.
export type AllowedSites = Record<string, string[]>;
export function readSites(text: string | null): AllowedSites {
  try {
    const parsed = JSON.parse(text ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([id, hosts]) => /^[\w-]{1,200}$/.test(id) && Array.isArray(hosts))
      .map(([id, hosts]) => [id, (hosts as unknown[]).filter((host): host is string => typeof host === "string" && host.length <= 253).slice(0, 50)]));
  } catch { return {}; }
}
export const siteAllowed = (sites: AllowedSites, id: string, host: string) => (sites[id] ?? []).includes(host.toLowerCase());
export function allowSite(sites: AllowedSites, id: string, host: string): AllowedSites {
  const hosts = sites[id] ?? [];
  return hosts.includes(host.toLowerCase()) ? sites : { ...sites, [id]: [...hosts, host.toLowerCase()].slice(-50) };
}

/// Reads a response's body up to `limit` bytes, or says it is too big.
export async function limitedText(response: Response, limit = FETCH_MAX_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); throw new Error(`That answer is bigger than ${Math.round(limit / 1024 / 1024)} MB`); }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}
