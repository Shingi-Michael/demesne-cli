/// Foundry: one long page of mockups (pass 196 A). Every version of every
/// mockup, newest first, grouped by day, each at real size under one quiet
/// line; options stack one under another. You only look here: what to change
/// goes to the chat. HTML and SVG
/// render in a foundry:// frame that has no network, no app access and no
/// shared origin; Markdown renders through the app's sanitizer.
import { drawnSurface, type FoundryArtifact, type FoundryKind, type FoundryShelfVersion, type FoundryWalk } from "@demesne/protocol";
import { dayWord } from "./chats-page.ts";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const icon = (paths: string) => `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true">${paths}</svg>`;

export const KIND_WORD: Record<FoundryKind, string> = { html: "Prototype", svg: "Graphic", markdown: "Document", deck: "Deck", doc: "Doc", dashboard: "Dashboard", react: "App", mermaid: "Diagram", code: "Code", sheet: "Sheet", board: "Whiteboard" };
export const KIND_ICON: Record<FoundryKind, string> = {
  html: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/>'),
  svg: icon('<circle cx="8" cy="9" r="3"/><path d="m4 19 5-5 3 3 3-4 5 6z"/>'),
  markdown: icon('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h4"/>'),
  deck: icon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>'),
  doc: icon('<path d="M6 3h12v18H6z"/><path d="M9 7h6M9 11h6M9 15h3"/>'),
  dashboard: icon('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>'),
  react: icon('<circle cx="12" cy="12" r="1.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/>'),
  mermaid: icon('<rect x="3" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="16" width="7" height="5" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><path d="M10 5.5h4M17.5 8v8"/>'),
  code: icon('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>'),
  sheet: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 4v16"/>'),
  board: icon('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M11 7h4a2 2 0 0 1 2 2v4"/>'),
};
/// Pass 241 A: a build's record, the pick beside what was built.
export const BUILT_ICON = icon('<rect x="2.5" y="5" width="8" height="12" rx="1.5"/><rect x="13.5" y="5" width="8" height="12" rx="1.5"/><path d="m15.5 11 1.5 1.5 3-3"/><path d="M6.5 20h11"/>');
/// Step 6: the code view of a page made of several files: the page, then each file under its name.
export function codeWithFiles(source: string, files: Record<string, string> | undefined): string {
  return [source, ...Object.entries(files ?? {}).map(([name, text]) => `\n── ${name} ${"─".repeat(Math.max(4, 56 - name.length))}\n\n${text}`)].join("\n");
}
export const FOUNDRY_EXTENSION: Record<FoundryKind, string> = { html: "html", svg: "svg", markdown: "md", deck: "html", doc: "html", dashboard: "html", react: "jsx", mermaid: "mmd", code: "txt", sheet: "csv", board: "json" };
/// The kinds Demesne draws from content (a deck, a doc, a dashboard).
export const READY_KIND = new Set<FoundryKind>(["deck", "doc", "dashboard"]);
export const frameURL = (id: string, version: number) => `foundry://artifact/${encodeURIComponent(id)}?v=${version}`;
/// On the long page a page shows its options stacked (parts.js reads stack=1),
/// and loads only when it scrolls near the screen.
/// `at` is when the version last changed: Foundry's own fixes in the same
/// ask change it in place (pass 197 A), so the frame loads the fixed page.
/// `first` marks a version that just came back from notes (pass 233 A): its
/// frame outlines what changed for a few seconds (electron/foundry-changed.ts).
/// `edit` (step 3): the page comes with its text editable instead of its demo and notes (foundry-kit/edit.js).
const frame = (id: string, version: number, title: string, at: string, first = false, edit = false) =>
  `<iframe class="fd-frame" src="${h(`${frameURL(id, version)}&stack=1&at=${Date.parse(at) || 0}${first ? "&first=1" : ""}${edit ? "&edit=1" : ""}`)}" loading="lazy" sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer" title="${h(title)}"></iframe>`;

/// The bar a window or a browser surface draws above the page (pass 221 A).
const CHROME: Partial<Record<string, number>> = { window: 30, browser: 38 };
const GROW_START = 480;

/// A version's stage (pass 221 A): the surface the model chose, drawn by
/// Foundry around the page at its real size (the Foundry page scales it down
/// only to fit), on its backdrop; and, when it has a demo or is a deck, the
/// quiet line under it that the demo's words appear in. Without a surface it
/// is the plain stage it always was.
export function stageHTML(artifact: Pick<FoundryArtifact, "id" | "title" | "kind">, version: Pick<FoundryShelfVersion, "version" | "createdAt" | "stage">, first = false, edit = false, still = edit) {
  const inner = frame(artifact.id, version.version, `${artifact.title} v${version.version}`, version.createdAt, first, edit);
  // While you edit it or compare it, nothing plays on it.
  const demo = !still && version.stage?.demo?.length ? version.stage.demo : null, deck = !still && artifact.kind === "deck";
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
  /// Versions that just came back from notes (pass 233 A), as shelf keys: each outlines what changed.
  changed?: ReadonlySet<string>;
  /// Pass 262 C: the one mockup you opened, grown to full width where it sits.
  open?: FoundryOpen | null;
  /// Pass 273 A: the long page for this one mockup, opened from its card,
  /// under `head` (the line back to the front page) in place of the title.
  only?: string | null;
  head?: string;
}

/// Pass 262 C, a mockup you can hold: the one you open grows on the long
/// page to full width, with a quiet head line (‹ vN ›, code, save a copy, ×).
/// `at` is the version whose place on the page it grows in; `shown` the
/// version it shows there now (‹ › step through them in place); `code` its
/// source while the code view is on (null while it is read); `said` the
/// quiet line under it after a save, and `saved` that copy.
export interface FoundryOpen {
  id: string;
  at: number;
  shown: number;
  code?: string | null;
  said?: string;
  saved?: { path: string; pdf: boolean; ready: boolean } | null;
  /// Step 8, share outside Demesne: asking before a first share, then the link.
  share?: { asking?: boolean; url?: string; version?: number } | null;
  /// Step 3, edit in place: a deck, doc or dashboard's newest version with
  /// its text editable; `source` is the content with your changes so far,
  /// `base` the version they apply to, kept as a new version on Done.
  editing?: { source: string; base: number; changes: number } | null;
  /// Step 4, compare: the version before the one shown lies over it, cut
  /// by a line you drag, so what changed shows where it changed.
  compare?: boolean;
}

/// The version before `shown` among an artifact's versions (oldest first), if any.
export const earlierOf = (all: readonly number[], shown: number) => { const at = all.indexOf(shown); return at > 0 ? all[at - 1] : undefined; };

/// Step 4: the shown version with the one before it laid over it, cut at
/// the middle by a line you drag (live.ts moves it in place). Neither plays.
export function wipeHTML(before: string, after: string, was: number, now: number) {
  return `<div class="fd-wipe" style="--wipe:50%"><div class="fd-wipe-after">${after}</div><div class="fd-wipe-before">${before}</div>`
    + `<div class="fd-wipe-bar" role="slider" tabindex="0" aria-label="${h(`Drag to compare v${was} and v${now}`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">`
    + `<span class="fd-wipe-tag was">v${was}</span><span class="fd-wipe-tag now">v${now}</span></div></div>`;
}

/// The kinds you can edit in place: the ones Demesne draws from content.
export const EDIT_KINDS = new Set<FoundryKind>(["deck", "doc", "dashboard"]);

/// An artifact's versions on the page, oldest first.
export const versionsOf = (versions: readonly FoundryShelfVersion[], id: string) =>
  versions.filter((item) => item.artifactId === id).map((item) => item.version).sort((a, b) => a - b);

const COMPARE = '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 3v18"/><path d="M7 12h2M15 12h2" />';
const BRANCH = '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4.5-6 3.5-11 6.8"/>';
const SHARE = '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>';
const PENCIL = '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>';

/// The head line of the opened mockup (pass 262 C): the versions to step
/// through, then code, save a copy and close, as quiet grey icons.
export function openHead(open: FoundryOpen, all: readonly number[], kind?: FoundryKind) {
  const at = all.indexOf(open.shown), earlier = at > 0 ? all[at - 1] : undefined, later = at >= 0 && at < all.length - 1 ? all[at + 1] : undefined;
  const ico = (action: string, args: Record<string, unknown>, paths: string, label: string, extra = "") =>
    `<button type="button" class="fd-hd-b" data-action="${action}" data-args="${h(JSON.stringify(args))}" aria-label="${h(label)}" title="${h(label)}"${extra}>${icon(paths)}</button>`;
  const editing = !!open.editing, compare = !!open.compare && earlier !== undefined;
  const step = (version: number | undefined, paths: string, label: string) => version === undefined || editing
    ? `<button type="button" class="fd-hd-b" disabled aria-label="${h(label)}">${icon(paths)}</button>`
    : ico("foundry-shown", { version }, paths, `${label} (v${version})`);
  const code = open.code !== undefined;
  return `<span class="fd-hd" role="group" aria-label="This mockup">`
    + step(earlier, '<path d="m14 6-6 6 6 6"/>', "Earlier version")
    + `<span class="fd-hd-v" aria-live="polite">v${open.shown}</span>`
    + step(later, '<path d="m10 6 6 6-6 6"/>', "Later version")
    + '<i class="fd-hd-sep" aria-hidden="true"></i>'
    // Step 3: a deck, doc or dashboard's text, edited where it sits (its newest version only).
    // Step 4: lay the version before over this one, cut by a line you drag.
    + (editing || code ? "" : earlier === undefined ? `<button type="button" class="fd-hd-b" disabled aria-label="Nothing earlier to compare with" title="Nothing earlier to compare with">${icon(COMPARE)}</button>`
      : ico("foundry-compare", {}, COMPARE, compare ? "Stop comparing" : `Compare with v${earlier}`, ` aria-pressed="${compare}"`))
    + (kind && EDIT_KINDS.has(kind) && !code && !compare
      ? open.shown !== all.at(-1) ? `<button type="button" class="fd-hd-b" disabled aria-label="Edit the newest version" title="Edit the newest version">${icon(PENCIL)}</button>`
        : ico("foundry-edit", {}, editing ? '<path d="m5 12.5 4.5 4.5L19 7.5"/>' : PENCIL, editing ? "Done editing" : "Edit the text", ` aria-pressed="${editing}"`)
      : "")
    + (editing ? "" : ico("foundry-code", {}, '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>', code ? "Show the page" : "Show the code", ` aria-pressed="${code}"`))
    // Step 7: a new mockup that starts from this version, so one good page can branch into a second idea.
    + (editing ? "" : ico("foundry-branch", {}, BRANCH, `Start a new one from v${open.shown}`))
    + ico("foundry-copy", {}, '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', "Save a copy to Downloads")
    // Step 8: the version shown, on a link others can open.
    + (editing ? "" : ico("foundry-share", {}, SHARE, `Share v${open.shown} as a link`))
    + ico("foundry-shrink", {}, '<path d="M6 6l12 12M18 6 6 18"/>', "Close (Esc)")
    + "</span>";
}

/// The quiet line under the opened mockup after a save: where it went, Show,
/// and the other format once for a deck, doc or dashboard.
/// Painted into the opened mockup's quiet line in place (never a redraw of
/// the page, which would reload every mockup on it).
export function savedLine(open: FoundryOpen, kind: FoundryKind) {
  // Step 8: a first share asks; a shared mockup shows its link, to copy, open or take down.
  const share = open.share;
  if (share?.asking) return `${h(`Publish v${open.shown} to a link anyone can open, on your GitHub Pages?`)}<button type="button" class="fd-said-b" data-action="foundry-share" data-args='{"yes":true}'>Publish</button><button type="button" class="fd-said-b" data-action="foundry-share-no">Not now</button>`;
  if (share?.url) return `${h(open.said || `Shared v${share.version ?? open.shown}`)} <span class="fd-said-link">${h(share.url.replace(/^https:\/\//, ""))}</span><button type="button" class="fd-said-b" data-action="foundry-share-copy">Copy link</button><button type="button" class="fd-said-b" data-action="foundry-share-open">Open</button><button type="button" class="fd-said-b" data-action="foundry-share-stop">Stop sharing</button>`;
  if (!open.said) return "";
  const saved = open.saved;
  const show = saved ? `<button type="button" class="fd-said-b" data-action="foundry-copy-show">Show</button>` : "";
  const other = saved && saved.ready ? `<button type="button" class="fd-said-b" data-action="foundry-copy" data-args='{"other":true}'>${kind === "deck" ? "Also as a web page" : kind === "react" ? "Also as the .jsx" : kind === "mermaid" ? "Also as the .mmd" : "Also as PDF"}</button>` : "";
  return `${h(open.said)}${show}${other}`;
}

/// Pass 263 A, every variant explained: the walkthrough under a mockup, one
/// section per variant (tab), the first shown until the page says which
/// variant it shows (foundry-stage.ts switches them with the tabs). Each
/// part is numbered; its number is drawn on the page where `at` points
/// (foundry-kit/marks.js), and resting on either lights the other.
export function walkHTML(walk: readonly FoundryWalk[] | undefined, title: string) {
  if (!walk?.length) return "";
  const others = walk.length - 1;
  const one = (item: FoundryWalk, index: number) => `<section class="fd-walk-v"${item.option ? ` data-option="${h(item.option)}"` : ""}${index ? " hidden" : ""}>`
    + `<p class="fd-walk-what">${h(item.what)}</p>`
    + (item.parts.length ? `<h4>The parts</h4><ol class="fd-walk-parts">${item.parts.map((part, at) => `<li data-n="${at + 1}"${part.at ? ` data-at="${h(part.at)}"` : ""}><span class="fd-num" aria-hidden="true">${at + 1}</span><span><b>${h(part.name)}</b> ${h(part.says)}</span></li>`).join("")}</ol>` : "")
    + (item.why ? `<h4>Why it’s shaped this way</h4><p>${h(item.why)}</p>` : "")
    + (item.differs ? `<h4>How it differs from the other${others === 1 ? "" : others ? ` ${others}` : "s"}</h4><p>${h(item.differs)}</p>` : "")
    + (item.next ? `<h4>What I’d do next</h4><p>${h(item.next)}</p>` : "")
    + "</section>";
  return `<div class="fd-walk" aria-label="${h(`${title}, explained`)}">${walk.map(one).join("")}</div>`;
}

/// The kinds a note can be pinned to (pass 233 A): the ones drawn in a frame that says what is under the pointer.
export const NOTE_KINDS = new Set<FoundryKind>(["html", "deck", "doc", "dashboard", "react", "mermaid"]);

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
/// The day stays at the top as you scroll.
export function foundryPage(view: FoundryView) {
  const { list, versions } = view;
  const title = (view.head ?? `<h1 class="cp-title fd-h">Foundry</h1>`) + (view.error ? `<p class="sp-error" role="alert">${h(view.error)}</p>` : "");
  if (list === null || versions === null) return title + '<p class="cp-empty">Reading Foundry…</p>';
  const byId = new Map(list.map((item) => [item.id, item]));
  const shown = versions.filter((item) => byId.has(item.artifactId) && (!view.only || item.artifactId === view.only));
  if (!shown.length) return title + `<div class="fd-empty">${icon('<path d="M4 15h16l-2 5H6z"/><path d="M8 15V9h8v6M10 9V5h4v4"/>')}<b>Nothing made yet</b><span>Ask for a mockup in any chat. It lands here, and every version is kept.</span></div>`;
  const days = shelfDays(shown);
  const built = builtVersions(shown, view.builtIn);
  // Pass 208 A: the name, from which chat (a link to it), what it is, and
  // the version's own name; "based on" links to the mockup it came from.
  const item = (slot: FoundryShelfVersion, pick: boolean) => {
    const artifact = byId.get(slot.artifactId)!, slotKey = shelfKey(artifact.id, slot.version);
    // Pass 262 C: the opened mockup grows in its place and may show another of its versions there.
    const open = view.open && view.open.id === artifact.id && view.open.at === slot.version ? view.open : null;
    const version = open ? shown.find((item) => item.artifactId === artifact.id && item.version === open.shown) ?? slot : slot;
    const key = shelfKey(artifact.id, version.version);
    const chat = version.sessionId ? view.chatTitle(version.sessionId) : null;
    const name = open ? `<b>${h(artifact.title)}</b>` : `<b>${link("foundry-grow", { id: artifact.id, version: slot.version }, h(artifact.title), "Open it here, full width")}</b>`;
    const line = `<div class="fd-ln">${name}${chat ? `<span>from ${link("select-session", { id: version.sessionId }, `“${h(chat)}”`, "Open the chat")}</span>` : ""}`
      + `<span class="fd-ln-r">${artifact.built ? "Built" : h(KIND_WORD[artifact.kind])} · ${h(clock(version.createdAt))}</span>`
      + (open ? openHead(open, versionsOf(shown, artifact.id), artifact.kind) : "") + "</div>";
    const based = artifact.basedOn && byId.get(artifact.basedOn.id);
    const from = based ? link("foundry-open", { id: based.id, version: artifact.basedOn!.version }, `${h(based.title)} v${artifact.basedOn!.version}`, "Show it") : "";
    // Pass 241 A: a build's record says how it came out and links the mockup it follows.
    const ver = (artifact.built
      ? `<div class="fd-ver"><b>Built like the mockup${version.note ? ` · ${h(version.note)}` : ""}</b>${from ? `<span>from ${from}</span>` : ""}`
      : `<div class="fd-ver"><b>v${version.version}${version.note ? ` · ${h(version.note)}` : ""}</b>`
        + (pick ? '<span class="fd-rec-pill">recommended</span>' : "")
        + (from ? `<span>based on ${from}</span>` : ""))
      + (built.has(key) ? `<span class="fd-built"><i aria-hidden="true"></i>built in ${link("pr-github", { id: version.sessionId }, `#${built.get(key)}`, "Open the pull request on GitHub")}</span>` : "") + "</div>";
    // Pass 219 A: the ask that made it, one quiet quoted line.
    const asked = version.ask ? `<p class="fd-ask">You asked <q title="${h(version.ask)}">${h(version.ask.length > ASK_SHOWN ? `${version.ask.slice(0, ASK_SHOWN - 1).trimEnd()}…` : version.ask)}</q></p>` : "";
    const words = artifact.description ? `<p class="fd-desc">${h(artifact.description)}</p>` : "";
    // Pass 218 A: why this version looks the way it does, three quiet lines.
    const why = version.why;
    // Pass 245 A: a fourth line when the version follows what the person liked on earlier mockups here.
    const taste = why?.followed && !/^none\b/i.test(why.followed) ? why.followed : "";
    // Pass 263 A: with a walkthrough under the mockup, only what it dropped and your taste stay up here.
    const walked = !!why?.walk?.length;
    const reasons = why ? ([["Direction", walked ? "" : why.direction], ["Look at", walked ? "" : why.look], ["Dropped", why.dropped], ["Your taste", taste], ["Project look", why.onLook ?? ""]] as const).filter(([, text]) => text) : [];
    const because = reasons.length ? `<dl class="fd-why" aria-label="Why it looks this way">${reasons.map(([label, text]) => `<dt>${label}</dt><dd>${h(text)}</dd>`).join("")}</dl>` : "";
    const before = open?.compare && open.code === undefined && !open.editing ? earlierOf(versionsOf(shown, artifact.id), open.shown) : undefined;
    const beforeSlot = before === undefined ? undefined : shown.find((item) => item.artifactId === artifact.id && item.version === before);
    const body = beforeSlot
      ? wipeHTML(stageHTML(artifact, beforeSlot, false, false, true), stageHTML(artifact, version, false, false, true), beforeSlot.version, version.version)
      : open && open.code !== undefined
      ? `<pre class="fd-code" tabindex="0" aria-label="${h(`${artifact.title} v${version.version}, its code`)}"><code>${open.code === null ? "Reading…" : h(open.code)}</code></pre>`
      : artifact.kind === "markdown"
      ? `<article class="fd-doc markdown" data-md="${h(key)}" data-at="${h(version.createdAt)}"><p class="cp-empty">Reading…</p></article>`
      : stageHTML(artifact, version, view.changed?.has(key), !!open?.editing);
    // Pass 233 A: notes are pinned to the newest version only (a correction makes the next one), and their quiet line sits under it.
    // A build's record takes none: what to change goes to the code or the mockup.
    const notes = artifact.version === version.version && NOTE_KINDS.has(artifact.kind) && !artifact.built ? '<p class="fd-notes" aria-live="polite" hidden></p>' : "";
    const notesHere = open && (open.code !== undefined || !!open.editing || !!beforeSlot || version !== slot) ? "" : notes;
    return `<section class="fd-item${pick ? " fd-rec" : ""}${open ? " fd-open" : ""}" data-fd="${h(slotKey)}" aria-label="${h(`${artifact.title}, version ${version.version}${pick ? ", recommended" : ""}${open ? ", open" : ""}`)}">${line}${asked}${words}${because}${ver}${body}${open ? `<p class="fd-said" role="status" data-kind="${h(artifact.kind)}" hidden></p>` : ""}${notesHere}${open && open.code !== undefined ? "" : walkHTML(why?.walk, artifact.title)}</section>`;
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
