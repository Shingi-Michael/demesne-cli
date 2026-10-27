/// Foundry: what the agent made for you — prototypes, graphics, documents —
/// as a gallery, and one artifact at a time with its versions. HTML and SVG
/// render in a foundry:// frame that has no network, no app access and no
/// shared origin; Markdown renders through the app's sanitizer.
import type { FoundryArtifact, FoundryArtifactDetail, FoundryKind } from "@demesne/protocol";
import { dayWord } from "./chats-page.ts";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const btn = (action: string, label: string, data: Record<string, unknown> = {}, className = "", extra = "") =>
  `<button type="button" class="${className}" data-action="${action}" data-args="${h(JSON.stringify(data))}"${extra}>${label}</button>`;
const icon = (paths: string) => `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true">${paths}</svg>`;
const projectWord = (path: string | null) => path ? path.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || path : "Just a chat";

export type FoundryTab = "all" | FoundryKind;
export type FoundryWidth = "desktop" | "tablet" | "phone";
export interface FoundryUi {
  tab: FoundryTab;
  view: "preview" | "source";
  width: FoundryWidth;
  /// Source being edited in place, or null.
  edit: string | null;
  draft: string;
  error: string;
  busy: boolean;
}
export interface FoundryView {
  list: FoundryArtifact[] | null;
  open: FoundryArtifactDetail | null;
  ui: FoundryUi;
  /// This window's project, to mark artifacts made here.
  here: string;
  /// Rendered, sanitized Markdown for an open document.
  markdownHtml: (source: string) => string;
}

export const KIND_WORD: Record<FoundryKind, string> = { html: "Prototype", svg: "Graphic", markdown: "Document" };
const KIND_ICON: Record<FoundryKind, string> = {
  html: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/>'),
  svg: icon('<circle cx="8" cy="9" r="3"/><path d="m4 19 5-5 3 3 3-4 5 6z"/>'),
  markdown: icon('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h4"/>'),
};
export const FOUNDRY_EXTENSION: Record<FoundryKind, string> = { html: "html", svg: "svg", markdown: "md" };
export const frameURL = (id: string, version: number) => `foundry://artifact/${encodeURIComponent(id)}?v=${version}`;
const frame = (artifact: { id: string; version: number; title: string }, className: string, extra = "") =>
  `<iframe class="${className}" src="${h(frameURL(artifact.id, artifact.version))}" sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer" title="${h(artifact.title)}"${extra}></iframe>`;

function gallery(view: FoundryView) {
  const { list, ui } = view;
  const counts: Record<FoundryTab, number> = { all: list?.length ?? 0, html: 0, svg: 0, markdown: 0 };
  for (const item of list ?? []) counts[item.kind]++;
  const tab = (id: FoundryTab, word: string) => btn("foundry-tab", `${word}<span class="cp-count"> ${counts[id] || ""}</span>`, { tab: id }, `cp-tab${ui.tab === id ? " on" : ""}`, ` aria-pressed="${ui.tab === id}"`);
  const shown = (list ?? []).filter((item) => ui.tab === "all" || item.kind === ui.tab);
  const cards = list === null ? '<p class="cp-empty">Reading Foundry…</p>' : !shown.length
    ? `<div class="fd-empty">${icon('<path d="M4 15h16l-2 5H6z"/><path d="M8 15V9h8v6M10 9V5h4v4"/>')}<b>${list.length ? "Nothing of this kind yet" : "Nothing made yet"}</b><span>Describe something above, or ask for it in any chat. The agent saves it here, and every revision is kept.</span></div>`
    : `<div class="fd-grid">${shown.map((item) => {
      const thumb = item.kind === "markdown"
        ? `<div class="fd-thumb doc">${KIND_ICON.markdown}</div>`
        : `<div class="fd-thumb${item.kind === "svg" ? " graphic" : ""}">${frame(item, "fd-thumb-frame", ' loading="lazy" tabindex="-1" aria-hidden="true" scrolling="no"')}</div>`;
      return `<div class="fd-card">${btn("foundry-open", `${thumb}<span class="fd-card-text"><b>${h(item.title)}</b><span>${KIND_ICON[item.kind]}${KIND_WORD[item.kind]} · ${h(dayWord(item.updatedAt))}${item.version > 1 ? ` · v${item.version}` : ""}</span></span>`, { id: item.id }, "fd-card-open")}${item.workspace && item.workspace !== view.here ? `<span class="fd-where" title="${h(item.workspace)}">${h(projectWord(item.workspace))}</span>` : ""}</div>`;
    }).join("")}</div>`;
  return `<div class="fd-head"><div><h1 class="cp-title">Foundry</h1><p class="cp-lede">Prototypes, graphics and documents made for you. Open one to see it live, revise it, or export it.</p></div></div>`
    + `<form class="fd-make" id="foundry-make"><span class="fd-make-icon">${icon('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>')}</span><input name="make" value="${h(ui.draft)}" placeholder="Make a pricing page for a coffee roaster, warm and minimal" aria-label="Describe something to make" autocomplete="off" spellcheck="false"${ui.busy ? " disabled" : ""}><kbd aria-hidden="true">↵</kbd></form>`
    + (ui.error ? `<p class="sp-error" role="alert">${h(ui.error)}</p>` : `<p class="sp-hint">Starts a chat ${view.here ? `in ${h(projectWord(view.here))}` : "on its own"}; what it makes lands here.</p>`)
    + `<div class="cp-tabs fd-tabs" role="toolbar" aria-label="Kinds">${tab("all", "All")}${tab("html", "Prototypes")}${tab("svg", "Graphics")}${tab("markdown", "Documents")}</div>${cards}`;
}

function detail(view: FoundryView, open: FoundryArtifactDetail) {
  const { ui } = view;
  const editing = ui.edit !== null;
  const showSource = ui.view === "source" || editing;
  const seg = (action: string, word: string, on: boolean, args: Record<string, unknown>) => btn(action, word, args, `fd-seg${on ? " on" : ""}`, ` aria-pressed="${on}"`);
  const current = open.versions[0]?.version ?? open.version;
  const versionNote = open.versions.find((item) => item.version === open.version)?.note;
  const versions = open.versions.length > 1
    ? `<label class="fd-versions"><span class="sr-only">Version</span><select data-foundry-version aria-label="Version">${open.versions.map((item) => `<option value="${item.version}"${item.version === open.version ? " selected" : ""}>v${item.version}${item.version === current ? " · latest" : ""}${item.note ? ` · ${h(item.note.slice(0, 40))}` : ""}</option>`).join("")}</select></label>`
    : "";
  const stage = showSource
    ? `<div class="fd-source"><textarea spellcheck="false" aria-label="Source"${editing ? "" : " readonly"}>${h(editing ? ui.edit : open.source)}</textarea>${editing ? `<div class="cz-edit-bar"><span class="cz-path">Saving makes version ${current + 1}</span>${btn("foundry-edit-cancel", "Cancel", {}, "cz-cancel")}${btn("foundry-edit-save", "Save version", {}, "cz-save")}</div>` : ""}</div>`
    : open.kind === "markdown"
      ? `<article class="fd-doc markdown">${view.markdownHtml(open.source)}</article>`
      : `<div class="fd-stage ${open.kind === "svg" ? "graphic" : h(ui.width)}">${frame(open, "fd-frame")}</div>`;
  const older = open.version !== current ? `<div class="fd-older">You're looking at v${open.version}. ${btn("foundry-version", "Show latest", { version: current }, "link")} ${btn("foundry-restore", "Make this the latest", {}, "link")}</div>` : "";
  return `<div class="fd-detail">`
    + `<div class="fd-top">${btn("foundry-close", `${icon('<path d="m15 6-6 6 6 6"/>')}Foundry`, {}, "st-back fd-back")}<span class="sp"></span>`
    + `${btn("foundry-revise", `${icon('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>')}Revise in chat`, { id: open.id, title: open.title }, "fd-act primary")}`
    + `${btn("foundry-copy", "Copy", {}, "fd-act")}${btn("foundry-export", "Export", { id: open.id }, "fd-act")}${btn("foundry-delete", "Delete", { id: open.id }, "fd-act danger")}</div>`
    + `<div class="fd-title"><h1 class="cp-title" title="Double-click to rename" data-foundry-title>${h(open.title)}</h1>`
    + `<p class="fd-meta">${KIND_ICON[open.kind]}${KIND_WORD[open.kind]} · v${open.version}${versionNote ? ` · ${h(versionNote)}` : ""} · ${h(dayWord(open.updatedAt))} · ${h(projectWord(open.workspace))}</p></div>`
    + `<div class="fd-bar"><div class="fd-segs" role="group" aria-label="View">${seg("foundry-view", "Preview", !showSource, { view: "preview" })}${seg("foundry-view", "Source", showSource, { view: "source" })}</div>`
    + (open.kind === "html" && !showSource ? `<div class="fd-segs" role="group" aria-label="Width">${seg("foundry-width", "Desktop", ui.width === "desktop", { width: "desktop" })}${seg("foundry-width", "Tablet", ui.width === "tablet", { width: "tablet" })}${seg("foundry-width", "Phone", ui.width === "phone", { width: "phone" })}</div>` : "")
    + `<span class="sp"></span>${versions}${editing ? "" : btn("foundry-edit", "Edit source", {}, "fd-act")}${open.kind !== "markdown" && !showSource ? btn("foundry-reload", "Reload", {}, "fd-act") : ""}</div>`
    + older + (ui.error ? `<p class="sp-error" role="alert">${h(ui.error)}</p>` : "") + stage + `</div>`;
}

export function foundryPage(view: FoundryView) {
  return view.open ? detail(view, view.open) : gallery(view);
}
