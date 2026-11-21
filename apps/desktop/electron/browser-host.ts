/// The model's own browser. The app started as `Demesne --browser-host` shows
/// nothing: no window, no Dock icon, its own profile. It stays up for as long
/// as the daemon keeps its input open, and holds one hidden tab per chat that
/// keeps its page, cookies and place between the model's calls. Commands come
/// in as JSON lines on stdin and each is answered with one JSON line on
/// stdout (apps/daemon/src/browser.ts). A page is read as an outline with a
/// number on every control (browser-runtime.ts); the model clicks and types by
/// number, with real input events, and is told what visibly changed.
/// This computer's own pages always open. A site on the internet opens only
/// once the daemon names it (the person approved it), and the tab then stays
/// on its approved sites; a public page can't reach this computer or its
/// network, download, or ask for the camera.
/// You can watch it (pass 248 D): while the desktop shows a chat's browser,
/// the tab sends small pictures of itself as it repaints. When the model hands
/// it over (a sign-in), your clicks and keys reach the page until you hand it
/// back. With a profile folder, a project's cookies are kept on disk, so a
/// sign-in you do once is still there next time.
import { app, BrowserWindow, session as sessions, type NativeImage, type Session } from "electron";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BROWSER_RUNTIME, OUTLINE_MAX_LINES, PAGE_TEXT_CHARS } from "./browser-runtime.ts";
import { wentTo } from "./foundry-look.ts";
import { changed, TRY_RUNTIME, TRY_WIDTHS, type Fingerprint } from "./foundry-try.ts";

export const BROWSER_HOST_FLAG = "--browser-host";
/// `--browser-profile=<folder>`: where projects' sign-ins are kept between runs.
export const BROWSER_PROFILE_FLAG = "--browser-profile=";
/// A picture of a watched tab at most this often, and no wider than this.
const FRAME_MS = 200;
const FRAME_WIDTH = 1280;
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

interface Tab { win: BrowserWindow; chat: string; width: "desktop" | "phone"; sites: Set<string>; local: boolean; errors: string[]; failed: string[]; blocked: string[]; used: number; queue: Promise<unknown>; handover: boolean; framed: number; frameTimer?: ReturnType<typeof setTimeout> }

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
  const tabs = new Map<string, Tab>();
  /// The tab each page belongs to, for the handlers its session shares with other chats of the project.
  const byContents = new Map<number, Tab>();
  /// Chats the desktop is showing, until when.
  const watched = new Map<string, number>();
  /// The sessions kept on disk, so their cookies are written out before the host goes.
  const keptSessions = new Set<Session>();
  const quit = async () => {
    for (const tab of tabs.values()) tab.win.destroy();
    await Promise.race([Promise.all([...keptSessions].map((one) => one.cookies.flushStore().catch(() => {}))), settle(1000)]);
    if (!kept) try { rmSync(profile, { recursive: true, force: true }); } catch {}
    app.exit(0);
  };
  const write = (line: Record<string, unknown>) => process.stdout.write(JSON.stringify(line) + "\n");
  const answer = (id: unknown, result: Record<string, unknown>) => write({ id, ...result });

  /// A picture of a watched tab, sent as an event the daemon keeps for the desktop.
  const sendFrame = (tab: Tab, image: NativeImage) => {
    if (tab.win.isDestroyed() || (watched.get(tab.chat) ?? 0) < Date.now() || image.isEmpty()) return;
    const view = TRY_WIDTHS[tab.width], size = image.getSize();
    const small = size.width > FRAME_WIDTH ? image.resize({ width: FRAME_WIDTH, quality: "good" }) : image;
    tab.framed = Date.now();
    const contents = tab.win.webContents;
    write({ event: "frame", chat: tab.chat, jpeg: small.toJPEG(76).toString("base64"), width: view.width, height: Math.round(view.width * size.height / Math.max(1, size.width)),
      url: contents.getURL(), title: contents.getTitle(), handover: tab.handover });
  };
  const frameSoon = (tab: Tab) => {
    if (tab.frameTimer || (watched.get(tab.chat) ?? 0) < Date.now()) return;
    const wait = Math.max(0, FRAME_MS - (Date.now() - tab.framed));
    tab.frameTimer = setTimeout(() => {
      tab.frameTimer = undefined;
      if (tab.win.isDestroyed()) return;
      void tab.win.webContents.capturePage().then((image) => sendFrame(tab, image), () => {});
    }, wait);
  };

  /// What a session's pages may do. Set once per session: chats of one project share it.
  const prepared = new WeakSet<Session>();
  function prepare(session: Session) {
    if (prepared.has(session)) return;
    prepared.add(session);
    const tabOf = (id: number | undefined) => id === undefined ? undefined : byContents.get(id);
    // A public page can't reach this computer or its network, download, or ask for the camera and the like.
    session.webRequest.onBeforeRequest((details, callback) => {
      const tab = tabOf(details.webContentsId);
      let host = ""; try { host = new URL(details.url).hostname; } catch {}
      callback({ cancel: Boolean(tab && !tab.local) && details.resourceType !== "mainFrame" && /^(https?|wss?):/.test(details.url) && privateHost(host) });
    });
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.removeAllListeners("will-download");
    session.on("will-download", (event, item, contents) => { event.preventDefault(); const tab = tabOf(contents?.id); if (tab && tab.blocked.length < 4) tab.blocked.push(`${item.getFilename().slice(0, 80)} was not downloaded: the browser saves no files`); });
    session.webRequest.onCompleted((details) => {
      const tab = tabOf(details.webContentsId);
      if (tab?.local && details.statusCode >= 400 && tab.failed.length < 8) tab.failed.push(`${details.method} ${shortUrl(details.url)} → ${details.statusCode}`);
    });
    session.webRequest.onErrorOccurred((details) => {
      const tab = tabOf(details.webContentsId);
      if (tab?.local && details.error !== "net::ERR_ABORTED" && tab.failed.length < 8) tab.failed.push(`${details.method} ${shortUrl(details.url)} → ${details.error.replace(/^net::/, "")}`);
    });
  }

  function open(chat: string, width: "desktop" | "phone", profileKey: unknown): Tab {
    const view = TRY_WIDTHS[width];
    // The project's cookies, kept on disk, when there is a profile folder; else the chat's own, in memory.
    const partition = browserPartition(chat, profileKey, kept);
    const session = sessions.fromPartition(partition);
    if (partition.startsWith("persist:")) keptSessions.add(session);
    prepare(session);
    const win = new BrowserWindow({ show: false, width: view.width, height: view.height, useContentSize: true, paintWhenInitiallyHidden: true,
      webPreferences: { session, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const tab: Tab = { win, chat, width, sites: new Set(), local: true, errors: [], failed: [], blocked: [], used: Date.now(), queue: Promise.resolve(), handover: false, framed: 0 };
    const contents = win.webContents;
    byContents.set(contents.id, tab);
    win.on("closed", () => { byContents.delete(contents.id); clearTimeout(tab.frameTimer); });
    // Repaints become pictures while someone is watching.
    contents.on("paint", () => frameSoon(tab));
    // Where this tab may go by itself: around this computer while it is here, and around the sites the person approved.
    const allowed = (url: string) => {
      if (localAddress(url)) return tab.local;
      const site = siteOf(url);
      return site !== null && [...tab.sites].some((approved) => site === approved || site.endsWith(`.${approved}`));
    };
    const blocked = (url: string) => { if (tab.blocked.length < 4) tab.blocked.push(localAddress(url) ? `${url.slice(0, 200)} was not opened: a public page can't send you into this computer` : `${url.slice(0, 200)} was not opened: it is another site, so open it yourself to go there`); };
    const refuse = (event: { preventDefault(): void }, url: string) => { if (!allowed(url)) { event.preventDefault(); blocked(url); } };
    contents.on("did-navigate", (_event, url) => { tab.local = localAddress(url); });
    // Sites see an ordinary browser, not the app's name.
    contents.setUserAgent(contents.getUserAgent().replace(/\s(?:Electron|demesne[\w-]*)\/\S+/gi, ""));
    contents.on("will-navigate", (event, url) => refuse(event, url));
    contents.on("will-redirect", (event, url) => refuse(event, url));
    // A link that wants a new window opens in this tab instead: there is one tab per chat.
    contents.setWindowOpenHandler(({ url }) => {
      if (allowed(url)) setImmediate(() => { void contents.loadURL(url).catch(() => {}); });
      else blocked(url);
      return { action: "deny" };
    });
    contents.on("console-message", (event) => { if (tab.local && event.level === "error" && tab.errors.length < 8) tab.errors.push(event.message.slice(0, 200)); });
    tabs.set(chat, tab);
    return tab;
  }

  async function run(tab: Tab, command: Command): Promise<Record<string, unknown>> {
    const { win } = tab, contents = win.webContents, action = String(command.action);
    const js = <T>(code: string) => contents.executeJavaScript(code) as Promise<T>;
    const loaded = async () => {
      if (contents.isLoading()) await Promise.race([new Promise<void>((resolve) => contents.once("did-stop-loading", () => resolve())), settle(8000)]);
      await js(TRY_RUNTIME).catch(() => {}); await js(BROWSER_RUNTIME).catch(() => {});
    };
    const page = async (withOutline: boolean, more: Record<string, unknown> = {}) => {
      await loaded();
      const dialogs = await js<string[]>("window.__demesneBrowser ? window.__demesneBrowser.dialogs() : []").catch(() => [] as string[]);
      return {
        url: contents.getURL(), title: contents.getTitle(), ...(tab.local ? {} : { public: true }), ...more,
        ...(withOutline ? { outline: await js<string[]>(`window.__demesneBrowser.outline(${OUTLINE_MAX_LINES})`).catch(() => [] as string[]) } : {}),
        ...(dialogs.length ? { dialogs } : {}),
        ...(tab.errors.length ? { errors: tab.errors.splice(0) } : {}), ...(tab.failed.length ? { failed: tab.failed.splice(0) } : {}), ...(tab.blocked.length ? { blocked: tab.blocked.splice(0) } : {}),
      };
    };
    if (action === "open") {
      const url = String(command.url ?? "");
      // The daemon names a site only after the person approved it.
      const site = siteOf(url);
      if (site !== null && command.site !== site) return { error: "That site was not approved for the browser." };
      if (site !== null) tab.sites.add(site);
      tab.local = site === null;
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
      return page(true);
    }
    if (contents.getURL() === "" || contents.getURL() === "about:blank") return { error: "No page is open yet: start with action open." };
    // Handed to the person (a sign-in) and back. Back, the model reads the page again: it saw nothing in between.
    if (action === "handover") {
      tab.handover = command.on === true;
      frameSoon(tab);
      if (tab.handover) { contents.focus(); return { url: contents.getURL(), title: contents.getTitle(), handover: true }; }
      tab.local = localAddress(contents.getURL());
      tab.errors.length = tab.failed.length = 0;
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
    // The rest act on the page, then say what a person would have seen happen.
    const print = () => js<Fingerprint>("window.__demesneTry.fingerprint()");
    const find = (ref: unknown) => typeof ref === "number" || /^\d+$/.test(String(ref))
      ? js<Found>(`window.__demesneBrowser.locate(${Number(ref)})`) : js<Found>(`window.__demesneTry.find(${JSON.stringify(String(ref))})`);
    const click = async (x: number, y: number) => {
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
    const before = await print(), at = contents.getURL(), y0 = await js<number>("scrollY");
    let result: { ok: boolean; said: string } = { ok: true, said: "" };
    if (action === "click") result = await reach(command.ref, click);
    else if (action === "hover") result = await reach(command.ref, async (x, y) => { contents.sendInputEvent({ type: "mouseMove", x, y }); });
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
      const chat = String(command.chat ?? ""), width = command.width === "phone" ? "phone" as const : "desktop" as const;
      if (!chat) { answer(command.id, { error: "chat is required" }); return; }
      let tab = tabs.get(chat);
      // Someone is showing this chat's browser: send pictures for a few seconds more, starting now.
      if (command.action === "watch") {
        watched.set(chat, Date.now() + WATCH_MS);
        // The page is as tall as the split shows it, so the picture fills it; its width stays the model's.
        const aspect = Number(command.aspect);
        if (tab && !tab.win.isDestroyed() && Number.isFinite(aspect) && aspect > 0) {
          const view = TRY_WIDTHS[tab.width], [, height] = tab.win.getContentSize();
          const wanted = Math.round(Math.max(view.height * 0.75, Math.min(view.width * 3, view.width * aspect)));
          if (Math.abs(wanted - (height ?? 0)) > 24) tab.win.setContentSize(view.width, wanted);
        }
        if (tab && !tab.win.isDestroyed()) { tab.framed = 0; frameSoon(tab); }
        answer(command.id, { watching: Boolean(tab && !tab.win.isDestroyed()) });
        return;
      }
      // Your clicks and keys, only while the model has handed you the page. Not queued: the hand-over waits in the queue.
      if (command.action === "input") {
        if (!tab || tab.win.isDestroyed() || !tab.handover) { answer(command.id, { error: "The page is not yours right now." }); return; }
        const contents = tab.win.webContents, events = Array.isArray(command.events) ? command.events.slice(0, 40) : [];
        contents.focus();
        for (const raw of events) {
          const event = handInput(raw);
          if (!event) continue;
          if (event.type === "text") void contents.insertText(event.text);
          else contents.sendInputEvent(event as Parameters<typeof contents.sendInputEvent>[0]);
        }
        tab.used = Date.now();
        frameSoon(tab);
        answer(command.id, { ok: true });
        return;
      }
      if (command.action === "close") { tab?.win.destroy(); tabs.delete(chat); answer(command.id, { closed: true }); return; }
      if (tab && command.action === "open" && command.width !== undefined && tab.width !== width) { tab.win.destroy(); tab = undefined; }
      if (!tab || tab.win.isDestroyed()) tab = open(chat, width, command.profile);
      const mine = tab;
      mine.used = Date.now();
      // One command at a time in a tab, in the order they came.
      mine.queue = mine.queue.then(() => run(mine, command)).then((result) => answer(command.id, result), (error) => answer(command.id, { error: error instanceof Error ? error.message : String(error) }));
    });
    // The daemon closing our input (or going away) is the end of the browser.
    lines.on("close", () => { void quit(); });
    // A tab handed to you is not closed under you.
    setInterval(() => { for (const [chat, tab] of tabs) if (!tab.handover && Date.now() - tab.used > IDLE_MS) { tab.win.destroy(); tabs.delete(chat); } }, 60_000).unref();
    answer("ready", { ready: true });
  });
}

function shortUrl(url: string): string {
  try { const parsed = new URL(url); return `${parsed.host === "" ? "" : parsed.pathname}${parsed.search}`.slice(0, 120) || url.slice(0, 120); } catch { return url.slice(0, 120); }
}
