/// The chat's browser, beside the chat (pass 248 D). The window splits: the
/// chat on the left, the model's own browser on the right, live. It opens by
/// itself the first time a turn browses, or when you click a browser step, and
/// stays until you close it with ×. When the model hands the page over (a
/// sign-in), your clicks and keys go to the page until you go back to the chat. Scrolling or clicking the page takes it any time,
/// and so does any button in its bar (back, forward, reload, the address, a new tab).
/// Pure parts here; live.ts draws it and runs the picture loop.

export interface SplitTool { name: string; input: Record<string, unknown>; state: string; toolCallId: string }
export interface SplitRun { id: string; entries: readonly ({ type: string } & Partial<SplitTool>)[] }

const isBrowser = (entry: { type: string } & Partial<SplitTool>): entry is { type: "tool" } & SplitTool => entry.type === "tool" && entry.name === "browser";

/// The browser steps of a turn, in order.
export const browserSteps = (run: SplitRun | undefined) => (run?.entries ?? []).filter(isBrowser);

/// What the model is asking you to do on the page right now, and the step that asks.
export function handOverAsk(run: SplitRun | undefined): { reason: string; toolCallId: string } | null {
  const step = browserSteps(run).findLast((tool) => tool.input.action === "hand_over" && tool.state === "running");
  return step ? { reason: typeof step.input.reason === "string" && step.input.reason.trim() ? step.input.reason.trim() : "Do what the page needs", toolCallId: step.toolCallId } : null;
}

export interface SplitWant { open: boolean; closedTurn: string | null; closedAsk: string | null; openedTurn: string | null }
/// Whether the split should be open now. The first browser step of a turn
/// opens it once; closing it keeps it closed for that turn. A hand-over opens
/// it again (it needs you), unless you closed it while that one was asking.
export function splitOpen(want: SplitWant, active: SplitRun | undefined): { open: boolean; openedTurn: string | null } {
  if (!active) return { open: want.open, openedTurn: want.openedTurn };
  const ask = handOverAsk(active);
  if (ask && want.closedAsk !== ask.toolCallId) return { open: true, openedTurn: active.id };
  const browsing = browserSteps(active).some((tool) => tool.input.action !== "close");
  if (browsing && want.openedTurn !== active.id && want.closedTurn !== active.id) return { open: true, openedTurn: active.id };
  return { open: want.open, openedTurn: want.openedTurn };
}

/// A point on the picture, in the page's own CSS pixels.
export function pagePoint(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }, page: { width: number; height: number }) {
  const x = box.width > 0 ? (clientX - box.left) / box.width * page.width : 0;
  const y = box.height > 0 ? (clientY - box.top) / box.height * page.height : 0;
  return { x: Math.round(Math.max(0, Math.min(page.width, x))), y: Math.round(Math.max(0, Math.min(page.height, y))) };
}

/// Keys whose names differ between the window and Electron's input events.
const SPECIAL: Record<string, string> = {
  Backspace: "Backspace", Tab: "Tab", Enter: "Enter", Escape: "Escape", Delete: "Delete", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
};
export interface KeyLike { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }
export type KeyInput = { type: "keyDown" | "keyUp" | "char"; keyCode: string; modifiers?: string[] };
/// One key you pressed on a page that is yours, as the events the page gets.
/// A paste arrives on its own (as text), so Cmd/Ctrl+V sends nothing here.
export function keyInputs(event: KeyLike): KeyInput[] {
  const modifiers = [event.shiftKey && "shift", event.ctrlKey && "control", event.altKey && "alt", event.metaKey && "meta"].filter((one): one is string => Boolean(one));
  const mod = modifiers.length ? { modifiers } : {};
  const chord = Boolean(event.ctrlKey || event.metaKey);
  if (event.key === " ") return [{ type: "keyDown", keyCode: "Space", ...mod }, ...(chord ? [] : [{ type: "char" as const, keyCode: " " }]), { type: "keyUp", keyCode: "Space", ...mod }];
  const special = SPECIAL[event.key];
  if (special) return [{ type: "keyDown", keyCode: special, ...mod }, ...(special === "Enter" && !chord ? [{ type: "char" as const, keyCode: "\r" }] : []), { type: "keyUp", keyCode: special, ...mod }];
  if ([...event.key].length !== 1) return [];
  if (chord) return event.key.toLowerCase() === "v" ? [] : [{ type: "keyDown", keyCode: event.key.toLowerCase(), ...mod }, { type: "keyUp", keyCode: event.key.toLowerCase(), ...mod }];
  return [{ type: "keyDown", keyCode: event.key, ...mod }, { type: "char", keyCode: event.key, ...mod }, { type: "keyUp", keyCode: event.key, ...mod }];
}

/// How wide the browser side may be: room for a page, and room left for the chat.
export const SPLIT_MIN = 360, CHAT_MIN = 380;
export const splitWidth = (wanted: number, total: number) => Math.round(Math.max(SPLIT_MIN, Math.min(Math.max(SPLIT_MIN, total - CHAT_MIN), wanted)));

/// What the model is doing, as a few words at the end of the address (pass 256). Nothing once it is done:
/// the bar is then just a browser bar. `took` is true while you hold a page the model did not ask for.
export function splitDoing(ask: { reason: string } | null, working: string | null, took = false): { tone: "ask" | "mine" | "now"; words: string } | null {
  if (ask) return { tone: "ask", words: `${ask.reason}, then go back to the chat` };
  if (took) return { tone: "mine", words: "Yours · the model waits" };
  if (working) return { tone: "now", words: working };
  return null;
}

/// The page's address can open in your own browser only when it is a web address.
export const openableOutside = (url: string | undefined) => /^https?:\/\//i.test(url ?? "");

/// Where the model last clicked or typed, as a share of the page, while it is fresh.
export const RING_MS = 1600;
export function ringSpot(pointer: { x: number; y: number; ago: number } | undefined, page: { width: number; height: number }): { left: number; top: number } | null {
  if (!pointer || pointer.ago > RING_MS || page.width <= 0 || page.height <= 0) return null;
  const share = (value: number, of: number) => Math.round(Math.max(0, Math.min(1, value / of)) * 10000) / 100;
  return { left: share(pointer.x, page.width), top: share(pointer.y, page.height) };
}

export interface SplitTab { n: number; url: string; title: string; active?: boolean }
/// A tab's short name for its chip: its title, else its site.
export function tabName(tab: SplitTab): string {
  const title = tab.title.trim();
  if (title) return title.length > 28 ? `${title.slice(0, 27)}…` : title;
  try { return new URL(tab.url).host || tab.url; } catch { return tab.url || `Tab ${tab.n}`; }
}

/// The find bar's count: "3 of 12", "No matches", or nothing before you type.
export function findWords(text: string, found: { matches: number; at: number } | null): string {
  if (!text.trim() || !found) return "";
  return found.matches > 0 ? `${Math.max(1, found.at)} of ${found.matches}` : "No matches";
}
/// The zoom chip's words, shown only when the page is not at its own size.
export const zoomWords = (zoom: number | undefined) => zoom && Math.abs(zoom - 1) > 0.001 ? `${Math.round(zoom * 100)}%` : "";
/// A page on this computer (a dev server): what you point at on it is looked up in the project's code.
export const localPage = (url: string) => { try { return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(new URL(url).hostname) || /\.localhost$/.test(new URL(url).hostname); } catch { return false; } };
/// What the browser downloaded for this chat, newest last.
export interface SplitDownload { name: string; path: string; bytes: number }
const sizeWords = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
/// The bar's download chip: the newest file, how many more, and every one in its tooltip.
export function downloadWords(list: readonly SplitDownload[]): { text: string; more: number; title: string } | null {
  const last = list.at(-1);
  if (!last) return null;
  const name = last.name.length > 22 ? `${last.name.slice(0, 21).trimEnd()}…` : last.name;
  return { text: name, more: list.length - 1, title: `${list.map((one) => `${one.name} · ${sizeWords(one.bytes)}`).reverse().join("\n")}\nIn the project’s .demesne/downloads. Click to show it.` };
}

/// A Google sign-in that went to your own browser, and the site coming back signed in.
export interface OutsideSignin { site: string; state: "waiting" | "done" | "failed" | "never"; from?: string; said?: string }
/// What the bar says about it: amber while it waits on you, a plain line once the site is back signed in.
export function outsideDoing(outside: OutsideSignin | null | undefined): { tone: "ask" | "mine" | "now"; words: string } | null {
  if (!outside) return null;
  if (outside.state === "waiting") return { tone: "ask", words: `Google signs in only in your own browser: sign in to ${outside.site} there, and it comes back here` };
  if (outside.state === "done") return { tone: "now", words: `Signed in to ${outside.site}${outside.from ? ` from ${outside.from}` : ""}` };
  if (outside.state === "never") return { tone: "ask", words: `${outside.site} opened in your own browser; email and money sites stay out of Demesne` };
  return { tone: "ask", words: outside.said ? `${outside.site}: ${outside.said}` : `Couldn’t bring ${outside.site} in` };
}
