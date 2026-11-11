/// See the app (pass 174): a look_at_page step in the turn. "Opened
/// localhost:5173/login", how each click went, and small pictures under it;
/// click one to see it large. The pictures are the chat's own image
/// artifacts, fetched once through the host (tool-picture) and kept here.

export interface PageLookPicture { id: string; width: number; height: number; label: string }
export interface PageLookOutcome { url: string; title: string; width: string; steps: string[]; errors: string[]; errorCount: number; pictures: PageLookPicture[] }

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/// The look the daemon recorded, or null.
export function pageLookOutcome(message: string | undefined): PageLookOutcome | null {
  if (!message) return null;
  try {
    const value = JSON.parse(message) as Partial<PageLookOutcome>;
    if (typeof value.url !== "string") return null;
    const strings = (list: unknown) => Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
    return {
      url: value.url, title: typeof value.title === "string" ? value.title : "", width: typeof value.width === "string" ? value.width : "",
      steps: strings(value.steps), errors: strings(value.errors), errorCount: Number(value.errorCount) || 0,
      pictures: Array.isArray(value.pictures) ? value.pictures.filter((p): p is PageLookPicture => !!p && typeof p.id === "string" && /^[0-9a-f-]{36}$/.test(p.id)
        && typeof p.width === "number" && typeof p.height === "number").map((p) => ({ ...p, label: typeof p.label === "string" ? p.label : "" })) : [],
    };
  } catch { return null; }
}

/// localhost:5173/login, or the file's name for a project file.
export function pageName(url: unknown): string {
  if (typeof url !== "string" || !url.trim()) return "the app";
  const value = url.trim();
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : /^(localhost|127\.|\[::1\])/i.test(value) ? `http://${value}` : `file:///${value}`);
    if (parsed.protocol === "file:") return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).slice(-2).join("/"));
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
  } catch { return value; }
}

const stepCount = (steps: unknown) => Array.isArray(steps) ? steps.length : 0;

/// The row's words and what goes under it.
export function pageLookRow(tool: { state: string; drafting?: boolean; input: Record<string, unknown>; message?: string }, picture: (id: string) => string | undefined): { verb: string; target: string; meta: string; tone: string; below: string } {
  const asked = pageName(tool.input.url), n = stepCount(tool.input.steps), phone = tool.input.width === "phone" ? " · phone" : "";
  if (tool.drafting || tool.state === "running") return { verb: n ? "Trying" : "Opening", target: h(asked), meta: h(n ? `${n} step${n === 1 ? "" : "s"}${phone}` : phone.slice(3)), tone: "running", below: "" };
  const look = pageLookOutcome(tool.message);
  if (!look) return { verb: "Couldn't open", target: h(asked), meta: tool.state === "failed" ? "is it running?" : "", tone: tool.state === "failed" ? "failed" : "", below: "" };
  const failed = look.steps.filter((line) => line.startsWith("✕")).length;
  const meta = look.errorCount ? `<span class="bad">${look.errorCount} console error${look.errorCount === 1 ? "" : "s"}</span>`
    : failed ? `<span class="bad">${failed} of ${look.steps.length} step${look.steps.length === 1 ? "" : "s"} didn't work</span>`
    : h(look.steps.length ? `${look.steps.length} step${look.steps.length === 1 ? "" : "s"} worked${phone}` : `${look.title}${phone}`);
  const steps = look.steps.length ? `<div class="pl-steps">${look.steps.map((line) => {
    const ok = !line.startsWith("✕");
    return `<div class="pl-step${ok ? "" : " bad"}"><span class="pl-mark" aria-hidden="true">${ok ? "✓" : "✕"}</span><span>${h(line.replace(/^[✓✕]\s*/, ""))}</span></div>`;
  }).join("")}</div>` : "";
  const errors = look.errors.length ? `<pre class="wait-tail pl-errors">${h(look.errors.join("\n"))}</pre>` : "";
  const shots = look.pictures.length ? `<div class="pl-shots">${look.pictures.map((p) => {
    const caption = pictureCaption(p.label, pageName(look.url));
    const src = picture(p.id);
    return `<button type="button" class="pl-shot" data-action="look-picture" data-args="${h(JSON.stringify({ id: p.id, caption }))}" title="${h(caption)}">`
      + `<img data-picture="${h(p.id)}" alt="${h(caption)}" style="aspect-ratio:${p.width} / ${p.height}"${src ? ` src="${h(src)}"` : ""}><span>${h(captionShort(p.label))}</span></button>`;
  }).join("")}</div>` : "";
  return { verb: look.steps.length ? "Tried" : "Opened", target: h(pageName(look.url)), meta, tone: look.errorCount || failed ? "failed" : "", below: steps + errors + shots };
}

const captionShort = (label: string) => !label || label === "on opening" ? "Opening" : label.replace(/^after /, "After ");
export const pictureCaption = (label: string, page: string) => `${captionShort(label)} · ${page}`;

/// The big view: the picture over the window; a click or Escape closes it.
export function showPicture(src: string, caption: string, root: HTMLElement = document.body): HTMLElement {
  root.querySelector(".pl-big")?.remove();
  const view = document.createElement("div");
  view.className = "pl-big";
  view.setAttribute("role", "dialog");
  view.setAttribute("aria-label", caption);
  view.innerHTML = `<figure><img alt="${h(caption)}" src="${h(src)}"><figcaption>${h(caption)}</figcaption></figure>`;
  const close = () => { view.remove(); document.removeEventListener("keydown", key, true); };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
  view.addEventListener("click", close);
  document.addEventListener("keydown", key, true);
  root.append(view);
  return view;
}
