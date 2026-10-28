/// The pane: one Foundry artifact open beside the conversation, the way
/// Claude shows an artifact. The window splits, the page fills the right
/// side edge to edge, and one line above it carries the title, the version
/// arrows, Preview · Code, the phone width and ×; a thin line below names
/// the version and holds Copy, Export, Revise and Open in Foundry. The
/// pane is per chat and remembers whether it was open.
import type { FoundryArtifactDetail } from "@demesne/protocol";
import { frameURL, KIND_WORD } from "./foundry-page.ts";
import { dayWord } from "./chats-page.ts";

export interface PaneState { id: string; version: number; view: "preview" | "code"; phone: boolean }

export interface PaneOptions {
  read(id: string, version?: number): Promise<FoundryArtifactDetail>;
  markdown(source: string): string;
  copy(text: string): Promise<unknown>;
  export(id: string, version: number): Promise<unknown>;
  revise(detail: FoundryArtifactDetail): Promise<unknown>;
  /// Make this the latest: an older version saved again as the newest.
  restore(detail: FoundryArtifactDetail): Promise<FoundryArtifactDetail>;
  openFoundry(id: string, version: number): void;
  notice(text: string): void;
  /// The pane opened, closed or moved to another version.
  changed(): void;
  /// A document drawn in the pane assembles on its first show (assemble.ts);
  /// `previousHTML` is the version before it, for a revision.
  assembleDocument?(root: HTMLElement, previousHTML: string | null): void;
}

/** The frame's address; the first show of a version asks for the assembly. */
export const frameSource = (id: string, version: number, assemble: boolean) => `${frameURL(id, version)}${assemble ? "&assemble=1" : ""}`;

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const icon = (paths: string) => `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true">${paths}</svg>`;
const button = (action: string, label: string, extra = "") => `<button type="button" data-pane="${action}"${extra}>${label}</button>`;

/// The versions just before and after the one shown, by number.
export function neighbours(versions: readonly { version: number }[], current: number) {
  const numbers = versions.map((item) => item.version).sort((a, b) => a - b);
  const at = numbers.indexOf(current);
  return { earlier: at > 0 ? numbers[at - 1] : null, later: at >= 0 && at < numbers.length - 1 ? numbers[at + 1] : null, latest: numbers.at(-1) ?? current };
}

/// The one line above the page while Foundry is still writing it: the title
/// alone, and ×.
export function paneMakingHead(title: string) {
  return `<b class="pane-title" title="${h(title)}">${h(title)}</b><span class="pane-making">making…</span><span class="sp"></span>`
    + button("close", icon('<path d="M6 6l12 12M18 6 6 18"/>'), ' aria-label="Close" title="Close (Esc)"');
}

/// The one line above the page.
export function paneHead(detail: FoundryArtifactDetail | null, state: PaneState) {
  const title = detail?.title ?? "Loading…";
  const near = detail ? neighbours(detail.versions, state.version) : { earlier: null, later: null, latest: state.version };
  const arrow = (action: string, to: number | null, label: string, path: string) =>
    button(action, icon(path), ` aria-label="${label}"${to === null ? " disabled" : ` title="v${to}"`}`);
  return `<b class="pane-title" title="${h(title)}">${h(title)}</b>`
    + `<span class="pane-vers">${arrow("earlier", near.earlier, "Earlier version", '<path d="m15 6-6 6 6 6"/>')}<span>v${state.version}</span>${arrow("later", near.later, "Later version", '<path d="m9 6 6 6-6 6"/>')}</span>`
    + `<span class="sp"></span>`
    + `<span class="pane-seg" role="group" aria-label="View">${button("preview", "Preview", ` aria-pressed="${state.view === "preview"}"`)}${button("code", "Code", ` aria-pressed="${state.view === "code"}"`)}</span>`
    + (detail?.kind === "html" ? button("phone", icon('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>'), ` aria-label="Phone width" title="Phone width" aria-pressed="${state.phone}"`) : "")
    + button("close", icon('<path d="M6 6l12 12M18 6 6 18"/>'), ' aria-label="Close" title="Close (Esc)"');
}

/// The thin line below the page.
export function paneFoot(detail: FoundryArtifactDetail | null, state: PaneState, error: string) {
  if (error) return `<span class="bad" role="alert">${h(error)}</span><span class="sp"></span>${button("close", "Close")}`;
  if (!detail) return `<span>Reading the artifact…</span>`;
  const version = detail.versions.find((item) => item.version === state.version);
  const latest = neighbours(detail.versions, state.version).latest;
  const words = [version?.note || (state.version === 1 ? "first version" : ""), version ? dayWord(version.createdAt) : ""].filter(Boolean).join(" · ");
  return `<b>v${state.version}</b><span class="note" title="${h(words)}">${h(words)}</span><span class="sp"></span>`
    + (state.version !== latest ? button("restore", "Make this the latest") : "")
    + button("copy", "Copy") + button("export", "Export") + button("revise", "Revise") + button("foundry", "Open in Foundry ›");
}

export class FoundryPane {
  state: PaneState | null = null;
  detail: FoundryArtifactDetail | null = null;
  error = "";
  private session = "";
  private frameKey = "";
  private loading = 0;
  /// The version whose first show assembles the page, until its frame is made.
  private assembleKey = "";
  /// A document's last rendered HTML, so a revision can settle only what changed.
  private lastDocument: { id: string; html: string } | null = null;
  /// What Foundry is writing right now, shown while the pane has nothing open.
  private makingTitle: string | null = null;
  /// Artifacts this chat has shown chips for; a new one opens the pane,
  /// the way Claude opens an artifact as it is made. History never does.
  private readonly seen = new Set<string>();
  private primed = false;
  private readonly head: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly code: HTMLPreElement;
  private readonly foot: HTMLElement;

  constructor(readonly root: HTMLElement, private readonly options: PaneOptions) {
    root.innerHTML = '<div class="pane-head"></div><div class="pane-body"><div class="pane-stage"></div><pre class="pane-code" tabindex="0" aria-label="Source" hidden></pre></div><div class="pane-foot"></div>';
    this.head = root.querySelector(".pane-head")!;
    this.stage = root.querySelector(".pane-stage")!;
    this.code = root.querySelector(".pane-code")!;
    this.foot = root.querySelector(".pane-foot")!;
    root.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-pane]");
      if (target && !(target as HTMLButtonElement).disabled) void this.act(target.dataset.pane!);
    });
    // Esc closes the pane, unless something that handles its own Esc has focus.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.state || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && (target.matches("input, textarea, select, [contenteditable]") || target.closest("#overlay, .popover, [role=dialog]"))) return;
      event.preventDefault();
      this.close();
    });
  }

  get open() { return this.state !== null || this.makingTitle !== null; }
  isOpen(id: string, version?: number) { return !!this.state && this.state.id === id && (version === undefined || this.state.version === version); }

  /// Foundry is writing a page: the pane opens on its title while the words
  /// arrive, so the page can assemble in front of you when they're done. With
  /// nothing being written, a pane that was only waiting closes again. A pane
  /// already showing an artifact keeps it.
  making(title: string | null) {
    if (this.state) { this.makingTitle = null; return; }
    if (title === this.makingTitle) return;
    this.makingTitle = title;
    this.render();
    this.options.changed();
  }

  /// Each chat keeps its own pane; switching chats puts the other one back.
  switchSession(id: string) {
    if (id === this.session) return;
    this.session = id;
    this.state = null; this.detail = null; this.error = ""; this.frameKey = ""; this.assembleKey = ""; this.lastDocument = null; this.makingTitle = null;
    this.seen.clear(); this.primed = false;
    let saved: PaneState | null = null;
    try { saved = id ? JSON.parse(localStorage.getItem(`demesne-pane:${id}`) ?? "null") : null; } catch {}
    if (saved && typeof saved.id === "string" && Number.isSafeInteger(saved.version)) void this.show(saved.id, saved.version, saved);
    else this.render();
  }

  /// `assemble`: this is the version's first show, so the page puts itself together.
  async show(id: string, version?: number, keep?: Partial<PaneState>, assemble = false) {
    const same = this.state?.id === id;
    this.state = { id, version: version ?? this.state?.version ?? 0, view: keep?.view ?? (same ? this.state!.view : "preview"), phone: keep?.phone ?? (same ? this.state!.phone : false) };
    if (!same) { this.detail = null; this.error = ""; }
    this.makingTitle = null;
    if (assemble && version !== undefined) this.assembleKey = `${id}:${version}`;
    this.render();
    const turn = ++this.loading;
    try {
      const found = await this.options.read(id, version);
      if (turn !== this.loading || this.state?.id !== id) return;
      this.detail = found;
      this.state.version = found.version;
      this.error = "";
    } catch (reason) {
      if (turn !== this.loading) return;
      this.error = reason instanceof Error ? reason.message : String(reason);
    }
    this.remember();
    this.render();
    this.options.changed();
  }

  close() {
    if (!this.state && this.makingTitle === null) return;
    this.state = null; this.detail = null; this.error = ""; this.frameKey = ""; this.assembleKey = ""; this.makingTitle = null;
    this.remember();
    this.render();
    this.options.changed();
  }

  /// Something new made in this chat opens the pane on it; a newer version of
  /// the open artifact moves the pane onto it, as long as it was on the latest.
  refresh(artifacts: readonly { id: string; version: number }[]) {
    const fresh = artifacts.filter((item) => this.primed && !this.seen.has(`${item.id}:${item.version}`));
    for (const item of artifacts) this.seen.add(`${item.id}:${item.version}`);
    this.primed = true;
    const open = this.state, made = fresh.at(-1);
    if (!open) { if (made) void this.show(made.id, made.version, undefined, true); return; }
    if (!this.detail) return;
    const latest = neighbours(this.detail.versions, open.version).latest;
    const newer = artifacts.find((item) => item.id === open.id && item.version > latest);
    if (newer && open.version === latest) void this.show(open.id, newer.version, undefined, true);
    else if (made && made.id !== open.id) void this.show(made.id, made.version, undefined, true);
  }

  /// The pane after a delete elsewhere: gone with the artifact.
  forget(id: string) { if (this.state?.id === id) this.close(); }

  private remember() {
    if (!this.session) return;
    try {
      if (this.state) localStorage.setItem(`demesne-pane:${this.session}`, JSON.stringify(this.state));
      else localStorage.removeItem(`demesne-pane:${this.session}`);
    } catch {}
  }

  private async act(action: string) {
    const state = this.state, detail = this.detail;
    if (!state) return;
    if (action === "close") return this.close();
    if (action === "preview" || action === "code") { state.view = action; this.remember(); return this.render(); }
    if (action === "phone") { state.phone = !state.phone; this.remember(); return this.render(); }
    if (!detail) return;
    const near = neighbours(detail.versions, state.version);
    if (action === "earlier" && near.earlier !== null) return this.show(state.id, near.earlier);
    if (action === "later" && near.later !== null) return this.show(state.id, near.later);
    try {
      if (action === "copy") { await this.options.copy(detail.source); this.options.notice("Copied the source"); }
      else if (action === "export") await this.options.export(state.id, state.version);
      else if (action === "revise") await this.options.revise(detail);
      else if (action === "foundry") this.options.openFoundry(state.id, state.version);
      else if (action === "restore") { const saved = await this.options.restore(detail); await this.show(saved.id, saved.version); }
    } catch (reason) {
      this.error = reason instanceof Error ? reason.message : String(reason);
      this.render();
    }
  }

  private render() {
    const state = this.state, detail = this.detail;
    this.root.hidden = !state && this.makingTitle === null;
    if (!state) {
      this.stage.replaceChildren(); this.frameKey = "";
      if (this.makingTitle !== null) {
        this.head.innerHTML = paneMakingHead(this.makingTitle);
        this.foot.innerHTML = "<span>writing the page…</span>";
        this.code.hidden = true; this.stage.hidden = false; this.stage.className = "pane-stage";
      }
      return;
    }
    this.head.innerHTML = paneHead(detail, state);
    this.foot.innerHTML = paneFoot(detail, state, this.error);
    const code = state.view === "code";
    this.code.hidden = !code;
    this.stage.hidden = code;
    this.stage.className = `pane-stage${detail?.kind === "svg" ? " graphic" : ""}${detail?.kind === "html" && state.phone ? " phone" : ""}`;
    if (code) this.code.textContent = detail?.source ?? "";
    if (!detail) { this.stage.replaceChildren(); this.frameKey = ""; return; }
    const key = `${detail.kind}:${detail.id}:${state.version}`;
    if (key === this.frameKey) return;
    this.frameKey = key;
    const assemble = this.assembleKey === `${detail.id}:${state.version}`;
    this.assembleKey = "";
    if (detail.kind === "markdown") {
      const article = document.createElement("article");
      article.className = "pane-doc markdown";
      article.innerHTML = this.options.markdown(detail.source);
      this.stage.replaceChildren(article);
      const previous = this.lastDocument?.id === detail.id ? this.lastDocument.html : null;
      this.lastDocument = { id: detail.id, html: article.innerHTML };
      if (assemble) this.options.assembleDocument?.(article, previous);
      return;
    }
    // The frame is made once per version: remaking it would reset the page.
    const frame = document.createElement("iframe");
    frame.className = "pane-frame";
    frame.src = frameSource(detail.id, state.version, assemble);
    frame.title = `${detail.title} ${KIND_WORD[detail.kind].toLowerCase()}`;
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals");
    frame.referrerPolicy = "no-referrer";
    this.stage.replaceChildren(frame);
  }
}
