/// Open it, and show it on the right (pass 210 A). The newest thing the chat
/// opened or showed sits in one quiet card on the right: its name, a 4:3
/// preview (live for the app being built, a picture of the window or page
/// otherwise), what it is, and Bring to front or Open ↗. A click on the
/// preview makes it bigger, × puts it away; the earlier pictures fold into the
/// screenshots pile. Nothing here takes the keyboard or moves the chat.

export interface Shown {
  /// The tool call that showed it, so a closed card stays closed.
  id: string;
  shown: "window" | "page" | "app" | "file";
  name: string;
  app?: string;
  title?: string;
  target?: string;
  path?: string;
  url?: string;
  kind?: string;
  live?: boolean;
  picture?: { id: string; width: number; height: number };
}

export const SHOWN_CARD = "shown";

interface ShownTool { name: string; state: string; toolCallId?: string; id?: string; message?: string }
interface ShownRun { entries: readonly { type: string }[] }

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/// One open or show result, read back from its step.
export function shownOf(tool: ShownTool): Shown | null {
  if ((tool.name !== "open" && tool.name !== "show") || tool.state !== "done" || !tool.message) return null;
  let value: Record<string, unknown>;
  try { const parsed = JSON.parse(tool.message) as unknown; if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null; value = parsed as Record<string, unknown>; } catch { return null; }
  const shown = value.shown;
  if (shown !== "window" && shown !== "page" && shown !== "app" && shown !== "file") return null;
  const text = (key: string) => typeof value[key] === "string" && value[key] ? value[key] as string : undefined;
  const picture = value.picture as Shown["picture"] | undefined;
  const ok = picture && typeof picture.id === "string" && typeof picture.width === "number" && typeof picture.height === "number";
  const id = tool.toolCallId ?? tool.id ?? "";
  if (!id) return null;
  const url = text("url");
  return {
    id, shown, name: text("name") ?? text("app") ?? "Preview",
    ...(text("app") ? { app: text("app") } : {}), ...(text("title") ? { title: text("title") } : {}),
    ...(text("target") ? { target: text("target") } : {}), ...(text("path") ? { path: text("path") } : {}),
    ...(url && /^https?:\/\//i.test(url) ? { url } : {}), ...(text("kind") ? { kind: text("kind") } : {}),
    ...(value.live === true && url ? { live: true } : {}), ...(ok ? { picture: picture! } : {}),
  };
}

/// Everything the chat opened or showed, oldest first.
export function chatShown(runs: readonly ShownRun[]): Shown[] {
  return runs.flatMap((run) => run.entries.filter((entry): entry is ShownTool & { type: "tool" } => entry.type === "tool").map(shownOf).filter((one): one is Shown => one !== null));
}

/// The card shows the newest, unless it was closed. A file goes to the file
/// preview card instead, and a window with no picture has nothing to show.
export function latestShown(all: readonly Shown[], closed: ReadonlySet<string>): Shown | null {
  const last = all.at(-1);
  if (!last || closed.has(last.id) || last.shown === "file") return null;
  if (!last.picture && !last.live && last.shown === "window") return null;
  return last;
}

/// What it is, in a word or two.
export function shownKind(shown: Shown): string {
  if (shown.shown === "app") return "Live · the app";
  if (shown.shown === "page") return "Web page";
  if (shown.kind === "file") return `${shown.app ?? "File"} · opened behind`;
  if (shown.kind === "folder") return "Folder · opened behind";
  if (shown.kind === "link") return `${shown.app ?? "Browser"} · opened behind`;
  return "App · opened behind";
}

/// Its name in the card: the window's title when it says more.
const nameOf = (shown: Shown) => shown.shown === "window" && shown.title && shown.title !== shown.app ? shown.title : shown.name;

/// Bigger is a class the chat sets on the card in place (setShownBig), so a
/// live page never reloads when it grows.
export function shownCardHTML(shown: Shown, src: (id: string) => string | undefined): string {
  const name = nameOf(shown);
  const url = shown.picture ? src(shown.picture.id) : undefined;
  const box = shown.live && shown.url
    ? `<iframe src="${h(shown.url)}" title="${h(name)}, live" tabindex="-1" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe><span class="sh-cover" aria-hidden="true"></span>`
    : shown.picture
      ? `<img data-picture="${h(shown.picture.id)}" alt="${h(name)}" draggable="false"${url ? ` src="${h(url)}"` : ""}>`
      : `<div class="fp-empty">${h(shown.url ? new URL(shown.url).host : name)}</div>`;
  const front = shown.shown === "window" && shown.app
    ? `<button type="button" class="link" data-action="shown-front" data-args="${h(JSON.stringify({ app: shown.app }))}" title="Bring ${h(shown.app)} in front of Demesne">Bring to front</button>`
    : shown.url ? `<button type="button" class="link" data-action="open-link" data-args="${h(JSON.stringify({ url: shown.url }))}" title="${h(shown.url)}">Open ↗</button>` : "";
  return `<section class="card fp sh" data-card="${SHOWN_CARD}" data-shown="${h(shown.id)}">`
    + `<div class="card-head fp-head">${shown.live ? '<span class="pv-live" title="Live" aria-hidden="true"></span>' : ""}<span class="card-line" title="${h(shown.url ?? shown.target ?? name)}">${h(name)}</span>`
    + `<button type="button" class="fp-x" data-action="shown-close" aria-label="Put away ${h(name)}">×</button></div>`
    + `<div class="fp-box" role="button" tabindex="-1" data-action="shown-big" aria-label="Bigger or smaller: ${h(name)}">${box}</div>`
    + `<div class="fp-foot"><span>${h(shownKind(shown))}</span>${front}</div></section>`;
}
