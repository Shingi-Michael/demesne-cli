/// The assembly, for a document the pane draws itself (a Markdown artifact
/// is rendered in the window, not in a frame): the first time a version
/// shows, its blocks spring into place in reading order; a later version
/// settles only the blocks the edit changed. The same motion as the frame's
/// (electron/foundry-assemble.ts), on the page's own blocks.
import { animate, spring, stagger, utils } from "animejs";

const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "LINK", "META", "BR"]);
const MAX = 80;

/** A document's pieces: its blocks, and a list's or table's rows when that
 * keeps the count sensible. */
export function documentPieces(root: Element): Element[] {
  const blocks = [...root.children].filter((el) => !SKIP.has(el.tagName));
  const out: Element[] = [];
  for (const block of blocks) {
    const rows = /^(UL|OL|TABLE|TBODY|DL)$/.test(block.tagName) ? [...(block.tagName === "TABLE" ? block.querySelectorAll(":scope > tbody > tr, :scope > thead > tr, :scope > tr") : block.children)] : [];
    if (rows.length >= 2 && rows.length <= 40 && out.length + rows.length <= MAX) out.push(...rows);
    else out.push(block);
  }
  return out.slice(0, MAX);
}

const norm = (el: Element) => el.outerHTML.replace(/\s+/g, " ").trim();

/** The pieces that differ from the previous version's, by position. */
export function changedPieces(pieces: Element[], previous: Element): Element[] {
  const old = documentPieces(previous);
  return pieces.filter((piece, index) => !old[index] || norm(old[index]!) !== norm(piece));
}

/** Plays the assembly on a rendered document. `previousHTML` is the last
 * version's rendered HTML, when this is a revision of it. */
export function assembleDocument(root: HTMLElement, previousHTML: string | null) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let list = documentPieces(root);
  if (previousHTML !== null) {
    const before = document.createElement("div");
    before.innerHTML = previousHTML;
    list = changedPieces(list, before);
  }
  if (!list.length) return;
  // The document's own inline transform and opacity, if any, come back at the end.
  const kept = list.map((el) => [(el as HTMLElement).style.transform, (el as HTMLElement).style.opacity]);
  const clean = () => list.forEach((el, index) => { (el as HTMLElement).style.transform = kept[index]![0]!; (el as HTMLElement).style.opacity = kept[index]![1]!; });
  if (previousHTML !== null) {
    utils.set(list, { y: 14, scale: 0.96, opacity: 0 });
    animate(list, { y: 0, scale: 1, opacity: 1, duration: 480, ease: "outExpo", delay: stagger(40), onComplete: clean });
    return;
  }
  utils.set(list, { x: () => utils.random(-200, 200), y: () => utils.random(-140, 140), rotate: () => utils.random(-24, 24), scale: 0.6, opacity: 0 });
  animate(list, {
    x: 0, y: 0, rotate: 0, scale: 1, opacity: 1,
    ease: spring({ mass: 1, stiffness: 150, damping: 14 }),
    delay: stagger(Math.min(22, 1100 / list.length)),
    onComplete: clean,
  });
}
