import { isAbsolute, resolve, sep } from "node:path";
import { assembledDocument } from "./foundry-assemble.ts";
export const APP_URL = "demesne://app/index.html";
/** Whether the desktop blurs what shows through a see-through window, so the
 *  shell can be glass: the Mac does (vibrancy), and so does Hyprland, which
 *  blurs behind any window with clear pixels. KDE and GNOME don't blur a window
 *  that hasn't asked them to, so there it stays solid. DEMESNE_GLASS=1 or 0
 *  says so on any other Linux desktop that blurs (SwayFX, Wayfire, a KWin
 *  script) or doesn't. */
export function desktopBlurs(platform: string, env: Record<string, string | undefined>) {
  if (platform === "darwin") return true;
  if (platform !== "linux") return false;
  if (env.DEMESNE_GLASS === "1" || env.DEMESNE_GLASS === "0") return env.DEMESNE_GLASS === "1";
  return (Boolean(env.HYPRLAND_INSTANCE_SIGNATURE) || /hyprland/i.test(env.XDG_CURRENT_DESKTOP ?? ""));
}
/** The Mac's blur under the glass. "fullscreen-ui" unless DEMESNE_VIBRANCY
 *  names another material, so a lighter one can be tried on a real screen. */
const VIBRANCIES = ["fullscreen-ui", "under-window", "hud", "sidebar", "window", "content", "header", "titlebar", "menu", "popover", "sheet", "tooltip", "under-page"] as const;
export function macVibrancy(env: Record<string, string | undefined>): (typeof VIBRANCIES)[number] {
  return VIBRANCIES.find((name) => name === env.DEMESNE_VIBRANCY) ?? "fullscreen-ui";
}
/** Project changes reload the shell; other destinations and frames stay blocked. */
export const allowAppReload = (url: string, isMainFrame: boolean) => isMainFrame && url === APP_URL;
/** A chat's live preview may load only pages served on this machine. */
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
/** Where an artifact may load libraries and fonts from: the same short list
 * Claude's artifacts allow, so a chart, React or a real typeface works. */
export const FOUNDRY_SCRIPT_HOSTS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com"] as const;
export const FOUNDRY_FONT_HOSTS = { styles: "https://fonts.googleapis.com", files: "https://fonts.gstatic.com" } as const;
/** What an artifact frame may do: run its own inline code, load pinned
 * libraries from the hosts above and Google Fonts, and nothing else: no
 * fetch, no forms, no other origins. */
export const FOUNDRY_CSP = `default-src 'none'; script-src 'unsafe-inline' ${FOUNDRY_SCRIPT_HOSTS.join(" ")}; style-src 'unsafe-inline' ${FOUNDRY_FONT_HOSTS.styles}; img-src data: blob:; font-src data: ${FOUNDRY_FONT_HOSTS.files}; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors demesne:`;
/** The first show of a version assembles the page: anime.js and the
 * assembly script ride along, with the previous version to diff against. */
export interface FoundryAssembly { library: string; previous: string | null }
/** The page an artifact frame shows: HTML as written, SVG as an image (so it runs no script). */
export function foundryDocument(kind: string, source: string, title: string, assembly?: FoundryAssembly) {
  const esc = (text: string) => text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
  if (kind === "html") return assembly ? assembledDocument(source, assembly.library, assembly.previous) : source;
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
