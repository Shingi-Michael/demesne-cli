import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { isRecord } from "@demesne/protocol";
import { toolError, type AgentTool } from "./tools.ts";

/// The web, for the model: search it and read a page. Both only read, so
/// neither asks; neither reaches this machine or its network (localhost,
/// private ranges), so a page can't steer the model into the daemon or a
/// router's admin page.

export const WEB_TOOL_NAMES = new Set(["web_search", "web_fetch"]);

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Demesne";
/// Most answers sit in a page's first screens; nextOffset reads on.
const PAGE_DEFAULT_CHARS = 10_000;
const PAGE_MAX_CHARS = 60_000;
const BODY_MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export interface SearchResult { title: string; url: string; snippet: string }

export interface WebOptions {
  fetcher?: typeof fetch;
  /// Resolves a host to its addresses; tests pass their own.
  resolve?: (host: string) => Promise<string[]>;
}

export function webSearchTool(options: WebOptions = {}): AgentTool {
  const fetcher = options.fetcher ?? fetch;
  return {
    definition: {
      name: "web_search",
      description: "Search the web. Returns up to 10 results (title, url, snippet). Use for docs, error messages, release notes and anything newer than you know; then read the best result with web_fetch. Cite the urls you rely on.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 400 },
          limit: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input, context) {
      if (!isRecord(input) || typeof input.query !== "string" || !input.query.trim()) throw toolError("MISSING_QUERY", "a search needs a query", "say what to look for");
      const limit = typeof input.limit === "number" ? Math.max(1, Math.min(10, Math.floor(input.limit))) : 8;
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query.trim())}`;
      let response: Response;
      try {
        response = await fetcher(url, { headers: { "user-agent": USER_AGENT, accept: "text/html" }, signal: anySignal(context.signal, TIMEOUT_MS) });
      } catch (error) {
        if (context.signal.aborted) throw error;
        throw toolError("SEARCH_UNREACHABLE", "the search engine can't be reached", "check the internet connection, or web_fetch a page you know");
      }
      if (!response.ok) throw toolError("SEARCH_FAILED", `the search engine answered HTTP ${response.status}`, "try again in a moment, or web_fetch a page you know");
      const results = parseSearchResults(await response.text()).slice(0, limit);
      if (!results.length) return JSON.stringify({ query: input.query, results: [], note: "No results. Try fewer or different words." });
      return JSON.stringify({ query: input.query, results });
    },
  };
}

/// DuckDuckGo's HTML results: each link is `result__a`, its text
/// `result__snippet`, and the real address sits in the `uddg` parameter.
export function parseSearchResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const block of blocks) {
    if (/result--ad\b/.test(block.slice(0, 200))) continue;
    const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
      ?? /<a[^>]+href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const url = realUrl(decodeEntities(link[1]!));
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(block);
    results.push({ title: inlineText(link[2]!), url, snippet: snippet ? inlineText(snippet[1]!) : "" });
  }
  return results;
}

function realUrl(href: string): string | null {
  const absolute = href.startsWith("//") ? `https:${href}` : href;
  try {
    const parsed = new URL(absolute, "https://duckduckgo.com");
    const target = parsed.searchParams.get("uddg");
    if (target) return target;
    return /^https?:$/.test(parsed.protocol) && !parsed.hostname.endsWith("duckduckgo.com") ? parsed.href : null;
  } catch {
    return null;
  }
}

export function webFetchTool(options: WebOptions = {}): AgentTool {
  const fetcher = options.fetcher ?? fetch;
  const resolve = options.resolve ?? (async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address));
  return {
    definition: {
      name: "web_fetch",
      description: `Read a web page (http/https) as text: headings, paragraphs, lists, code and links kept, scripts and styling dropped. Returns up to ${PAGE_DEFAULT_CHARS} characters from offset; pass the returned nextOffset to read on. JSON and plain text come back as they are. Pages on this machine or its local network are refused.`,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, maxLength: 4000 },
          offset: { type: "integer", minimum: 0 },
          maxChars: { type: "integer", minimum: 1000, maximum: PAGE_MAX_CHARS },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input, context) {
      if (!isRecord(input) || typeof input.url !== "string") throw toolError("MISSING_URL", "web_fetch needs a url", "pass an http or https address");
      let url: URL;
      try { url = new URL(input.url.trim()); } catch { throw toolError("BAD_URL", `"${input.url}" is not a web address`, "pass a full http or https address"); }
      const offset = typeof input.offset === "number" ? Math.max(0, Math.floor(input.offset)) : 0;
      const maxChars = typeof input.maxChars === "number" ? Math.max(1000, Math.min(PAGE_MAX_CHARS, Math.floor(input.maxChars))) : PAGE_DEFAULT_CHARS;
      const signal = anySignal(context.signal, TIMEOUT_MS);
      // Redirects are followed by hand, so each hop is checked like the first.
      let response: Response | undefined;
      for (let hop = 0; hop < 6; hop++) {
        await assertPublic(url, resolve);
        try {
          response = await fetcher(url.href, { headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5" }, redirect: "manual", signal });
        } catch (error) {
          if (context.signal.aborted) throw error;
          throw toolError("UNREACHABLE", `${url.host} can't be reached`, "check the address, or search for another source");
        }
        const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
        if (!location) break;
        url = new URL(location, url);
        response = undefined;
      }
      if (!response) throw toolError("TOO_MANY_REDIRECTS", "the page redirected too many times", "try another source");
      if (!response.ok) throw toolError("HTTP_ERROR", `${url.host} answered HTTP ${response.status}`, response.status === 404 ? "the page doesn't exist; search for it instead" : "try another source");
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (/^(image|audio|video|font)\/|application\/(pdf|zip|octet-stream)/.test(type)) throw toolError("NOT_TEXT", `the page is ${type.split(";")[0]}, not text`, "look for an HTML or text version");
      const raw = await readBounded(response, BODY_MAX_BYTES);
      const html = /html|xml/.test(type) || (!type && /^\s*<(!doctype|html)/i.test(raw));
      const title = html ? inlineText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? "") : "";
      const text = html ? htmlToText(raw, url) : raw;
      const slice = text.slice(offset, offset + maxChars);
      const end = offset + slice.length;
      return JSON.stringify({
        url: url.href,
        ...(title ? { title } : {}),
        length: text.length,
        ...(end < text.length ? { nextOffset: end } : {}),
        content: slice,
      });
    },
  };
}

export async function assertPublic(url: URL, resolve: (host: string) => Promise<string[]>): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw toolError("BAD_URL", `${url.protocol} addresses can't be read`, "pass an http or https address");
  if (url.username || url.password) throw toolError("BAD_URL", "addresses with a login can't be read", "pass the address without the user and password");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw localRefusal(host);
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try { addresses = await resolve(host); } catch { throw toolError("UNREACHABLE", `${host} doesn't resolve`, "check the address"); }
  }
  if (addresses.some(isPrivateAddress)) throw localRefusal(host);
}

function localRefusal(host: string): Error {
  return toolError("LOCAL_ADDRESS", `${host} is on this machine or its local network`, "web_fetch only reads public pages; use run_command (curl) for a local server");
}

export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (ip === "::" || ip === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(ip);
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= limit) { await reader.cancel().catch(() => {}); break; }
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}

/// A page as readable text: block elements become lines, headings `#`,
/// list items `-`, code blocks fenced, links `text (url)`. Navigation,
/// scripts, styles, forms and other chrome are dropped.
export function htmlToText(html: string, base?: URL): string {
  let body = html.replace(/<!--[\s\S]*?-->/g, "");
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main && inlineText(main[2]!).length > 200) body = main[2]!;
  body = body
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form|button|select)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(link|meta|input|img)\b[^>]*>/gi, " ");
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\n\`\`\`\n${decodeEntities(code.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\n+$/, "")}\n\`\`\`\n\n`);
  body = body.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, text: string) => `\n\n${"#".repeat(Number(level))} ${inlineText(text)}\n\n`);
  body = body.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
    const label = inlineText(text);
    if (!label) return " ";
    let target = decodeEntities(href);
    try { target = new URL(target, base).href; } catch { /* keep as written */ }
    return /^(https?:)/.test(target) && target !== label ? `${label} (${target})` : label;
  });
  body = body.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code: string) => `\`${code.replace(/<[^>]+>/g, "")}\``);
  body = body
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|header|ul|ol|table|tr|blockquote|dl|dt|dd|figure|figcaption|aside|details|summary|hr)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(body)
    .split("\n").map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", middot: "·" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function anySignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
