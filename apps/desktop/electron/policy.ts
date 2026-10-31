import { isAbsolute, resolve, sep } from "node:path";
import { assembledDocument } from "./foundry-assemble.ts";
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
  // anime.js, then the motion runtime (demesne.motion) that lets the pane scrub a page's motions.
  "anime.js": { path: "vendor/anime.umd.min.js", type: "application/javascript; charset=utf-8", then: "kit/motion.js" },
  // Pick an option: pages that mark options with data-option get a Pick button on hover.
  "pick.js": { path: "kit/pick.js", type: "application/javascript; charset=utf-8" },
  ...Object.fromEntries([400, 500, 600].map((weight) => [`fonts/inter-latin-${weight}-normal.woff2`, { path: `vendor/fonts/inter-latin-${weight}-normal.woff2`, type: "font/woff2" }])),
};
export const FOUNDRY_KIT_STYLE = "foundry://kit/base.css", FOUNDRY_KIT_SCRIPT = "foundry://kit/anime.js";
export const FOUNDRY_PICK_SCRIPT = "foundry://kit/pick.js";
/** A page that marks options (data-option) gets the Pick runtime after it. */
export const withPick = (html: string) => /\bdata-option\b/.test(html) ? `${html}\n<script src="${FOUNDRY_PICK_SCRIPT}"></script>` : html;
/** The kit file a foundry://kit/<file> address names, or null. */
export function foundryKitFile(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "foundry:" || url.hostname !== "kit" || url.username || url.password || url.port) return null;
    const name = url.pathname.slice(1);
    return Object.hasOwn(FOUNDRY_KIT, name) ? name : null;
  } catch { return null; }
}
/** A page as it leaves Demesne (Export): the kit it leaned on is inlined,
 * so the file stands on its own. The fonts fall back to the system's. */
export function exportedSource(source: string, kit: { style: string; script: string }) {
  const tag = (name: string, address: string) => new RegExp(`<${name}\\b[^>]*\\b(?:href|src)=["']?${address.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']?[^>]*>(?:\\s*</${name}>)?`, "gi");
  const style = kit.style.replace(/@font-face\{[^}]*foundry:\/\/kit\/[^}]*\}\n?/g, "");
  return source
    .replace(tag("link", FOUNDRY_KIT_STYLE), () => `<style>\n${style}</style>`)
    .replace(tag("script", FOUNDRY_KIT_SCRIPT), () => `<script>${kit.script.replace(/<\//g, "<\\/")}</script>`);
}
/** Where an artifact may load libraries and fonts from: the same short list
 * Claude's artifacts allow, so a chart, React or a real typeface works. */
export const FOUNDRY_SCRIPT_HOSTS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com"] as const;
export const FOUNDRY_FONT_HOSTS = { styles: "https://fonts.googleapis.com", files: "https://fonts.gstatic.com" } as const;
/** What an artifact frame may do: run its own inline code, load the kit,
 * pinned libraries from the hosts above and Google Fonts, and nothing
 * else: no fetch, no forms, no other origins. */
export const FOUNDRY_CSP = `default-src 'none'; script-src 'unsafe-inline' foundry: ${FOUNDRY_SCRIPT_HOSTS.join(" ")}; style-src 'unsafe-inline' foundry: ${FOUNDRY_FONT_HOSTS.styles}; img-src data: blob:; font-src data: foundry: ${FOUNDRY_FONT_HOSTS.files}; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors demesne:`;
/** The first show of a version assembles the page: anime.js and the
 * assembly script ride along, with the previous version to diff against. */
export interface FoundryAssembly { library: string; previous: string | null }
/** The page an artifact frame shows: HTML as written, SVG as an image (so it runs no script). */
export function foundryDocument(kind: string, source: string, title: string, assembly?: FoundryAssembly) {
  const esc = (text: string) => text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
  if (kind === "html") return withPick(assembly ? assembledDocument(source, assembly.library, assembly.previous) : source);
  if (kind === "svg") return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>html,body{margin:0;height:100%;background:transparent}body{display:grid;place-items:center}img{max-width:92%;max-height:92%}${assembly ? "@media(prefers-reduced-motion:no-preference){img{animation:in 600ms cubic-bezier(.2,.8,.2,1)}@keyframes in{from{opacity:0;transform:scale(.6) rotate(-6deg)}}}" : ""}</style><img alt="${esc(title)}" src="data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}">`;
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
export function validateRequest(method: unknown, args: unknown): asserts method is string {
  if (typeof method !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(method) || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid desktop request");
  if (Buffer.byteLength(JSON.stringify(args)) > 260_000) throw new Error("Desktop request is too large");
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
