/// The model's own browser. The app started as `Demesne --browser-host` shows
/// nothing: no window, no Dock icon, its own profile. It stays up for as long
/// as the daemon keeps its input open, and holds hidden tabs per chat that keep
/// their pages, cookies and place between the model's calls. Commands come in
/// as JSON lines on stdin and each is answered with one JSON line on stdout
/// (apps/daemon/src/browser.ts). A page is read as an outline with a number on
/// every control (browser-runtime.ts); the model clicks and types by number,
/// with real input events, and is told what visibly changed.
/// This computer's own pages always open. A site on the internet opens only
/// once the daemon names it (the person approved it), and the tab then stays
/// on its approved sites; a public page can't reach this computer or its
/// network, or ask for the camera.
/// You can watch it (pass 248 D): while the desktop shows a chat's browser,
/// the active tab sends small pictures of itself as it repaints, with where the
/// model last pointed. You can take the page (or the model hands it to you for
/// a sign-in): your clicks, keys and typed addresses reach it until you hand it
/// back, and while it is yours the site limits are yours to cross, so a
/// "Sign in with Google" window opens as a tab of its own. With a profile
/// folder, a project's cookies are kept on disk, session sign-ins included.
/// For the model's own work on this computer's pages it can read what the
/// server answered and how a control is styled, upload a project file and
/// download into the project.
import { app, BrowserWindow, nativeTheme, session as sessions, type Cookie, type NativeImage, type Session, type WebContents } from "electron";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { BROWSER_RUNTIME, OUTLINE_MAX_LINES, PAGE_TEXT_CHARS } from "./browser-runtime.ts";
import { wentTo } from "./foundry-look.ts";
import { changed, TRY_RUNTIME, TRY_WIDTHS, type Fingerprint } from "./foundry-try.ts";

export const BROWSER_HOST_FLAG = "--browser-host";
/// `--browser-profile=<folder>`: where projects' sign-ins are kept between runs.
export const BROWSER_PROFILE_FLAG = "--browser-profile=";
/// A picture of a watched tab at most this often, and no wider than this.
const FRAME_MS = 100;
const FRAME_WIDTH = 1280;
/// How often a hidden page draws: smooth while you watch it, sparing while nobody does. Each frame an
/// offscreen page draws is copied whole (twice the pixels each way on a Retina screen), so 60 a second
/// on a tab nobody sees was most of the browser's cost.
const WATCHED_FPS = 12, UNWATCHED_FPS = 10;
/// A tab is watched for this long after the desktop last asked for a picture.
const WATCH_MS = 4000;
/// A chat's tab is closed after this long untouched.
const IDLE_MS = 20 * 60_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/// Where the browser may go: this computer's own servers, and files.
export function localAddress(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:" || url === "about:blank") return true;
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && (LOCAL_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith(".localhost"));
  } catch { return false; }
}

/// A host on this computer or its own network, which a public page must not reach.
export function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host.replace(/^::ffff:/, ""));
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return host.includes(":") && (host === "::" || host === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(host));
}

/// The site of a public address ("github.com"), as the daemon names it; null for a local one.
function siteOf(url: string): string | null {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) && !localAddress(url) ? parsed.hostname.toLowerCase().replace(/^www\./, "") : null; } catch { return null; }
}

/// One hidden tab. A chat has one or more; the model acts on the active one.
interface Tab { win: BrowserWindow; chat: Chat; n: number; width: "desktop" | "phone"; sites: Set<string>; local: boolean; errors: string[]; failed: string[]; blocked: string[]; downloaded: string[];
  framed: number; frameTimer?: ReturnType<typeof setTimeout>; pointer?: { x: number; y: number; at: number }; requests: Seen[]; popup?: boolean; sized?: boolean;
  /// The page is streaming its pictures (CDP screencast), and the newest one, to send again with news.
  casting?: boolean; last?: { jpeg: string; ratio: number } }
/// A chat's browser: its tabs, which one is active, and whether the person has it.
interface Chat { id: string; tabs: Map<number, Tab>; active: number; next: number; held: boolean; queue: Promise<unknown>; used: number; profile: unknown; downloads: string | null }
/// A request this computer's page made, for the model to read the answer of.
interface Seen { id: string; n: number; method: string; url: string; status: number; type: string; mime: string; finished: boolean }

/// One event you make on a page you were handed, as the desktop sends it.
/// Page coordinates are CSS pixels of the tab.
export type HandInput =
  | { type: "mouseDown" | "mouseUp" | "mouseMove"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: number }
  | { type: "mouseWheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "keyDown" | "keyUp" | "char"; keyCode: string; modifiers?: string[] }
  | { type: "text"; text: string };

const MOUSE = new Set(["mouseDown", "mouseUp", "mouseMove"]);
const MODIFIERS = new Set(["shift", "control", "alt", "meta", "command", "cmd"]);
/// What the desktop sent, made safe to hand to the page: known kinds, numbers in range, short text.
export function handInput(value: unknown): HandInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>, type = String(event.type);
  const at = (n: unknown) => Number.isFinite(Number(n)) ? Math.max(-10, Math.min(20_000, Math.round(Number(n)))) : null;
  if (MOUSE.has(type) || type === "mouseWheel") {
    const x = at(event.x), y = at(event.y);
    if (x === null || y === null) return null;
    if (type === "mouseWheel") return { type, x, y, deltaX: Math.max(-4000, Math.min(4000, Number(event.deltaX) || 0)), deltaY: Math.max(-4000, Math.min(4000, Number(event.deltaY) || 0)) };
    const button = event.button === "right" || event.button === "middle" ? event.button : "left";
    return { type: type as "mouseDown", x, y, button, clickCount: Math.max(1, Math.min(3, Math.round(Number(event.clickCount) || 1))) };
  }
  if (type === "keyDown" || type === "keyUp" || type === "char") {
    const keyCode = typeof event.keyCode === "string" ? event.keyCode : "";
    if (!keyCode || keyCode.length > 24) return null;
    const modifiers = Array.isArray(event.modifiers) ? event.modifiers.filter((m): m is string => typeof m === "string" && MODIFIERS.has(m.toLowerCase())).map((m) => m.toLowerCase()) : [];
    return { type, keyCode, ...(modifiers.length ? { modifiers } : {}) };
  }
  if (type === "text" && typeof event.text === "string" && event.text.length <= 4000) return { type, text: event.text };
  return null;
}

/// The partition a chat's tab lives in: the project's, kept on disk, when there is a profile folder; else the chat's own, in memory.
export function browserPartition(chat: string, profile: unknown, kept: boolean): string {
  return kept && typeof profile === "string" && /^[a-f0-9]{8,64}$/.test(profile) ? `persist:browser-${profile}` : `browser-${chat}`;
}
type Command = Record<string, unknown> & { id?: unknown; chat?: unknown; action?: unknown };
type Found = { found: boolean; gone?: boolean; hidden?: boolean; names?: string[]; x: number; y: number; many: number; what: string; covered: string | null; disabled: boolean };

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/// How many tabs a chat may have, requests kept per tab, and how big a download may be.
const MAX_TABS = 6, MAX_SEEN = 40, MAX_DOWNLOAD = 50 * 1024 * 1024;
/// A response body is read back at most this long.
export const BODY_CHARS = 6_000;
/// A file name a download can be saved under: no folders, nothing hidden.
export const safeFileName = (name: string) => (basename(name).replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 120)) || "download";

export function runBrowserHost() {
  const keptAt = process.argv.find((arg) => arg.startsWith(BROWSER_PROFILE_FLAG))?.slice(BROWSER_PROFILE_FLAG.length) ?? "";
  const kept = Boolean(keptAt);
  if (kept) mkdirSync(keptAt, { recursive: true });
  const profile = kept ? keptAt : mkdtempSync(join(tmpdir(), "demesne-browser-"));
  app.setPath("userData", profile);
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  const chats = new Map<string, Chat>();
  /// The tab each page belongs to, for the handlers its session shares with other chats of the project.
  const byContents = new Map<number, Tab>();
  /// Chats the desktop is showing, until when, and how tall it shows them.
  const watched = new Map<string, number>(), aspects = new Map<string, number>();
  /// The sessions kept on disk, by partition, so their cookies are written out before the host goes.
  const keptSessions = new Map<string, Session>();
  const sessionCookies = (partition: string) => join(profile, "session-cookies", `${partition.replace(/[^\w-]/g, "_")}.json`);
  const quit = async () => {
    for (const chat of chats.values()) for (const tab of chat.tabs.values()) tab.win.destroy();
    // A sign-in that lasts only for the session is kept too, and comes back as one when the browser starts again.
    await Promise.race([Promise.all([...keptSessions].map(async ([partition, one]) => {
      const held = (await one.cookies.get({}).catch(() => [])).filter((cookie) => cookie.session);
      if (held.length) { mkdirSync(join(profile, "session-cookies"), { recursive: true }); writeFileSync(sessionCookies(partition), JSON.stringify(held)); }
      await one.cookies.flushStore().catch(() => {});
    })), settle(1500)]);
    if (!kept) try { rmSync(profile, { recursive: true, force: true }); } catch {}
    app.exit(0);
  };
  const write = (line: Record<string, unknown>) => process.stdout.write(JSON.stringify(line) + "\n");
  const answer = (id: unknown, result: Record<string, unknown>) => write({ id, ...result });
  const activeTab = (chat: Chat | undefined) => chat ? chat.tabs.get(chat.active) : undefined;
  const tabList = (chat: Chat) => [...chat.tabs.values()].map((tab) => ({ n: tab.n, url: tab.win.isDestroyed() ? "" : tab.win.webContents.getURL(), title: tab.win.isDestroyed() ? "" : tab.win.webContents.getTitle(), ...(tab.n === chat.active ? { active: true } : {}) }));

  const isWatched = (tab: Tab) => !tab.win.isDestroyed() && (watched.get(tab.chat.id) ?? 0) >= Date.now() && tab.chat.active === tab.n;
  /// A picture of a watched tab, sent as an event the daemon keeps for the desktop. `ratio` is its height over its width.
  const sendFrame = (tab: Tab, jpeg: string, ratio: number) => {
    if (!isWatched(tab)) return;
    const view = TRY_WIDTHS[tab.width];
    tab.framed = Date.now();
    tab.last = { jpeg, ratio };
    const contents = tab.win.webContents;
    write({ event: "frame", chat: tab.chat.id, jpeg, width: view.width, height: Math.round(view.width * ratio),
      url: contents.getURL(), title: contents.getTitle(), handover: tab.chat.held, tabs: tabList(tab.chat),
      ...(tab.pointer ? { pointer: { x: tab.pointer.x, y: tab.pointer.y, ago: Date.now() - tab.pointer.at } } : {}),
      back: contents.navigationHistory.canGoBack(), forward: contents.navigationHistory.canGoForward() });
  };
  /// The page streams its own pictures while watched: Chromium draws them small and as JPEG itself, off
  /// this process, and sends the next only once the last is taken, so a busy page can't pile them up.
  const startCast = (tab: Tab) => {
    if (tab.casting || tab.win.isDestroyed()) return;
    const contents = tab.win.webContents;
    if (!contents.debugger.isAttached()) return;
    tab.casting = true;
    contents.setFrameRate(WATCHED_FPS);
    const view = TRY_WIDTHS[tab.width];
    void contents.debugger.sendCommand("Page.startScreencast", { format: "jpeg", quality: 72, maxWidth: Math.min(FRAME_WIDTH, view.width), maxHeight: view.width * 3 })
      .catch(() => { tab.casting = false; });
  };
  const stopCast = (tab: Tab) => {
    if (!tab.casting) return;
    tab.casting = false;
    if (tab.win.isDestroyed()) return;
    tab.win.webContents.setFrameRate(UNWATCHED_FPS);
    void tab.win.webContents.debugger.sendCommand("Page.stopScreencast").catch(() => {});
  };
  /// One streamed picture: sent on, and taken (so the next can come) no sooner than FRAME_MS later.
  const castFrame = (tab: Tab, params: Record<string, any>) => {
    const take = () => { if (!tab.win.isDestroyed() && tab.casting) void tab.win.webContents.debugger.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {}); };
    if (!isWatched(tab)) { stopCast(tab); return; }
    const meta = params.metadata ?? {}, ratio = Number(meta.deviceHeight) > 0 && Number(meta.deviceWidth) > 0 ? Number(meta.deviceHeight) / Number(meta.deviceWidth) : 0.625;
    clearTimeout(tab.frameTimer); tab.frameTimer = undefined;
    // Chromium sends a few ahead of the takes: only the newest goes on, one each FRAME_MS.
    tab.last = { jpeg: String(params.data ?? ""), ratio };
    const wait = FRAME_MS - (Date.now() - tab.framed);
    if (wait <= 0) sendFrame(tab, tab.last.jpeg, ratio);
    else tab.frameTimer = setTimeout(() => { tab.frameTimer = undefined; if (tab.last) sendFrame(tab, tab.last.jpeg, tab.last.ratio); }, wait);
    setTimeout(take, FRAME_MS);
  };
  /// Pictures flow for the tab on show, and news (who has it, its tabs, where it pointed) reaches the
  /// desktop even when the page itself did not change.
  const frameSoon = (tab: Tab | undefined) => {
    if (!tab || tab.win.isDestroyed()) return;
    for (const one of tab.chat.tabs.values()) if (one !== tab) stopCast(one);
    if (!isWatched(tab)) { stopCast(tab); return; }
    startCast(tab);
    if (tab.frameTimer) return;
    tab.frameTimer = setTimeout(() => {
      tab.frameTimer = undefined;
      if (!isWatched(tab)) return;
      if (tab.last && tab.casting) { sendFrame(tab, tab.last.jpeg, tab.last.ratio); return; }
      // No stream (the debugger is taken): a still picture instead.
      void tab.win.webContents.capturePage().then((image) => {
        if (image.isEmpty()) return;
        const size = image.getSize(), small = size.width > FRAME_WIDTH ? image.resize({ width: FRAME_WIDTH, quality: "good" }) : image;
        sendFrame(tab, small.toJPEG(76).toString("base64"), size.height / Math.max(1, size.width));
      }, () => {});
    }, Math.max(FRAME_MS, 250 - (Date.now() - tab.framed)));
  };
  // A watch that lapsed stops its stream.
  setInterval(() => { for (const chat of chats.values()) for (const tab of chat.tabs.values()) if (tab.casting && !isWatched(tab)) stopCast(tab); }, 1000).unref?.();
  /// A page it went to, kept small, so the desktop can step back through them afterwards.
  /// A small picture of each page a tab went to. Right after a load the offscreen page may not have drawn yet, so it tries again.
  const sendVisit = (tab: Tab, tries = 4) => {
    if (tab.win.isDestroyed()) return;
    const contents = tab.win.webContents, url = contents.getURL();
    if (!url || url === "about:blank") return;
    void contents.capturePage().then((image) => {
      if (image.isEmpty()) { if (tries > 1) setTimeout(() => { if (!tab.win.isDestroyed() && tab.win.webContents.getURL() === url) sendVisit(tab, tries - 1); }, 400); return; }
      write({ event: "visit", chat: tab.chat.id, url, title: contents.getTitle(), tab: tab.n, jpeg: image.resize({ width: 640, quality: "good" }).toJPEG(70).toString("base64") });
    }, () => {});
  };
  /// The page's height follows the split's shape; its width stays the model's.
  const fit = (tab: Tab) => {
    const aspect = aspects.get(tab.chat.id);
    if (!aspect || tab.win.isDestroyed()) return;
    const view = TRY_WIDTHS[tab.width], [, height] = tab.win.getContentSize();
    const wanted = Math.round(Math.max(view.height * 0.75, Math.min(view.width * 3, view.width * aspect)));
    if (Math.abs(wanted - (height ?? 0)) > 24) { tab.win.setContentSize(view.width, wanted); sizePopup(tab); }
  };
  /// A window a page opened comes up offscreen with no viewport (an Electron quirk): it takes no clicks and
  /// draws nothing until its size is set through the debugger.
  /// Only once its page is up, and only when it has no size: setting it any earlier, or on a window that has one, can crash the host.
  const sizePopup = (tab: Tab) => {
    if (!tab.popup || tab.win.isDestroyed()) return;
    const contents = tab.win.webContents;
    const size = async () => {
      if (tab.win.isDestroyed()) return;
      const [width, height] = tab.win.getContentSize();
      const inner = await contents.executeJavaScript("innerWidth").catch(() => -1) as number;
      if (inner === 0 || tab.sized) { tab.sized = true; await contents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: tab.width === "phone" }).catch(() => {}); }
    };
    if (contents.isLoading() || !contents.getURL()) contents.once("dom-ready", () => void size()); else void size();
  };

  /// What a session's pages may do. Set once per session: chats of one project share it.
  const prepared = new WeakSet<Session>();
  function prepare(session: Session) {
    if (prepared.has(session)) return;
    prepared.add(session);
    const tabOf = (id: number | undefined) => id === undefined ? undefined : byContents.get(id);
    // A public page can't reach this computer or its network, or ask for the camera and the like.
    session.webRequest.onBeforeRequest((details, callback) => {
      const tab = tabOf(details.webContentsId);
      let host = ""; try { host = new URL(details.url).hostname; } catch {}
      callback({ cancel: Boolean(tab && !tab.local) && details.resourceType !== "mainFrame" && /^(https?|wss?):/.test(details.url) && privateHost(host) });
    });
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.removeAllListeners("will-download");
    // A download goes into the project's downloads folder, up to 50 MB; a chat outside a project saves nothing.
    session.on("will-download", (event, item, contents) => {
      const tab = tabOf(contents?.id), folder = tab?.chat.downloads;
      if (!tab || !folder) { event.preventDefault(); if (tab && tab.blocked.length < 4) tab.blocked.push(`${item.getFilename().slice(0, 80)} was not downloaded: this chat is not in a project`); return; }
      if (item.getTotalBytes() > MAX_DOWNLOAD) { event.preventDefault(); if (tab.blocked.length < 4) tab.blocked.push(`${item.getFilename().slice(0, 80)} was not downloaded: it is over 50 MB`); return; }
      mkdirSync(folder, { recursive: true });
      const name = safeFileName(item.getFilename());
      let path = join(folder, name);
      for (let i = 2; existsSync(path) && i < 100; i++) path = join(folder, name.replace(/(\.[^.]*)?$/, ` (${i})$1`));
      item.setSavePath(path);
      item.on("updated", () => { if (item.getReceivedBytes() > MAX_DOWNLOAD) item.cancel(); });
      item.once("done", (_event, state) => { if (tab.downloaded.length < 6) tab.downloaded.push(state === "completed" ? `${path} (${Math.ceil(item.getReceivedBytes() / 1024)} KB)` : `${name} did not finish: ${state === "cancelled" ? "it was over 50 MB" : state}`); });
    });
    session.webRequest.onCompleted((details) => {
      const tab = tabOf(details.webContentsId);
      if (tab?.local && details.statusCode >= 400 && tab.failed.length < 8) tab.failed.push(`${details.method} ${shortUrl(details.url)} → ${details.statusCode}`);
    });
    session.webRequest.onErrorOccurred((details) => {
      const tab = tabOf(details.webContentsId);
      if (tab?.local && details.error !== "net::ERR_ABORTED" && tab.failed.length < 8) tab.failed.push(`${details.method} ${shortUrl(details.url)} → ${details.error.replace(/^net::/, "")}`);
    });
  }
  /// A session kept on disk, with the session sign-ins it had when the browser last quit.
  async function keptSession(partition: string) {
    const session = sessions.fromPartition(partition);
    if (!keptSessions.has(partition)) {
      keptSessions.set(partition, session);
      const file = sessionCookies(partition);
      if (existsSync(file)) {
        try {
          const saved = JSON.parse(readFileSync(file, "utf8")) as Cookie[];
          for (const cookie of saved) {
            const host = (cookie.domain ?? "").replace(/^\./, "");
            if (!host) continue;
            await session.cookies.set({ url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`, name: cookie.name, value: cookie.value, ...(cookie.domain?.startsWith(".") ? { domain: cookie.domain } : {}), path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, ...(cookie.sameSite && cookie.sameSite !== "unspecified" ? { sameSite: cookie.sameSite } : {}) }).catch(() => {});
          }
        } catch { /* a damaged file: start signed out */ }
        rmSync(file, { force: true });
      }
    }
    return session;
  }

  /// Watches what this computer's page asks its server, so the model can read an answer (`requests`, `response`).
  /// Requests are followed only on this computer's own pages, where the model may read them: a public
  /// site makes hundreds, and each would cross into this process for nothing.
  const followed = new WeakMap<Tab, boolean>();
  function watchNetwork(tab: Tab) {
    if (tab.win.isDestroyed() || !tab.win.webContents.debugger.isAttached() || followed.get(tab) === tab.local) return;
    followed.set(tab, tab.local);
    void tab.win.webContents.debugger.sendCommand(tab.local ? "Network.enable" : "Network.disable").catch(() => {});
  }
  function listen(tab: Tab, contents: WebContents) {
    try { contents.debugger.attach("1.3"); } catch { return; }
    watchNetwork(tab);
    let n = 0;
    const methods = new Map<string, string>();
    contents.debugger.on("message", (_event, method, params: Record<string, any>) => {
      if (method === "Page.screencastFrame") { castFrame(tab, params); return; }
      if (method === "Network.requestWillBeSent") { methods.set(params.requestId, params.request?.method ?? "GET"); if (methods.size > 400) methods.delete(methods.keys().next().value!); }
      else if (method === "Network.responseReceived" && tab.local && /^(XHR|Fetch|Document)$/.test(params.type)) {
        tab.requests.push({ id: params.requestId, n: ++n, method: methods.get(params.requestId) ?? "GET", url: String(params.response?.url ?? ""), status: Number(params.response?.status) || 0, type: params.type, mime: String(params.response?.mimeType ?? ""), finished: false });
        if (tab.requests.length > MAX_SEEN) tab.requests.shift();
      } else if (method === "Network.loadingFinished") { const seen = tab.requests.find((one) => one.id === params.requestId); if (seen) seen.finished = true; }
    });
  }

  /// A new hidden tab for a chat. A window the page opened (a sign-in popup) comes in as `win`.
  function addTab(chat: Chat, width: "desktop" | "phone", session: Session | null, given?: BrowserWindow): Tab {
    const view = TRY_WIDTHS[width];
    const win = given ?? new BrowserWindow({ show: false, width: view.width, height: view.height, useContentSize: true, paintWhenInitiallyHidden: true,
      webPreferences: { session: session!, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    if (given) win.setContentSize(view.width, view.height);
    const tab: Tab = { win, chat, n: chat.next++, width, sites: new Set(activeTab(chat)?.sites ?? []), local: true, errors: [], failed: [], blocked: [], downloaded: [], framed: 0, requests: [] };
    const contents = win.webContents;
    byContents.set(contents.id, tab);
    chat.tabs.set(tab.n, tab);
    chat.active = tab.n;
    win.on("closed", () => {
      byContents.delete(contents.id); clearTimeout(tab.frameTimer);
      chat.tabs.delete(tab.n);
      // A popup that closed itself (a sign-in done) hands back to the tab before it.
      if (chat.active === tab.n) { chat.active = [...chat.tabs.keys()].at(-1) ?? 0; frameSoon(activeTab(chat)); }
    });
    // Nobody watches a new tab yet: it draws sparingly until someone does.
    contents.setFrameRate(UNWATCHED_FPS);
    // Where this tab may go: around this computer while it is here, the sites the person approved, and anywhere public while the person has it.
    const allowed = (url: string) => {
      if (localAddress(url)) return tab.local;
      const site = siteOf(url);
      if (site === null) return false;
      if (chat.held) return true;
      return [...tab.sites].some((approved) => site === approved || site.endsWith(`.${approved}`));
    };
    const blocked = (url: string) => { if (tab.blocked.length < 4) tab.blocked.push(localAddress(url) ? `${url.slice(0, 200)} was not opened: a public page can't send you into this computer` : `${url.slice(0, 200)} was not opened: it is another site, so open it yourself to go there`); };
    const refuse = (event: { preventDefault(): void }, url: string) => { if (!allowed(url)) { event.preventDefault(); blocked(url); } };
    contents.on("did-navigate", (_event, url) => {
      tab.local = localAddress(url);
      watchNetwork(tab);
      // Where the person went is approved for this tab from then on.
      const site = siteOf(url);
      if (site && chat.held) tab.sites.add(site);
      tab.pointer = undefined;
    });
    contents.on("did-stop-loading", () => sendVisit(tab));
    // Sites see an ordinary browser, not the app's name.
    contents.setUserAgent(contents.getUserAgent().replace(/\s(?:Electron|demesne[\w-]*)\/\S+/gi, ""));
    contents.on("will-navigate", (event, url) => refuse(event, url));
    contents.on("will-redirect", (event, url) => refuse(event, url));
    // A page's new window (target=_blank, a sign-in popup) opens as another tab of this chat, still linked to its opener.
    contents.setWindowOpenHandler(({ url }) => {
      if (url && url !== "about:blank" && !allowed(url)) { blocked(url); return { action: "deny" }; }
      if (chat.tabs.size >= MAX_TABS) { if (tab.blocked.length < 4) tab.blocked.push(`${url.slice(0, 200)} was not opened: this chat already has ${MAX_TABS} tabs; close one`); return { action: "deny" }; }
      return { action: "allow", overrideBrowserWindowOptions: { show: false, width: view.width, height: view.height, useContentSize: true, paintWhenInitiallyHidden: true,
        webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } } };
    });
    contents.on("did-create-window", (child) => { const opened = addTab(chat, tab.width, null, child); opened.popup = true; sizePopup(opened); frameSoon(activeTab(chat)); });
    contents.on("console-message", (event) => { if (tab.local && event.level === "error" && tab.errors.length < 8) tab.errors.push(event.message.slice(0, 200)); });
    listen(tab, contents);
    fit(tab);
    return tab;
  }

  async function run(chat: Chat, command: Command): Promise<Record<string, unknown>> {
    const action = String(command.action), width = command.width === "phone" ? "phone" as const : "desktop" as const;
    // Tabs: list, switch, close one.
    if (action === "tabs") return { tabs: tabList(chat) };
    if (action === "switch") {
      const n = Math.round(Number(command.tab));
      if (!chat.tabs.has(n)) return { error: `There is no tab ${command.tab}; the tabs are ${[...chat.tabs.keys()].join(", ") || "none"}.` };
      chat.active = n;
      frameSoon(activeTab(chat));
    }
    if (action === "close_tab") {
      const n = command.tab === undefined ? chat.active : Math.round(Number(command.tab));
      const tab = chat.tabs.get(n);
      if (!tab) return { error: `There is no tab ${command.tab ?? ""}.` };
      tab.win.destroy();
      chat.tabs.delete(n);
      if (chat.active === n) chat.active = [...chat.tabs.keys()].at(-1) ?? 0;
      frameSoon(activeTab(chat));
      if (!chat.tabs.size) return { closed: true, tabs: [] };
    }
    let tab = activeTab(chat);
    if (action === "open") {
      const fresh = command.new_tab === true || !tab || (command.width !== undefined && tab.width !== width);
      if (fresh && chat.tabs.size >= MAX_TABS) return { error: `This chat already has ${MAX_TABS} tabs; close one first.` };
      if (tab && fresh && command.new_tab !== true) { tab.win.destroy(); chat.tabs.delete(tab.n); }
      if (fresh) {
        const partition = browserPartition(chat.id, chat.profile, kept);
        const session = partition.startsWith("persist:") ? await keptSession(partition) : sessions.fromPartition(partition);
        prepare(session);
        tab = addTab(chat, width, session);
      }
    }
    if (!tab || tab.win.isDestroyed()) return { error: "No page is open yet: start with action open." };
    const { win } = tab, contents = win.webContents;
    const js = <T>(code: string) => contents.executeJavaScript(code) as Promise<T>;
    const loaded = async () => {
      if (contents.isLoading()) await Promise.race([new Promise<void>((resolve) => contents.once("did-stop-loading", () => resolve())), settle(8000)]);
      await js(TRY_RUNTIME).catch(() => {}); await js(BROWSER_RUNTIME).catch(() => {});
    };
    const page = async (withOutline: boolean, more: Record<string, unknown> = {}) => {
      await loaded();
      const dialogs = await js<string[]>("window.__demesneBrowser ? window.__demesneBrowser.dialogs() : []").catch(() => [] as string[]);
      return {
        url: contents.getURL(), title: contents.getTitle(), ...(tab!.local ? {} : { public: true }), ...more,
        ...(chat.tabs.size > 1 ? { tab: tab!.n, tabs: tabList(chat) } : {}),
        ...(withOutline ? { outline: await js<string[]>(`window.__demesneBrowser.outline(${OUTLINE_MAX_LINES})`).catch(() => [] as string[]) } : {}),
        ...(dialogs.length ? { dialogs } : {}),
        ...(tab!.errors.length ? { errors: tab!.errors.splice(0) } : {}), ...(tab!.failed.length ? { failed: tab!.failed.splice(0) } : {}), ...(tab!.blocked.length ? { blocked: tab!.blocked.splice(0) } : {}),
        ...(tab!.downloaded.length ? { downloaded: tab!.downloaded.splice(0) } : {}),
      };
    };
    if (action === "open" || (action === "go" && typeof command.url === "string")) {
      if (action === "go" && !chat.held) return { error: "The page is not yours right now." };
      const url = String(command.url ?? "");
      // The daemon names a site only after the person approved it, or the person typed it.
      const site = siteOf(url);
      if (site !== null && command.site !== site) return { error: "That site was not approved for the browser." };
      if (site !== null) tab.sites.add(site);
      tab.local = site === null;
      watchNetwork(tab);
      tab.errors.length = tab.failed.length = tab.blocked.length = 0;
      try { await win.loadURL(url); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        tab.local = localAddress(contents.getURL() || "about:blank");
        // A redirect that left the approved sites: say where it wanted to go.
        if (tab.blocked.length) return { error: `${url} sends you on elsewhere. ${tab.blocked.splice(0).join("; ")}` };
        if (!/ERR_ABORTED/.test(message)) return { error: `Could not open ${url}: ${message.replace(/^.*?(ERR_[A-Z_]+).*$/s, "$1")}` };
      }
      await Promise.race([js("document.fonts.ready.then(() => true)").catch(() => true), settle(3000)]);
      await settle(250);
      return page(action === "open");
    }
    if (contents.getURL() === "" || contents.getURL() === "about:blank") return { error: "No page is open yet: start with action open." };
    if (action === "switch" || action === "close_tab") return page(true);
    // The person's own back, forward and reload, while the page is theirs.
    if (action === "go") {
      if (!chat.held) return { error: "The page is not yours right now." };
      if (command.to === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      else if (command.to === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      else if (command.to === "reload") contents.reload();
      frameSoon(tab);
      return { url: contents.getURL(), title: contents.getTitle() };
    }
    // Handed to the person (a sign-in, or they took it) and back. Back, the model reads the page again: it saw nothing in between.
    if (action === "handover") {
      chat.held = command.on === true;
      frameSoon(tab);
      if (chat.held) { contents.focus(); return { url: contents.getURL(), title: contents.getTitle(), handover: true }; }
      for (const one of chat.tabs.values()) { if (!one.win.isDestroyed()) one.local = localAddress(one.win.webContents.getURL()); one.errors.length = one.failed.length = 0; }
      return page(true);
    }
    await loaded();
    if (action === "read") return page(true);
    if (action === "text") {
      const from = Math.max(0, Math.round(Number(command.from) || 0));
      return page(false, await js<Record<string, unknown>>(`window.__demesneBrowser.text(${from}, ${PAGE_TEXT_CHARS})`));
    }
    if (action === "picture") {
      const view = TRY_WIDTHS[tab.width];
      let image = await contents.capturePage();
      if (image.getSize().width > view.scaleTo) image = image.resize({ width: view.scaleTo, quality: "good" });
      return page(false, { png: image.toPNG().toString("base64") });
    }
    // What this computer's page asked its server, and what came back.
    if (action === "requests") {
      if (!tab.local) return { error: "Requests are read only on this computer's own pages." };
      return page(false, { requests: tab.requests.slice(-20).map((one) => `[${one.n}] ${one.method} ${shortUrl(one.url)} → ${one.status}${one.mime ? ` ${one.mime}` : ""}`) });
    }
    if (action === "response") {
      if (!tab.local) return { error: "Answers are read only on this computer's own pages." };
      const n = Math.round(Number(command.request)), seen = tab.requests.find((one) => one.n === n);
      if (!seen) return { error: `There is no request ${command.request}; read the list with action requests.` };
      try {
        const got = await contents.debugger.sendCommand("Network.getResponseBody", { requestId: seen.id }) as { body: string; base64Encoded: boolean };
        const body = got.base64Encoded ? (/^(text\/|application\/(json|xml|javascript))/.test(seen.mime) ? Buffer.from(got.body, "base64").toString("utf8") : `(${Math.ceil(got.body.length * 0.75 / 1024)} KB of ${seen.mime || "binary data"})`) : got.body;
        return page(false, { request: `${seen.method} ${shortUrl(seen.url)} → ${seen.status}`, body: body.slice(0, BODY_CHARS), ...(body.length > BODY_CHARS ? { body_more: `${body.length - BODY_CHARS} more characters not shown` } : {}) });
      } catch { return { error: "That answer is no longer kept; make the request again." }; }
    }
    if (action === "inspect") {
      const seen = await js<Record<string, unknown>>(`window.__demesneBrowser.inspect(${Number(command.ref)})`).catch(() => ({ found: false }));
      if (!seen.found) return page(false, { ok: false, did: `${command.ref} is no longer on the page; read it again` });
      const { found: _found, ...rest } = seen;
      return page(false, { inspected: rest });
    }
    // A project file into the page's file field: set on the field, as a person choosing it would.
    if (action === "upload") {
      type Marked = { ok: boolean; said?: string; what?: string; multiple?: boolean };
      const marked = await js<Marked>(`window.__demesneBrowser.markFile(${command.ref === undefined ? "null" : JSON.stringify(command.ref)})`).catch((): Marked => ({ ok: false, said: "the page could not be read" }));
      if (!marked.ok) return page(false, { ok: false, did: marked.said });
      const files = (Array.isArray(command.files) ? command.files : [command.files]).filter((one): one is string => typeof one === "string").slice(0, marked.multiple ? 10 : 1);
      const before = await js<Fingerprint>("window.__demesneTry.fingerprint()").catch(() => null);
      try {
        const root = await contents.debugger.sendCommand("DOM.getDocument", { depth: 0 }) as { root: { nodeId: number } };
        const field = await contents.debugger.sendCommand("DOM.querySelector", { nodeId: root.root.nodeId, selector: "[data-demesne-upload]" }) as { nodeId: number };
        await contents.debugger.sendCommand("DOM.setFileInputFiles", { files, nodeId: field.nodeId });
      } catch (error) { return page(false, { ok: false, did: `the file could not be given to the page: ${error instanceof Error ? error.message : String(error)}` }); }
      await settle(300);
      const after = before ? await js<Fingerprint>("window.__demesneTry.fingerprint()").catch(() => before) : null;
      const what = before && after ? changed(before, after, false, false) : null;
      return page(false, { ok: true, did: `${marked.what} ← ${files.map((one) => basename(one)).join(", ")}`, ...(what ? { changed: what } : {}) });
    }
    // The rest act on the page, then say what a person would have seen happen.
    const print = () => js<Fingerprint>("window.__demesneTry.fingerprint()");
    const find = (ref: unknown) => typeof ref === "number" || /^\d+$/.test(String(ref))
      ? js<Found>(`window.__demesneBrowser.locate(${Number(ref)})`) : js<Found>(`window.__demesneTry.find(${JSON.stringify(String(ref))})`);
    // Where the model last pointed shows as a soft ring on the picture.
    const point = (x: number, y: number) => { tab!.pointer = { x: Math.round(x), y: Math.round(y), at: Date.now() }; };
    const click = async (x: number, y: number) => {
      point(x, y);
      contents.sendInputEvent({ type: "mouseMove", x, y });
      contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    };
    const reach = async (ref: unknown, then: (x: number, y: number) => Promise<void>): Promise<{ ok: boolean; said: string }> => {
      const found = await find(ref);
      if (found.gone) return { ok: false, said: `${ref} is no longer on the page; read it again` };
      if (found.hidden) return { ok: false, said: `${found.what} is hidden now` };
      if (!found.found) return { ok: false, said: `nothing matches${found.names?.length ? `; the controls are ${found.names.map((n) => `“${n}”`).join(", ")}` : ""}` };
      if (found.covered) return { ok: false, said: `${found.what} is covered by ${found.covered}, so a person can't reach it` };
      if (found.disabled) return { ok: false, said: `${found.what} is disabled` };
      await then(found.x, found.y);
      return { ok: true, said: found.what };
    };
    const key = (keyCode: string) => {
      contents.sendInputEvent({ type: "keyDown", keyCode });
      if (keyCode === "Enter" || keyCode === "Space") contents.sendInputEvent({ type: "char", keyCode: keyCode === "Enter" ? "\r" : " " });
      contents.sendInputEvent({ type: "keyUp", keyCode });
    };
    contents.focus();
    const before = await print(), at = contents.getURL(), y0 = await js<number>("scrollY"), tabsBefore = chat.tabs.size;
    let result: { ok: boolean; said: string } = { ok: true, said: "" };
    if (action === "click") result = await reach(command.ref, click);
    else if (action === "hover") result = await reach(command.ref, async (x, y) => { point(x, y); contents.sendInputEvent({ type: "mouseMove", x, y }); });
    else if (action === "type") {
      if (command.ref !== undefined && command.ref !== "") result = await reach(command.ref, click);
      if (result.ok) {
        await settle(80);
        if (command.clear === true) { await js("document.activeElement && 'value' in document.activeElement && document.activeElement.select && document.activeElement.select()").catch(() => {}); key("Backspace"); }
        await contents.insertText(String(command.text ?? ""));
        if (command.enter === true) { await settle(60); key("Enter"); }
      }
    } else if (action === "key") key(String(command.key));
    else if (action === "scroll") await js(`scrollBy(0, ${Math.round(Number(command.px) || 600)})`);
    else if (action === "back") { if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); else result = { ok: false, said: "there is no page to go back to" }; }
    else if (action === "forward") { if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); else result = { ok: false, said: "there is no page to go forward to" }; }
    else if (action === "reload") contents.reload();
    else if (action === "wait") {
      const want = typeof command.for === "string" ? command.for : "", until = Date.now() + Math.min(Math.max(Number(command.ms) || (want ? 10_000 : 1000), 0), 15_000);
      if (!want) await settle(until - Date.now());
      else {
        let seen = false;
        while (!seen && Date.now() < until) { seen = await js<boolean>(`document.body.innerText.includes(${JSON.stringify(want)})`).catch(() => false); if (!seen) await settle(200); }
        result = seen ? { ok: true, said: `“${want}” is on the page` } : { ok: false, said: `“${want}” did not appear` };
      }
    } else return { error: `Unknown action ${action}` };
    if (!result.ok) return page(false, { ok: false, did: result.said });
    await settle(350);
    // A tab that closed itself (a sign-in popup, done): the chat is back on the tab before it.
    if (win.isDestroyed()) {
      if (!activeTab(chat)) return { ok: true, did: result.said, changed: "the tab closed itself; no page is open now", tabs: [] };
      return { ...(await run(chat, { action: "read" })), ok: true, did: result.said, changed: `the tab closed itself; now on tab ${chat.active}` };
    }
    // A click that opened a new tab: the model is now on it.
    if (chat.tabs.size > tabsBefore && chat.active !== tab.n) {
      const opened = activeTab(chat)!;
      await settle(400);
      const view = opened.win.webContents;
      if (view.isLoading()) await Promise.race([new Promise<void>((resolve) => view.once("did-stop-loading", () => resolve())), settle(8000)]);
      return { ...(await run(chat, { action: "read" })), ok: true, did: result.said, changed: `opened a new tab (${opened.n}) at ${view.getURL().slice(0, 200)}` };
    }
    await loaded();
    const moved = contents.getURL() !== at;
    const after = await print().catch(() => before), scrolled = (await js<number>("scrollY").catch(() => y0)) !== y0;
    const what = moved ? wentTo(at, contents.getURL()) : changed(before, after, scrolled, action === "key");
    // A new address is a new page: its outline comes with it. Otherwise the numbers still hold.
    return page(moved || action === "reload", { ok: true, ...(result.said ? { did: result.said } : {}), changed: what ?? (action === "wait" || action === "hover" ? "" : "nothing visible changed") });
  }

  void app.whenReady().then(() => {
    const lines = createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      let command: Command;
      try { command = JSON.parse(line) as Command; } catch { return; }
      const id = String(command.chat ?? "");
      if (!id) { answer(command.id, { error: "chat is required" }); return; }
      let chat = chats.get(id);
      // Someone is showing this chat's browser: send pictures for a few seconds more, starting now.
      if (command.action === "watch") {
        watched.set(id, Date.now() + WATCH_MS);
        // Pages follow the app's own light or dark (prefers-color-scheme), not the computer's.
        if (typeof command.dark === "boolean") { const want = command.dark ? "dark" : "light"; if (nativeTheme.themeSource !== want) nativeTheme.themeSource = want; }
        const aspect = Number(command.aspect);
        if (Number.isFinite(aspect) && aspect > 0) aspects.set(id, aspect);
        const tab = activeTab(chat);
        if (tab && !tab.win.isDestroyed()) { fit(tab); tab.framed = 0; frameSoon(tab); }
        answer(command.id, { watching: Boolean(tab && !tab.win.isDestroyed()) });
        return;
      }
      // Your clicks and keys, only while the page is yours. Not queued: a hand-over waits in the queue.
      if (command.action === "input") {
        const tab = activeTab(chat);
        if (!chat || !tab || tab.win.isDestroyed() || !chat.held) { answer(command.id, { error: "The page is not yours right now." }); return; }
        const contents = tab.win.webContents, events = Array.isArray(command.events) ? command.events.slice(0, 40) : [];
        contents.focus();
        for (const raw of events) {
          const event = handInput(raw);
          if (!event) continue;
          if (event.type === "text") void contents.insertText(event.text);
          else contents.sendInputEvent(event as Parameters<typeof contents.sendInputEvent>[0]);
        }
        chat.used = Date.now();
        frameSoon(tab);
        answer(command.id, { ok: true });
        return;
      }
      if (command.action === "close") { for (const tab of chat?.tabs.values() ?? []) tab.win.destroy(); chats.delete(id); answer(command.id, { closed: true }); return; }
      if (!chat) {
        if (command.action !== "open") { answer(command.id, { error: "No page is open yet: start with action open." }); return; }
        chat = { id, tabs: new Map(), active: 0, next: 1, held: false, queue: Promise.resolve(), used: Date.now(), profile: command.profile, downloads: typeof command.downloads === "string" && command.downloads ? command.downloads : null };
        chats.set(id, chat);
      }
      if (command.action === "open" && typeof command.downloads === "string" && command.downloads) chat.downloads = command.downloads;
      const mine = chat;
      mine.used = Date.now();
      // One command at a time in a chat's browser, in the order they came.
      mine.queue = mine.queue.then(() => run(mine, command)).then((result) => answer(command.id, result), (error) => answer(command.id, { error: error instanceof Error ? error.message : String(error) }));
    });
    // The daemon closing our input (or going away) is the end of the browser.
    lines.on("close", () => { void quit(); });
    // A chat's browser left alone for 20 minutes closes, unless the person has it.
    setInterval(() => { for (const [id, chat] of chats) if (!chat.held && Date.now() - chat.used > IDLE_MS) { for (const tab of chat.tabs.values()) tab.win.destroy(); chats.delete(id); } }, 60_000).unref();
    answer("ready", { ready: true });
  });
}

function shortUrl(url: string): string {
  try { const parsed = new URL(url); return `${parsed.host === "" ? "" : parsed.pathname}${parsed.search}`.slice(0, 120) || url.slice(0, 120); } catch { return url.slice(0, 120); }
}
