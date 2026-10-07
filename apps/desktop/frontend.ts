import { createDesktopBridge, type DesktopInvoke } from "./frontend-bridge.ts";
import type { GraphicsSnapshot, StateUpdate } from "../graphics/state-wire.ts";
import type { GraphicsUICommand } from "../graphics/drive-controller.ts";

interface DesktopBootstrap {
  workspace: string | null;
  recentProjects: string[];
  snapshot: GraphicsSnapshot | null;
}
interface TauriGlobal {
  core: { invoke: DesktopInvoke };
  event: {
    listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
  };
}
declare global {
  interface Window { __TAURI__?: TauriGlobal }
}
const el = <T extends HTMLElement = HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Desktop UI is missing ${id}.`);
  return element as T;
};
const shell = el("desktop-shell"), home = el("desktop-home"), app = el("app"),
  toolbar = el("desktop-toolbar"), errorPanel = el("desktop-error"),
  startStatus = el("desktop-start-status"), menu = el("desktop-project-menu"),
  projectButton = el<HTMLButtonElement>("desktop-project-button"),
  chooser = el<HTMLButtonElement>("desktop-choose-project");
const native = window.__TAURI__;
const invoke: DesktopInvoke = <T>(command: string, args?: Record<string, unknown>) => {
  if (!native) return Promise.reject(new Error("Open Demesne with its desktop launcher. This page requires the native application bridge."));
  return native.core.invoke<T>(command, args);
};
const request = <T>(method: string, args: Record<string, unknown> = {}) =>
  invoke<T>("desktop_request", { method, args });
const listeners: (() => void)[] = [];
const mac = /Mac/i.test(navigator.platform);
const openShortcut = mac ? "⌘O" : "Ctrl+O";
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
  for (const id of ["desktop-choose-project", "desktop-error-choose", "desktop-retry"])
    el<HTMLButtonElement>(id).disabled = value;
  for (const button of menu.querySelectorAll<HTMLButtonElement>("button")) button.disabled = value;
  for (const button of el("desktop-recent-list").querySelectorAll<HTMLButtonElement>("button")) button.disabled = value;
  if (message !== undefined) {
    startStatus.textContent = message;
    startStatus.dataset.error = "false";
  }
}
function showError(error: unknown) {
  fatal = true;
  closeMenu(false);
  app.hidden = toolbar.hidden = home.hidden = true;
  errorPanel.hidden = false;
  el("desktop-error-message").textContent = errorMessage(error);
  el("desktop-error-title").textContent = mounted ? "The desktop connection stopped." : "Couldn’t open Demesne.";
  setBusy(false);
  el<HTMLButtonElement>("desktop-retry").focus({ preventScroll: true });
  // Shell readiness shows the initially hidden native window even when the
  // workspace UI cannot mount. Drive commands still wait for bridge.ready().
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
function closeMenu(focus: boolean) {
  if (menu.hidden) return;
  menu.hidden = true;
  projectButton.setAttribute("aria-expanded", "false");
  if (focus) projectButton.focus({ preventScroll: true });
}
function recentButton(path: string, inMenu: boolean) {
  const button = document.createElement("button");
  button.type = "button";
  if (inMenu) button.setAttribute("role", "menuitem");
  button.title = path;
  const title = document.createElement(inMenu ? "span" : "strong");
  title.textContent = projectName(path);
  const detail = document.createElement("small");
  detail.textContent = path;
  if (inMenu) button.append(title, detail);
  else {
    const copy = document.createElement("span"), arrow = document.createElement("span");
    copy.append(title, detail);
    arrow.className = "desktop-recent-arrow";
    arrow.textContent = "↗";
    arrow.setAttribute("aria-hidden", "true");
    button.append(copy, arrow);
  }
  button.addEventListener("click", () => { void openProject(path); });
  return button;
}
function renderProjects() {
  const list = el("desktop-recent-list");
  list.replaceChildren(...recentProjects.slice(0, 6).map((path) => recentButton(path, false)));
  el("desktop-recent").hidden = !recentProjects.length;
  menu.replaceChildren();
  for (const path of recentProjects.filter((path) => path !== workspace).slice(0, 10))
    menu.append(recentButton(path, true));
  if (menu.children.length) menu.append(document.createElement("hr"));
  const open = document.createElement("button"), label = document.createElement("span"), key = document.createElement("kbd");
  open.type = "button";
  open.className = "desktop-menu-open";
  open.setAttribute("role", "menuitem");
  label.textContent = "Open another project…";
  key.textContent = openShortcut;
  open.append(label, key);
  open.addEventListener("click", () => { void openProject(); });
  menu.append(open);
  if (workspace) {
    el("desktop-project-name").textContent = projectName(workspace);
    el("desktop-project-path").textContent = workspace;
    projectButton.title = workspace;
    document.title = `${projectName(workspace)} — Demesne`;
  }
}
async function applyBootstrap(result: DesktopBootstrap) {
  if (fatal) return;
  const previous = workspace;
  workspace = result.workspace;
  recentProjects = [...new Set(result.recentProjects.filter((path) => typeof path === "string"))];
  renderProjects();
  if (!workspace) {
    home.hidden = false;
    toolbar.hidden = app.hidden = errorPanel.hidden = true;
    setBusy(false, "");
    chooser.focus({ preventScroll: true });
    await request("desktop-ready");
    return;
  }
  if (!result.snapshot) throw new Error("The project opened without a workspace connection. Try again to restart the desktop backend.");
  // Each GraphicsHost has its own revision sequence and UI listeners. Reloading
  // makes project changes atomic, resets StateReceiver, and avoids double mounts.
  if (mounted && previous !== workspace) {
    window.location.reload();
    return;
  }
  home.hidden = errorPanel.hidden = true;
  toolbar.hidden = app.hidden = false;
  if (!mounted) {
    mounted = true;
    await import("../graphics/live.ts");
  }
  setBusy(false, "");
}
async function openProject(path?: string) {
  if (busy) return;
  closeMenu(false);
  setBusy(true, "Opening project…");
  try {
    const result = await request<DesktopBootstrap>(path ? "desktop-open-project" : "desktop-select-project", path ? { path } : {});
    // A successful recovery gets a fresh webview, including UI listeners.
    if (fatal && result.workspace && result.snapshot) { window.location.reload(); return; }
    await applyBootstrap(result);
  } catch (error) {
    showActionError(error);
  } finally {
    setBusy(false);
  }
}
for (const id of ["desktop-choose-project", "desktop-error-choose"])
  el(id).addEventListener("click", () => { void openProject(); });
el("desktop-retry").addEventListener("click", () => window.location.reload());
projectButton.addEventListener("click", () => {
  if (busy) return;
  const open = menu.hidden;
  menu.hidden = !open;
  projectButton.setAttribute("aria-expanded", String(open));
  if (open) menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
});
document.addEventListener("pointerdown", (event) => {
  if (event.target instanceof Node && !menu.contains(event.target) && !projectButton.contains(event.target)) closeMenu(false);
}, true);
document.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  const key = event.key.toLowerCase(), modifier = event.metaKey || event.ctrlKey;
  if (modifier && !event.altKey && !event.shiftKey && ["o", "q"].includes(key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === "o") void openProject();
    else void request("desktop-quit").catch(showActionError);
    return;
  }
  if (menu.hidden) return;
  if (key === "escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMenu(true);
    return;
  }
  if (!["arrowdown", "arrowup", "home", "end", "enter", " "].includes(key) || modifier || event.altKey) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (key === "enter" || key === " ") { buttons[index]?.click(); return; }
  const next = key === "home" ? 0 : key === "end" ? buttons.length - 1 : (index + (key === "arrowup" ? -1 : 1) + buttons.length) % buttons.length;
  buttons[next]?.focus({ preventScroll: true });
}, true);
window.addEventListener("beforeunload", () => {
  for (const unlisten of listeners.splice(0)) unlisten();
  bridge.dispose();
});
const appearance = matchMedia("(prefers-color-scheme: dark)");
function updateAppearance() {
  return request("desktop-appearance", { dark: appearance.matches });
}
appearance.addEventListener("change", () => { void updateAppearance().catch(showActionError); });
async function start() {
  try {
    if (!native) throw new Error("Open Demesne with its desktop launcher. This page requires the native application bridge.");
    listeners.push(...await Promise.all([
      native.event.listen<StateUpdate>("demesne:update", (event) => bridge.update(event.payload)),
      native.event.listen<GraphicsUICommand>("demesne:command", (event) => bridge.command(event.payload)),
      native.event.listen<unknown>("demesne:desktop-error", (event) => showError(event.payload)),
      native.event.listen<{ action: "open-project" | "settings" }>("demesne:desktop-action", (event) => {
        if (event.payload.action === "open-project") void openProject();
        else if (event.payload.action === "settings" && mounted && !fatal && !busy)
          document.dispatchEvent(new Event("demesne:open-settings"));
      }),
    ]));
    await updateAppearance();
    if (fatal) return;
    await applyBootstrap(await request<DesktopBootstrap>("desktop-bootstrap"));
  } catch (error) { showError(error); }
}
void start();
