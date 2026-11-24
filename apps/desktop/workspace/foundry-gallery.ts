/// Pass 273 A, Foundry's front page: everything made, in every project, as
/// cards with a picture of each, pinned first. Search at the top, then All,
/// This project, Pinned and Shared. A card opens the long page for that one
/// mockup, with a line back here. A row of kinds starts something new (step 2).
import type { FoundryArtifact, FoundryShelfVersion } from "@demesne/protocol";
import { dayWord } from "./chats-page.ts";
import { frameURL, KIND_WORD, shelfKey } from "./foundry-page.ts";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export type GalleryFilter = "all" | "here" | "pinned" | "shared";
export const GALLERY_FILTERS: readonly (readonly [GalleryFilter, string])[] = [["all", "All"], ["here", "This project"], ["pinned", "Pinned"], ["shared", "Shared"]];

/// What the front page shows: the words searched, the filter, and the one
/// mockup whose long page is open instead (null on the front page).
export interface FoundryGallery {
  query: string;
  filter: GalleryFilter;
  one: string | null;
}

export interface GalleryView {
  list: readonly FoundryArtifact[];
  versions: readonly FoundryShelfVersion[];
  gallery: FoundryGallery;
  /// The project this window is in, or null for "Just a chat".
  here: string | null;
  pins: readonly string[];
  shared: ReadonlySet<string>;
  /// Mockups the search found by the words on their pages (from the daemon), while a search runs.
  found?: ReadonlySet<string> | null;
  chatTitle: (id: string) => string | null;
  now?: number;
}

export const projectName = (root: string | null) => root ? root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root : "Just a chat";
const kindWord = (item: FoundryArtifact) => item.built ? "Built" : KIND_WORD[item.kind];

/// When, in a few words: "Just now", "12 min ago", "3h ago", then the day.
export function ago(date: string, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(date)) / 60_000);
  if (!(minutes >= 0)) return dayWord(date);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 12 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return dayWord(date);
}

/// The cards the front page shows, pinned first (in the order you pinned
/// them) then newest first. A search keeps every mockup whose name,
/// description, kind, project or chat holds every word, or that the daemon
/// found by the words on its page.
export function galleryItems(view: GalleryView) {
  const { gallery, pins, shared } = view;
  const words = gallery.query.toLowerCase().split(/\s+/).filter(Boolean);
  const titles = new Map<string, string>();
  for (const version of view.versions) if (version.sessionId && !titles.has(version.artifactId)) titles.set(version.artifactId, view.chatTitle(version.sessionId) ?? "");
  const pinned = new Set(pins);
  const kept = view.list.filter((item) => {
    if (gallery.filter === "here" && item.workspace !== view.here) return false;
    if (gallery.filter === "pinned" && !pinned.has(item.id)) return false;
    if (gallery.filter === "shared" && !shared.has(item.id)) return false;
    if (!words.length) return true;
    if (view.found?.has(item.id)) return true;
    const haystack = [item.title, item.description, kindWord(item), projectName(item.workspace), titles.get(item.id) ?? ""].join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  const order = new Map(pins.map((id, at) => [id, at]));
  const top = kept.filter((item) => pinned.has(item.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const rest = kept.filter((item) => !pinned.has(item.id)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { pinned: top, rest };
}

const PIN = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 3 3v1H7v-1l3-3z"/><path d="M12 14v6"/></svg>';
const SEARCH = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>';
const act = (action: string, args: Record<string, unknown>) => `data-action="${action}" data-args="${h(JSON.stringify(args))}"`;

/// A card's picture: the mockup's newest version, drawn small. Pages load
/// only near the screen, take no input and play no demo; a Markdown
/// document shows its first lines.
export function thumbHTML(item: FoundryArtifact, at: string) {
  if (item.kind === "markdown") return `<article class="fd-doc markdown fg-doc" data-md="${h(shelfKey(item.id, item.version))}" data-at="${h(at)}" aria-hidden="true"></article>`;
  return `<iframe class="fg-frame" src="${h(`${frameURL(item.id, item.version)}&at=${Date.parse(at) || 0}`)}" loading="lazy" tabindex="-1" inert aria-hidden="true" sandbox="allow-scripts" referrerpolicy="no-referrer" title=""></iframe>`;
}

function card(item: FoundryArtifact, view: GalleryView, pinned: boolean) {
  const newest = view.versions.find((version) => version.artifactId === item.id && version.version === item.version);
  const at = newest?.createdAt ?? item.updatedAt;
  const where = view.gallery.filter === "here" ? "" : ` · ${h(projectName(item.workspace))}`;
  const shared = view.shared.has(item.id) ? " · Shared" : "";
  return `<div class="fg-card${pinned ? " pinned" : ""}" data-fg="${h(item.id)}">`
    + `<div class="fg-th">${thumbHTML(item, at)}</div>`
    + `<b class="fg-name">${h(item.title)}</b><span class="fg-meta">${h(kindWord(item))}${where} · ${h(ago(item.updatedAt, view.now))}${shared}</span>`
    + `<button type="button" class="fg-go" ${act("foundry-one", { id: item.id })} aria-label="${h(`Open ${item.title}`)}" title="${h(item.description || item.title)}"></button>`
    + `<button type="button" class="fg-pin${pinned ? " on" : ""}" ${act("foundry-pin", { id: item.id, pinned: !pinned })} aria-pressed="${pinned}" aria-label="${h(`${pinned ? "Unpin" : "Pin"} ${item.title}`)}" title="${pinned ? "Unpin" : "Pin to the top"}">${PIN}</button></div>`;
}

/// What a filter with nothing in it says.
const EMPTY: Record<GalleryFilter, string> = {
  all: "Nothing made yet.",
  here: "Nothing made in this project yet.",
  pinned: "Nothing pinned yet. Rest on a card and press its pin to keep it at the top.",
  shared: "Nothing shared yet. Open a mockup and share it as a link to see it here.",
};

/// The cards alone, redrawn while you type so the search box keeps its place.
export function galleryGrid(view: GalleryView) {
  const { pinned, rest } = galleryItems(view);
  if (!pinned.length && !rest.length) {
    const query = view.gallery.query.trim();
    return `<p class="fg-none">${h(query ? `Nothing ${view.gallery.filter === "all" ? "" : `${GALLERY_FILTERS.find(([key]) => key === view.gallery.filter)![1].toLowerCase()} `}matches “${query}”.` : EMPTY[view.gallery.filter])}</p>`;
  }
  const group = (label: string, items: FoundryArtifact[], pin: boolean) => items.length
    ? `<h2 class="fg-group">${label}</h2><div class="fg-grid">${items.map((item) => card(item, view, pin)).join("")}</div>` : "";
  return group("Pinned", pinned, true) + group(pinned.length ? "Recent" : view.gallery.query.trim() ? "Found" : "Recent", rest, false);
}

/// Step 2, make something new: the kinds a press can start, each with the
/// words its new chat begins with. Nothing runs until you finish the sentence
/// and send it.
export const MAKE_KINDS: readonly { kind: string; label: string; start: string; icon: string }[] = [
  { kind: "html", label: "Page", start: "/foundry Make a page for ", icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18M7 12h6M7 16h10"/>' },
  { kind: "deck", label: "Deck", start: "/foundry Make a deck about ", icon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>' },
  { kind: "doc", label: "Doc", start: "/foundry Make a doc about ", icon: '<path d="M6 3h9l3 3v15H6z"/><path d="M9 10h6M9 14h6M9 18h3"/>' },
  { kind: "sheet", label: "Sheet", start: "/foundry Make a sheet of ", icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 4v16"/>' },
  { kind: "dashboard", label: "Dashboard", start: "/foundry Make a dashboard of ", icon: '<path d="M4 20V13M9 20V6M14 20V10M19 20v-5"/>' },
  { kind: "mermaid", label: "Diagram", start: "/foundry Make a diagram of ", icon: '<rect x="3" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="16" width="7" height="5" rx="1.5"/><path d="M6.5 8v10.5H14"/>' },
];

/// The row of kinds over the cards, named for where the new chat will live.
export function makeRow(here: string | null) {
  return `<div class="fg-make"><span class="fg-make-t">Make something new${here ? ` in ${h(projectName(here))}` : ""}</span><div class="fg-make-row">`
    + MAKE_KINDS.map((one) => `<button type="button" class="fg-mk" ${act("foundry-make", { kind: one.kind })} title="${h(`Start a new chat that makes a ${one.label.toLowerCase()}`)}"><span class="fg-mk-i"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${one.icon}</svg></span>${h(one.label)}</button>`).join("")
    + "</div></div>";
}

/// The whole front page: the title and search, the filters, then the cards.
export function galleryPage(view: GalleryView, error = "") {
  const head = `<div class="fg-top"><h1 class="cp-title fd-h">Foundry</h1><form class="fg-search" role="search" data-kind="foundry">${SEARCH}<input type="search" id="fg-q" placeholder="Search everything made" value="${h(view.gallery.query)}" aria-label="Search everything made" autocomplete="off" spellcheck="false"></form></div>`
    + (error ? `<p class="sp-error" role="alert">${h(error)}</p>` : "");
  const make = makeRow(view.here);
  if (!view.list.length) return head + make + `<div class="fd-empty"><b>Nothing made yet</b><span>Pick a kind above, or ask for a mockup in any chat. It lands here, and every version is kept.</span></div>`;
  const chips = `<div class="fg-chips" role="group" aria-label="Show">${GALLERY_FILTERS.map(([key, label]) => `<button type="button" class="fg-chip${view.gallery.filter === key ? " on" : ""}" ${act("foundry-filter", { filter: key })} aria-pressed="${view.gallery.filter === key}">${label}</button>`).join("")}</div>`;
  return head + make + chips + `<div id="fg-cards">${galleryGrid(view)}</div>`;
}

/// The long page for one mockup: a line back to the front page, its name,
/// where it is from, and its pin.
export function oneHead(item: FoundryArtifact, pinned: boolean, shared: boolean) {
  return `<button type="button" class="fg-back" data-action="foundry-home">← Foundry</button>`
    + `<div class="fg-one"><h1 class="cp-title fd-h">${h(item.title)}</h1><span class="fg-meta">${h(kindWord(item))} · ${h(projectName(item.workspace))}${shared ? " · Shared" : ""}</span>`
    + `<button type="button" class="fg-pin${pinned ? " on" : ""}" ${act("foundry-pin", { id: item.id, pinned: !pinned })} aria-pressed="${pinned}" aria-label="${pinned ? "Unpin" : "Pin to the top"}" title="${pinned ? "Unpin" : "Pin to the top"}">${PIN}</button></div>`;
}
