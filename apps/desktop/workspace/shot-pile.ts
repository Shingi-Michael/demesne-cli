/// Screenshots that pile up (pass 202 A), and leave (pass 247 A). The pictures
/// of the turn that is running, the windows and pages the chat takes and the
/// ones you sent with it, stack into one pile card on the right, newest on
/// top. Hover fans it out; a click opens them full size to flip through. Just
/// the pictures, no words (Mike, 2026-11-09). Each picture shows once. When
/// the answer is done the pile lifts away: a picture you sent stays in your
/// message, and one the chat took stays as a small picture on its step.
import { pageLookOutcome, pageName, pictureCaption } from "./page-look-row.ts";

export interface PileShot {
  /// The picture's id in this chat (an attachment or a tool's picture).
  id: string;
  caption: string;
  by: "you" | "chat";
}

interface PileTool { name: string; state: string; input: Record<string, unknown>; message?: string; phase?: string; created?: boolean; changes?: { path: string; beforeExists: boolean; afterExists: boolean }[] }
interface PileRun { attachments?: { id: string; filename: string; kind?: string }[]; entries: readonly { type: string }[] }

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const toolsOf = (run: PileRun) => run.entries.filter((entry): entry is PileTool & { type: "tool" } => entry.type === "tool");

/// The one picture a step took: a window the chat captured, or what open and
/// show pictured (pass 210 A). Null for every other step. A page look has
/// several and draws them itself (page-look-row.ts).
export function stepPicture(tool: { name: string; state: string; message?: string }): PileShot | null {
  if (tool.state !== "done" || !tool.message || !["capture_window", "open", "show"].includes(tool.name)) return null;
  try {
    const value = JSON.parse(tool.message) as { name?: string; title?: string; app?: string; picture?: { id?: string } };
    if (typeof value.picture?.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.picture.id)) return null;
    const caption = tool.name === "capture_window" ? value.title || value.app || "A window" : value.title || value.name || value.app || "A preview";
    return { id: value.picture.id, caption: String(caption), by: "chat" };
  } catch { return null; }
}

/// The small picture on the step that took it (pass 247 A): a click opens it
/// full size. `src` gives the picture's data URL once it's loaded.
export function stepShotHTML(shot: PileShot, src: (id: string) => string | undefined): string {
  const url = src(shot.id);
  return `<button type="button" class="step-shot" data-action="look-picture" data-args="${h(JSON.stringify({ id: shot.id, caption: shot.caption }))}" title="${h(shot.caption)}" aria-label="Open the screenshot of ${h(shot.caption)}">`
    + `<img data-picture="${h(shot.id)}" alt=""${url ? ` src="${h(url)}"` : ""}></button>`;
}

/// The pictures of these turns in the order the chat saw them, each once.
/// `hidden` leaves some out: the one that has a card of its own.
export function chatPile(runs: readonly PileRun[], hidden: ReadonlySet<string> = new Set()): PileShot[] {
  const out: PileShot[] = [], seen = new Set<string>();
  const add = (shot: PileShot) => { if (!shot.id || seen.has(shot.id) || hidden.has(shot.id)) return; seen.add(shot.id); out.push(shot); };
  for (const run of runs) {
    for (const image of (run.attachments ?? []).filter((one) => one.kind !== "file")) add({ id: image.id, caption: image.filename.replace(/\.(png|jpe?g|webp|gif)$/i, ""), by: "you" });
    for (const tool of toolsOf(run)) {
      if (tool.state !== "done" || !tool.message) continue;
      const one = stepPicture(tool);
      if (one) add(one);
      if (tool.name === "look_at_page") {
        const look = pageLookOutcome(tool.message);
        for (const picture of look?.pictures ?? []) add({ id: picture.id, caption: pictureCaption(picture.label, pageName(look!.url)), by: "chat" });
      }
    }
  }
  return out;
}

/// Up to three pictures fanned out, newest on top; on hover they spread out
/// in a row. `src` gives a picture's data URL once it's loaded; `landing`
/// is a picture that just joined, which drops onto the pile.
const REST = ["translate(0px,0px) rotate(-1.5deg)", "translate(-8px,6px) rotate(-5deg)", "translate(10px,10px) rotate(4deg)"];
export function pileHTML(shots: readonly PileShot[], src: (id: string) => string | undefined, landing?: string, leaving = false): string {
  if (!shots.length) return "";
  const top = shots.slice(-3), n = top.length;
  const pictures = top.map((shot, index) => {
    const depth = n - 1 - index;
    // Spread like a hand of cards, oldest on the left, at 0.6 of their size.
    const off = index - (n - 1) / 2;
    const fan = n === 1 ? "translate(0px,0px) scale(.92)" : `translate(${Math.round(off * (n === 2 ? 66 : 72))}px,${Math.round(Math.abs(off) * 8)}px) rotate(${off * 6}deg) scale(.6)`;
    const url = src(shot.id);
    return `<img class="pile-shot${shot.id === landing && depth === 0 ? " landing" : ""}" style="--rest:${REST[depth]};--fan:${fan};z-index:${10 - depth}" data-picture="${h(shot.id)}" alt="${h(shot.caption)}" draggable="false"${url ? ` src="${h(url)}"` : ""}>`;
  }).join("");
  const word = shots.length === 1 ? "1 screenshot" : `${shots.length} screenshots`;
  // Lifting away once the answer is done: a picture, no longer a thing to press.
  if (leaving) return `<div class="pile-stack" aria-hidden="true">${pictures}</div>`;
  return `<button type="button" class="pile-stack" data-action="pile-open" data-args='{"index":${shots.length - 1}}' aria-label="Look through the ${word}">${shots.length > 1 ? `<span class="pile-n">${shots.length}</span>` : ""}${pictures}</button>`;
}

/// The flip-through: one picture full size, ‹ › and the arrow keys, and a strip
/// of all of them. Nothing to remove: the pile goes by itself (pass 247 A).
export function showPile(shots: readonly PileShot[], index: number, src: (id: string) => string | undefined, root: HTMLElement = document.body): HTMLElement {
  root.querySelector(".pile-view")?.remove();
  const view = document.createElement("div");
  view.className = "pile-view";
  view.setAttribute("role", "dialog");
  let at = Math.max(0, Math.min(index, shots.length - 1));
  const list = [...shots];
  const draw = () => {
    const shot = list[at]!, url = src(shot.id);
    view.setAttribute("aria-label", shot.caption);
    view.innerHTML = `<figure><img data-picture="${h(shot.id)}" alt="${h(shot.caption)}"${url ? ` src="${h(url)}"` : ""}><figcaption>${h(shot.caption)} · ${shot.by === "you" ? "you sent it" : "the chat took it"}</figcaption></figure>`
      + (list.length > 1 ? `<div class="pile-nav"><button type="button" class="pile-prev" aria-label="Previous">‹</button><span>${at + 1} of ${list.length}</span><button type="button" class="pile-next" aria-label="Next">›</button></div>`
        + `<div class="pile-strip">${list.map((one, i) => `<button type="button" class="pile-thumb${i === at ? " on" : ""}" data-at="${i}" aria-label="${h(one.caption)}"><img data-picture="${h(one.id)}" alt=""${src(one.id) ? ` src="${h(src(one.id)!)}"` : ""}></button>`).join("")}</div>` : "");
  };
  const close = () => { view.remove(); document.removeEventListener("keydown", key, true); };
  const step = (by: number) => { at = (at + by + list.length) % list.length; draw(); };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowLeft" && list.length > 1) step(-1);
    else if (event.key === "ArrowRight" && list.length > 1) step(1);
    else return;
    event.stopPropagation(); event.preventDefault();
  };
  view.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest(".pile-prev")) return step(-1);
    if (target.closest(".pile-next")) return step(1);
    const thumb = target.closest<HTMLElement>(".pile-thumb");
    if (thumb) { at = Number(thumb.dataset.at) || 0; return draw(); }
    if (!target.closest("img")) close();
  });
  document.addEventListener("keydown", key, true);
  draw();
  root.append(view);
  return view;
}
