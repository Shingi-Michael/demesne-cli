import { isAbsolute, resolve, sep } from "node:path";
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
/** Project changes reload the shell; other destinations and frames stay blocked. */
export const allowAppReload = (url: string, isMainFrame: boolean) => isMainFrame && url === APP_URL;
/** A chat's live preview may load only pages served on this machine. */
export function previewURL(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
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
