/// Foundry: a place of mockups (pass 189 A). The page is your mockups, big,
/// and one open fills it at real size under a single line; revising happens
/// in the chat. HTML and SVG
/// render in a foundry:// frame that has no network, no app access and no
/// shared origin; Markdown renders through the app's sanitizer.
import type { FoundryArtifact, FoundryArtifactDetail, FoundryKind } from "@demesne/protocol";
import { dayWord } from "./chats-page.ts";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const btn = (action: string, label: string, data: Record<string, unknown> = {}, className = "", extra = "") =>
  `<button type="button" class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}"${extra}>${label}</button>`;
const icon = (paths: string) => `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true">${paths}</svg>`;

export interface FoundryView {
  list: FoundryArtifact[] | null;
  open: FoundryArtifactDetail | null;
  error: string;
  /// Rendered, sanitized Markdown for an open document.
  markdownHtml: (source: string) => string;
}

export const KIND_WORD: Record<FoundryKind, string> = { html: "Prototype", svg: "Graphic", markdown: "Document", deck: "Deck", doc: "Doc", dashboard: "Dashboard" };
export const KIND_ICON: Record<FoundryKind, string> = {
  html: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/>'),
  svg: icon('<circle cx="8" cy="9" r="3"/><path d="m4 19 5-5 3 3 3-4 5 6z"/>'),
  markdown: icon('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h4"/>'),
  deck: icon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>'),
  doc: icon('<path d="M6 3h12v18H6z"/><path d="M9 7h6M9 11h6M9 15h3"/>'),
  dashboard: icon('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>'),
};
export const FOUNDRY_EXTENSION: Record<FoundryKind, string> = { html: "html", svg: "svg", markdown: "md", deck: "html", doc: "html", dashboard: "html" };
/// The kinds Demesne draws from content (a deck, a doc, a dashboard).
export const READY_KIND = new Set<FoundryKind>(["deck", "doc", "dashboard"]);
export const frameURL = (id: string, version: number) => `foundry://artifact/${encodeURIComponent(id)}?v=${version}`;
const frame = (artifact: { id: string; version: number; title: string }, className: string, extra = "") =>
  `<iframe class="${className}" src="${h(frameURL(artifact.id, artifact.version))}" sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer" title="${h(artifact.title)}"${extra}></iframe>`;

/// The wall: your mockups, big, newest first, each with its name and when.
/// Clicking one opens it. You only look here: what to change goes to the chat.
function wall(view: FoundryView) {
  const { list } = view;
  const cards = list === null ? '<p class="cp-empty">Reading Foundry…</p>' : !list.length
    ? `<div class="fd-empty">${icon('<path d="M4 15h16l-2 5H6z"/><path d="M8 15V9h8v6M10 9V5h4v4"/>')}<b>Nothing made yet</b><span>Ask for a mockup in any chat. It lands here, and every version is kept.</span></div>`
    : `<div class="fd-wall">${list.map((item) => {
      const thumb = item.kind === "markdown"
        ? `<div class="fd-thumb doc">${KIND_ICON.markdown}</div>`
        : `<div class="fd-thumb${item.kind === "svg" ? " graphic" : ""}">${frame(item, "fd-thumb-frame", ' loading="lazy" tabindex="-1" aria-hidden="true" scrolling="no"')}</div>`;
      return `<div class="fd-card">${btn("foundry-open", thumb, { id: item.id }, "fd-card-open", ` aria-label="Open ${h(item.title)}"`)}`
        + `<div class="fd-name"><b>${h(item.title)}</b><span>${h(dayWord(item.updatedAt))}</span></div></div>`;
    }).join("")}</div>`;
  return `<h1 class="cp-title fd-h">Foundry</h1>` + (view.error ? `<p class="sp-error" role="alert">${h(view.error)}</p>` : "") + cards;
}

/// One mockup open: it fills the page at real size, with one line above it:
/// back to Foundry, its name and ‹ vN ›.
function opened(view: FoundryView, open: FoundryArtifactDetail) {
  const numbers = open.versions.map((item) => item.version).sort((a, b) => a - b);
  const at = numbers.indexOf(open.version);
  const earlier = at > 0 ? numbers[at - 1] : null, later = at >= 0 && at < numbers.length - 1 ? numbers[at + 1] : null;
  const note = open.versions.find((item) => item.version === open.version)?.note;
  const arrow = (to: number | null, label: string, path: string) =>
    to === null ? `<button type="button" class="fd-arrow" aria-label="${label}" disabled>${icon(path)}</button>` : btn("foundry-version", icon(path), { version: to }, "fd-arrow", ` aria-label="${label}" title="v${to}"`);
  const stage = open.kind === "markdown"
    ? `<article class="fd-doc markdown">${view.markdownHtml(open.source)}</article>`
    : `<div class="fd-stage${open.kind === "svg" ? " graphic" : ""}">${frame(open, "fd-frame")}</div>`;
  return `<div class="fd-open">`
    + `<div class="fd-line">${btn("foundry-close", `${icon('<path d="m15 6-6 6 6 6"/>')}Foundry`, {}, "fd-back")}`
    + `<b class="fd-title">${h(open.title)}</b>`
    + `<span class="fd-vers">${arrow(earlier, "Earlier version", '<path d="m15 6-6 6 6 6"/>')}<span${note ? ` title="${h(note)}"` : ""}>v${open.version}</span>${arrow(later, "Later version", '<path d="m9 6 6 6-6 6"/>')}</span>`
    + `</div>`
    + (view.error ? `<p class="sp-error" role="alert">${h(view.error)}</p>` : "") + stage + `</div>`;
}

export function foundryPage(view: FoundryView) {
  return view.open ? opened(view, view.open) : wall(view);
}
