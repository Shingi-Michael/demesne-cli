/// The chat's browser, beside the chat (pass 248 D). The window splits: the
/// chat on the left, the model's own browser on the right, live. It opens by
/// itself the first time a turn browses, or when you click a browser step, and
/// stays until you close it with ×. When the model hands the page over (a
/// sign-in), your clicks and keys go to the page until you press Hand back.
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

/// The line under the page.
export function splitFoot(ask: { reason: string } | null, working: string | null, hasPage: boolean): { tone: "ask" | "now" | ""; words: string } {
  if (ask) return { tone: "ask", words: `${ask.reason}, then hand it back. The model can't see what you type.` };
  if (working) return { tone: "now", words: working };
  return { tone: "", words: hasPage ? "The model is done with this page. Look at it, or close it with ×." : "The page shows here once the model opens one." };
}
