/// Errors come back (Foundry, after pass 262 C; like Claude artifacts' "Try
/// fixing"): a mockup on Foundry's long page that throws while you use it
/// says so on one quiet line under it, with one press to send the error to
/// the chat that made it. The page's frame tells us (foundry-kit/errors.js);
/// nothing is drawn inside the mockup. Each load of a frame starts clean.

const h = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export interface FoundryPageError { message: string; line: number; stack: string }

/// What the line under a mockup knows: its errors, and where they went once sent.
export interface FoundryErrorState { errors: FoundryPageError[]; sending?: boolean; sent?: string; failed?: string }

/// The mockup version a frame shows, from its address: "id:version", or null.
export function frameKey(src: string): string | null {
  const found = /^foundry:\/\/artifact\/([^?#]+)\?v=(\d+)/.exec(src);
  return found ? `${decodeURIComponent(found[1]!)}:${found[2]}` : null;
}

/// One error as the frame tells it, made safe and short; null for anything else.
export function readError(data: unknown): FoundryPageError | "fresh" | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.demesne !== "error") return null;
  if (message.action === "fresh") return "fresh";
  if (message.action !== "error" || typeof message.message !== "string" || !message.message.trim()) return null;
  const line = typeof message.line === "number" && Number.isSafeInteger(message.line) && message.line > 0 ? message.line : 0;
  return { message: message.message.slice(0, 300), line, stack: typeof message.stack === "string" ? message.stack.slice(0, 600) : "" };
}

/// The quiet line under a mockup: the first error in words, how many more,
/// and Send to the chat; or where it went.
export function errorLine(state: FoundryErrorState | undefined): string {
  if (!state?.errors.length) return "";
  const first = state.errors[0]!, more = state.errors.length - 1;
  const what = `<span class="fd-err-what" title="${h(first.message)}">${h(first.message)}${first.line ? ` <span class="fd-quiet">line ${first.line}</span>` : ""}</span>${more ? `<span class="fd-quiet">and ${more} more</span>` : ""}`;
  const end = state.sending ? '<span class="fd-quiet">Sending…</span>'
    : state.sent ? `<span class="fd-quiet">Sent to ${h(state.sent)}</span>`
    : `<button type="button" class="fd-err-send">Send to the chat</button>${state.failed ? `<span class="fd-quiet">${h(state.failed)}</span>` : ""}`;
  return `<i class="fd-err-dot" aria-hidden="true"></i><span>This page hit an error:</span>${what}${end}`;
}

/// What the chat gets: the mockup, what broke and where, and to fix only that.
export function errorMessage(mockup: { id: string; title: string; version: number }, errors: readonly FoundryPageError[]): string {
  const list = errors.map((error) => `- ${error.message}${error.line ? ` (line ${error.line})` : ""}${error.stack && !error.stack.includes(error.message) ? `\n  ${error.stack.split("\n").slice(0, 3).join("\n  ")}` : ""}`).join("\n");
  return `The Foundry mockup "${mockup.title}" (id ${mockup.id}, v${mockup.version}) hit ${errors.length > 1 ? "these errors" : "this error"} while I was using it:\n${list}\n`
    + "Find the cause and fix only that: foundry_read it, then one foundry_edit, and foundry_try the path that broke. Leave the design as it is.";
}

/// Watches the frames on the page: errors are kept by mockup version, the
/// line under each is painted in place (never a redraw, which would reload
/// every mockup), and Send hands the key to `send`.
export function watchFoundryErrors(root: HTMLElement, store: Map<string, FoundryErrorState>, send: (key: string) => void) {
  const frames = () => [...root.querySelectorAll<HTMLIFrameElement>("iframe.fd-frame")];
  const sectionOf = (key: string) => {
    for (const frame of frames()) if (frameKey(frame.getAttribute("src") ?? "") === key) return frame.closest<HTMLElement>(".fd-item");
    return null;
  };
  function paint(key: string) {
    const section = sectionOf(key);
    if (!section) return;
    let line = section.querySelector<HTMLElement>(":scope > .fd-err");
    const inner = errorLine(store.get(key));
    if (!inner) { line?.remove(); return; }
    if (!line) {
      line = document.createElement("p");
      line.className = "fd-err";
      line.setAttribute("role", "status");
      line.dataset.key = key;
      section.insertBefore(line, section.querySelector(":scope > .fd-said, :scope > .fd-notes"));
    }
    if (line.innerHTML !== inner) line.innerHTML = inner;
  }
  const heard = (event: MessageEvent) => {
    const told = readError(event.data);
    if (!told) return;
    const frame = frames().find((item) => item.contentWindow === event.source);
    const key = frame ? frameKey(frame.getAttribute("src") ?? "") : null;
    if (!key) return;
    // A fresh load forgets what an earlier one said, unless it was just sent.
    if (told === "fresh") { const was = store.get(key); if (was && !was.sending && !was.sent) store.delete(key); paint(key); return; }
    const state = store.get(key) ?? { errors: [] };
    if (state.sent) { state.errors = []; delete state.sent; }
    if (state.errors.some((error) => error.message === told.message) || state.errors.length >= 5) return;
    state.errors.push(told);
    delete state.failed;
    store.set(key, state);
    paint(key);
  };
  const clicked = (event: Event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>(".fd-err-send") : null;
    const key = button?.closest<HTMLElement>(".fd-err")?.dataset.key;
    if (!key) return;
    event.preventDefault(); event.stopPropagation();
    send(key);
  };
  window.addEventListener("message", heard);
  root.addEventListener("click", clicked, true);
  const all = () => { for (const key of store.keys()) paint(key); };
  all();
  return {
    paint: all,
    stop() { window.removeEventListener("message", heard); root.removeEventListener("click", clicked, true); },
  };
}
