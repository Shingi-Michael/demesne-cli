/// Foundry: one long page of mockups (pass 196 A). Every version of every
/// mockup, newest first, grouped by day, each at real size under one quiet
/// line; options stack one under another. You only look here: what to change
/// goes to the chat. HTML and SVG
/// render in a foundry:// frame that has no network, no app access and no
/// shared origin; Markdown renders through the app's sanitizer.
import type { FoundryArtifact, FoundryKind, FoundryShelfVersion } from "@demesne/protocol";
import { dayWord } from "./chats-page.ts";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const icon = (paths: string) => `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true">${paths}</svg>`;

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
/// On the long page a page shows its options stacked (parts.js reads stack=1),
/// and loads only when it scrolls near the screen.
/// `at` is when the version last changed: Foundry's own fixes in the same
/// ask change it in place (pass 197 A), so the frame loads the fixed page.
const frame = (id: string, version: number, title: string, at: string) =>
  `<iframe class="fd-frame" src="${h(`${frameURL(id, version)}&stack=1&at=${Date.parse(at) || 0}`)}" loading="lazy" sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer" title="${h(title)}"></iframe>`;

export interface FoundryView {
  list: FoundryArtifact[] | null;
  versions: FoundryShelfVersion[] | null;
  error: string;
  /// The chat a version came from, by its id.
  chatTitle: (id: string) => string | null;
}

/// One version on the long page: its address, for links from the chat.
export const shelfKey = (id: string, version: number) => `${id}:${version}`;
const dayKey = (date: string) => { const at = new Date(date); return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`; };
const clock = (date: string) => new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/// The long page: days on a strip at the top, then every version, newest
/// first, under the day it was made. The day stays at the top as you scroll.
export function foundryPage(view: FoundryView) {
  const { list, versions } = view;
  const title = `<h1 class="cp-title fd-h">Foundry</h1>` + (view.error ? `<p class="sp-error" role="alert">${h(view.error)}</p>` : "");
  if (list === null || versions === null) return title + '<p class="cp-empty">Reading Foundry…</p>';
  const byId = new Map(list.map((item) => [item.id, item]));
  const shown = versions.filter((item) => byId.has(item.artifactId));
  if (!shown.length) return title + `<div class="fd-empty">${icon('<path d="M4 15h16l-2 5H6z"/><path d="M8 15V9h8v6M10 9V5h4v4"/>')}<b>Nothing made yet</b><span>Ask for a mockup in any chat. It lands here, and every version is kept.</span></div>`;
  const days: { key: string; word: string; items: FoundryShelfVersion[] }[] = [];
  for (const item of shown) {
    const key = dayKey(item.createdAt);
    const day = days.at(-1)?.key === key ? days.at(-1)! : (days.push({ key, word: dayWord(item.createdAt), items: [] }), days.at(-1)!);
    day.items.push(item);
  }
  const strip = days.length > 1 ? `<nav class="fd-days" aria-label="Days">${days.map((day) => `<button type="button" data-action="foundry-day" data-args="${h(JSON.stringify({ day: day.key }))}">${h(day.word)}</button>`).join("")}</nav>` : "";
  // Pass 208 A: the name, from which chat (a link to it), what it is, and
  // the version's own name; "based on" links to the mockup it came from.
  const item = (version: FoundryShelfVersion, pick: boolean) => {
    const artifact = byId.get(version.artifactId)!, key = shelfKey(artifact.id, version.version);
    const chat = version.sessionId ? view.chatTitle(version.sessionId) : null;
    const line = `<div class="fd-ln"><b>${h(artifact.title)}</b>${chat ? `<span>from ${link("select-session", { id: version.sessionId }, `“${h(chat)}”`, "Open the chat")}</span>` : ""}`
      + `<span class="fd-ln-r">${h(KIND_WORD[artifact.kind])} · ${h(clock(version.createdAt))}</span></div>`;
    const based = artifact.basedOn && byId.get(artifact.basedOn.id);
    const ver = `<div class="fd-ver"><b>v${version.version}${version.note ? ` · ${h(version.note)}` : ""}</b>`
      + (pick ? '<span class="fd-rec-pill">recommended</span>' : "")
      + (based ? `<span>based on ${link("foundry-open", { id: based.id, version: artifact.basedOn!.version }, `${h(based.title)} v${artifact.basedOn!.version}`, "Show it")}</span>` : "") + "</div>";
    const words = artifact.description ? `<p class="fd-desc">${h(artifact.description)}</p>` : "";
    const body = artifact.kind === "markdown"
      ? `<article class="fd-doc markdown" data-md="${h(key)}" data-at="${h(version.createdAt)}"><p class="cp-empty">Reading…</p></article>`
      : `<div class="fd-stage ${artifact.kind === "svg" ? "graphic" : `k-${artifact.kind}`}">${frame(artifact.id, version.version, `${artifact.title} v${version.version}`, version.createdAt)}</div>`;
    return `<section class="fd-item${pick ? " fd-rec" : ""}" data-fd="${h(key)}" aria-label="${h(`${artifact.title}, version ${version.version}${pick ? ", recommended" : ""}`)}">${line}${words}${ver}${body}</section>`;
  };
  return title + strip + days.map((day) => `<h2 class="fd-day" id="fd-day-${h(day.key)}">${h(day.word)}</h2>${pickFirst(day.items).map(({ version, pick }) => item(version, pick)).join("")}`).join("");
}

const link = (action: string, args: Record<string, unknown>, html: string, tip: string) =>
  `<button type="button" class="fd-link" data-action="${action}" data-args="${h(JSON.stringify(args))}" title="${h(tip)}">${html}</button>`;

/// What one ask made sits together, the one the model would use first
/// (pass 208 A). The pink mark shows only where an ask made several.
export function pickFirst(items: readonly FoundryShelfVersion[]) {
  const out: { version: FoundryShelfVersion; pick: boolean }[] = [];
  for (let at = 0; at < items.length;) {
    const turn = items[at]!.turnId;
    let end = at + 1;
    if (turn) while (end < items.length && items[end]!.turnId === turn) end++;
    const group = items.slice(at, end), several = new Set(group.map((item) => item.artifactId)).size > 1;
    const pick = several ? group.find((item) => item.recommended) : undefined;
    for (const version of pick ? [pick, ...group.filter((item) => item !== pick)] : group) out.push({ version, pick: version === pick });
    at = end;
  }
  return out;
}
