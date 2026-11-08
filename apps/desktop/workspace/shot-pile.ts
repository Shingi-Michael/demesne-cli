/// Screenshots that pile up (pass 202 A). Every picture a chat has seen, the
/// windows and pages it took and the ones you sent it, stacks into one pile
/// card on the right, newest on top, for the whole chat. Hover fans it out; a
/// click opens them full size to flip through. Above it, two quiet lists:
/// what the chat made, and what it looked at. Each thing shows once.
import { pageLookOutcome, pageName, pictureCaption } from "./page-look-row.ts";

export interface PileShot {
  /// The picture's id in this chat (an attachment or a tool's picture).
  id: string;
  caption: string;
  by: "you" | "chat";
}

interface PileTool { name: string; state: string; input: Record<string, unknown>; message?: string; phase?: string; created?: boolean; changes?: { path: string; beforeExists: boolean; afterExists: boolean }[] }
interface PileRun { attachments?: { id: string; filename: string }[]; entries: readonly { type: string }[] }

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const toolsOf = (run: PileRun) => run.entries.filter((entry): entry is PileTool & { type: "tool" } => entry.type === "tool");

/// The chat's pictures in the order it saw them, each once.
export function chatPile(runs: readonly PileRun[], hidden: ReadonlySet<string> = new Set()): PileShot[] {
  const out: PileShot[] = [], seen = new Set<string>();
  const add = (shot: PileShot) => { if (!shot.id || seen.has(shot.id) || hidden.has(shot.id)) return; seen.add(shot.id); out.push(shot); };
  for (const run of runs) {
    for (const image of run.attachments ?? []) add({ id: image.id, caption: image.filename.replace(/\.(png|jpe?g|webp|gif)$/i, ""), by: "you" });
    for (const tool of toolsOf(run)) {
      if (tool.state !== "done" || !tool.message) continue;
      if (tool.name === "capture_window") {
        try {
          const value = JSON.parse(tool.message) as { app?: string; title?: string; picture?: { id?: string } };
          if (typeof value.picture?.id === "string") add({ id: value.picture.id, caption: String(value.title || value.app || "A window"), by: "chat" });
        } catch { /* not a picture */ }
      }
      if (tool.name === "look_at_page") {
        const look = pageLookOutcome(tool.message);
        for (const picture of look?.pictures ?? []) add({ id: picture.id, caption: pictureCaption(picture.label, pageName(look!.url)), by: "chat" });
      }
    }
  }
  return out;
}

/// What the chat made (files it created) and looked at (folders it listed,
/// pages it opened), each once, oldest first.
export function chatShelf(runs: readonly PileRun[], root: string): { made: string[]; looked: { label: string; title: string }[] } {
  const made: string[] = [], looked = new Map<string, string>();
  const strip = (path: string) => root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  for (const run of runs) for (const tool of toolsOf(run)) {
    if (tool.state !== "done") continue;
    if (tool.phase === "change") {
      const fresh = tool.changes?.length
        ? tool.changes.filter((change) => !change.beforeExists && change.afterExists).map((change) => change.path)
        : tool.name === "write_file" && tool.created && typeof tool.input.path === "string" ? [tool.input.path] : [];
      for (const path of fresh.map(strip)) if (path && !made.includes(path)) made.push(path);
    }
    if (tool.name === "list_files") {
      const path = strip(String(tool.input.path ?? ".").replace(/\/+$/, ""));
      const label = !path || path === "." ? `${root.split("/").filter(Boolean).at(-1) ?? "this folder"}/` : `${path}/`;
      if (!looked.has(label)) looked.set(label, path || ".");
    }
    if ((tool.name === "web_fetch" || tool.name === "look_at_page") && typeof tool.input.url === "string") {
      const label = pageName(tool.input.url);
      if (!looked.has(label)) looked.set(label, tool.input.url);
    }
  }
  // Something it made isn't also something it looked at.
  return { made, looked: [...looked].filter(([label]) => !made.includes(label)).map(([label, title]) => ({ label, title })) };
}

/// Up to three pictures fanned out, newest on top; on hover they spread out
/// in a row. `src` gives a picture's data URL once it's loaded; `landing`
/// is a picture that just joined, which drops onto the pile.
const REST = ["translate(0px,0px) rotate(-1.5deg)", "translate(-8px,6px) rotate(-5deg)", "translate(10px,10px) rotate(4deg)"];
export function pileHTML(shots: readonly PileShot[], src: (id: string) => string | undefined, landing?: string): string {
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
  return `<button type="button" class="pile-stack" data-action="pile-open" data-args='{"index":${shots.length - 1}}' aria-label="Look through the ${word}">${shots.length > 1 ? `<span class="pile-n">${shots.length}</span>` : ""}${pictures}</button>`
    + `<div class="pile-cap"><span>${word}</span><span>${shots.length > 1 ? "newest on top" : h(shots[0]!.caption)}</span></div>`;
}

/// The quiet lists above the pile: up to three of each, then "and N more".
export function shelfListsHTML(made: readonly string[], looked: readonly { label: string; title: string }[], link: (path: string, label: string) => string): string {
  const list = (title: string, items: string[]) => items.length ? `<div class="shelf-list"><div class="shelf-title"><span>${title}</span><span>${items.length}</span></div>${items.slice(0, 3).join("")}${items.length > 3 ? `<div class="shelf-more">and ${items.length - 3} more</div>` : ""}</div>` : "";
  const name = (path: string) => path.split("/").at(-1) ?? path;
  return list("Made", made.map((path) => `<div class="shelf-row" title="${h(path)}"><i aria-hidden="true">▤</i>${link(path, name(path))}</div>`))
    + list("Looked at", looked.map((item) => `<div class="shelf-row" title="${h(item.title)}"><i aria-hidden="true">${item.label.endsWith("/") ? "▢" : "↗"}</i><span>${h(item.label)}</span></div>`));
}

/// The flip-through: one picture full size, ‹ › and the arrow keys, a strip of
/// all of them, and Remove (it leaves the pile, not the chat).
export function showPile(shots: readonly PileShot[], index: number, src: (id: string) => string | undefined, remove: (id: string) => void, root: HTMLElement = document.body): HTMLElement {
  root.querySelector(".pile-view")?.remove();
  const view = document.createElement("div");
  view.className = "pile-view";
  view.setAttribute("role", "dialog");
  let at = Math.max(0, Math.min(index, shots.length - 1));
  let list = [...shots];
  const draw = () => {
    const shot = list[at]!, url = src(shot.id);
    view.setAttribute("aria-label", shot.caption);
    view.innerHTML = `<figure><img data-picture="${h(shot.id)}" alt="${h(shot.caption)}"${url ? ` src="${h(url)}"` : ""}><figcaption>${h(shot.caption)} · ${shot.by === "you" ? "you sent it" : "the chat took it"} · <button type="button" class="pile-remove">Remove</button></figcaption></figure>`
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
    if (target.closest(".pile-remove")) {
      remove(list[at]!.id);
      list = list.filter((_, i) => i !== at);
      if (!list.length) return close();
      at = Math.min(at, list.length - 1);
      return draw();
    }
    if (!target.closest("img")) close();
  });
  document.addEventListener("keydown", key, true);
  draw();
  root.append(view);
  return view;
}
