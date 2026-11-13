/// Foundry: one long page of mockups (pass 196 A). Every version of every
/// mockup, newest first, grouped by day, each at real size under one quiet
/// line; options stack one under another. You only look here: what to change
/// goes to the chat. HTML and SVG
/// render in a foundry:// frame that has no network, no app access and no
/// shared origin; Markdown renders through the app's sanitizer.
import { drawnSurface, type FoundryArtifact, type FoundryKind, type FoundryShelfVersion } from "@demesne/protocol";
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

/// The bar a window or a browser surface draws above the page (pass 221 A).
const CHROME: Partial<Record<string, number>> = { window: 30, browser: 38 };
const GROW_START = 480;

/// A version's stage (pass 221 A): the surface the model chose, drawn by
/// Foundry around the page at its real size (the Foundry page scales it down
/// only to fit), on its backdrop; and, when it has a demo or is a deck, the
/// quiet line under it that the demo's words appear in. Without a surface it
/// is the plain stage it always was.
export function stageHTML(artifact: Pick<FoundryArtifact, "id" | "title" | "kind">, version: Pick<FoundryShelfVersion, "version" | "createdAt" | "stage">) {
  const inner = frame(artifact.id, version.version, `${artifact.title} v${version.version}`, version.createdAt);
  const demo = version.stage?.demo?.length ? version.stage.demo : null, deck = artifact.kind === "deck";
  const plays = `${demo ? ` data-demo="${h(JSON.stringify(demo))}"` : ""}${deck ? " data-deck" : ""}`;
  const line = demo || deck ? '<p class="fd-demo" aria-live="polite"></p>' : "";
  const surface = version.stage?.surface && artifact.kind !== "svg" ? drawnSurface(version.stage.surface) : null;
  if (!surface) return `<div class="fd-stage ${artifact.kind === "svg" ? "graphic" : `k-${artifact.kind}`}"${plays}>${inner}</div>${line}`;
  const fluid = surface.frame === "page" && !version.stage!.surface!.width, bar = CHROME[surface.frame] ?? 0, grow = !surface.height;
  const width = fluid ? 0 : surface.width, height = bar + (grow ? GROW_START : surface.height);
  const chrome = surface.frame === "window" ? `<div class="fd-chrome" aria-hidden="true"><i></i><i></i><i></i><span>${h(surface.title)}</span></div>`
    : surface.frame === "browser" ? `<div class="fd-chrome" aria-hidden="true"><i></i><i></i><i></i><span class="fd-url">${h(surface.title || "example.com")}</span></div>` : "";
  return `<div class="fd-stage fd-s s-${surface.frame} b-${surface.backdrop}${fluid ? " fd-fluid" : ""}" data-ow="${width}" data-oh="${height}" data-bar="${bar}"${grow ? " data-grow" : ""}${plays}>`
    + `<div class="fd-fit" style="--ow:${width}px;--oh:${height}px"><div class="fd-surface">${chrome}<div class="fd-screen">${inner}</div></div></div></div>${line}`;
}

export interface FoundryView {
  list: FoundryArtifact[] | null;
  versions: FoundryShelfVersion[] | null;
  error: string;
  /// The chat a version came from, by its id.
  chatTitle: (id: string) => string | null;
  /// The merged pull request a chat opened, if any (pass 219 A): the mockups
  /// it made before opening it are what it built.
  builtIn?: (sessionId: string) => { number: number; createdAt: string } | null;
}

/// Pass 219 A: which versions a chat's merged pull request built, as
/// shelf keys: of each mockup the chat made, its newest version from before
/// the pull request was opened.
export function builtVersions(versions: readonly FoundryShelfVersion[], builtIn: FoundryView["builtIn"]): Map<string, number> {
  const built = new Map<string, number>(), seen = new Set<string>();
  if (!builtIn) return built;
  for (const version of versions) {
    if (!version.sessionId) continue;
    const pr = builtIn(version.sessionId);
    const mine = `${version.sessionId}:${version.artifactId}`;
    if (!pr || seen.has(mine) || Date.parse(version.createdAt) > Date.parse(pr.createdAt)) continue;
    seen.add(mine);
    built.set(shelfKey(version.artifactId, version.version), pr.number);
  }
  return built;
}

const ASK_SHOWN = 160;

/// One version on the long page: its address, for links from the chat.
export const shelfKey = (id: string, version: number) => `${id}:${version}`;
const dayKey = (date: string) => { const at = new Date(date); return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`; };
const clock = (date: string) => new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/// The long page: every version, newest first, under the day it was made.
/// The day stays at the top as you scroll; the rail on the edge (pass 209 A)
/// snaps to any mockup.
export function foundryPage(view: FoundryView) {
  const { list, versions } = view;
  const title = `<h1 class="cp-title fd-h">Foundry</h1>` + (view.error ? `<p class="sp-error" role="alert">${h(view.error)}</p>` : "");
  if (list === null || versions === null) return title + '<p class="cp-empty">Reading Foundry…</p>';
  const byId = new Map(list.map((item) => [item.id, item]));
  const shown = versions.filter((item) => byId.has(item.artifactId));
  if (!shown.length) return title + `<div class="fd-empty">${icon('<path d="M4 15h16l-2 5H6z"/><path d="M8 15V9h8v6M10 9V5h4v4"/>')}<b>Nothing made yet</b><span>Ask for a mockup in any chat. It lands here, and every version is kept.</span></div>`;
  const days = shelfDays(shown);
  const built = builtVersions(shown, view.builtIn);
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
      + (based ? `<span>based on ${link("foundry-open", { id: based.id, version: artifact.basedOn!.version }, `${h(based.title)} v${artifact.basedOn!.version}`, "Show it")}</span>` : "")
      + (built.has(key) ? `<span class="fd-built"><i aria-hidden="true"></i>built in ${link("pr-github", { id: version.sessionId }, `#${built.get(key)}`, "Open the pull request on GitHub")}</span>` : "") + "</div>";
    // Pass 219 A: the ask that made it, one quiet quoted line.
    const asked = version.ask ? `<p class="fd-ask">You asked <q title="${h(version.ask)}">${h(version.ask.length > ASK_SHOWN ? `${version.ask.slice(0, ASK_SHOWN - 1).trimEnd()}…` : version.ask)}</q></p>` : "";
    const words = artifact.description ? `<p class="fd-desc">${h(artifact.description)}</p>` : "";
    // Pass 218 A: why this version looks the way it does, three quiet lines.
    const why = version.why;
    const reasons = why ? ([["Direction", why.direction], ["Look at", why.look], ["Dropped", why.dropped]] as const).filter(([, text]) => text) : [];
    const because = reasons.length ? `<dl class="fd-why" aria-label="Why it looks this way">${reasons.map(([label, text]) => `<dt>${label}</dt><dd>${h(text)}</dd>`).join("")}</dl>` : "";
    const body = artifact.kind === "markdown"
      ? `<article class="fd-doc markdown" data-md="${h(key)}" data-at="${h(version.createdAt)}"><p class="cp-empty">Reading…</p></article>`
      : stageHTML(artifact, version);
    return `<section class="fd-item${pick ? " fd-rec" : ""}" data-fd="${h(key)}" aria-label="${h(`${artifact.title}, version ${version.version}${pick ? ", recommended" : ""}`)}">${line}${asked}${words}${because}${ver}${body}</section>`;
  };
  return title + days.map((day) => `<h2 class="fd-day" id="fd-day-${h(day.key)}">${h(day.word)}</h2>${pickFirst(day.items).map(({ version, pick }) => item(version, pick)).join("")}`).join("");
}

/// The page's days, newest first, each with its versions in page order.
function shelfDays(shown: readonly FoundryShelfVersion[]) {
  const days: { key: string; word: string; items: FoundryShelfVersion[] }[] = [];
  for (const item of shown) {
    const key = dayKey(item.createdAt);
    const day = days.at(-1)?.key === key ? days.at(-1)! : (days.push({ key, word: dayWord(item.createdAt), items: [] }), days.at(-1)!);
    day.items.push(item);
  }
  return days;
}

/// Every version in the order the long page draws it, with its day: what
/// the rail on the page's edge is made from (pass 209 A).
export function foundryOrder(list: readonly FoundryArtifact[] | null, versions: readonly FoundryShelfVersion[] | null) {
  if (!list || !versions) return [];
  const byId = new Map(list.map((item) => [item.id, item]));
  return shelfDays(versions.filter((item) => byId.has(item.artifactId))).flatMap((day) =>
    pickFirst(day.items).map(({ version }) => ({ id: version.artifactId, version: version.version, title: byId.get(version.artifactId)!.title, day: day.word })));
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
