import { isAbsolute, resolve, sep } from "node:path";
import { isReadyKind, renderReadyKind } from "./foundry-kinds.ts";
import { codePage, mermaidPage, reactPage, sheetPage, boardPage } from "./foundry-more-kinds.ts";
export const APP_URL = "demesne://app/index.html";
/** Whether the window is glass, with the Glass slider in Settings: on the
 *  Mac, Windows and Linux alike. DEMESNE_GLASS=0 keeps Linux or Windows
 *  solid. */
export function desktopGlass(platform: string, env: Record<string, string | undefined>) {
  if (platform === "darwin") return true;
  if (platform !== "linux" && platform !== "win32") return false;
  return env.DEMESNE_GLASS !== "0";
}
/** Whether the desktop blurs what shows through the window: the Mac does
 *  (vibrancy), Windows does (acrylic), and so does Hyprland, which blurs
 *  behind any window with clear pixels. Other Linux desktops (KDE, GNOME)
 *  show the wallpaper sharp, so the glass starts more solid there.
 *  DEMESNE_GLASS=1 says a desktop blurs (SwayFX, Wayfire, a KWin script). */
export function desktopBlurs(platform: string, env: Record<string, string | undefined>) {
  if (platform === "darwin" || platform === "win32") return true;
  if (platform !== "linux") return false;
  if (env.DEMESNE_GLASS === "1") return true;
  return (Boolean(env.HYPRLAND_INSTANCE_SIGNATURE) || /hyprland/i.test(env.XDG_CURRENT_DESKTOP ?? ""));
}
/** The Mac's blur under the glass: "hud", which let the most wallpaper colour
 *  through on a real screen (fullscreen-ui close behind, under-window ~40%
 *  greyer). DEMESNE_VIBRANCY names another material to try. */
const VIBRANCIES = ["hud", "fullscreen-ui", "under-window", "sidebar", "window", "content", "header", "titlebar", "menu", "popover", "sheet", "tooltip", "under-page"] as const;
export function macVibrancy(env: Record<string, string | undefined>): (typeof VIBRANCIES)[number] {
  return VIBRANCIES.find((name) => name === env.DEMESNE_VIBRANCY) ?? "hud";
}
/** macOS 26 (Darwin 25) gets the clear window, and Apple's liquid glass
 *  (NSGlassEffectView) on request. Naming a material in DEMESNE_VIBRANCY
 *  keeps the older frosted blur. */
export function liquidGlass(platform: string, darwinRelease: string, env: Record<string, string | undefined>) {
  return platform === "darwin" && Number(darwinRelease.split(".")[0]) >= 25 && !env.DEMESNE_VIBRANCY;
}
/** Project changes reload the shell; other destinations and frames stay blocked. */
export const allowAppReload = (url: string, isMainFrame: boolean) => isMainFrame && url === APP_URL;
/** A chat's live preview may load only pages served on this machine. */
type Rect = { x: number; y: number; width: number; height: number };
/** How far down the Mac's simple full screen must start so nothing sits
 *  behind the camera notch. Simple full screen covers the whole display, the
 *  notch's strip included (macOS's own full screen leaves that strip black).
 *  On a notched display the menu bar is as tall as the notch (about 32–38pt,
 *  against 24–25pt elsewhere), so its height is the inset. With the menu bar
 *  hidden it can't be measured: a built-in display with the notched panels'
 *  taller shape gets the usual 38pt. */
export function notchInset(display: { bounds: Rect; workArea: Rect; internal?: boolean }) {
  const bar = display.workArea.y - display.bounds.y;
  if (bar > 30) return bar;
  if (bar > 0) return 0;
  return display.internal && display.bounds.height / display.bounds.width > 0.64 ? 38 : 0;
}

export function previewURL(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
/** A Foundry artifact's frame: foundry://artifact/<id>?v=<version>. */
export function foundryURL(value: string) {
  try { const url = new URL(value); return url.protocol === "foundry:" && url.hostname === "artifact" && /^\/[\w-]{1,200}$/.test(url.pathname) && !url.username && !url.password && !url.port; } catch { return false; }
}
/** The Foundry kit, served to every artifact frame from inside the app at
 * foundry://kit/<file>: the base stylesheet a page starts from, anime.js
 * with the motion runtime, and Inter. Each file's place in the app's ui
 * folder, its type, and a file served after it. */
export const FOUNDRY_KIT: Record<string, { path: string; type: string; then?: string }> = {
  "base.css": { path: "kit/base.css", type: "text/css; charset=utf-8" },
  // anime.js, then motion.js, which keeps older pages' demesne.motion() calls working.
  "anime.js": { path: "vendor/anime.umd.min.js", type: "application/javascript; charset=utf-8", then: "kit/motion.js" },
  // Parts: frames, Demesne's own shell and pieces, icons, avatars, charts.
  "parts.js": { path: "kit/parts.js", type: "application/javascript; charset=utf-8" },
  // Demesne's own styles, scoped to the window <d-demesne> draws (foundry-kit/scope-app.ts); parts.js loads it.
  "app.css": { path: "kit/app.css", type: "text/css; charset=utf-8" },
  // The ready kinds (foundry-kinds.ts): how a Deck, a Doc and a Dashboard look and move.
  "kinds.css": { path: "kit/kinds.css", type: "text/css; charset=utf-8" },
  "kinds.js": { path: "kit/kinds.js", type: "application/javascript; charset=utf-8" },
  // Pages that remember: demesne.save / load / ask / pick. Demesne puts it in front of every page (withRemember).
  "remember.js": { path: "kit/remember.js", type: "application/javascript; charset=utf-8" },
  // Foundry plays a page's demo (pass 221 A): put in front of pages on the Foundry page, with the try runtime.
  "demo.js": { path: "kit/demo.js", type: "application/javascript; charset=utf-8" },
  // Notes on a mockup (pass 233 A): put in front of pages on the Foundry page; it tells the page which part is under the pointer.
  "note.js": { path: "kit/note.js", type: "application/javascript; charset=utf-8" },
  // Every variant explained (pass 263 A): put in front of pages on the Foundry page; it numbers the parts its walkthrough names.
  "marks.js": { path: "kit/marks.js", type: "application/javascript; charset=utf-8" },
  // Edit in place (step 3): put in front of a deck, doc or dashboard on the Foundry page while you edit its text, instead of the demo and notes.
  "edit.js": { path: "kit/edit.js", type: "application/javascript; charset=utf-8" },
  // More kinds (foundry-more-kinds.ts): what a React page, a Mermaid diagram runs on, from the app, so they work offline.
  "react.js": { path: "kit/react.js", type: "application/javascript; charset=utf-8" },
  "react-dom.js": { path: "kit/react-dom.js", type: "application/javascript; charset=utf-8" },
  "prop-types.js": { path: "kit/prop-types.js", type: "application/javascript; charset=utf-8" },
  "lucide.js": { path: "kit/lucide.js", type: "application/javascript; charset=utf-8" },
  "recharts.js": { path: "kit/recharts.js", type: "application/javascript; charset=utf-8" },
  "tailwind.js": { path: "kit/tailwind.js", type: "application/javascript; charset=utf-8" },
  "mermaid.js": { path: "kit/mermaid.js", type: "application/javascript; charset=utf-8" },
  // Errors come back: put first in front of pages on the Foundry page; it tells the page when the mockup throws while you use it.
  "errors.js": { path: "kit/errors.js", type: "application/javascript; charset=utf-8" },
  ...Object.fromEntries([400, 500, 600].map((weight) => [`fonts/inter-latin-${weight}-normal.woff2`, { path: `vendor/fonts/inter-latin-${weight}-normal.woff2`, type: "font/woff2" }])),
  ...Object.fromEntries([400, 500].map((weight) => [`fonts/jetbrains-mono-latin-${weight}-normal.woff2`, { path: `vendor/fonts/jetbrains-mono-latin-${weight}-normal.woff2`, type: "font/woff2" }])),
};
/** The kinds whose pages can play a demo on the Foundry page. */
export const FOUNDRY_DEMO_KINDS = new Set(["html", "deck", "doc", "dashboard", "react", "mermaid", "code"]);
/** A page's own calls to Demesne: foundry://data/<id> keeps what the page
 * saves, foundry://ask/<id> asks the chat's model. Null for anything else. */
/** What a page may ask Demesne for: its saves, the model, and real data (read, list, fetch: foundry-data.ts). */
export const PAGE_CALLS = ["data", "ask", "read", "list", "fetch"] as const;
export type PageCall = typeof PAGE_CALLS[number];
export function foundryPageCall(value: string): { what: PageCall; id: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "foundry:" || !(PAGE_CALLS as readonly string[]).includes(url.hostname) || url.username || url.password || url.port || url.search) return null;
    const id = decodeURIComponent(url.pathname.slice(1));
    return /^[\w-]{1,200}$/.test(id) ? { what: url.hostname as PageCall, id } : null;
  } catch { return null; }
}
/** Pass 240 A: a real picture a mockup shows, served from inside the app at
 * foundry://shot/<artifact>/<picture>, or null when the address is not one. */
export function foundryShotURL(value: string): { id: string; shot: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "foundry:" || url.hostname !== "shot" || url.username || url.password || url.port || url.search) return null;
    const [id, shot, ...rest] = url.pathname.slice(1).split("/").map(decodeURIComponent);
    return !rest.length && id && shot && /^[\w-]{1,200}$/.test(id) && /^[\w-]{1,200}$/.test(shot) ? { id, shot } : null;
  } catch { return null; }
}
/** The pictures a page shows (<d-shot src>), told to the kit before the page's
 * own scripts run: where each one is, its pixels and its pixels per point. */
export interface ShotPlace { url: string; width: number; height: number; scale: number }
export function withShots(html: string, shots: Record<string, ShotPlace>) {
  return Object.keys(shots).length ? withRemember(html, `window.__demesneShots=${JSON.stringify(shots).replace(/</g, "\\u003c")};`) : html;
}
/** Step 6: picture:IMAGE_ID, a picture from the chat in any kind, becomes
 * where Demesne serves it (or its data, for the look and a saved copy).
 * Only pictures the mockup keeps; any other stays as written. */
export function withPictures(page: string, places: Record<string, string>) {
  return Object.keys(places).length ? page.replace(/\bpicture:([A-Za-z0-9_-]{1,200})/g, (whole, id: string) => Object.hasOwn(places, id) ? places[id]! : whole) : page;
}
/** A page uses the remember runtime when it calls one of its four functions. */
export const usesRemember = (html: string) => /\bdemesne\s*\.\s*(?:save|load|ask|pick|read|list|fetch)\s*\(/.test(html);
/** A page that uses it gets the runtime first, before its own scripts run. With
 * a page (its id and the key Demesne made for it) saves and asks reach
 * Demesne; without one (the look window, an exported file) they stay in the
 * page. A script before <html> would not change the document's mode once
 * the doctype is read, so it goes straight after the doctype. */
export function withRemember(html: string, runtime: string, page?: { id: string; key: string }) {
  const script = `${page ? `<script>window.__demesnePage=${JSON.stringify(page).replace(/</g, "\\u003c")};</script>` : ""}<script>${runtime.replace(/<\//g, "<\\/")}</script>`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${doctype[0]}${script}${html.slice(doctype[0].length)}` : `${script}${html}`;
}
/** Pass 262 C: a page as it leaves Demesne (Save a copy). The kit it leans
 * on is inlined so the file stands on its own; a page that remembers keeps
 * its saves in the browser once it is a file. Fonts fall back to the system's. */
/// `libs`: the libraries a React page or a Mermaid diagram loads from the kit (react.js, mermaid.js…), by name, inlined too.
export function exportedSource(source: string, kit: { style: string; script: string; parts: string; kinds: { style: string; script: string }; remember: string }, libs: Record<string, string> = {}) {
  if (usesRemember(source)) source = withRemember(source, kit.remember);
  const tag = (name: string, address: string) => new RegExp(`<${name}\\b[^>]*\\b(?:href|src)=["']?${address.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']?[^>]*>(?:\\s*</${name}>)?`, "gi");
  const inline = (code: string) => code.replace(/<\//g, "<\\/");
  const style = kit.style.replace(/@font-face\s*\{[^}]*foundry:\/\/kit\/[^}]*\}\n?/g, "");
  return source
    .replace(tag("link", "foundry://kit/base.css"), () => `<style>\n${style}</style>`)
    .replace(tag("script", "foundry://kit/anime.js"), () => `<script>${inline(kit.script)}</script>`)
    .replace(tag("script", "foundry://kit/parts.js"), () => `<script>${inline(kit.parts)}</script>`)
    .replace(tag("link", "foundry://kit/kinds.css"), () => `<style>\n${kit.kinds.style}</style>`)
    .replace(tag("script", "foundry://kit/kinds.js"), () => `<script>${inline(kit.kinds.script)}</script>`)
    .replace(/<script\b[^>]*\bsrc=["']?foundry:\/\/kit\/([\w.-]+)["']?[^>]*>\s*<\/script>/gi, (whole, name: string) => Object.hasOwn(libs, name) ? `<script>${inline(libs[name]!)}</script>` : whole);
}
/** Pass 262 C: the file a saved copy gets in Downloads: the artifact's name
 * made safe, its version, and the extension; a number when that is taken. */
export function copyName(title: string, version: number, extension: string, taken: (name: string) => boolean) {
  const base = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Mockup"} v${version}`;
  for (let n = 1; n < 1000; n++) {
    const name = `${base}${n > 1 ? ` (${n})` : ""}.${extension}`;
    if (!taken(name)) return name;
  }
  return `${base} ${Date.now()}.${extension}`;
}
/** The kit file a foundry://kit/<file> address names, or null. */
export function foundryKitFile(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "foundry:" || url.hostname !== "kit" || url.username || url.password || url.port) return null;
    const name = url.pathname.slice(1);
    return Object.hasOwn(FOUNDRY_KIT, name) ? name : null;
  } catch { return null; }
}
/** Where an artifact may load libraries and fonts from: the same short list
 * Claude's artifacts allow, so a chart, React or a real typeface works. */
export const FOUNDRY_SCRIPT_HOSTS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com"] as const;
export const FOUNDRY_FONT_HOSTS = { styles: "https://fonts.googleapis.com", files: "https://fonts.gstatic.com" } as const;
/** What an artifact frame may do: run its own inline code, load the kit,
 * pinned libraries from the hosts above and Google Fonts, and nothing
 * else: no forms, no other origins. Its only fetch is to foundry:, for
 * what the page saves and asks (foundryPageCall). */
export const FOUNDRY_CSP = `default-src 'none'; script-src 'unsafe-inline' foundry: ${FOUNDRY_SCRIPT_HOSTS.join(" ")}; style-src 'unsafe-inline' foundry: ${FOUNDRY_FONT_HOSTS.styles}; img-src data: blob: foundry:; connect-src foundry:; font-src data: foundry: ${FOUNDRY_FONT_HOSTS.files}; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors demesne:`;
/** The page an artifact frame shows: HTML as written, SVG as an image (so it runs no script). */
export function foundryDocument(kind: string, source: string, title: string) {
  const esc = (text: string) => text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
  // A Deck, a Doc or a Dashboard: the content drawn by the app's own renderer.
  if (isReadyKind(kind)) return renderReadyKind(kind, source, title);
  if (kind === "html") return source;
  if (kind === "react") return reactPage(source, title);
  if (kind === "mermaid") return mermaidPage(source, title);
  if (kind === "code") return codePage(source, title);
  if (kind === "sheet") return sheetPage(source, title);
  if (kind === "board") return boardPage(source, title);
  if (kind === "svg") return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>html,body{margin:0;height:100%;background:transparent}body{display:grid;place-items:center}img{max-width:92%;max-height:92%}</style><img alt="${esc(title)}" src="data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}">`;
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><pre style="white-space:pre-wrap;font:14px/1.6 system-ui;padding:24px">${esc(source)}</pre>`;
}
export const EVENTS = ["demesne:update", "demesne:desktop-error", "demesne:desktop-action"] as const;
export function localAppURL(value: string) {
  try { const url = new URL(value); return url.protocol === "demesne:" && url.hostname === "app" && !url.port && !url.username && !url.password; } catch { return false; }
}
export function assetPath(root: string, value: string) {
  if (!localAppURL(value)) throw new Error("Invalid application origin");
  const path = decodeURIComponent(new URL(value).pathname);
  if (path.includes("\\") || path.includes("\0")) throw new Error("Invalid asset path");
  const target = resolve(root, `.${path === "/" ? "/index.html" : path}`);
  if (!target.startsWith(resolve(root) + sep)) throw new Error("Invalid asset path");
  return target;
}
/// Requests that carry a picture (base64) get room for one; the page fits
/// big pictures first (fit-image.ts), so this is a backstop.
export const PICTURE_REQUESTS = new Set(["attach", "socials-share", "image-convert"]);
export const PICTURE_REQUEST_BYTES = 32 * 1024 * 1024;
export function validateRequest(method: unknown, args: unknown): asserts method is string {
  if (typeof method !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(method) || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid desktop request");
  const limit = PICTURE_REQUESTS.has(method) ? PICTURE_REQUEST_BYTES : 260_000;
  if (Buffer.byteLength(JSON.stringify(args)) > limit) throw new Error(PICTURE_REQUESTS.has(method) ? "That picture is too big to send" : "Desktop request is too large");
}
export function openTarget(value: unknown): "url" | "file" {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("Invalid item to open");
  if (isAbsolute(value)) return "file";
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsupported link protocol");
  return "url";
}
export const ZOOM_LEVELS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
/// Bumped when the app's own scale changes, so an older saved zoom no longer applies.
export const ZOOM_VERSION = 2;
export function nextZoom(current: number, step: number) {
  return step === 0 ? 1 : step > 0 ? ZOOM_LEVELS.find(level => level > current + 1e-9) ?? current : [...ZOOM_LEVELS].reverse().find(level => level < current - 1e-9) ?? current;
}
/// Google's own sign-in pages, which refuse a browser inside an app ("This browser or app may not be secure").
/// They open in the person's own browser instead, and the site comes back signed in (browser-signins.ts).
export function outsideSignin(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname === "accounts.google.com" && !/^\/(?:Logout|ServiceLogout|o\/oauth2\/revoke)/i.test(parsed.pathname); } catch { return false; }
}
/// A find or zoom key pressed on the page (⌘ on a Mac, Ctrl elsewhere).
export function browserKey(input: { type: string; key: string; meta: boolean; control: boolean; alt: boolean; shift: boolean }, mac = process.platform === "darwin"): string {
  if (input.type !== "keyDown" || input.alt || !(mac ? input.meta : input.control)) return "";
  const key = input.key.toLowerCase();
  if (key === "f" && !input.shift) return "find";
  if (key === "g") return input.shift ? "find-back" : "find-next";
  if (key === "=" || key === "+") return "zoom-in";
  if (key === "-" || key === "_") return "zoom-out";
  if (key === "0" && !input.shift) return "zoom-reset";
  return "";
}
/// Where the browser split says its page area is (the page's own pixels), as a place in the window
/// for the real page (browser-inapp.ts): whole points, kept inside the window, or nothing when it is too small to show.
export function placeRect(value: unknown, zoom: number, bounds: { width: number; height: number }): { x: number; y: number; width: number; height: number } | null {
  if (!value || typeof value !== "object") return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const k = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const left = Math.max(0, Math.round((x as number) * k)), top = Math.max(0, Math.round((y as number) * k));
  const right = Math.min(bounds.width, Math.round(((x as number) + (width as number)) * k)), bottom = Math.min(bounds.height, Math.round(((y as number) + (height as number)) * k));
  return right - left >= 120 && bottom - top >= 120 ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

