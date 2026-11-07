/// File previews (pass 188 A). A click on a file name in the chat, the steps
/// or the Changes card opens the file as the last card on the right. A click
/// on the preview widens the column so it can be read, × or the name again
/// closes it. The motion is take 2: it grows out of the name you clicked,
/// lifts a little and settles; the column slides; closing folds it back into
/// its name, which glows for a moment.
import type { FilePreview } from "@demesne/protocol";

export interface Rect { x: number; y: number; width: number; height: number }

export interface OpenPreview {
  sessionId: string;
  path: string;
  name: string;
  data?: FilePreview;
  error?: string;
  wide: boolean;
  sheet: number;
  slide: number;
  /// Where the name was clicked, for the grow and the fold.
  from?: Rect;
  /// Set until the card has grown in.
  landing?: boolean;
}

export const PREVIEW_CARD = "file-preview";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const args = (value: object) => h(JSON.stringify(value));
export const FILE_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
export const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/// What the head says beside the name.
export function previewSummary(data: FilePreview | undefined): string {
  if (!data) return "";
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (data.kind === "sheet") return data.sheets.length > 1 ? n(data.sheets.length, "sheet") : `${data.sheets[0]?.rows.length ?? 0}${data.sheets[0]?.more ? "+" : ""} rows`;
  if (data.kind === "slides") return n(data.slides.length, "slide");
  if (data.kind === "pdf") return "PDF";
  if (data.kind === "doc") return data.name.toLowerCase().endsWith(".docx") ? "Word" : "";
  return "";
}

const letters = (index: number) => { let out = ""; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; };
const numeric = (cell: string) => /^[−-]?[$€£¥]?[\d,]+(\.\d+)?%?$/.test(cell.trim());

/// The file itself, drawn at the card's size.
export function fileBodyHTML(preview: OpenPreview): string {
  const data = preview.data;
  if (preview.error) return `<div class="fp-empty">${h(preview.error)}</div>`;
  if (!data) return '<div class="fp-empty fp-loading">Opening…</div>';
  if (data.kind === "sheet") {
    const sheet = data.sheets[Math.min(preview.sheet, data.sheets.length - 1)]!;
    const width = Math.max(1, ...sheet.rows.map((row) => row.length));
    const head = `<tr><th></th>${Array.from({ length: width }, (_, i) => `<th>${letters(i)}</th>`).join("")}</tr>`;
    const rows = sheet.rows.map((row, r) => `<tr><th>${r + 1}</th>${Array.from({ length: width }, (_, i) => { const cell = row[i] ?? ""; return `<td class="${numeric(cell) ? "n" : ""}${/^[−-]/.test(cell) && numeric(cell) ? " neg" : ""}">${h(cell)}</td>`; }).join("")}</tr>`).join("");
    const tabs = data.sheets.length > 1 ? `<div class="fp-tabs">${data.sheets.map((one, i) => `<button type="button" class="${i === preview.sheet ? "on" : ""}" data-action="preview-sheet" data-args="${args({ index: i })}">${h(one.name)}</button>`).join("")}</div>` : "";
    return `<div class="fp-file fp-sheet"><div class="fp-scroll"><table>${head}${rows}</table>${sheet.more ? '<div class="fp-more">More rows past here. Open it to see them all.</div>' : ""}</div>${tabs}</div>`;
  }
  if (data.kind === "doc") {
    const blocks = data.blocks.map((block) => block.level ? `<h${block.level + 2}>${h(block.text)}</h${block.level + 2}>` : block.text ? `<p${block.bullet ? ' class="li"' : ""}>${h(block.text)}</p>` : "").join("");
    return `<div class="fp-file fp-doc"><div class="fp-page">${blocks || '<p class="fp-quiet">Empty</p>'}${data.more ? '<p class="fp-quiet">…</p>' : ""}</div></div>`;
  }
  if (data.kind === "slides") {
    if (!data.slides.length) return '<div class="fp-empty">No slides</div>';
    const at = Math.min(preview.slide, data.slides.length - 1), slide = data.slides[at]!;
    const go = (to: number) => args({ index: Math.max(0, Math.min(data.slides.length - 1, to)) });
    const strip = preview.wide && data.slides.length > 1 ? `<div class="fp-strip">${data.slides.map((one, i) => `<button type="button" class="${i === at ? "on" : ""}" data-action="preview-slide" data-args="${args({ index: i })}" title="${h(one.title)}" style="aspect-ratio:${data.ratio}"><span>${h(one.title)}</span></button>`).join("")}</div>` : "";
    return `<div class="fp-file fp-slides"><div class="fp-slide" style="aspect-ratio:${data.ratio}"><h5>${h(slide.title || "Untitled slide")}</h5>${slide.lines.map((line) => `<p>${h(line)}</p>`).join("")}</div>${strip}<div class="fp-nav"><button type="button" data-action="preview-slide" data-args="${go(at - 1)}" aria-label="Previous slide"${at ? "" : " disabled"}>‹</button><span>${at + 1} of ${data.slides.length}</span><button type="button" data-action="preview-slide" data-args="${go(at + 1)}" aria-label="Next slide"${at < data.slides.length - 1 ? "" : " disabled"}>›</button></div></div>`;
  }
  if (data.kind === "pdf") return '<div class="fp-file fp-pdf"><div class="fp-pages" data-pdf></div></div>';
  return `<div class="fp-file fp-image"><img src="data:${h(data.mimeType)};base64,${data.data}" alt="${h(data.name)}" draggable="false"></div>`;
}

/// The card: the name, what it is, ×; the file; a quiet line and Open ↗.
export function previewCardHTML(preview: OpenPreview): string {
  const summary = previewSummary(preview.data);
  return `<section class="card fp${preview.wide ? " wide" : ""}" data-card="${PREVIEW_CARD}"><div class="card-head fp-head">${FILE_ICON}<span class="card-line" title="${h(preview.path)}">${h(preview.name)}</span>${summary ? `<span class="card-sum">${h(summary)}</span>` : ""}<button type="button" class="fp-x" data-action="preview-close" aria-label="Close the preview of ${h(preview.name)}">×</button></div>`
    + `<div class="fp-box" role="button" tabindex="0" data-action="preview-wide" aria-label="${preview.wide ? "Narrow" : "Widen"} the preview of ${h(preview.name)}">${fileBodyHTML(preview)}</div>`
    + `<div class="fp-foot"><span>${preview.error ? "" : preview.wide ? "Click to narrow" : "Click to enlarge"}</span>${preview.data ? `<button type="button" class="link" data-action="preview-open" title="Open it in its own app">Open ↗</button>` : ""}</div></section>`;
}

/// PDF pages, drawn with pdf.js (loaded the first time one is opened).
const pdfs = new WeakMap<HTMLElement, string>();
export async function drawPdf(host: HTMLElement, data: string, pages: number): Promise<void> {
  const key = `${data.length}:${data.slice(0, 64)}:${pages}:${host.clientWidth}`;
  if (pdfs.get(host) === key) return;
  pdfs.set(host, key);
  const { getDocumentProxy } = await import("unpdf");
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const pdf = await getDocumentProxy(bytes, { useSystemFonts: true });
  try {
    const width = Math.max(120, host.clientWidth - 16), ratio = Math.min(2, devicePixelRatio || 1);
    const canvases: HTMLCanvasElement[] = [];
    for (let n = 1; n <= Math.min(pages, pdf.numPages); n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: width / base.width * ratio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      canvas.style.width = `${width}px`;
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
      canvases.push(canvas);
      if (pdfs.get(host) !== key) return;
    }
    host.replaceChildren(...canvases);
    if (pdf.numPages > canvases.length) host.insertAdjacentHTML("beforeend", `<div class="fp-more">${pdf.numPages - canvases.length} more page${pdf.numPages - canvases.length === 1 ? "" : "s"}. Open it to see them all.</div>`);
    host.dataset.pages = String(pdf.numPages);
  } finally { await pdf.loadingTask.destroy(); }
}

// Motion -------------------------------------------------------------------

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(.2,.8,.2,1)", SOFT = "cubic-bezier(.3,.7,.2,1)";
/// Take 2 at Mike's pace ("too fast" at 1×): every part runs 1.75× longer.
export const PACE = 1.75;
const ms = (value: number) => Math.round(value * PACE);
const rectOf = (element: Element): Rect => { const r = element.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
/// A uniform scale with the centres lined up, so the file never stretches.
const from = (start: Rect, end: Rect) => {
  const scale = Math.max(0.08, Math.min(start.width / end.width, start.height / end.height * 3));
  return `translate(${start.x + start.width / 2 - (end.x + end.width / 2)}px, ${start.y + start.height / 2 - (end.y + end.height / 2)}px) scale(${scale})`;
};
/// A copy of the preview over the page, canvases included.
function ghost(box: HTMLElement, layer: HTMLElement): [HTMLElement, Rect] {
  const rect = rectOf(box), copy = document.createElement("div");
  copy.className = "fp-ghost";
  Object.assign(copy.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const clone = box.cloneNode(true) as HTMLElement;
  const sources = box.querySelectorAll("canvas"), copies = clone.querySelectorAll("canvas");
  copies.forEach((canvas, i) => canvas.getContext("2d")?.drawImage(sources[i]!, 0, 0));
  clone.removeAttribute("data-action");
  copy.append(...clone.childNodes);
  layer.appendChild(copy);
  return [copy, rect];
}

/// The card grows out of the name that was clicked. The card itself opens a
/// gap in the column while the copy travels; the name pulses once.
export function growPreview(card: HTMLElement, start: Rect | undefined, name: Element | null, layer: HTMLElement = document.body): Promise<void> {
  const box = card.querySelector<HTMLElement>(".fp-box");
  if (!box || reduced() || typeof card.animate !== "function") { card.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 200 }); return Promise.resolve(); }
  const height = card.offsetHeight;
  card.style.overflow = "hidden";
  card.animate([{ height: "0px", opacity: 0.3 }, { height: `${height}px`, opacity: 1 }], { duration: ms(380), easing: SOFT }).finished.then(() => { card.style.overflow = ""; }, () => { card.style.overflow = ""; });
  name?.animate([{ boxShadow: "0 0 0 0 rgba(242,182,200,.5)" }, { boxShadow: "0 0 0 6px rgba(242,182,200,0)" }], { duration: ms(500), easing: "ease-out" });
  const end = rectOf(box);
  // A name scrolled away, or not on the page: grow from just left of the card.
  const origin = start && start.width > 0 && start.y + start.height > 0 && start.y < innerHeight ? start : { x: end.x - 60, y: end.y + 10, width: 40, height: 16 };
  const [copy] = ghost(box, layer);
  box.style.opacity = "0";
  const done = () => { box.style.opacity = ""; copy.remove(); };
  return copy.animate([
    { transform: from(origin, end), opacity: 0, borderRadius: "14px", boxShadow: "0 0 0 0 rgba(0,0,0,0)" },
    { opacity: 1, offset: 0.25 },
    { transform: "translateY(-6px) scale(1.015)", boxShadow: "0 24px 50px -18px rgba(0,0,0,.75)", offset: 0.75 },
    { transform: "none", opacity: 1, borderRadius: "8px", boxShadow: "0 0 0 1px rgba(255,255,255,.08)" },
  ], { duration: ms(520), easing: EASE }).finished.then(() => {
    done();
    box.animate([{ boxShadow: "0 0 0 1.5px rgba(242,182,200,.6), 0 0 18px rgba(242,182,200,.18)" }, { boxShadow: "0 0 0 1px var(--hair)" }], { duration: ms(700), easing: "ease-out" });
  }, done);
}

/// Closing: the copy folds back into the name while the card closes its gap.
export function foldPreview(card: HTMLElement, end: Rect | undefined, name: Element | null, layer: HTMLElement = document.body): Promise<void> {
  const box = card.querySelector<HTMLElement>(".fp-box");
  if (!box || reduced() || typeof card.animate !== "function") return Promise.resolve();
  const [copy, rect] = ghost(box, layer);
  box.style.opacity = "0";
  const target = end && end.width > 0 ? end : { x: rect.x - 60, y: rect.y + 10, width: 40, height: 16 };
  copy.animate([
    { transform: "none", opacity: 1 },
    { transform: "translateY(-4px) scale(.98)", opacity: 1, offset: 0.2 },
    { transform: from(target, rect), opacity: 0 },
  ], { duration: ms(420), easing: "cubic-bezier(.5,0,.2,1)", fill: "forwards" }).finished.then(() => copy.remove(), () => copy.remove());
  name?.animate([{ backgroundColor: "rgba(242,182,200,.22)" }, { backgroundColor: "transparent" }], { duration: ms(600), delay: ms(300), easing: "ease-out" });
  card.style.overflow = "hidden";
  return card.animate([{ height: `${card.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: ms(360), easing: SOFT, fill: "forwards" }).finished.then(() => undefined, () => undefined);
}

/// Widening or narrowing: the column slides to its new width and the file
/// sharpens in at its new size.
export function resizePreview(column: HTMLElement, oldWidth: number, card: HTMLElement | null, oldHeight: number | undefined) {
  if (reduced() || typeof column.animate !== "function") return;
  column.animate([{ width: `${oldWidth}px` }, { width: `${column.offsetWidth}px` }], { duration: ms(420), easing: SOFT });
  const box = card?.querySelector<HTMLElement>(".fp-box");
  if (box && oldHeight) box.animate([{ height: `${oldHeight}px` }, { height: `${box.offsetHeight}px` }], { duration: ms(420), easing: SOFT });
  box?.firstElementChild?.animate([{ opacity: 0.55, filter: "blur(1.5px)" }, { opacity: 1, filter: "none" }], { duration: ms(380), easing: "ease-out" });
}

export const rectOfElement = rectOf;
