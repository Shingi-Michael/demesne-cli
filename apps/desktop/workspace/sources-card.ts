/// The Sources line (pass 204 A, refined). Files, folders and links you keep
/// with a chat sit in one quiet card on the right: "Sources" and up to four
/// small marks; hover unfolds the rows, a click keeps them open. The + opens
/// one field for a link (or Choose… for a file or folder), and anything
/// dragged over the window lands on the line. A pink ring or dot marks what
/// the last answer used.
import type { ChatSource } from "@demesne/protocol";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export const SOURCES_CARD = "sources";
export const SHOWN_ROWS = 6;
const MARKS = 4;

export const SOURCES_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h11l3 3v13H5z"/><path d="M9 10h6M9 14h6"/></svg>';
const FOLDER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

/// A steady colour for a site, from its name.
export function siteColour(host: string): string {
  let hash = 0;
  for (const char of host.replace(/^www\./, "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 62% 66%)`;
}

/// A source's small mark: a link's first letter on its site's colour, a
/// file's kind (SQL, PDF), a folder's glyph.
export function sourceMark(source: ChatSource): { kind: "link" | "file" | "folder"; label: string; colour?: string } {
  if (source.kind === "folder") return { kind: "folder", label: "" };
  if (source.kind === "link") {
    let host = source.name;
    try { host = new URL(source.target).hostname; } catch { /* the name will do */ }
    const site = host.replace(/^www\./, "");
    return { kind: "link", label: (site[0] ?? "?").toUpperCase(), colour: siteColour(site) };
  }
  const ending = /\.([a-z0-9]{1,4})$/i.exec(source.name)?.[1]?.toUpperCase();
  return { kind: "file", label: ending ?? "FILE" };
}

const markHTML = (source: ChatSource, used: boolean, tag: "i" | "span") => {
  const mark = sourceMark(source);
  return `<${tag} class="src-k ${mark.kind}${used ? " used" : ""}"${mark.colour ? ` style="background:${mark.colour}"` : ""} aria-hidden="true">${mark.kind === "folder" ? FOLDER : h(mark.label)}</${tag}>`;
};

interface UsedTool { name: string; input: Record<string, unknown>; state?: string }

const urlKey = (value: unknown) => {
  try { const url = new URL(String(value)); url.hash = ""; return url.href.replace(/\/$/, ""); } catch { return ""; }
};

/// The source a step used, if any: read_source by id, a read of a kept
/// file's path (or one inside a kept folder), a fetch of a kept link.
export function sourceOfStep(sources: readonly ChatSource[], tool: UsedTool): ChatSource | undefined {
  if (tool.name === "read_source") return sources.find((source) => source.id === tool.input.id);
  const paths = tool.name === "read_files" && Array.isArray(tool.input.paths) ? tool.input.paths.map(String)
    : ["read_file", "list_files", "search_files"].includes(tool.name) && typeof tool.input.path === "string" ? [tool.input.path] : [];
  for (const raw of paths) {
    const path = raw.replace(/^\.\//, "").replace(/\/$/, "");
    const found = sources.find((source) => source.inProject !== undefined && source.inProject !== ""
      && (source.inProject === path || (source.kind === "folder" && path.startsWith(`${source.inProject}/`))));
    if (found) return found;
  }
  if (tool.name === "web_fetch") {
    const asked = urlKey(tool.input.url);
    return asked ? sources.find((source) => source.kind === "link" && urlKey(source.target) === asked) : undefined;
  }
  return undefined;
}

/// The ids of the sources the last answer used.
export function usedSources(sources: readonly ChatSource[], lastTools: readonly UsedTool[]): Set<string> {
  const used = new Set<string>();
  for (const tool of lastTools) {
    if (tool.state === "failed" || tool.state === "denied") continue;
    const source = sourceOfStep(sources, tool);
    if (source) used.add(source.id);
  }
  return used;
}

export interface SourcesView {
  /// Sticky open (a click on the head), like the other cards.
  open: boolean;
  /// The + field is showing.
  field: boolean;
  /// What the field says under it: a refusal, or the hint.
  error?: string;
  /// Something is being dragged over the window.
  dragging: boolean;
  /// A source that just landed, for its slide in.
  fresh?: string;
}

/// The card's HTML: nothing with no sources unless something is being
/// dragged, when a dashed line of its own takes the drop.
export function sourcesCardHTML(sources: readonly ChatSource[], used: ReadonlySet<string>, view: SourcesView): string {
  if (!sources.length) {
    if (!view.dragging) return "";
    return `<section class="card src-card src-ghost" data-card="${SOURCES_CARD}" data-source-drop><div class="card-head src-head">${SOURCES_ICON}<span class="card-line">Drop to keep it with this chat</span></div></section>`;
  }
  const classes = ["card", "src-card", view.open ? "open" : "", view.field ? "field" : "", view.dragging ? "drop" : "", view.fresh && sources.some((source) => source.id === view.fresh) ? "fresh" : ""].filter(Boolean).join(" ");
  const marks = sources.slice(0, MARKS).map((source) => markHTML(source, used.has(source.id), "i")).join("")
    + (sources.length > MARKS ? `<i class="src-more">+${sources.length - MARKS}</i>` : "");
  const word = sources.length === 1 ? "1 source" : `${sources.length} sources`;
  const head = `<button type="button" class="card-head src-head" data-action="card-fold" data-args='{"name":"${SOURCES_CARD}"}' aria-expanded="${view.open}" aria-label="Sources: ${word}">${SOURCES_ICON}<span class="card-line">Sources</span><span class="src-marks">${marks}</span></button>`
    + `<button type="button" class="src-add" data-action="source-field" title="Add a source" aria-label="Add a source">+</button>`;
  const field = view.field
    ? `<div class="src-field"><input class="src-input" type="text" placeholder="Paste a link…" aria-label="Paste a link" spellcheck="false" autocomplete="off"><button type="button" class="src-choose" data-action="source-choose">Choose…</button></div>`
      + `<div class="src-hint${view.error ? " bad" : ""}">${h(view.error ?? "Return to keep it · or drop a file or folder here")}</div>`
    : "";
  const rows = sources.slice(0, SHOWN_ROWS).map((source) => `<div class="src-row${used.has(source.id) ? " used" : ""}${source.id === view.fresh ? " new" : ""}" data-source="${h(source.id)}">`
    + `<button type="button" class="src-open" data-action="source-open" data-args="${h(JSON.stringify({ id: source.id }))}" title="Open ${h(source.name)}">${markHTML(source, false, "span")}<span class="src-nm"><span>${h(source.name)}</span><small>${h(source.detail)}</small></span></button>`
    + `<i class="src-dot" aria-hidden="true"></i><button type="button" class="src-x" data-action="source-remove" data-args="${h(JSON.stringify({ id: source.id }))}" title="Take it off" aria-label="Take ${h(source.name)} off">×</button></div>`).join("");
  const more = sources.length > SHOWN_ROWS ? `<div class="src-rest">and ${sources.length - SHOWN_ROWS} more</div>` : "";
  return `<section class="${classes}" data-card="${SOURCES_CARD}" data-source-drop>${head}<div class="card-body">${field}${rows}${more}</div></section>`;
}

/// A dropped link, from a drag's text: the first http(s) address in it.
export function droppedLink(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    try { const url = new URL(value); if (url.protocol === "https:" || url.protocol === "http:") return url.href; } catch { /* not this line */ }
  }
  return undefined;
}

/// What the field does with what you typed: a link to keep, or why not.
export function fieldLink(text: string): { url: string } | { error: string } {
  const value = text.trim();
  if (!value) return { error: "Paste a link starting with https://, or press Choose…" };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value) ? `https://${value}` : "";
  const link = withScheme ? droppedLink(withScheme) : undefined;
  return link ? { url: link } : { error: "That isn’t a link. Paste one starting with https://, or press Choose…" };
}
