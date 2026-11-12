/// The model's own browser. The app started as `Demesne --browser-host` shows
/// nothing: no window, no Dock icon, its own profile. It stays up for as long
/// as the daemon keeps its input open, and holds one hidden tab per chat that
/// keeps its page, cookies and place between the model's calls. Commands come
/// in as JSON lines on stdin and each is answered with one JSON line on
/// stdout (apps/daemon/src/browser.ts). A page is read as an outline with a
/// number on every control (browser-runtime.ts); the model clicks and types by
/// number, with real input events, and is told what visibly changed.
/// Only this computer for now: localhost addresses and files.
import { app, BrowserWindow, session as sessions } from "electron";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BROWSER_RUNTIME, OUTLINE_MAX_LINES, PAGE_TEXT_CHARS } from "./browser-runtime.ts";
import { wentTo } from "./foundry-look.ts";
import { changed, TRY_RUNTIME, TRY_WIDTHS, type Fingerprint } from "./foundry-try.ts";

export const BROWSER_HOST_FLAG = "--browser-host";
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

interface Tab { win: BrowserWindow; width: "desktop" | "phone"; errors: string[]; failed: string[]; blocked: string[]; used: number; queue: Promise<unknown> }
type Command = Record<string, unknown> & { id?: unknown; chat?: unknown; action?: unknown };
type Found = { found: boolean; gone?: boolean; hidden?: boolean; names?: string[]; x: number; y: number; many: number; what: string; covered: string | null; disabled: boolean };

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function runBrowserHost() {
  const profile = mkdtempSync(join(tmpdir(), "demesne-browser-"));
  app.setPath("userData", profile);
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  const tabs = new Map<string, Tab>();
  const quit = () => { for (const tab of tabs.values()) tab.win.destroy(); try { rmSync(profile, { recursive: true, force: true }); } catch {} app.exit(0); };
  const answer = (id: unknown, result: Record<string, unknown>) => process.stdout.write(JSON.stringify({ id, ...result }) + "\n");

  function open(chat: string, width: "desktop" | "phone"): Tab {
    const view = TRY_WIDTHS[width];
    const win = new BrowserWindow({ show: false, width: view.width, height: view.height, useContentSize: true, paintWhenInitiallyHidden: true,
      // Its own cookies and storage per chat, kept in memory for as long as the host lives.
      webPreferences: { session: sessions.fromPartition(`browser-${chat}`), offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const tab: Tab = { win, width, errors: [], failed: [], blocked: [], used: Date.now(), queue: Promise.resolve() };
    const contents = win.webContents;
    const refuse = (event: { preventDefault(): void }, url: string) => { if (!localAddress(url)) { event.preventDefault(); if (tab.blocked.length < 4) tab.blocked.push(url.slice(0, 200)); } };
    contents.on("will-navigate", (event, url) => refuse(event, url));
    contents.on("will-redirect", (event, url) => refuse(event, url));
    // A link that wants a new window opens in this tab instead: there is one tab per chat.
    contents.setWindowOpenHandler(({ url }) => {
      if (localAddress(url)) setImmediate(() => { void contents.loadURL(url).catch(() => {}); });
      else if (tab.blocked.length < 4) tab.blocked.push(url.slice(0, 200));
      return { action: "deny" };
    });
    contents.on("console-message", (event) => { if (event.level === "error" && tab.errors.length < 8) tab.errors.push(event.message.slice(0, 200)); });
    contents.session.webRequest.onCompleted((details) => {
      if (details.statusCode >= 400 && tab.failed.length < 8) tab.failed.push(`${details.method} ${shortUrl(details.url)} → ${details.statusCode}`);
    });
    contents.session.webRequest.onErrorOccurred((details) => {
      if (details.error !== "net::ERR_ABORTED" && tab.failed.length < 8) tab.failed.push(`${details.method} ${shortUrl(details.url)} → ${details.error.replace(/^net::/, "")}`);
    });
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
        url: contents.getURL(), title: contents.getTitle(), ...more,
        ...(withOutline ? { outline: await js<string[]>(`window.__demesneBrowser.outline(${OUTLINE_MAX_LINES})`).catch(() => [] as string[]) } : {}),
        ...(dialogs.length ? { dialogs } : {}),
        ...(tab.errors.length ? { errors: tab.errors.splice(0) } : {}), ...(tab.failed.length ? { failed: tab.failed.splice(0) } : {}), ...(tab.blocked.length ? { blocked: tab.blocked.splice(0) } : {}),
      };
    };
    if (action === "open") {
      const url = String(command.url ?? "");
      if (!localAddress(url)) return { error: "The browser opens only this computer's own apps: a localhost address or a file." };
      tab.errors.length = tab.failed.length = tab.blocked.length = 0;
      try { await win.loadURL(url); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/ERR_ABORTED/.test(message)) return { error: `Could not open ${url}: ${message.replace(/^.*?(ERR_[A-Z_]+).*$/s, "$1")}` };
      }
      await Promise.race([js("document.fonts.ready.then(() => true)").catch(() => true), settle(3000)]);
      await settle(250);
      return page(true);
    }
    if (contents.getURL() === "" || contents.getURL() === "about:blank") return { error: "No page is open yet: start with action open." };
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
      if (command.action === "close") { tab?.win.destroy(); tabs.delete(chat); answer(command.id, { closed: true }); return; }
      if (tab && command.action === "open" && command.width !== undefined && tab.width !== width) { tab.win.destroy(); tab = undefined; }
      if (!tab || tab.win.isDestroyed()) tab = open(chat, width);
      const mine = tab;
      mine.used = Date.now();
      // One command at a time in a tab, in the order they came.
      mine.queue = mine.queue.then(() => run(mine, command)).then((result) => answer(command.id, result), (error) => answer(command.id, { error: error instanceof Error ? error.message : String(error) }));
    });
    // The daemon closing our input (or going away) is the end of the browser.
    lines.on("close", quit);
    setInterval(() => { for (const [chat, tab] of tabs) if (Date.now() - tab.used > IDLE_MS) { tab.win.destroy(); tabs.delete(chat); } }, 60_000).unref();
    answer("ready", { ready: true });
  });
}

function shortUrl(url: string): string {
  try { const parsed = new URL(url); return `${parsed.host === "" ? "" : parsed.pathname}${parsed.search}`.slice(0, 120) || url.slice(0, 120); } catch { return url.slice(0, 120); }
}
