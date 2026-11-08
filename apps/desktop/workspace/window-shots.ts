/// Screenshots that land in a card (pass 187 A). The capture keys take the
/// window you're in; its picture lands as a card after the last card on the
/// right, and goes with your next message along with the window's text. The
/// window you were looking at is never covered: a small copy peels off and
/// glides into the card column, which opens a gap for it.
import type { Paste } from "./pastes.ts";

export interface WindowShot {
  /// The uploaded attachment's id.
  id: string;
  sessionId: string;
  app: string; title: string;
  /// The picture, as the page shows it.
  url: string;
  text: string; textNote?: string;
  at: number;
  /// The picture shown whole in its card.
  big?: boolean;
}

export interface Rect { x: number; y: number; width: number; height: number }

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export const SHOT_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/></svg>';

/// The card's key: letters, digits and dashes.
export const shotKey = (shot: WindowShot) => `shot-${shot.id.replace(/[^a-z0-9]/gi, "").slice(0, 16).toLowerCase()}`;
export const shotName = (shot: WindowShot) => shot.title || shot.app || "Window";

/// One screenshot waiting to go: the app and window name, ×, the picture and
/// "Goes with your next message". Once sent it joins the chat's pile
/// (shot-pile.ts).
export function shotCardHTML(shot: WindowShot): string {
  const key = shotKey(shot), name = h(shotName(shot));
  const picture = `<button type="button" class="shot-pic${shot.big ? " big" : ""}" data-action="shot-big" data-args='${JSON.stringify({ id: shot.id })}' aria-label="${shot.big ? "Show less of" : "Show all of"} the screenshot of ${name}"><img${shot.url ? ` src="${h(shot.url)}"` : ""} alt="Screenshot of ${name}" draggable="false"></button>`;
  const app = shot.app && shot.app !== shot.title ? `<b>${h(shot.app)}</b>${shot.title ? " · " : ""}` : "";
  return `<section class="card shot" data-card="${key}"><div class="card-head shot-head">${SHOT_ICON}<span class="card-line" title="${h([shot.app, shot.title].filter(Boolean).join(" · "))}">${app}${shot.title ? h(shot.title) : app ? "" : "Window"}</span><button type="button" class="shot-x" data-action="detach" data-args='${JSON.stringify({ id: shot.id })}' aria-label="Remove the screenshot of ${name}">×</button></div>${picture}<small class="shot-note">${shot.text ? "Goes with your next message, with its text" : h(shot.textNote ? `Goes with your next message. ${shot.textNote}` : "Goes with your next message")}</small></section>`;
}

/// The window's text, sent folded after your words like a big paste.
export function shotPaste(shot: WindowShot): Paste | null {
  if (!shot.text.trim()) return null;
  return { id: shot.id, text: `Text from ${[shot.app, shot.title].filter(Boolean).join(" — ")}:\n${shot.text}` };
}

/// The composer's note while a screenshot waits.
export function shotsNote(shots: readonly WindowShot[]): string {
  if (!shots.length) return "";
  const names = shots.map((shot) => shot.app || shotName(shot));
  const who = shots.length === 1 ? names[0]! : shots.length === 2 ? `${names[0]} and ${names[1]}` : `${shots.length} screenshots`;
  return `<span class="att shot-note-att">${SHOT_ICON}<span class="att-name">${h(who)} ${shots.length === 1 ? "goes" : "go"} with this</span></span>`;
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/// The landing (pass 187 A, lift and glide). `from` is where the window was,
/// in the page's pixels; when it's unknown or nowhere near the page, the
/// copy starts just right of the column, so it still glides in.
/// The card is already in place (hidden); it opens a gap while the copy
/// travels, glows once and its name slides in.
export function landShot(card: HTMLElement, from: Rect | undefined, layer: HTMLElement = document.body): Promise<void> {
  const picture = card.querySelector<HTMLElement>(".shot-pic"), image = picture?.querySelector("img");
  const parts = [card.querySelector<HTMLElement>(".shot-head"), card.querySelector<HTMLElement>(".shot-note")].filter((part): part is HTMLElement => Boolean(part));
  if (!picture || !image || reduced() || typeof card.animate !== "function") {
    card.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    return Promise.resolve();
  }
  const height = card.offsetHeight, target = picture.getBoundingClientRect();
  const width = innerWidth, tall = innerHeight;
  // A window far off the page (another screen) starts at the page's edge.
  const start = from && from.width > 0 && from.x < width && from.y < tall && from.x + from.width > 0 && from.y + from.height > 0
    ? from : { x: width + 40, y: target.top - 40, width: target.width * 2.2, height: target.width * 2.2 * 0.62 };
  const ratio = image.naturalWidth && image.naturalHeight ? image.naturalHeight / image.naturalWidth : start.height / start.width;
  const copy = document.createElement("div");
  copy.className = "shot-copy";
  copy.innerHTML = `<img src="${image.src}" alt="">`;
  layer.appendChild(copy);
  for (const part of [picture, ...parts]) part.style.opacity = "0";
  card.style.overflow = "hidden";
  const box = (x: number, y: number, w: number, extra: Record<string, string | number> = {}) => ({ left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${w * ratio}px`, ...extra });
  const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
  const s = 0.9, sw = start.width * s, cx = start.x + start.width / 2, cy = start.y + start.height / 2;
  const mw = lerp(start.width, target.width, 0.72), mx = lerp(cx, target.left + target.width / 2, 0.55) - mw / 2, my = lerp(cy, target.top + target.height / 2, 0.55) - mw * ratio / 2 - 70;
  const ow = target.width * 1.06;
  const duration = 880, easing = "cubic-bezier(.45,.05,.25,1)";
  const flight = copy.animate([
    box(start.x, start.y, start.width, { transform: "rotate(0deg)", boxShadow: "0 20px 50px -18px rgba(0,0,0,.7)", opacity: 0, offset: 0 }),
    box(cx - sw / 2, cy - sw * ratio / 2, sw, { transform: "rotate(-1.5deg)", boxShadow: "0 34px 70px -18px rgba(0,0,0,.85)", opacity: 1, offset: 0.16 }),
    box(mx, my, mw, { transform: "rotate(-4deg)", boxShadow: "0 26px 50px -16px rgba(0,0,0,.75)", opacity: 1, offset: 0.58 }),
    box(target.left - (ow - target.width) / 2, target.top - (ow * ratio - target.height) / 2, ow, { transform: "rotate(.8deg)", boxShadow: "0 10px 24px -10px rgba(0,0,0,.6)", opacity: 1, offset: 0.86 }),
    box(target.left, target.top, target.width, { transform: "rotate(0deg)", boxShadow: "0 0 0 1px rgba(255,255,255,.08)", opacity: 1, offset: 1 }),
  ], { duration, easing, fill: "both" });
  // The column makes room while it travels.
  card.animate([{ height: "0px" }, { height: `${height}px` }], { duration: duration * 0.45, delay: duration * 0.4, easing: "cubic-bezier(.3,.7,.2,1)", fill: "backwards" });
  return flight.finished.then(() => {
    picture.style.opacity = "";
    card.style.overflow = "";
    copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" }).finished.then(() => copy.remove(), () => copy.remove());
    card.animate([{ boxShadow: "0 0 0 1px rgba(242,182,200,0)" }, { boxShadow: "0 0 0 1.5px rgba(242,182,200,.65), 0 0 18px rgba(242,182,200,.18)", offset: 0.3 }, { boxShadow: "0 0 0 1px rgba(242,182,200,0)" }], { duration: 900 });
    parts.forEach((part, index) => {
      part.style.opacity = "";
      part.animate([{ opacity: 0, transform: "translateX(-5px)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: 120 + index * 140, easing: "ease-out", fill: "backwards" });
    });
  }, () => { copy.remove(); for (const part of [picture, ...parts]) part.style.opacity = ""; card.style.overflow = ""; });
}
