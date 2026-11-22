/// Real data in the page (Foundry step 5): the first time a mockup asks for
/// live data from a site (demesne.fetch), a quiet line under it asks you:
/// "This page wants live data from api.example.com. Allow · Not now".
/// Allow is kept for that mockup and that site; nothing is drawn inside it.
import { frameKey } from "./foundry-errors.ts";

const h = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/// A site a frame asks about, made safe; null for anything else.
export function readSiteAsk(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.demesne !== "site" || message.action !== "ask" || typeof message.host !== "string") return null;
  const host = message.host.toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(host) && host.includes(".") ? host : null;
}

/// The line under a mockup that asks you about a site.
export function siteLine(host: string, failed = "") {
  return `<i class="fd-site-dot" aria-hidden="true"></i><span>This page wants live data from <b>${h(host)}</b>.</span>`
    + `<button type="button" class="fd-site-b" data-site="allow">Allow</button><button type="button" class="fd-site-b quiet" data-site="no">Not now</button>`
    + (failed ? `<span class="fd-quiet">${h(failed)}</span>` : "");
}

/// Watches the frames on the page for sites they ask about; `allow` keeps
/// one for a mockup (the app's own store). The answer goes back to every
/// frame of that mockup that asked.
export function watchFoundrySites(root: HTMLElement, allow: (id: string, host: string) => Promise<unknown>) {
  const asks = new Map<string, { host: string; frames: Set<MessageEventSource> }>();
  const frames = () => [...root.querySelectorAll<HTMLIFrameElement>("iframe.fd-frame")];
  const idOf = (key: string) => key.slice(0, key.lastIndexOf(":"));
  function paint(key: string, failed = "") {
    const frame = frames().find((item) => frameKey(item.getAttribute("src") ?? "") === key);
    const section = frame?.closest<HTMLElement>(".fd-item");
    if (!section) return;
    let line = section.querySelector<HTMLElement>(":scope > .fd-site");
    const ask = asks.get(key);
    if (!ask) { line?.remove(); return; }
    if (!line) {
      line = document.createElement("p");
      line.className = "fd-site";
      line.setAttribute("role", "status");
      line.dataset.key = key;
      section.insertBefore(line, section.querySelector(":scope > .fd-err, :scope > .fd-said, :scope > .fd-notes"));
    }
    line.innerHTML = siteLine(ask.host, failed);
  }
  function answer(key: string, allowed: boolean) {
    const ask = asks.get(key);
    if (!ask) return;
    asks.delete(key);
    for (const source of ask.frames) (source as Window).postMessage({ demesne: "site", host: ask.host, allowed }, "*");
    paint(key);
  }
  const heard = (event: MessageEvent) => {
    const host = readSiteAsk(event.data);
    if (!host || !event.source) return;
    const frame = frames().find((item) => item.contentWindow === event.source);
    const key = frame ? frameKey(frame.getAttribute("src") ?? "") : null;
    if (!key) { (event.source as Window).postMessage({ demesne: "site", host, allowed: false }, "*"); return; }
    const ask = asks.get(key);
    // One question at a time per mockup: another site waits for the next ask.
    if (ask && ask.host !== host) { (event.source as Window).postMessage({ demesne: "site", host, allowed: false }, "*"); return; }
    (ask ?? asks.set(key, { host, frames: new Set() }).get(key)!).frames.add(event.source);
    paint(key);
  };
  const clicked = (event: Event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>(".fd-site-b") : null;
    const key = button?.closest<HTMLElement>(".fd-site")?.dataset.key;
    const ask = key ? asks.get(key) : undefined;
    if (!key || !ask) return;
    event.preventDefault(); event.stopPropagation();
    if (button!.dataset.site !== "allow") { answer(key, false); return; }
    void allow(idOf(key), ask.host).then(() => answer(key, true), (error) => paint(key, `Couldn't allow it: ${error instanceof Error ? error.message : String(error)}`));
  };
  window.addEventListener("message", heard);
  root.addEventListener("click", clicked, true);
  return {
    paint() { for (const key of asks.keys()) paint(key); },
    stop() { window.removeEventListener("message", heard); root.removeEventListener("click", clicked, true); },
  };
}
