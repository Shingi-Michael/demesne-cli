import { createDesktopBridge, type DesktopInvoke } from "./frontend-bridge.ts";
import type { WorkspaceSnapshot, StateUpdate } from "./workspace/state-wire.ts";

interface DesktopBootstrap {
  workspace: string | null;
  recentProjects: string[];
  userName?: string;
  snapshot: WorkspaceSnapshot | null;
}
interface DesktopNative {
  glass?: boolean;
  core: { invoke: DesktopInvoke };
  event: {
    listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
  };
}
declare global {
  interface Window { demesneDesktop?: DesktopNative; demesneSystemDark?: boolean }
}
const el = <T extends HTMLElement = HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Desktop UI is missing ${id}.`);
  return element as T;
};
const shell = el("desktop-shell"), home = el("desktop-home"), app = el("app"),
  toolbar = el("desktop-toolbar"), errorPanel = el("desktop-error"),
  startStatus = el("desktop-start-status"), projectsList = el("sidebar-projects"), searchField = el<HTMLInputElement>("sidebar-search");
const native = window.demesneDesktop;
const invoke: DesktopInvoke = <T>(command: string, args?: Record<string, unknown>) => {
  if (!native) return Promise.reject(new Error("Open Demesne with its desktop launcher. This page requires the native application bridge."));
  return native.core.invoke<T>(command, args);
};
const request = <T>(method: string, args: Record<string, unknown> = {}) =>
  invoke<T>("desktop_request", { method, args });
const listeners: (() => void)[] = [];
const mac = /Mac/i.test(navigator.platform);
// The Mac window has no title bar. The window is translucent under the shell
// wherever the desktop blurs what shows through (the Mac, Hyprland).
if (mac) document.documentElement.classList.add("mac-chrome");
if (native?.glass) document.documentElement.classList.add("glass");
document.getElementById("mac-lights")?.addEventListener("click", (event) => {
  const light = (event.target as HTMLElement).closest<HTMLElement>("[data-light]")?.dataset.light;
  if (light) void request("desktop-window", { action: light }).catch(() => {});
});
let workspace: string | null = null, mounted = false, busy = true, fatal = false;
let recentProjects: string[] = [];
const bridge = createDesktopBridge(invoke, showError);
window.demesne = bridge.bridge;
const projectName = (path: string) => path.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || path;
const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error || "The desktop backend stopped responding.");
};
function setBusy(value: boolean, message?: string) {
  busy = value;
  shell.setAttribute("aria-busy", String(value));
  for (const id of ["desktop-error-choose", "desktop-retry"])
    el<HTMLButtonElement>(id).disabled = value;
  for (const button of projectsList.querySelectorAll<HTMLButtonElement>("button")) button.disabled = value;
  if (message !== undefined) {
    startStatus.textContent = message;
    startStatus.dataset.error = "false";
  }
}
function showError(error: unknown) {
  fatal = true;
  app.hidden = toolbar.hidden = home.hidden = true;
  el("desktop-sidebar").hidden = true;
  errorPanel.hidden = false;
  el("desktop-error-message").textContent = errorMessage(error);
  el("desktop-error-title").textContent = mounted ? "The desktop connection stopped." : "Couldn’t open Demesne.";
  setBusy(false);
  el<HTMLButtonElement>("desktop-retry").focus({ preventScroll: true });
  // Shell readiness shows the initially hidden native window even when the
  // workspace UI cannot mount.
  void request("desktop-ready").catch(() => {});
}
function showActionError(error: unknown) {
  if (fatal) {
    el("desktop-error-message").textContent = errorMessage(error);
    return;
  }
  if (!mounted) {
    setBusy(false, errorMessage(error));
    startStatus.dataset.error = "true";
  } else {
    const notice = el("notice");
    notice.textContent = errorMessage(error);
    notice.hidden = false;
    setTimeout(() => { notice.hidden = true; }, 6000);
  }
}
function renderProjects() {
  document.title = workspace ? `${projectName(workspace)} — Demesne` : "Demesne";
  el("sidebar-sessions").dataset.projects = JSON.stringify(recentProjects);
  el("sidebar-sessions").dataset.workspace = workspace ?? "";
}
async function applyBootstrap(result: DesktopBootstrap) {
  if (fatal) return;
  document.body.dataset.user = result.userName ?? "";
  const previous = workspace;
  workspace = result.workspace;
  recentProjects = [...new Set(result.recentProjects.filter((path) => typeof path === "string"))];
  renderProjects();
  // With no project yet, Home still opens, as Just a chat.
  if (!result.snapshot) throw new Error("Demesne opened without a workspace connection. Try again to restart the desktop backend.");
  // Each WorkspaceHost has its own revision sequence and UI listeners. Reloading
  // makes project changes atomic, resets StateReceiver, and avoids double mounts.
  if (mounted && previous !== workspace) {
    window.location.reload();
    return;
  }
  home.hidden = errorPanel.hidden = true;
  toolbar.hidden = app.hidden = false;
  el("desktop-sidebar").hidden = false;
  if (!mounted) {
    mounted = true;
    await import("./workspace/live.ts");
  }
  setBusy(false, "");
}
/// `fresh` opens a new chat there carrying `draft`: Home's where word.
async function openProject(path?: string, sessionId?: string, fresh?: { draft: string }) {
  if (busy) return;
  setBusy(true, "Opening project…");
  try {
    const result = await request<DesktopBootstrap>(path ? "desktop-open-project" : "desktop-select-project", { ...(path ? { path, ...(sessionId ? { sessionId } : {}) } : {}), ...(fresh ? { fresh: true, draft: fresh.draft } : {}) });
    // A successful recovery gets a fresh webview, including UI listeners.
    if (fatal && result.workspace && result.snapshot) { window.location.reload(); return; }
    await applyBootstrap(result);
  } catch (error) {
    showActionError(error);
  } finally {
    setBusy(false);
  }
}
for (const id of ["desktop-error-choose", "sidebar-open-project"])
  el(id).addEventListener("click", () => { void openProject(); });
document.addEventListener("demesne:open-project", (event) => {
  const { path, sessionId, fresh, draft } = (event as CustomEvent<{ path?: string; sessionId?: string; fresh?: boolean; draft?: string }>).detail;
  void openProject(path, sessionId, fresh ? { draft: draft ?? "" } : undefined);
});
el("desktop-retry").addEventListener("click", () => window.location.reload());
document.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  const key = event.key.toLowerCase(), modifier = event.metaKey || event.ctrlKey;
  if (modifier && !event.altKey && !event.shiftKey && ["o", "q", "n"].includes(key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === "o") void openProject();
    else if (key === "n") { if (mounted && !fatal && !busy) el("desktop-sidebar").querySelector<HTMLButtonElement>('[data-action="new-session"]')?.click(); }
    else void request("desktop-quit").catch(showActionError);
    return;
  }
}, true);
window.addEventListener("beforeunload", () => {
  for (const unlisten of listeners.splice(0)) unlisten();
  bridge.dispose();
});
const appearance = matchMedia("(prefers-color-scheme: dark)");
function updateAppearance(dark=appearance.matches) {
  window.demesneSystemDark=dark;
  document.dispatchEvent(new CustomEvent("demesne:system-appearance",{detail:{dark}}));
  return request("desktop-appearance", { dark });
}
async function start() {
  try {
    if (!native) throw new Error("Open Demesne with its desktop launcher. This page requires the native application bridge.");
    listeners.push(...await Promise.all([
      native.event.listen<StateUpdate>("demesne:update", (event) => bridge.update(event.payload)),
      native.event.listen<unknown>("demesne:desktop-error", (event) => showError(event.payload)),
      native.event.listen<{ action: "open-project" | "settings" | "open-chat" | "fullscreen" | "appearance" | "close-tab" | "notify-answer"; sessionId?: string; path?: string; on?: boolean; top?: number; dark?: boolean; key?: string; index?: number; text?: string }>("demesne:desktop-action", (event) => {
        if(event.payload.action==="appearance")void updateAppearance(event.payload.dark===true).catch(showActionError);
        else if (event.payload.action === "fullscreen") {
          document.documentElement.classList.toggle("fullscreen", event.payload.on === true);
          // Below the camera notch, which simple full screen also covers.
          document.documentElement.style.setProperty("--notch-top", `${Math.max(0, Number(event.payload.top) || 0)}px`);
          document.getElementById("mac-lights")!.hidden = !(mac && event.payload.on === true);
        }
        else if (event.payload.action === "open-project") void openProject();
        else if (event.payload.action === "open-chat" && mounted && !fatal)
          document.dispatchEvent(new CustomEvent("demesne:open-chat", { detail: { sessionId: event.payload.sessionId, path: event.payload.path } }));
        else if (event.payload.action === "notify-answer" && mounted && !fatal)
          document.dispatchEvent(new CustomEvent("demesne:notify-answer", { detail: { key: event.payload.key, index: event.payload.index, text: event.payload.text } }));
        else if (event.payload.action === "close-tab" && mounted && !fatal)
          document.dispatchEvent(new Event("demesne:close-tab"));
        else if (event.payload.action === "settings" && mounted && !fatal && !busy)
          document.dispatchEvent(new Event("demesne:open-settings"));
      }),
    ]));
    const initial=await request<{dark:boolean} | null>("desktop-theme",{system:true});
    await updateAppearance(initial?.dark ?? appearance.matches);
    if (fatal) return;
    await applyBootstrap(await request<DesktopBootstrap>("desktop-bootstrap"));
  } catch (error) { showError(error); }
}
setBusy(true);
void start();

const sidebarToggle = el<HTMLButtonElement>("desktop-toggle-sidebar");
// The folded sidebar peeks out (pass 76 B): rest on the rail's empty space
// and the whole sidebar slides out over the panel. Picking a chat, Esc, or
// moving away (after a short grace, so crossing to it never drops it) puts
// it back; the rail's own buttons stay buttons.
const sidebar = el("desktop-sidebar");
let peekTimer: ReturnType<typeof setTimeout> | undefined;
/// Folded, the sidebar is a 60px rail: the mark, +, and dots for what waits.
function setSidebarCollapsed(collapsed: boolean) {
  setPeek(false);
  shell.classList.toggle("sidebar-collapsed", collapsed);
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  try { localStorage.setItem("demesne-sidebar-collapsed", String(collapsed)); } catch {}
}
try { setSidebarCollapsed(localStorage.getItem("demesne-sidebar-collapsed") === "true"); } catch {}
sidebarToggle.addEventListener("click", () => setSidebarCollapsed(!shell.classList.contains("sidebar-collapsed")));
for (const id of ["rail-expand", "rail-sessions"]) el(id).addEventListener("click", () => setSidebarCollapsed(false));
function setPeek(on: boolean) {
  clearTimeout(peekTimer);
  peekTimer = undefined;
  shell.classList.toggle("sidebar-peek", on && shell.classList.contains("sidebar-collapsed"));
}
const peeking = () => shell.classList.contains("sidebar-peek");
sidebar.addEventListener("pointermove", (event) => {
  if (!shell.classList.contains("sidebar-collapsed")) return;
  if (peeking()) { clearTimeout(peekTimer); peekTimer = undefined; return; }
  if ((event.target as Element).closest("button")) { clearTimeout(peekTimer); peekTimer = undefined; return; }
  peekTimer ??= setTimeout(() => setPeek(true), 250);
});
sidebar.addEventListener("pointerleave", () => {
  clearTimeout(peekTimer);
  peekTimer = peeking() ? setTimeout(() => setPeek(false), 180) : undefined;
});
sidebar.addEventListener("click", (event) => {
  if (peeking() && (event.target as Element).closest(".sidebar-session, [data-action='new-session'], [data-action='page-open']")) setTimeout(() => setPeek(false), 0);
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && peeking()) setPeek(false); });
// Search is always there; Escape clears it and gives the list back.
searchField.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (searchField.value) { searchField.value = ""; searchField.dispatchEvent(new Event("input")); }
  searchField.blur();
});
// The Dock icon counts the chats that need you, so it shows from any app.
let badge = -1;
document.addEventListener("demesne:needs-you", (event) => {
  const count = Number((event as CustomEvent<number>).detail) || 0;
  if (count === badge) return;
  badge = count;
  void request("desktop-badge", { count }).catch(() => {});
});
// While anything works, the Dock icon shows it (an indeterminate bar on the Mac, a pulse on Linux docks).
let working: boolean | null = null;
document.addEventListener("demesne:working", (event) => {
  const on = (event as CustomEvent<boolean>).detail === true;
  if (on === working) return;
  working = on;
  void request("desktop-working", { on }).catch(() => {});
});
// The shortcuts live in tooltips, not on the rows.
document.querySelector("#desktop-sidebar .sidebar-nav [data-action='new-session']")?.setAttribute("title", `New chat (${mac ? "⌘N" : "Ctrl+N"})`);
el("sidebar-search").setAttribute("title", `Search (${mac ? "⌘K" : "Ctrl+K"})`);
document.querySelector(".sidebar-settings")?.setAttribute("title", `Settings (${mac ? "⌘," : "Ctrl+,"})`);
