import { createDesktopBridge, type DesktopInvoke } from "./frontend-bridge.ts";
import type { GraphicsSnapshot, StateUpdate } from "../graphics/state-wire.ts";
import type { GraphicsUICommand } from "../graphics/drive-controller.ts";

interface DesktopBootstrap {
  workspace: string | null;
  recentProjects: string[];
  userName?: string;
  snapshot: GraphicsSnapshot | null;
}
interface DesktopNative {
  core: { invoke: DesktopInvoke };
  event: {
    listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
  };
}
declare global {
  interface Window { demesneDesktop?: DesktopNative }
}
const el = <T extends HTMLElement = HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Desktop UI is missing ${id}.`);
  return element as T;
};
const shell = el("desktop-shell"), home = el("desktop-home"), app = el("app"),
  toolbar = el("desktop-toolbar"), errorPanel = el("desktop-error"),
  startStatus = el("desktop-start-status"), projectsList = el("sidebar-projects"), searchField = el<HTMLInputElement>("sidebar-search"),
  projectHead = el("desktop-project-button"),
  chooser = el<HTMLButtonElement>("desktop-choose-project");
const native = window.demesneDesktop;
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
  for (const button of projectsList.querySelectorAll<HTMLButtonElement>("button")) button.disabled = value;
  for (const button of el("desktop-recent-list").querySelectorAll<HTMLButtonElement>("button")) button.disabled = value;
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
const icon = (paths: string, className = "ico") => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths;
  return svg;
};
const FOLDER_ICON = '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>';
/// "dc" for demesne-cli, "bl" for blog: the mark a project wears in the switcher.
const projectMark = (name: string) => {
  const words = name.split(/[-_ .]+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toLowerCase();
};
/// A path at home reads as ~/code/blog.
const shortPath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
function recentButton(path: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = path;
  const title = document.createElement("strong");
  title.textContent = projectName(path);
  const detail = document.createElement("small");
  detail.textContent = path;
  const copy = document.createElement("span"), arrow = document.createElement("span");
  copy.append(title, detail);
  arrow.className = "desktop-recent-arrow";
  arrow.textContent = "↗";
  arrow.setAttribute("aria-hidden", "true");
  button.append(copy, arrow);
  button.addEventListener("click", () => { void openProject(path); });
  return button;
}
/// A project in the sidebar's search results: one line, its mark and name,
/// like a chat row.
function projectRow(path: string) {
  const button = document.createElement("button"), mark = document.createElement("span"), name = document.createElement("span");
  button.type = "button";
  button.className = "sidebar-project-row";
  button.title = path;
  mark.className = "project-mark";
  mark.dataset.hue = String(1 + [...projectName(path)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 3);
  mark.textContent = projectMark(projectName(path));
  mark.setAttribute("aria-hidden", "true");
  name.textContent = projectName(path);
  button.append(mark, name);
  // A click must not blur the search first, or the row would vanish under it.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => { void openProject(path); });
  return button;
}
/// Search switches projects: while it has focus, your other projects that
/// match show under the chats, with Open a folder… last. No menu.
function renderProjectResults() {
  const query = searchField.value.trim().toLowerCase(), open = document.activeElement === searchField || Boolean(query);
  projectsList.hidden = !open;
  if (!open) { projectsList.replaceChildren(); return; }
  const matches = recentProjects.filter((path) => path !== workspace && (!query || projectName(path).toLowerCase().includes(query) || path.toLowerCase().includes(query))).slice(0, 5);
  const label = document.createElement("div"), folder = document.createElement("button"), word = document.createElement("span"), key = document.createElement("kbd");
  label.className = "sidebar-group";
  label.textContent = "Projects";
  folder.type = "button";
  folder.className = "sidebar-project-row";
  word.textContent = "Open a folder…";
  key.textContent = openShortcut;
  folder.append(icon(FOLDER_ICON), word, key);
  folder.addEventListener("mousedown", (event) => event.preventDefault());
  folder.addEventListener("click", () => { void openProject(); });
  projectsList.replaceChildren(label, ...matches.map(projectRow), folder);
}
function renderProjects() {
  const list = el("desktop-recent-list");
  list.replaceChildren(...recentProjects.slice(0, 6).map((path) => recentButton(path)));
  el("desktop-recent").hidden = !recentProjects.length;
  if (workspace) {
    el("desktop-project-name").textContent = projectName(workspace);
    projectHead.title = workspace;
    projectHead.dataset.path = shortPath(workspace);
    document.title = `${projectName(workspace)} — Demesne`;
  }
  renderProjectResults();
}
async function applyBootstrap(result: DesktopBootstrap) {
  if (fatal) return;
  document.body.dataset.user = result.userName ?? "";
  const previous = workspace;
  workspace = result.workspace;
  recentProjects = [...new Set(result.recentProjects.filter((path) => typeof path === "string"))];
  renderProjects();
  if (!workspace) {
    home.hidden = false;
    toolbar.hidden = app.hidden = errorPanel.hidden = true;
    el("desktop-sidebar").hidden = true;
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
  el("desktop-sidebar").hidden = false;
  if (!mounted) {
    mounted = true;
    await import("../graphics/live.ts");
  }
  setBusy(false, "");
}
async function openProject(path?: string) {
  if (busy) return;
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

const sidebarToggle = el<HTMLButtonElement>("desktop-toggle-sidebar");
/// Folded, the sidebar is a 60px rail: the mark, +, and dots for what waits.
function setSidebarCollapsed(collapsed: boolean) {
  shell.classList.toggle("sidebar-collapsed", collapsed);
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  try { localStorage.setItem("demesne-sidebar-collapsed", String(collapsed)); } catch {}
}
try { setSidebarCollapsed(localStorage.getItem("demesne-sidebar-collapsed") === "true"); } catch {}
sidebarToggle.addEventListener("click", () => setSidebarCollapsed(!shell.classList.contains("sidebar-collapsed")));
for (const id of ["rail-expand", "rail-sessions"]) el(id).addEventListener("click", () => setSidebarCollapsed(false));
// Search is always there; Escape clears it and gives the list back.
searchField.addEventListener("input", renderProjectResults);
searchField.addEventListener("focus", renderProjectResults);
searchField.addEventListener("blur", renderProjectResults);
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
el("sidebar-new-key").textContent = mac ? "⌘N" : "Ctrl+N";
el("sidebar-settings-key").textContent = mac ? "⌘," : "Ctrl+,";
